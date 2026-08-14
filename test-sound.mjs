/**
 * sound.py 生成物验证：检查 ~/.dsh/notify/sounds/ 下的 wav 文件格式正确
 * （不重新生成，只验证已有文件；若缺失则调用生成器）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}

const home = process.env.USERPROFILE || process.env.HOME
const soundsDir = join(home, '.dsh', 'notify', 'sounds')

// 确保音效存在（缺失时生成）
try {
  execFileSync('python', ['sound.py'], { cwd: process.cwd(), stdio: 'ignore' })
} catch { /* 生成失败也不阻塞检查 */ }

const names = ['explode', 'success', 'alarm', 'notify']
for (const n of names) {
  const f = join(soundsDir, n + '.wav')
  if (!existsSync(f)) { check(`${n}.wav 存在`, false); continue }
  const buf = readFileSync(f)
  // WAV 头：RIFF + WAVE + fmt 块
  const ok = buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE'
  check(`${n}.wav 格式有效`, ok, `size=${buf.length}`)
  // 采样率 44100
  const rate = buf.readUInt32LE(24)
  check(`${n}.wav 采样率 44100`, rate === 44100, `rate=${rate}`)
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
