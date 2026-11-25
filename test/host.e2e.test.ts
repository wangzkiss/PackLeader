/**
 * 主机协议 e2e：真的起一个子进程，用 NDJSON 说话。
 * 这层是 GUI 的唯一接口，坏了窗口就全瞎，所以必须被测试覆盖。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

  /** 从缓冲区里取第一个该类型的事件；没有就轮询等（协议顺序确定，够用且不脆） */
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

  /** 断言某类型事件没出现过（用于「read-only 不该弹审批」这类检查） */
  has(type: string): boolean {
    return this.seen.some((e) => e.type === type)
  }

  async close(): Promise<void> {
    this.child.stdin.end()
    await new Promise((r) => this.child.on('close', r))
  }
}

async function setup(): Promise<{ host: HostProc; root: string; dataDir: string; llm: Awaited<ReturnType<typeof startFakeLlm>>; close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'pl-host-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-host-data-'))
  const llm = await startFakeLlm([
    { toolCalls: [{ id: 'c1', name: 'write', args: { path: 'a.txt', content: 'hello host\n' } }] },
    { text: '写好了' },
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
  return { host, root, dataDir, llm, close: async () => { await host.close(); await llm.close() } }
}

test('host: load-config reloads hand-edited settings and applies them to the running client', async () => {
  const s = await setup()
  try {
    await s.host.next('ready')
    await writeFile(
      join(s.dataDir, 'config.json'),
      JSON.stringify({ baseURL: 'https://edited.example/v1', apiKey: 'sk-edited-key', model: 'edited-model', verify: 'npm test', vision: false }),
      'utf8',
    )

    s.host.send({ cmd: 'load-config' })
    const loaded = await s.host.next('config-loaded')
    assert.equal(loaded.baseURL, 'https://edited.example/v1')
    assert.equal(loaded.model, 'edited-model')
    assert.equal(loaded.apiKeyMasked, 'sk-e…-key')
    assert.equal(loaded.hasKey, true)
    assert.equal(loaded.verify, 'npm test')
    assert.equal(loaded.vision, false)
  } finally {
    await s.close()
  }
})

test('host: task → 审批 → 放行 → 写入落盘 → turn-end', async () => {
  const s = await setup()
  try {
    const ready = await s.host.next('ready')
    assert.equal(ready.mode, 'guarded')
    assert.ok(String(ready.session).startsWith('s-'))

    s.host.send({ cmd: 'task', text: '创建 a.txt' })
    assert.equal((await s.host.next('turn-start')).text, '创建 a.txt')
    const call = await s.host.next('tool-start')
    assert.equal(call.name, 'write')
    assert.equal(call.summary, 'a.txt')

    const ap = await s.host.next('approval')
    assert.equal(ap.tool, 'write')
    s.host.send({ cmd: 'approve', reqId: ap.reqId, decision: 'allowed-once' })

    const end = await s.host.next('tool-end')
    assert.equal(end.ok, true)
    const turn = await s.host.next('turn-end')
    assert.equal(turn.reason, 'done')
    assert.equal(await readFile(join(s.root, 'a.txt'), 'utf8'), 'hello host\n')

    const usage = await s.host.next('usage')
    assert.ok(Number(usage.calls) >= 2)
  } finally {
    await s.close()
  }
})

test('host: 拒绝审批 → 不写入；read-only 档连审批都不弹', async () => {
  const s = await setup()
  try {
    await s.host.next('ready')
    s.host.send({ cmd: 'task', text: '创建 a.txt' })
    const ap = await s.host.next('approval')
    s.host.send({ cmd: 'approve', reqId: ap.reqId, decision: 'denied' })
    const end = await s.host.next('tool-end')
    assert.equal(end.ok, false)
    assert.match(String(end.error), /拒绝/)
    assert.equal(await readFile(join(s.root, 'a.txt'), 'utf8').catch(() => null), null)
    await s.host.next('turn-end')

    // 切到 read-only：策略在审批之前，所以不会再弹审批
    s.host.send({ cmd: 'mode', mode: 'read-only' })
    assert.equal((await s.host.next('mode')).mode, 'read-only')
    assert.equal(s.host.has('approval'), true, '之前那次 guarded 审批应该已经出现过')
  } finally {
    await s.close()
  }
})

test('host: 未知命令回 error，ping 回 pong，sessions 可列', async () => {
  const s = await setup()
  try {
    await s.host.next('ready')
    s.host.send({ cmd: 'ping' })
    await s.host.next('pong')
    s.host.send({ cmd: 'nonsense' })
    assert.match(String((await s.host.next('error')).message), /未知命令/)
    s.host.send({ cmd: 'list-sessions' })
    const list = await s.host.next('sessions')
    assert.ok(Array.isArray(list.items))
  } finally {
    await s.close()
  }
})
