/**
 * 切会话 e2e：一轮还在跑的时候点另一条会话，应该先把这一轮停干净再切过去，
 * 而不是回一句「请先等当前轮结束」。
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
      env: { ...process.env, NO_COLOR: '1' },
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

test('load-session: 一轮跑着时也能切会话（先中止当前轮，不报错）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-switch-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-switch-data-'))
  const llm = await startFakeLlm([
    { toolCalls: [{ id: 'c1', name: 'write', args: { path: 'a.txt', content: 'x\n' } }] },
    { text: '好的' },
  ])
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

  try {
    const ready0 = await host.next('ready')
    const aId = String(ready0.session)

    // 造出第二个会话，再切回 A
    host.send({ cmd: 'new-session' })
    const bId = String((await host.next('ready')).session)
    assert.notEqual(bId, aId)
    host.send({ cmd: 'load-session', id: aId })
    assert.equal(String((await host.next('ready')).session), aId)

    // 在 A 里开一轮，卡在审批上（= running）
    host.send({ cmd: 'task', text: '创建 a.txt' })
    await host.next('turn-start')
    const ap = await host.next('approval')
    assert.ok(ap.reqId, '应该弹出审批，说明这一轮确实在跑')

    // 跑着的时候切到 B
    host.send({ cmd: 'load-session', id: bId })
    const readyB = await host.next('ready')
    assert.equal(String(readyB.session), bId)
    assert.deepEqual(host.errors(), [], '切会话不该回错误')

    // 中断的那一轮要收尾成 cancelled，并且切过去之后还能正常开新一轮
    const cancelled = await host.next('turn-end')
    assert.equal(cancelled.reason, 'cancelled')

    host.send({ cmd: 'task', text: '再试一次' })
    const turn = await host.next('turn-end')
    assert.equal(turn.reason, 'done')
  } finally {
    await host.close()
    await llm.close()
  }
})

test('load-session: 没在跑的时候切换不额外发 notice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-switch2-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-switch2-data-'))
  const llm = await startFakeLlm([{ text: '嗯' }])
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

  try {
    const aId = String((await host.next('ready')).session)
    host.send({ cmd: 'new-session' })
    const bId = String((await host.next('ready')).session)
    host.send({ cmd: 'load-session', id: aId })
    assert.equal(String((await host.next('ready')).session), aId)
    assert.ok(!host.seen.some((e) => e.type === 'notice' && String(e.text).includes('已中断')))
    assert.notEqual(bId, aId)
  } finally {
    await host.close()
    await llm.close()
  }
})
