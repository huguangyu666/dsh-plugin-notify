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
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-plugin-notify'

export const inject = ['commands', 'webServer', 'tools', 'systemPrompt']

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const homeDir = process.env.USERPROFILE || process.env.HOME || ''
const PS1 = join(PACKAGE_ROOT, 'notify.ps1')
const IDLE_PS1 = join(PACKAGE_ROOT, 'idle.ps1')
const DEFAULT_MODE = process.env.DSH_NOTIFY_DEFAULT_MODE || 'toast'
const VALID_MODES = ['toast', 'speak', 'sound', 'both']
/** 语音播报最长字符（避免念太久） */
const SPEAK_MAX_CHARS = 300
/** 自动叫人：toast 发出后等待用户响应的秒数（期间用户在 dsh 发消息则取消） */
const CALL_DELAY_SECONDS = Number(process.env.DSH_NOTIFY_CALL_DELAY_SECONDS) || 60

/** 待确认的通知：sessionId -> { summary, responded, timer } */
const pendingCalls = new Map()

// ── 文案模板：模型不写 message 时的兜底文案；模型想说什么自己写 message ──
// 优先级：~/.dsh/notify/templates.json > 环境变量 DSH_NOTIFY_TEMPLATE_* > 默认
// 变量：{{summary}}（结果摘要）、{{session}}（会话 id）——默认模板不含，想用可自定义
const DEFAULT_TEMPLATES = {
  task_done: '任务已经完成了，快回来看看结果吧',
  task_error: '任务出错了，需要你处理一下',
  call_back: '我需要你过来看看',
}

function loadTemplates() {
  const t = { ...DEFAULT_TEMPLATES }
  for (const key of ['task_done', 'task_error', 'call_back']) {
    const env = process.env[`DSH_NOTIFY_TEMPLATE_${key.toUpperCase()}`]
    if (env) t[key] = env
  }
  try {
    const file = join(homeDir, '.dsh', 'notify', 'templates.json')
    if (existsSync(file)) {
      const d = JSON.parse(readFileSync(file, 'utf8'))
      for (const key of ['task_done', 'task_error', 'call_back']) {
        if (typeof d[key] === 'string' && d[key].trim()) t[key] = d[key].trim()
      }
    }
  } catch { /* 配置文件损坏时用默认 */ }
  return t
}

const TEMPLATES = loadTemplates()

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

/** 执行一次通知（同步，spawnSync 调 PowerShell） */
function notify(mode, title, message) {
  if (!VALID_MODES.includes(mode)) mode = 'toast'
  let text = String(message ?? '').trim()
  if (!text) throw new Error('通知内容为空')
  if ((mode === 'speak' || mode === 'both') && text.length > SPEAK_MAX_CHARS) {
    text = text.slice(0, SPEAK_MAX_CHARS) + '。详细内容请看桌面通知。'
  }
  const payload = Buffer.from(JSON.stringify({ mode, title: String(title ?? 'dsh 通知'), message: text })).toString('base64')
  if (!existsSync(PS1)) throw new Error(`notify.ps1 不存在: ${PS1}`)
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, DSH_NOTIFY_PAYLOAD: payload },
  })
  if (r.error) throw new Error(`PowerShell 启动失败: ${r.error.message}`)
  if (r.status !== 0) {
    const err = (r.stderr || '').trim() || (r.stdout || '').trim()
    throw new Error(`通知失败: ${err.slice(0, 300)}`)
  }
  return mode
}

/** 从原始输入解析模式 flag 与内容 */
function parseFlags(raw) {
  let mode = DEFAULT_MODE
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
:root { --bg:#0f1115; --panel:#171a21; --line:#262b36; --text:#d6dae2; --dim:#8b93a3;
        --accent:#4f8cff; --ok:#3fb96f; --bad:#e5484d; }
* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--bg); color:var(--text); font:14px/1.6 "Segoe UI",system-ui,sans-serif; }
header { display:flex; align-items:center; gap:14px; padding:14px 22px; border-bottom:1px solid var(--line); }
header h1 { font-size:17px; font-weight:600; }
header .sub { color:var(--dim); font-size:12px; }
main { max-width:640px; margin:0 auto; padding:20px 22px; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; }
.panel h2 { font-size:14px; margin-bottom:12px; color:var(--dim); font-weight:600; }
textarea { width:100%; background:#0f1115; border:1px solid var(--line); color:var(--text);
  border-radius:6px; padding:10px; font-size:13px; outline:none; resize:vertical; min-height:90px; }
textarea:focus { border-color:var(--accent); }
.row { display:flex; gap:10px; margin-top:12px; align-items:center; flex-wrap:wrap; }
button { background:var(--accent); border:none; color:#fff; border-radius:6px; padding:8px 18px; font-size:13px; cursor:pointer; }
button.ghost { background:transparent; border:1px solid var(--line); color:var(--dim); }
select { background:#0f1115; border:1px solid var(--line); color:var(--text); border-radius:6px; padding:8px 10px; font-size:13px; }
#msg { color:var(--dim); font-size:12px; margin-top:10px; }
.hint { color:var(--dim); font-size:12px; margin-top:8px; }
</style>
</head>
<body>
<header>
  <h1>dsh 通知测试</h1>
  <span class="sub">notify_user 工具 / /notify 命令 共用此后端</span>
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
  if (process.env.DSH_NOTIFY_ON_TURN_END !== '0') {
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
        if (process.env.DSH_NOTIFY_AUTO_CALL !== '0') {
          const sessionId = agent.id
          const prev = pendingCalls.get(sessionId)
          if (prev?.timer) clearTimeout(prev.timer)
          const entry = { summary, responded: false, timer: null }
          entry.timer = setTimeout(() => {
            if (!entry.responded) {
              notify('speak', '任务完成', renderTemplate(TEMPLATES.task_done))
              console.log(`[notify] 1 分钟未确认，语音呼叫（${sessionId}）`)
            }
            pendingCalls.delete(sessionId)
          }, CALL_DELAY_SECONDS * 1000)
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
      const text = custom || renderTemplate(TEMPLATES[scene] ?? TEMPLATES.task_done, {
        summary: String(args.summary ?? '').trim(),
        session: '',
      })
      const mode = notify(args.mode ?? DEFAULT_MODE, args.title, text)
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
        const mode = String(body.mode ?? DEFAULT_MODE)
        const used = notify(mode, 'dsh 通知', String(body.text ?? ''))
        sendJson(res, 200, { ok: true, mode: used })
      } catch (e) {
        sendJson(res, 500, { error: e.message })
      }
    },
  })
}
