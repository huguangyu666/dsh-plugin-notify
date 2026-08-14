/**
 * 构建脚本：生成 lib/ 发布产物。
 * lib/index.js  host 端（ESM bundle）；lib/client.js  client bundle（CJS + __ModuleLoader__ 包装）；
 * notify.ps1 / idle.ps1 / volume.py 原样进包（files 声明）。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'

const ID = 'dsh-plugin-notify'
rmSync('lib', { recursive: true, force: true })
mkdirSync('lib', { recursive: true })

// host 端：ESM bundle
execSync(
  `npx esbuild src/index.js --bundle --format=esm --platform=node --target=es2022 ` +
  `--external:node:fs --external:node:path --external:node:url --external:node:child_process --external:@deepseek-ai/* ` +
  `--outfile=lib/index.js`,
  { stdio: 'inherit' })

// client bundle：CJS + load 包装（官方格式）
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`
const footer = `return module.exports; } });`
execSync(
  `npx esbuild src/client-source.js --bundle --format=cjs --platform=browser --target=es2022 ` +
  `--external:react --external:react/jsx-runtime --external:@deepseek-ai/* ` +
  `--banner:js=${JSON.stringify(banner)} --footer:js=${JSON.stringify(footer)} ` +
  `--outfile=lib/client.js`,
  { stdio: 'inherit' })

// 校验产物
const host = readFileSync('lib/index.js', 'utf8')
const client = readFileSync('lib/client.js', 'utf8')
if (!host.includes('dsh-plugin-notify')) throw new Error('host bundle 缺关键符号')
if (!host.includes('settingsNamespace')) throw new Error('host bundle 缺 settings 注册')
if (!client.includes('__ModuleLoader__.load')) throw new Error('client bundle 缺 load 包装')
if (!client.includes('settings.section')) throw new Error('client bundle 缺 settings.section 注册')
if (!readFileSync('notify.ps1', 'utf8').includes('DSH_NOTIFY_PAYLOAD')) throw new Error('ps1 文件异常')
if (!readFileSync('volume.py', 'utf8').includes('pycaw')) throw new Error('volume.py 异常')
console.log('构建完成：lib/index.js + lib/client.js（notify.ps1 / idle.ps1 / volume.py 随 files 进包）')
console.log('host:', host.length, 'bytes | client:', client.length, 'bytes')
