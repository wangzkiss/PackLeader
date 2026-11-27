/**
 * 主机协议 e2e：真的起一个子进程，用 NDJSON 说话。
 * 这层是 GUI 的唯一接口，坏了窗口就全瞎，所以必须被测试覆盖。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:http'
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

  constructor(args: string[], extraEnv: Record<string, string> = {}) {
    this.child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOST, ...args], {
      // PL_PERF=off：测试起的 host 不要往用户真实的 perf 目录里写日志
      // extraEnv 用来把跑测试那台机器上的 PL_API_KEY / OPENAI_API_KEY 之类清成空串，
      // 否则「不传 --api-key」的测试会悄悄吃到开发机的环境变量
      env: { ...process.env, NO_COLOR: '1', PL_PERF: 'off', ...extraEnv },
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

/** 只回 /models 的假端点：验证「一次拉所有供应商」时的正常那一家 */
async function startModelServer(ids: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }))
      return
    }
    res.writeHead(404).end('not found')
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('假 /models 启动失败')
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    close: () => new Promise<void>((ok, fail) => server.close((e) => (e ? fail(e) : ok()))),
  }
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

test('host: use-model 切到另一家的模型，下一轮真的打到那家，且落盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-usemodel-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-usemodel-data-'))
  const a = await startFakeLlm([{ text: '甲家回答' }])
  const b = await startFakeLlm([{ text: '乙家回答' }])
  await writeFile(
    join(dataDir, 'config.json'),
    JSON.stringify({
      providers: [
        { id: 'p-a', name: '甲家', baseURL: a.url, apiKey: 'sk-a', model: 'a-1' },
        { id: 'p-b', name: '乙家', baseURL: b.url, apiKey: 'sk-b', model: 'b-1' },
      ],
      activeProvider: 'p-a',
    }),
    'utf8',
  )
  // 不传 --base-url/--api-key/--model：让 host 完全按 config.json 里的供应商列表走
  // （环境变量也清空，否则开发机上的 OPENAI_API_KEY 会让 host 跳过 config.json 里的那家）
  const host = new HostProc(['--cwd', root, '--data-dir', dataDir, '--mode', 'read-only'], {
    PL_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    OPENAI_API_KEY: '',
  })
  try {
    const ready = await host.next('ready')
    assert.equal(ready.model, 'a-1')
    const provs = ready.providers as Array<{ id: string; models: string[] }>
    assert.equal(provs.length, 2)
    assert.deepEqual(provs[0]?.models, ['a-1'], '没缓存过就退化成当前模型一项')

    host.send({ cmd: 'use-model', providerId: 'p-b', model: 'b-2' })
    const switched = await host.next('model')
    assert.equal(switched.model, 'b-2')
    assert.equal(switched.providerId, 'p-b')

    host.send({ cmd: 'task', text: '你好' })
    await host.next('turn-end')
    assert.equal(b.requests.length, 1, '应该打到乙家')
    assert.equal((b.requests[0] as Record<string, unknown>).model, 'b-2', '带的是刚选的那个模型')
    assert.equal(a.requests.length, 0, '不该再打甲家')

    const cfg = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as {
      activeProvider: string
      model: string
      baseURL: string
      providers: Array<{ id: string; models?: string[] }>
    }
    assert.equal(cfg.activeProvider, 'p-b')
    assert.equal(cfg.model, 'b-2')
    assert.equal(cfg.baseURL, b.url)
    assert.ok(cfg.providers.find((p) => p.id === 'p-b')?.models?.includes('b-2'), '选过的模型要进这家的列表')
  } finally {
    await host.close()
    await a.close()
    await b.close()
  }
})

test('host: 机器上有 OPENAI_API_KEY 时仍用 config.json 里的 Key（别拿别家的 Key 打界面配的端点）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-envkey-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-envkey-data-'))
  const llm = await startFakeLlm([{ text: '好' }])
  await writeFile(
    join(dataDir, 'config.json'),
    JSON.stringify({
      providers: [{ id: 'p-cfg', name: '配置里那家', baseURL: llm.url, apiKey: 'sk-cfg-key-1234', model: 'm-cfg' }],
      activeProvider: 'p-cfg',
    }),
    'utf8',
  )
  // 开发机装了别的工具时常有 OPENAI_API_KEY。以前它排在 config.json 前面，
  // 结果拿着别家的 Key 去打界面上配的端点，开局一发 401（界面上点一下设置、重读磁盘才好）。
  const host = new HostProc(['--cwd', root, '--data-dir', dataDir, '--mode', 'read-only'], {
    PL_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    OPENAI_API_KEY: 'sk-openai-env-9999',
  })
  try {
    const ready = await host.next('ready')
    assert.equal(ready.baseURL, llm.url, '端点和模型都该来自 config.json')
    assert.equal(ready.model, 'm-cfg')
    assert.equal(ready.apiKeyMasked, 'sk-c…1234', 'Key 用 config.json 里的那把')
    host.send({ cmd: 'task', text: '你好' })
    await host.next('turn-end')
    assert.equal(llm.requests.length, 1)
    assert.equal(llm.headers[0]?.authorization, 'Bearer sk-cfg-key-1234', '请求带的是 config.json 里的 Key')
  } finally {
    await host.close()
    await llm.close()
  }
})

test('host: config 一家可以存多个模型；界面没带 models 的那家沿用旧列表（别被保存抹掉）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-modelsave-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-modelsave-data-'))
  const base = 'https://models.example/v1'
  await writeFile(
    join(dataDir, 'config.json'),
    JSON.stringify({
      providers: [{ id: 'p-a', name: '甲家', baseURL: base, apiKey: 'sk-a', model: 'a-1', models: ['a-1', 'a-2'] }],
      activeProvider: 'p-a',
    }),
    'utf8',
  )
  const host = new HostProc(['--cwd', root, '--data-dir', dataDir, '--mode', 'read-only'], {
    PL_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    OPENAI_API_KEY: '',
  })
  try {
    await host.next('ready')
    // 1) 不带 models 保存（只是改了 Key）：这家的旧列表不能被抹成空
    host.send({
      cmd: 'config',
      providers: [{ id: 'p-a', name: '甲家', baseURL: base, apiKey: 'sk-a', model: 'a-1' }],
      activeProvider: 'p-a',
      baseURL: base,
      model: 'a-1',
    })
    const saved = await host.next('config')
    assert.deepEqual(
      (saved.providers as Array<{ models: string[] }>)[0]?.models,
      ['a-1', 'a-2'],
      '界面没带 models 时沿用旧列表',
    )

    // 2) 带上勾选的两个模型（换掉 a-2、加上 a-3）：整份落盘
    host.send({
      cmd: 'config',
      providers: [{ id: 'p-a', name: '甲家', baseURL: base, model: 'a-3', models: ['a-1', 'a-3'] }],
      activeProvider: 'p-a',
      baseURL: base,
      model: 'a-3',
    })
    const multi = await host.next('config')
    assert.deepEqual((multi.providers as Array<{ models: string[] }>)[0]?.models, ['a-1', 'a-3'])
    const cfg = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as {
      providers: Array<{ models?: string[]; model: string }>
      model: string
    }
    assert.deepEqual(cfg.providers[0]?.models, ['a-1', 'a-3'], '勾选的多个模型要落盘')
    assert.equal(cfg.model, 'a-3')
  } finally {
    await host.close()
  }
})

test('host: list-models all 并发拉所有供应商，一家连不上不影响别家，拉到的会缓存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-listmodels-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-listmodels-data-'))
  const good = await startModelServer(['g-1', 'g-2'])
  // 坏的一家：拿一个刚关掉的端口，连不上＝真实场景里那家端点挂了
  const dead = await startModelServer([])
  const deadUrl = dead.url
  await dead.close()
  await writeFile(
    join(dataDir, 'config.json'),
    JSON.stringify({
      providers: [
        { id: 'p-good', name: '好的一家', baseURL: good.url, apiKey: 'sk-g', model: 'g-1' },
        { id: 'p-bad', name: '坏的一家', baseURL: deadUrl, apiKey: 'sk-d', model: 'd-1' },
      ],
      activeProvider: 'p-good',
    }),
    'utf8',
  )
  const host = new HostProc(['--cwd', root, '--data-dir', dataDir, '--mode', 'read-only'])
  try {
    await host.next('ready')
    host.send({ cmd: 'list-models', all: true })
    const evt = await host.next('models', 30_000)
    const rows = evt.byProvider as Array<{ id: string; name: string; items: string[]; error?: string }>
    const goodRow = rows.find((r) => r.id === 'p-good')
    const badRow = rows.find((r) => r.id === 'p-bad')
    assert.ok(goodRow, '正常那家要在回包里')
    assert.ok(goodRow!.items.includes('g-1') && goodRow!.items.includes('g-2'), '拉到端点上的模型')
    assert.equal(goodRow!.error, undefined)
    assert.ok(badRow, '挂了的那家也要在回包里（只是带 error）')
    assert.ok(badRow!.error, '连不上要报出来')
    assert.deepEqual(badRow!.items, ['d-1'], '拉不到就用它自己的当前模型兜底，菜单不至于空着')

    const cfg = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as {
      providers: Array<{ id: string; models?: string[] }>
    }
    assert.ok(
      cfg.providers.find((p) => p.id === 'p-good')?.models?.includes('g-2'),
      '拉到的列表要缓存进 config.json，下次打开菜单不用再等网络',
    )
  } finally {
    await host.close()
    await good.close()
  }
})

test('host: 免鉴权的端点（不填 API Key）也能保存并用，请求不带 authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-nokey-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-nokey-data-'))
  const llm = await startFakeLlm([{ text: '本地服务不需要 Key' }])
  // 开发机上常有 PL_API_KEY / OPENAI_API_KEY：清空才测得到「真没 Key」这条路
  const host = new HostProc(
    ['--cwd', root, '--data-dir', dataDir, '--mode', 'read-only'],
    { PL_API_KEY: '', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '' },
  )
  try {
    await host.next('ready')
    // 界面点保存：这家只有端点，没有 apiKey
    host.send({
      cmd: 'config',
      providers: [{ id: 'p-local', name: '本地 llama', baseURL: llm.url, model: 'local-1' }],
      activeProvider: 'p-local',
      baseURL: llm.url,
      model: 'local-1',
      verify: '',
    })
    const saved = await host.next('config')
    assert.equal(saved.saved, true, '没 Key 也要能存下来，不能被校验挡住')
    assert.equal(saved.apiKeyMasked, '', '掩码是空的，界面据此知道这家没 Key')

    host.send({ cmd: 'task', text: '问一句' })
    await host.next('turn-end')
    assert.equal(llm.requests.length, 1)
    assert.equal((llm.requests[0] as Record<string, unknown>).model, 'local-1')
    assert.equal(llm.headers[0]?.authorization, undefined, '没 Key 就不该带一个空的 Bearer')

    const cfg = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as {
      apiKey?: string
      providers: Array<{ id: string; apiKey: string; model: string }>
    }
    assert.equal(cfg.providers[0]?.apiKey, '', '空 Key 原样落盘')
    assert.equal(cfg.apiKey, undefined, '顶层快照没有 Key 就不写这个字段')
    assert.equal(cfg.providers[0]?.model, 'local-1')
  } finally {
    await host.close()
    await llm.close()
  }
})
