/**
 * 构建脚本：生成 lib/ 发布产物。
 * lib/index.js  host 端（ESM bundle）；notify.ps1 原样进包（files 声明）。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'

rmSync('lib', { recursive: true, force: true })
mkdirSync('lib', { recursive: true })

// host 端：ESM bundle
execSync(
  `npx esbuild src/index.js --bundle --format=esm --platform=node --target=es2022 ` +
  `--external:node:fs --external:node:path --external:node:url --external:node:child_process --external:@deepseek-ai/* ` +
  `--outfile=lib/index.js`,
  { stdio: 'inherit' })

// 校验产物
const host = readFileSync('lib/index.js', 'utf8')
if (!host.includes('dsh-plugin-notify')) throw new Error('host bundle 缺关键符号')
if (!host.includes('notify.ps1', 'idle.ps1')) throw new Error('host bundle 缺 ps1 路径引用')
console.log('构建完成：lib/index.js（notify.ps1 + idle.ps1 随 files 进包）')
console.log('host:', host.length, 'bytes')
