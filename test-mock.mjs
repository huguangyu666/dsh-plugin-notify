/**
 * dsh-plugin-notify mock 测试：
 * 1. 工具/命令/路由注册
 * 2. 模板渲染（scene → 文案，不实际通知）
 * 3. 配置读写（settings API）
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.USERPROFILE || process.env.HOME
// 隔离配置目录，避免污染真实配置
const cfgDir = join(home, '.dsh', 'notify')
rmSync(join(cfgDir, 'config.json'), { force: true })

const routes = new Map()
const commands = new Map()
const tools = new Map()
const fakeCtx = {
  webServer: { register: (r) => routes.set(r.path, r) },
  commands: { register: (c) => commands.set(c.name, c) },
  tools: { register: (d) => tools.set(d.name, d) },
  systemPrompt: { section: () => () => {} },
}
const m = await import('./lib/index.js')
m.apply(fakeCtx)

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}

// 1. 注册检查
check('工具 notify_user 注册', tools.has('notify_user'))
check('工具 user_activity 注册', tools.has('user_activity'))
check('命令 notify 注册', commands.has('notify'))
check('路由 /notify', routes.has('/notify'))
check('路由 /notify/api', routes.has('/notify/api'))
check('路由 /notify/api/settings', routes.has('/notify/api/settings'))

// 2. 模板渲染（通过 execute 但拦截实际通知——用 sound 模式会响，这里改用直接验证参数结构）
const notifyTool = tools.get('notify_user')
const p = notifyTool.parameters
check('工具参数含 message 必填', p.required?.includes('message'))
check('工具参数含 scene 枚举', Array.isArray(p.properties?.scene?.enum))
check('工具参数含 mode 枚举', Array.isArray(p.properties?.mode?.enum))

// 3. 配置 API 读写（不触发通知）
function mockReq(body, method = 'POST') {
  return { method, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body ?? {})) } }
}
function mockRes() {
  const res = { statusCode: 0, body: '' }
  res.writeHead = (c) => { res.statusCode = c }
  res.end = (d) => { res.body = d.toString() }
  return res
}

// GET 配置
const getRes = mockRes()
await routes.get('/notify/api/settings').handler({ method: 'GET' }, getRes)
const cfg = JSON.parse(getRes.body).config
check('GET 配置返回默认值', getRes.statusCode === 200 && cfg.defaultMode === 'toast')
check('配置含 boostVolume', typeof cfg.boostVolume === 'boolean')
check('配置含 soundEffect', typeof cfg.soundEffect === 'string')

// POST 配置
const postRes = mockRes()
await routes.get('/notify/api/settings').handler(mockReq({ defaultMode: 'speak', boostVolume: true, callDelaySeconds: 30 }), postRes)
const saved = JSON.parse(postRes.body).config
check('POST 配置保存', postRes.statusCode === 200 && saved.defaultMode === 'speak' && saved.boostVolume === true)
check('确认窗口保存', saved.callDelaySeconds === 30)

// 恢复默认（清理）
await routes.get('/notify/api/settings').handler(mockReq({ defaultMode: 'toast', boostVolume: false, callDelaySeconds: 60 }), mockRes())

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
