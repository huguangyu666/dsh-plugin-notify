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
const PS1 = join(PACKAGE_ROOT, 'notify.ps1')
const DEFAULT_MODE = process.env.DSH_NOTIFY_DEFAULT_MODE || 'toast'
const VALID_MODES = ['toast', 'speak', 'sound', 'both']
/** 语音播报最长字符（避免念太久） */
const SPEAK_MAX_CHARS = 300

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
      text: '你有 notify_user 工具（桌面通知 / 中文语音播报 / 提示音），用于主动联系用户。规则：\n' +
        '1. 必须：任务出错、或需要用户注意与确认时，立即用 notify_user 通知用户\n' +
        '2. 必须：完成任务需要多步操作或持续较长时间时，完成后用 notify_user 通知用户结果摘要\n' +
        '3. 建议：用户可能不在电脑前时（长任务），用 speak 或 both 模式呼叫用户回来\n' +
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

  // 兜底：回合结束自动桌面通知（保证"任务完成必然知道"，不依赖模型自觉）。
  // 可用 DSH_NOTIFY_ON_TURN_END=0 关闭。
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
        notify('toast', '任务完成', summary)
      } catch (e) {
        console.error('[notify] 完成自动通知失败:', e.message)
      }
    })
  }

  // agent 工具：模型主动通知用户
  ctx.tools?.register?.({
    name: 'notify_user',
    description: '通过桌面通知 / 中文语音播报 / 提示音主动联系用户。适合：长任务完成、出错、需要用户注意或确认、用户可能不在电脑前时呼叫用户回来。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '通知内容，一句话说清楚（语音播报会念出来，控制在 50 字内最佳）' },
        mode: { type: 'string', enum: ['speak', 'toast', 'sound', 'both'], description: 'speak=语音播报（响亮，用户不在电脑前也能听到）；toast=桌面通知；sound=提示音；both=语音+桌面通知。默认 toast' },
        title: { type: 'string', description: '通知标题（默认 dsh 通知）' },
      },
      required: ['message'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (args, value) => [{ type: 'text', text: `已通知用户（${value.mode}）` }],
    },
    execute: async (args) => {
      const mode = notify(args.mode ?? DEFAULT_MODE, args.title, args.message)
      return { mode }
    },
    isConcurrencySafe: () => false, // 语音播报必须串行
    timeoutMs: 120000,
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
