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
import { Session } from '../src/core/session.ts'

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
    // 没在 config.json 里写超时：回报的是内置默认（首字节 120s / 空闲 180s / 整体 900s）
    assert.equal(loaded.firstByteSecs, 120)
    assert.equal(loaded.idleSecs, 180)
    assert.equal(loaded.requestSecs, 900)

    // 手改超时（长上下文 prefill 慢的网关）→ 不重启就作用到运行中的客户端
    await writeFile(join(s.dataDir, 'config.json'), JSON.stringify({ firstByteSecs: 240, idleSecs: 300 }), 'utf8')
    s.host.send({ cmd: 'load-config' })
    const reloaded = await s.host.next('config-loaded')
    assert.equal(reloaded.firstByteSecs, 240)
    assert.equal(reloaded.idleSecs, 300)
    assert.equal(reloaded.requestSecs, 900, '没写的字段回到默认，不粘着上一次的值')
    assert.equal(reloaded.baseURL, 'https://edited.example/v1', '只改了超时的文件不该把端点冲掉')
  } finally {
    await s.close()
  }
})

test('host: ready sends a question index and history-slice returns only the requested turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-history-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-history-data-'))
  const savedSession = await Session.create(dataDir, {
    cwd: root,
    model: 'demo-model',
    baseURL: 'http://127.0.0.1',
    mode: 'guarded',
    version: '0.1.0',
  })
  await savedSession.append({ kind: 'user/message', text: '定位慢查询' })
  await savedSession.append({ kind: 'assistant/message', text: '先检查索引', reasoning: '', toolCalls: [], ms: 10, finish: 'stop' })
  await savedSession.append({ kind: 'turn/start', turn: 1 })
  await savedSession.append({ kind: 'user/message', text: '然后检查缓存' })
  await savedSession.append({ kind: 'assistant/message', text: '检查缓存命中率', reasoning: '', toolCalls: [], ms: 10, finish: 'stop' })
  const llm = await startFakeLlm([{ text: '完成' }])
  const host = new HostProc([
    '--cwd', root,
    '--data-dir', dataDir,
    '--resume', savedSession.id,
    '--base-url', llm.url,
    '--api-key', 'sk-x',
    '--model', 'demo-model',
  ])
  try {
    const ready = await host.next('ready')
    assert.equal(ready.historyCount, 6)
    assert.equal(ready.events, undefined, 'ready must not transmit the full conversation')
    const questions = ready.questions as Array<{ eventIndex: number; text: string }>
    assert.deepEqual(questions.map((q) => ({ eventIndex: q.eventIndex, text: q.text })), [
      { eventIndex: 1, text: '定位慢查询' },
      { eventIndex: 4, text: '然后检查缓存' },
    ])

    host.send({ cmd: 'history-slice', session: savedSession.id, requestId: 1, mode: 'tail' })
    const slice = await host.next('history-slice')
    assert.equal(slice.requestId, 1)
    // tail 默认给最后一轮；会话里只有 2 轮，会一起给（最多 6 轮）
    assert.equal(slice.from, 1)
    assert.deepEqual((slice.events as Array<{ kind: string }>).map((event) => event.kind), [
      'user/message',
      'assistant/message',
      'turn/start',
      'user/message',
      'assistant/message',
    ])

    host.send({ cmd: 'history-slice', session: savedSession.id, requestId: 2, mode: 'around', target: 1 })
    const around = await host.next('history-slice')
    assert.equal(around.from, 1)
    assert.equal(around.jumpTo, 1)
    assert.deepEqual((around.events as Array<{ kind: string }>).map((event) => event.kind), ['user/message', 'assistant/message'])

    host.send({ cmd: 'history-slice', session: savedSession.id, requestId: 3, mode: 'before', cursor: 3 })
    const before = await host.next('history-slice')
    assert.equal(before.from, 1)
    assert.deepEqual((before.events as Array<{ kind: string }>).map((event) => event.kind), ['user/message', 'assistant/message'])
  } finally {
    await host.close()
    await llm.close()
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

    // 切的档要落进 config.json：界面显示「完全权限」而 host 还停在 guarded，
    // 就是因为以前这个命令根本没发出去，也不能靠重启把它找回来
    let savedMode = ''
    for (let i = 0; i < 100 && savedMode !== 'read-only'; i++) {
      try {
        savedMode = String((JSON.parse(await readFile(join(s.dataDir, 'config.json'), 'utf8')) as Record<string, unknown>).mode ?? '')
      } catch {
        savedMode = ''
      }
      if (savedMode !== 'read-only') await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(savedMode, 'read-only', '界面切的档要落进 config.json')
  } finally {
    await s.close()
  }
})

test('host: 命令行没指定 --mode 时，按 config.json 里记的档启动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-mode-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-mode-data-'))
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ mode: 'full' }), 'utf8')
  const llm = await startFakeLlm([{ text: 'ok' }])
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
    const ready = await host.next('ready')
    assert.equal(ready.mode, 'full', '上次切的档要接着用，不能让用户每次启动重新点一遍')
  } finally {
    await host.close()
    await llm.close()
  }
})

test('host: 删掉当前会话不会在列表里再冒出一个「新对话」', async () => {
  const s = await setup()
  try {
    const ready = await s.host.next('ready')
    const first = String(ready.session)
    // 空壳会话（还没发消息）本身就不该出现在列表里
    s.host.send({ cmd: 'list-sessions' })
    assert.deepEqual((await s.host.next('sessions')).items, [])

    s.host.send({ cmd: 'task', text: '创建 a.txt' })
    const ap = await s.host.next('approval')
    s.host.send({ cmd: 'approve', reqId: ap.reqId, decision: 'allowed-once' })
    await s.host.next('turn-end')
    s.host.send({ cmd: 'list-sessions' })
    const before = (await s.host.next('sessions')).items as Array<{ id: string }>
    assert.deepEqual(before.map((it) => it.id), [first], '发过消息的会话才进列表')

    // 删掉当前会话：host 会换一个新的空会话接着用，但它不该出现在列表里
    s.host.send({ cmd: 'delete-session', id: first })
    assert.notEqual(String((await s.host.next('ready')).session), first)
    const after = await s.host.next('sessions')
    assert.deepEqual(after.items, [], '删掉之后列表应该真的空了，而不是又冒出一个新对话')
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
