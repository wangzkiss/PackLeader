import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { resolveShell, runShell } from '../src/tools/shell.ts'

const isWin = process.platform === 'win32'

test('shell: 能解析出真实存在的解释器', () => {
  const shell = resolveShell()
  assert.ok(shell.file.length > 0)
  assert.ok(existsSync(shell.file), `${shell.file} 不存在`)
  assert.ok(shell.args('echo hi').length > 0)
})

test('shell: 执行并拿到 stdout 与 exit code', async () => {
  const r = await runShell('echo packleader-ok', { cwd: process.cwd() })
  assert.equal(r.exitCode, 0)
  assert.match(r.stdout, /packleader-ok/)
  assert.equal(r.timedOut, false)
})

test('shell: 命令失败时 exit code 非 0', async () => {
  const r = await runShell(isWin ? 'exit 3' : 'exit 3', { cwd: process.cwd() })
  assert.equal(r.exitCode, 3)
})

test('shell: 超时会被标记并终止', async () => {
  const cmd = isWin ? 'Start-Sleep -Seconds 5' : 'sleep 5'
  const started = Date.now()
  const r = await runShell(cmd, { cwd: process.cwd(), timeoutMs: 400 })
  assert.equal(r.timedOut, true)
  assert.equal(r.aborted, false, '超时不应被当成取消')
  assert.ok(Date.now() - started < 4000, '应该被提前杀掉')
})

// 中文 Windows 上 PS 5.1 默认按 GBK 往管道里写，按 UTF-8 解就是一片「����」。
// 现在每条命令前拼了 [Console]::OutputEncoding=UTF8，这里盯住它别再退回去。
test('shell: 中文输出不会变成乱码', async () => {
  const cmd = isWin ? "Write-Output '包老大中文测试'" : "printf '包老大中文测试\\n'"
  const r = await runShell(cmd, { cwd: process.cwd() })
  assert.equal(r.exitCode, 0)
  assert.match(r.stdout, /包老大中文测试/)
  assert.doesNotMatch(r.stdout, /\ufffd/, 'stdout 里不该出现替换字符')
})

test('shell: stderr 的中文也能正确解出来', async () => {
  const cmd = isWin ? "Write-Error '中文错误信息'" : "echo '中文错误信息' 1>&2"
  const r = await runShell(cmd, { cwd: process.cwd() })
  assert.match(r.stderr, /中文错误信息/)
})

test('shell: Windows 上每条命令都带 UTF-8 前缀', () => {
  if (!isWin) return
  const shell = resolveShell()
  const line = shell.args('echo hi').join(' ')
  assert.ok(/OutputEncoding|chcp 65001/.test(line), `前缀丢了：${line}`)
})
