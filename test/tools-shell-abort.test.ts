import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runShell } from '../src/tools/shell.ts'

// 回归：Windows 上 child.kill() 只杀直接子进程，命令里拉起的孙进程握着 stdout 管道，
// close 事件不来 → runShell 永不 resolve。界面上就是「点了停止，任务还在跑」。
test('shell: 中断时连孙进程一起杀，promise 一定会返回', async () => {
  const ac = new AbortController()
  const t0 = Date.now()
  const p = runShell('node -e "setTimeout(()=>{},60000)"', {
    cwd: process.cwd(),
    timeoutMs: 60_000,
    signal: ac.signal,
  })
  const guard = new Promise<never>((_, rej) => {
    setTimeout(() => rej(new Error('abort 之后 10 秒还没返回：进程树没杀干净')), 10_000).unref?.()
  })
  setTimeout(() => ac.abort(), 300)

  const r = await Promise.race([p, guard])
  const ms = Date.now() - t0
  assert.equal(r.aborted, true, '被取消的调用要标记 aborted')
  assert.equal(r.timedOut, false, '取消不是超时：日志里 992ms 就报「超时」误导过模型')
  assert.ok(ms < 10_000, `中断后应尽快返回，实际 ${ms}ms`)
})
