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
  assert.ok(Date.now() - started < 4000, '应该被提前杀掉')
})
