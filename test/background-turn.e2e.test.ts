/**
 * 后台轮次 e2e：切到别的会话时，正在跑的那一轮不该被中断，而应该在原会话里跑完；
 * 切回去时能看到它还在跑（ready.runningSession），跑完后的结果也落在原会话里。
 *
 * 之前的行为是「先 stopCurrentTurn 再切」，于是 A 里那一轮必然收成 cancelled。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { startFakeLlm } from './fake-llm.ts'

const HOST = join(import.meta.dirname, '..', 'src', 'host.ts')

interface Line {
  type: string
  [k: string]: unknown
}

class HostProc {
  readonly child: ChildProcessWithoutNullStreams
  private buf = ''
  private queue: Line[] = []
  readonly seen: Line[] = []
  stderr = ''

  constructor(args: string[]) {
    this.child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOST, ...args], {
      // PL_PERF=off：测试起的 host 不要往用户真实的 perf 目录里写日志
      env: { ...process.env, NO_COLOR: '1', PL_PERF: 'off' },
      windowsHide: true,
    })
    this.child.stdout.on('data', (b: Buffer) => {
      this.buf += b.toString('utf8')
      let i: number
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        if (!line.trim()) continue
        const evt = JSON.parse(line) as Line
        this.seen.push(evt)
        this.queue.push(evt)
      }
    })
    this.child.stderr.on('data', (b: Buffer) => {
      this.stderr += b.toString('utf8')
    })
  }

  send(cmd: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(cmd)}\n`)
  }

  async next(type: string, timeoutMs = 20_000): Promise<Line> {
    const t0 = Date.now()
    for (;;) {
      const i = this.queue.findIndex((e) => e.type === type)
      if (i !== -1) return this.queue.splice(i, 1)[0]!
      if (this.stderr) throw new Error(`host 写了 stderr：${this.stderr}`)
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`等 ${type} 超时；已收到：${this.seen.map((e) => e.type).join(',')}`)
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  errors(): string[] {
    return this.seen.filter((e) => e.type === 'error').map((e) => String(e.message))
  }

  async close(): Promise<void> {
    this.child.stdin.end()
    await new Promise((r) => this.child.on('close', r))
  }
}

async function boot(steps: Parameters<typeof startFakeLlm>[0]): Promise<{ host: HostProc; llm: Awaited<ReturnType<typeof startFakeLlm>> }> {
  const root = await mkdtemp(join(tmpdir(), 'pl-bg-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-bg-data-'))
  const llm = await startFakeLlm(steps)
  const host = new HostProc([
    '--cwd',
    root,
    '--data-dir',
    dataDir,
    '--base-url',
    llm.url,
    '--api-key',
    'sk-x',
    '--model',
    'demo-model',
  ])
  return { host, llm }
}

test('切走不中断：A 跑着时切到 B，A 那一轮继续跑到 done，事件带 A 的 session', async () => {
  const { host, llm } = await boot([
    { toolCalls: [{ id: 'c1', name: 'write', args: { path: 'a.txt', content: 'x\n' } }] },
    { text: '好的' },
  ])
  try {
    const aId = String((await host.next('ready')).session)
    host.send({ cmd: 'new-session' })
    const bId = String((await host.next('ready')).session)

    // 切回 A，开一轮，卡在审批上（= 正在跑）
    host.send({ cmd: 'load-session', id: aId })
    assert.equal(String((await host.next('ready')).session), aId)
    host.send({ cmd: 'task', text: '创建 a.txt' })
    await host.next('turn-start')
    const ap = await host.next('approval')

    // 跑着的时候切到 B
    host.send({ cmd: 'load-session', id: bId })
    const readyB = await host.next('ready')
    assert.equal(String(readyB.session), bId)
    assert.equal(String(readyB.runningSession), aId, 'ready 要告诉界面另一个会话正在跑')
    assert.deepEqual(host.errors(), [], '切会话不该回错误')

    // 关键：切走之后 A 那一轮仍在跑，批准它，应该正常跑完
    host.send({ cmd: 'approve', reqId: String(ap.reqId), decision: 'allowed-once' })
    const end = await host.next('turn-end')
    assert.equal(String(end.session), aId, 'turn-end 要标明属于哪个会话')
    assert.equal(String(end.reason), 'done')

    // 切走期间 A 的实时事件照样发出来，并且带 A 的 session（界面据此丢弃/提示）
    const toolStart = host.seen.find((e) => e.type === 'tool-start')
    assert.ok(toolStart, '应该有 tool-start')
    assert.equal(String(toolStart.session), aId)

    // 切回 A：这一轮已经跑完了，不该再显示运行中
    host.send({ cmd: 'load-session', id: aId })
    const readyA = await host.next('ready')
    assert.equal(String(readyA.session), aId)
    assert.ok(!readyA.runningSession, '跑完了就不该报 runningSession')
  } finally {
    await host.close()
    await llm.close()
  }
})

test('切回正在跑的会话：ready 报 runningSession + runningStep，界面据此显示运行中', async () => {
  const { host, llm } = await boot([
    { toolCalls: [{ id: 'c1', name: 'write', args: { path: 'b.txt', content: 'y\n' } }] },
    { text: '完成' },
  ])
  try {
    const aId = String((await host.next('ready')).session)
    host.send({ cmd: 'new-session' })
    const bId = String((await host.next('ready')).session)
    host.send({ cmd: 'load-session', id: aId })
    await host.next('ready')

    host.send({ cmd: 'task', text: '创建 b.txt' })
    await host.next('turn-start')
    const ap = await host.next('approval')

    // 切到 B 再切回 A：A 还在跑
    host.send({ cmd: 'load-session', id: bId })
    await host.next('ready')
    host.send({ cmd: 'load-session', id: aId })
    const readyA = await host.next('ready')
    assert.equal(String(readyA.runningSession), aId)
    assert.ok(Number(readyA.runningStep) >= 1, '要带上跑到第几步')

    host.send({ cmd: 'approve', reqId: String(ap.reqId), decision: 'allowed-once' })
    const end = await host.next('turn-end')
    assert.equal(String(end.reason), 'done')
    assert.equal(String(end.session), aId)
  } finally {
    await host.close()
    await llm.close()
  }
})

test('正在跑的会话被删掉：先停下来再删，不留半轮', async () => {
  const { host, llm } = await boot([
    { toolCalls: [{ id: 'c1', name: 'write', args: { path: 'c.txt', content: 'z\n' } }] },
    { text: '完成' },
  ])
  try {
    const aId = String((await host.next('ready')).session)
    host.send({ cmd: 'task', text: '创建 c.txt' })
    await host.next('turn-start')
    await host.next('approval')

    host.send({ cmd: 'delete-session', id: aId })
    // 删自己正在跑的会话：这一轮必须收尾（cancelled），然后换一个新会话
    const end = await host.next('turn-end')
    assert.equal(String(end.reason), 'cancelled')
    const ready = await host.next('ready')
    assert.notEqual(String(ready.session), aId)
  } finally {
    await host.close()
    await llm.close()
  }
})
