/**
 * dsh-plugin-notify
 * 通知出口：agent 主动联系用户——桌面通知 / 中文语音播报 / 提示音。
 *
 * 场景：长任务完成、出错、需要用户注意、用户离开电脑时呼叫（"任务做完了叫你回来"）。
 *
 * 用法：
 *   - agent 工具 notify_user（模型自主决定何时通知）
 *   - 命令   /notify <内容> [--speak|--sound|--toast]
 *   - 页面   http://<dsh-host>:<dsh-port>/notify（测试）
 *
 * 后端：notify.ps1（PowerShell SAPI 离线中文语音 + NotifyIcon 气泡，零外部依赖）
 * 环境变量：DSH_NOTIFY_DEFAULT_MODE（默认通知方式：toast|speak|sound|both，默认 toast）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'dsh-plugin-notify'

export const inject = ['commands', 'webServer', 'tools', 'systemPrompt', 'settings']

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const homeDir = process.env.USERPROFILE || process.env.HOME || ''
const PS1 = join(PACKAGE_ROOT, 'notify.ps1')
const IDLE_PS1 = join(PACKAGE_ROOT, 'idle.ps1')
const VOLUME_PY = join(PACKAGE_ROOT, 'volume.py')
const VALID_MODES = ['toast', 'speak', 'sound', 'both']
/** 语音播报最长字符（避免念太久） */
const SPEAK_MAX_CHARS = 300

/** 待确认的通知：sessionId -> { summary, responded, timer } */
const pendingCalls = new Map()

// ── 配置：优先 dsh 原生设置（ctx.settings，设置界面自动渲染）；回退 config.json / 环境变量 / 默认 ──
const CONFIG_FILE = join(homeDir, '.dsh', 'notify', 'config.json')
let _settingsScope = null // apply 时注册的 dsh settings scope

const DEFAULT_TEMPLATES = {
  task_done: '任务已经完成了，快回来看看结果吧',
  task_error: '任务出错了，需要你处理一下',
  call_back: '我需要你过来看看',
}

let _configCache = null

function loadConfig() {
  if (_configCache) return _configCache
  // 1. dsh 原生设置（最高优先级）
  if (_settingsScope) {
    try {
      const v = _settingsScope.get()
      if (v && typeof v === 'object') {
        _configCache = v
        return v
      }
    } catch { /* 回退 */ }
  }
  // 2. config.json + 环境变量 + 默认
  const cfg = {
    defaultMode: process.env.DSH_NOTIFY_DEFAULT_MODE || 'toast',
    callDelaySeconds: Number(process.env.DSH_NOTIFY_CALL_DELAY_SECONDS) || 60,
    onTurnEnd: process.env.DSH_NOTIFY_ON_TURN_END !== '0',
    autoCall: process.env.DSH_NOTIFY_AUTO_CALL !== '0',
    boostVolume: true,
    soundEffect: process.env.DSH_NOTIFY_SOUND_EFFECT || 'explode',
    templates: { ...DEFAULT_TEMPLATES },
  }
  // 环境变量模板
  for (const key of ['task_done', 'task_error', 'call_back']) {
    const env = process.env[`DSH_NOTIFY_TEMPLATE_${key.toUpperCase()}`]
    if (env) cfg.templates[key] = env
  }
  // config.json（旧面板设置）
  try {
    const d = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    if (typeof d.defaultMode === 'string' && VALID_MODES.includes(d.defaultMode)) cfg.defaultMode = d.defaultMode
    if (Number.isFinite(d.callDelaySeconds) && d.callDelaySeconds > 0) cfg.callDelaySeconds = d.callDelaySeconds
    if (typeof d.onTurnEnd === 'boolean') cfg.onTurnEnd = d.onTurnEnd
    if (typeof d.autoCall === 'boolean') cfg.autoCall = d.autoCall
    if (typeof d.boostVolume === 'boolean') cfg.boostVolume = d.boostVolume
    if (typeof d.soundEffect === 'string' && ['explode','success','alarm','notify','system'].includes(d.soundEffect)) cfg.soundEffect = d.soundEffect
    if (d.templates && typeof d.templates === 'object') {
      for (const key of ['task_done', 'task_error', 'call_back']) {
        if (typeof d.templates[key] === 'string' && d.templates[key].trim()) cfg.templates[key] = d.templates[key].trim()
      }
    }
  } catch { /* 无配置或损坏时用默认 */ }
  _configCache = cfg
  return cfg
}

async function saveConfig(patch) {
  // 1. dsh 原生设置
  if (_settingsScope) {
    await _settingsScope.update(patch)
    _configCache = null
    return loadConfig()
  }
  // 2. config.json 兜底
  const current = loadConfig()
  const next = {
    defaultMode: patch.defaultMode ?? current.defaultMode,
    callDelaySeconds: Number(patch.callDelaySeconds) > 0 ? Number(patch.callDelaySeconds) : current.callDelaySeconds,
    onTurnEnd: Boolean(patch.onTurnEnd),
    autoCall: Boolean(patch.autoCall),
    boostVolume: Boolean(patch.boostVolume),
    soundEffect: patch.soundEffect ?? current.soundEffect,
    templates: {
      task_done: patch.templates?.task_done ?? current.templates.task_done,
      task_error: patch.templates?.task_error ?? current.templates.task_error,
      call_back: patch.templates?.call_back ?? current.templates.call_back,
    },
  }
  const dir = join(CONFIG_FILE, '..')
  mkdirSync(dir, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  _configCache = null // 缓存失效，下次重新读
  return next
}

/** 渲染模板：{{summary}} 自动加"："前缀；{{session}} 会话 id */
function renderTemplate(tpl, vars = {}) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (k === 'summary') {
      const s = String(vars.summary ?? '').trim()
      return s ? `：${s}` : ''
    }
    if (k === 'session') return String(vars.session ?? '')
    return m
  })
}

/** 音量增强：通知前调到最大，返回恢复函数（失败返回 null，不阻塞通知） */
function volumeBoost() {
  if (!existsSync(VOLUME_PY)) return null
  try {
    const r = spawnSync('python', [VOLUME_PY, 'boost'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    if (r.status !== 0) return null
    return () => {
      try { spawnSync('python', [VOLUME_PY, 'restore'], { encoding: 'utf8', timeout: 15000, windowsHide: true }) } catch { /* 忽略恢复失败 */ }
    }
  } catch {
    return null
  }
}

/** 查询系统空闲秒数（用户键盘/鼠标无操作时长） */
function queryIdle() {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', IDLE_PS1], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    })
    if (r.status === 0) {
      const d = JSON.parse(r.stdout.trim())
      return Number(d.idle_seconds) || 0
    }
  } catch { /* 查询失败按 0 处理（视为用户在） */ }
  return 0
}

/** 执行一次通知（同步，spawnSync 调 PowerShell；开启音量增强时先 boost 再恢复） */
function notify(mode, title, message) {
  if (!VALID_MODES.includes(mode)) mode = 'toast'
  let text = String(message ?? '').trim()
  if (!text) throw new Error('通知内容为空')
  if ((mode === 'speak' || mode === 'both') && text.length > SPEAK_MAX_CHARS) {
    text = text.slice(0, SPEAK_MAX_CHARS) + '。详细内容请看桌面通知。'
  }
  const payload = Buffer.from(JSON.stringify({ mode, title: String(title ?? 'dsh 通知'), message: text })).toString('base64')
  if (!existsSync(PS1)) throw new Error(`notify.ps1 不存在: ${PS1}`)
  // 音量增强：调到最大 → 通知 → 恢复
  const restore = loadConfig().boostVolume ? volumeBoost() : null
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1], {
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
      env: { ...process.env, DSH_NOTIFY_PAYLOAD: payload, DSH_NOTIFY_SOUND_EFFECT: loadConfig().soundEffect },
    })
    if (r.error) throw new Error(`PowerShell 启动失败: ${r.error.message}`)
    if (r.status !== 0) {
      const err = (r.stderr || '').trim() || (r.stdout || '').trim()
      throw new Error(`通知失败: ${err.slice(0, 300)}`)
    }
  } finally {
    if (restore) restore()
  }
  return mode
}

/** 从原始输入解析模式 flag 与内容 */
function parseFlags(raw) {
  let mode = loadConfig().defaultMode
  let rest = String(raw ?? '').trim()
  for (const flag of ['--speak', '--sound', '--toast', '--both']) {
    if (rest.includes(flag)) {
      mode = flag.slice(2)
      rest = rest.replace(flag, '').trim()
      break
    }
  }
  return { mode, text: rest }
}

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh 通知测试</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: 13px/1.6 var(--dsw-font-family, "Segoe UI", system-ui, sans-serif); }
header { display: flex; align-items: center; gap: 14px; padding: 12px 22px;
  border-bottom: 1px solid var(--dsw-alias-border-l2); }
header h1 { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
header .sub { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
main { max-width: 720px; margin: 0 auto; padding: 18px 22px; }
.panel { background: var(--dsw-alias-bg-module-platform); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px; padding: 14px; margin-bottom: 14px; }
.panel h2 { font-size: 13.5px; margin-bottom: 10px; color: var(--dsw-alias-label-secondary); font-weight: 600; }
textarea { width: 100%; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 9px 11px; font-size: 13px;
  outline: none; resize: vertical; min-height: 64px; }
textarea:focus { border-color: var(--dsw-alias-brand-primary); }
input[type=number] { background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 6px 10px; font-size: 13px;
  outline: none; width: 90px; }
input:focus { border-color: var(--dsw-alias-brand-primary); }
.row { display: flex; gap: 10px; margin-top: 10px; align-items: center; flex-wrap: wrap; }
.switch-row { display: flex; align-items: center; gap: 10px; margin: 7px 0; font-size: 13px; }
.switch-row label { color: var(--dsw-alias-label-secondary); cursor: pointer; }
button { background: var(--dsw-alias-button-info-fill); border: none; color: var(--dsw-alias-label-inverse, #fff);
  border-radius: 6px; padding: 7px 16px; font-size: 12.5px; cursor: pointer; }
button:hover { background: var(--dsw-alias-button-info-hover); }
button.ghost { background: transparent; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
button.ghost:hover { background: var(--dsw-alias-interactive-bg-hover); }
select { background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 7px 10px; font-size: 13px; }
#msg, #setmsg { color: var(--dsw-alias-label-tertiary); font-size: 12px; margin-top: 8px; }
.hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; margin-top: 6px; }
.tpl-label { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-top: 10px; }
</style>
</head>
<body>
<header>
  <h1>dsh 通知</h1>
  <span class="sub">notify_user 工具 / /notify 命令 / 自动通知共用此后端</span>
</header>
<main>
  <div class="panel">
    <h2>发一条通知</h2>
    <textarea id="text" placeholder="通知内容…">你好，我是 dsh 助手，这是通知测试。</textarea>
    <div class="row">
      <select id="mode">
        <option value="toast">桌面通知</option>
        <option value="speak">语音播报</option>
        <option value="sound">提示音</option>
        <option value="both">语音 + 桌面</option>
      </select>
      <button onclick="send()">发送</button>
      <button class="ghost" onclick="demo()">演示：任务完成叫你</button>
    </div>
    <div id="msg"></div>
  </div>

  <div class="panel">
    <h2>行为偏好</h2>
    <div class="row">
      <span style="color:var(--dim);font-size:13px">默认通知方式</span>
      <select id="set-mode">
        <option value="toast">桌面通知</option>
        <option value="speak">语音播报</option>
        <option value="sound">提示音</option>
        <option value="both">语音 + 桌面</option>
      </select>
    </div>
    <div class="row">
      <span style="color:var(--dim);font-size:13px">确认窗口（秒，超时未互动则语音呼叫）</span>
      <input type="number" id="set-delay" min="5" max="600">
    </div>
    <div class="switch-row"><input type="checkbox" id="set-turend"><label for="set-turend">回合结束自动通知（toast → 确认窗口 → 无人回应语音呼叫）</label></div>
    <div class="switch-row"><input type="checkbox" id="set-autocall"><label for="set-autocall">确认窗口超时后语音呼叫用户</label></div>
    <div class="switch-row"><input type="checkbox" id="set-boost"><label for="set-boost">通知时把音量调到最大，播完恢复（语音呼叫更响亮）</label></div>
    <div class="tpl-label">通知文案模板（模型不写 message 时使用；支持 {{summary}} / {{session}} 变量）</div>
    <textarea id="set-tpl-done" style="margin-top:6px"></textarea>
    <textarea id="set-tpl-error" style="margin-top:6px"></textarea>
    <textarea id="set-tpl-call" style="margin-top:6px"></textarea>
    <div class="row">
      <button onclick="saveSettings()">保存设置</button>
      <span id="setmsg"></span>
    </div>
    <div class="hint">设置保存到 ~/.dsh/notify/config.json，立即生效，无需重启 dsh</div>
  </div>
</main>
<script>
const $ = s => document.querySelector(s);
async function send() {
  const text = $('#text').value.trim();
  if (!text) { $('#msg').textContent = '内容为空'; return; }
  $('#msg').textContent = '通知中…';
  const r = await fetch('/notify/api', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text, mode: $('#mode').value }) });
  const d = await r.json().catch(() => ({}));
  $('#msg').textContent = r.ok ? ('已发送（' + d.mode + '）' + (d.detail ? ' — ' + d.detail : '')) : ('失败: ' + (d.error || r.status));
}
async function demo() {
  $('#text').value = '任务已经全部完成了，快回来看看结果吧。';
  $('#mode').value = 'both';
  await send();
}
async function loadSettings() {
  try {
    const r = await fetch('/notify/api/settings');
    const d = await r.json();
    if (!d.config) return;
    const c = d.config;
    $('#set-mode').value = c.defaultMode || 'toast';
    $('#set-delay').value = c.callDelaySeconds || 60;
    $('#set-turend').checked = !!c.onTurnEnd;
    $('#set-autocall').checked = !!c.autoCall;
    $('#set-boost').checked = !!c.boostVolume;
    $('#set-tpl-done').value = c.templates?.task_done || '';
    $('#set-tpl-error').value = c.templates?.task_error || '';
    $('#set-tpl-call').value = c.templates?.call_back || '';
  } catch(e) { $('#setmsg').textContent = '设置读取失败: ' + e.message; }
}
async function saveSettings() {
  const body = {
    defaultMode: $('#set-mode').value,
    callDelaySeconds: Number($('#set-delay').value) || 60,
    onTurnEnd: $('#set-turend').checked,
    autoCall: $('#set-autocall').checked,
    boostVolume: $('#set-boost').checked,
    templates: {
      task_done: $('#set-tpl-done').value.trim(),
      task_error: $('#set-tpl-error').value.trim(),
      call_back: $('#set-tpl-call').value.trim(),
    },
  };
  const r = await fetch('/notify/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  $('#setmsg').textContent = r.ok ? '已保存，立即生效' : ('保存失败: ' + (d.error || r.status));
}
loadSettings();
</script>
</body>
</html>`

function sendHtml(res, text) {
  const data = Buffer.from(text, 'utf8')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': data.length })
  res.end(data)
}

function sendJson(res, code, obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length })
  res.end(data)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

export function apply(ctx) {
  // 注册 dsh 原生设置命名空间：设置界面（侧边栏设置 → 插件 section）自动渲染表单，
  // 修改即时生效。注册失败（无 settings provider）时回退 config.json。
  try {
    const notifySchema = z.object({
      defaultMode: z.string().default('toast'),
      callDelaySeconds: z.number().default(60),
      onTurnEnd: z.boolean().default(true),
      autoCall: z.boolean().default(true),
      boostVolume: z.boolean().default(true),
      soundEffect: z.string().default('explode'),
      templates: z.object({
        task_done: z.string().default(DEFAULT_TEMPLATES.task_done),
        task_error: z.string().default(DEFAULT_TEMPLATES.task_error),
        call_back: z.string().default(DEFAULT_TEMPLATES.call_back),
      }).default({}),
    })
    _settingsScope = ctx.settings?.register(settingsNamespace('notify'), notifySchema, { applies: 'live' })
    if (_settingsScope) console.log('[notify] 已注册原生设置（设置界面可配置 notify）')
  } catch (e) {
    console.error('[notify] settings 注册失败，回退 config.json:', e.message)
    _settingsScope = null
  }

  // 系统提示词注入：让 agent 默认就有"主动通知用户"的习惯（不用每次教）。
  // 工具指导区约定 order 100-199；可用 DSH_NOTIFY_INJECT_PROMPT=0 禁用。
  if (process.env.DSH_NOTIFY_INJECT_PROMPT !== '0') {
    ctx.systemPrompt?.section?.({
      name: 'notify-user-guidance',
      order: 100,
      text: '你有 notify_user 工具（桌面通知 / 中文语音播报 / 提示音）和 user_activity 工具（查询用户是否在电脑前），用于主动联系用户。规则：\n' +
        '1. 必须：任务出错、或需要用户注意与确认时，立即用 notify_user 通知用户（scene 传 task_error）\n' +
        '2. 必须：完成多步或较长时间的任务后，用 notify_user 通知用户；若用户不在电脑前（user_activity 空闲超过 2 分钟），mode 用 speak 或 both 呼叫用户回来\n' +
        '3. 通知内容自己写进 message，想说啥说啥，像跟朋友说话一样自然（如"搞定了，报告放桌面了"）；不写 message 则用场景默认文案\n' +
        '4. 例外：几秒就能完成的简单任务无需通知，避免打扰',
    })
  }

  // 兜底：会话出错时自动通知（模型没调用 notify_user 也保证用户知道）
  ctx.on?.('agent/error', (payload) => {
    try {
      const err = payload?.error
      const detail = String(err?.message ?? err ?? '未知错误').slice(0, 200)
      notify('both', 'dsh 任务出错', `会话 ${payload?.agent?.id ?? ''} 出错：${detail}`)
    } catch (e) {
      console.error('[notify] 出错自动通知失败:', e.message)
    }
  })

  // 兜底：回合结束自动通知。
  // 流程：立即 toast → 进入 CALL_DELAY_SECONDS 秒确认窗口 → 期间用户在 dsh
  // 发了消息（=看到了通知）则取消；没发 → 语音叫人。
  // 不依赖"用户是否在线"：用电脑没看到 toast 更应该叫（语音打断提醒）。
  // 开关：DSH_NOTIFY_ON_TURN_END=0 关闭全部。
  if (loadConfig().onTurnEnd) {
    ctx.on?.('agent/turn-stopping', (payload) => {
      try {
        const agent = payload?.agent
        if (!agent?.session) return
        let text = ''
        for (const ev of agent.session.events) {
          if (ev.type === 'assistant/message') {
            const parts = (ev.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '')
            if (parts.length) text = parts.join('\n')
          }
        }
        const summary = text.trim().slice(0, 200) || `会话 ${agent.id} 的回合已结束`

        // 立即桌面通知
        notify('toast', '任务完成', summary)

        // 确认窗口：等 CALL_DELAY_SECONDS 秒，用户没发消息 → 语音叫人
        if (loadConfig().autoCall) {
          const sessionId = agent.id
          const prev = pendingCalls.get(sessionId)
          if (prev?.timer) clearTimeout(prev.timer)
          const entry = { summary, responded: false, timer: null }
          entry.timer = setTimeout(() => {
            if (!entry.responded) {
              notify('speak', '任务完成', renderTemplate(loadConfig().templates.task_done))
              console.log(`[notify] 1 分钟未确认，语音呼叫（${sessionId}）`)
            }
            pendingCalls.delete(sessionId)
          }, loadConfig().callDelaySeconds * 1000)
          pendingCalls.set(sessionId, entry)
        }
      } catch (e) {
        console.error('[notify] 完成自动通知失败:', e.message)
      }
    })

    // 用户在任意会话发了消息 → 视为看到了通知，取消待确认呼叫
    ctx.on?.('agent/inbox/inserted', (payload) => {
      if (payload?.message?.source?.kind !== 'user') return
      for (const [sessionId, entry] of pendingCalls) {
        if (!entry.responded) {
          entry.responded = true
          if (entry.timer) clearTimeout(entry.timer)
          pendingCalls.delete(sessionId)
          console.log(`[notify] 用户已互动，取消呼叫（${sessionId}）`)
        }
      }
    })
  }

  // agent 工具：模型主动通知用户（想说什么写 message，自由发挥；不写用场景默认文案）
  ctx.tools?.register?.({
    name: 'notify_user',
    description: '通过桌面通知 / 中文语音播报 / 提示音主动联系用户。任务完成、出错、需要用户注意或确认、呼叫用户回来时使用。想说的话写进 message（自由发挥，语气自然即可）；不写则按 scene 用默认文案。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '你想对用户说的话（自由发挥，不用模板；语音播报会念出来，50 字内最佳）' },
        scene: { type: 'string', enum: ['task_done', 'task_error', 'call_back'], description: '通知场景（不写 message 时决定默认文案）：task_done=任务完成（默认）；task_error=出错；call_back=呼叫用户回来' },
        mode: { type: 'string', enum: ['speak', 'toast', 'sound', 'both'], description: 'speak=语音播报（响亮，用户不在电脑前也能听到）；toast=桌面通知；sound=提示音；both=语音+桌面通知。默认 toast' },
        title: { type: 'string', description: '通知标题（默认 dsh 通知）' },
      },
      required: ['message'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (args, value) => [{ type: 'text', text: `已通知用户（${value.mode}）` }],
    },
    execute: async (args, exec) => {
      const scene = args.scene ?? 'task_done'
      const custom = String(args.message ?? '').trim()
      const cfg = loadConfig()
      const text = custom || renderTemplate(cfg.templates[scene] ?? cfg.templates.task_done, {
        summary: String(args.summary ?? '').trim(),
        session: '',
      })
      const mode = notify(args.mode ?? loadConfig().defaultMode, args.title, text)
      // 模型已主动通知 → 取消该系统兜底的待确认呼叫（避免 60 秒后重复叫）
      if (exec?.agent?.id) {
        const p = pendingCalls.get(exec.agent.id)
        if (p && !p.responded) {
          p.responded = true
          if (p.timer) clearTimeout(p.timer)
          pendingCalls.delete(exec.agent.id)
          console.log(`[notify] 模型已主动通知，取消兜底呼叫（${exec.agent.id}）`)
        }
      }
      return { mode, text: text.slice(0, 80) }
    },
    isConcurrencySafe: () => false, // 语音播报必须串行
    timeoutMs: 120000,
  })

  // agent 工具：查询用户是否在电脑前（模型自主判断"要不要叫人"的依据）
  ctx.tools?.register?.({
    name: 'user_activity',
    description: '查询用户当前是否在电脑前：返回系统键盘/鼠标空闲秒数（0 表示用户正在操作，数值越大表示离开越久）。长任务完成或不确定用户是否在线时使用，判断是否需要主动呼叫用户。',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (args, value) => {
        const idle = value?.idle_seconds ?? 0
        const desc = idle <= 30 ? '用户正在电脑前' : idle <= 180 ? '用户可能短暂离开' : '用户不在电脑前'
        return [{ type: 'text', text: `系统空闲 ${idle} 秒（${desc}）` }]
      },
    },
    execute: async () => {
      const idle = queryIdle()
      return { idle_seconds: idle }
    },
    isConcurrencySafe: () => true,
  })

  // 命令：/notify
  ctx.commands.register({
    name: 'notify',
    description: '通知用户（桌面通知 / 语音播报 / 提示音）。/notify <内容>；--speak 语音播报；--sound 仅提示音；--toast 桌面通知',
    input: { hint: '<内容> [--speak|--sound|--toast]' },
    handler: async (invocation) => {
      const { mode, text } = parseFlags(invocation?.rawInput)
      if (!text) {
        return { kind: 'error', text: '用法：/notify <通知内容> [--speak|--sound|--toast]\n例如：/notify --speak 任务完成了，快回来看看' }
      }
      try {
        const used = notify(mode, 'dsh 通知', text)
        return { kind: 'success', text: `已通知（${used}）：${text.slice(0, 60)}${text.length > 60 ? '…' : ''}` }
      } catch (e) {
        return { kind: 'error', text: `[notify] ${e.message}` }
      }
    },
  })

  // 测试页
  ctx.webServer.register({
    kind: 'exact',
    path: '/notify',
    handler: (req, res) => sendHtml(res, PAGE),
  })

  // 测试 API
  ctx.webServer.register({
    kind: 'exact',
    path: '/notify/api',
    handler: async (req, res) => {
      try {
        const body = await readBody(req).catch(() => ({}))
        const mode = String(body.mode ?? loadConfig().defaultMode)
        const used = notify(mode, 'dsh 通知', String(body.text ?? ''))
        sendJson(res, 200, { ok: true, mode: used })
      } catch (e) {
        sendJson(res, 500, { error: e.message })
      }
    },
  })

  // 设置 API：GET 读配置 / POST 保存配置（面板用）
  ctx.webServer.register({
    kind: 'exact',
    path: '/notify/api/settings',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, { config: loadConfig() })
          return
        }
        if (req.method === 'POST') {
          const body = await readBody(req).catch(() => ({}))
          const next = await saveConfig(body)
          sendJson(res, 200, { ok: true, config: next })
          return
        }
        sendJson(res, 405, { error: 'method not allowed' })
      } catch (e) {
        sendJson(res, 500, { error: e.message })
      }
    },
  })
}
