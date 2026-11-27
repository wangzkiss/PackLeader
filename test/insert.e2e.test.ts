/**
 * 插队（insert）e2e：一轮还在跑的时候用户补一句话，
 * 这句话要落进当前会话、模型下一步就能看到，而不是另起一轮。
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

  count(type: string): number {
    return this.seen.filter((e) => e.type === type).length
  }

  async close(): Promise<void> {
    this.child.stdin.end()
    await new Promise((r) => this.child.on('close', r))
  }
}

test('insert: 跑着的时候插话，模型下一步能看到，且不另起一轮', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-insert-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-insert-data-'))
  const llm = await startFakeLlm([
    { toolCalls: [{ id: 'c1', name: 'write', args: { path: 'a.txt', content: 'hello\n' } }] },
    { text: '两件事都做了' },
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
    await host.next('ready')
    host.send({ cmd: 'task', text: '创建 a.txt' })
    await host.next('turn-start')

    // 这一轮还在跑：直接插一句
    host.send({ cmd: 'insert', text: '顺便在 a.txt 里加一行' })
    const notice = await host.next('notice')
    assert.match(String(notice.text), /已插话/)

    const ap = await host.next('approval')
    host.send({ cmd: 'approve', reqId: ap.reqId, decision: 'allowed-once' })
    await host.next('tool-end')
    const turn = await host.next('turn-end')
    assert.equal(turn.reason, 'done')

    // 插话没有另起一轮
    assert.equal(host.count('turn-start'), 1, '插话不该再开一轮')

    // 模型第二次请求（也就是下一步）里必须带着那句话
    assert.ok(llm.requests.length >= 2, `模型至少被调两次，实际 ${llm.requests.length}`)
    const last = JSON.stringify(llm.requests[llm.requests.length - 1])
    assert.match(last, /顺便在 a\.txt 里加一行/)

    // 落进会话文件，重开也还在
    const sessionId = String(host.seen.find((e) => e.type === 'ready')!.session)
    const raw = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(dataDir, 'sessions', sessionId, 'session.jsonl'), 'utf8'),
    )
    assert.match(raw, /顺便在 a\.txt 里加一行/)
  } finally {
    await host.close()
    await llm.close()
  }
})

test('insert: 插话落在工具执行期间，也要排在这批工具结果之后（否则服务端整批判无效）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-insert-mid-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-insert-mid-data-'))
  // 用一条会卡住的命令撑开「tool/call 已写入、tool/result 还没写」的窗口，
  // 让插话正好落在这段里——这正是用户实际遇到的情况。
  const llm = await startFakeLlm([
    {
      toolCalls: [
        {
          id: 'c1',
          name: 'shell',
          args: { command: 'node -e "setTimeout(()=>{},600)"', timeout: 30000 },
        },
      ],
    },
    { text: '看到了插话' },
  ])
  const host = new HostProc([
    '--cwd', root,
    '--data-dir', dataDir,
    '--base-url', llm.url,
    '--api-key', 'sk-x',
    '--model', 'demo-model',
  ])

  try {
    await host.next('ready')
    host.send({ cmd: 'task', text: '跑个慢命令' })
    await host.next('turn-start')

    const ap = await host.next('approval')
    host.send({ cmd: 'approve', reqId: ap.reqId, decision: 'allowed-once' })

    // 工具已经开始执行（tool-start 已到、tool-end 还没来）：此刻插话
    await host.next('tool-start')
    host.send({ cmd: 'insert', text: '别跑完，直接换计划' })
    assert.match(String((await host.next('notice')).text), /已插话/)

    await host.next('tool-end')
    assert.equal((await host.next('turn-end')).reason, 'done')

    // 关键断言：第二步请求里，插话那条 user 消息必须排在那条 tool 结果之后，
    // 否则 assistant(tool_calls) 与 tool 之间夹了 user，整批会被判无效、插话等于没发。
    const msgs = (llm.requests[llm.requests.length - 1] as { messages: Array<{ role: string; content: string }> }).messages
    const userIdx = msgs.findIndex((m) => m.role === 'user' && m.content.includes('别跑完，直接换计划'))
    const toolIdx = msgs.findIndex((m) => m.role === 'tool')
    assert.ok(userIdx >= 0, '插话必须出现在请求里')
    assert.ok(toolIdx >= 0, 'tool 结果必须还在')
    assert.ok(userIdx > toolIdx, `插话应排在 tool 结果之后，实际 user@${userIdx} tool@${toolIdx}`)
    // 第二条 assistant(tool_calls) 与其 tool 结果之间不许夹 user
    const callIdx = msgs.findIndex((m) => m.role === 'assistant' && (m as { toolCalls?: unknown[] }).toolCalls?.length)
    if (callIdx >= 0) {
      const between = msgs.slice(callIdx + 1, toolIdx)
      assert.equal(between.filter((m) => m.role === 'user').length, 0, 'tool_calls 与 tool 结果之间不该夹 user 消息')
    }
  } finally {
    await host.close()
    await llm.close()
  }
})

test('insert: 插话也能带附件——图片和文件的处理跟正常发一轮一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-insert3-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-insert3-data-'))
  // 附件里放一个文本文件，看它会不会被内联进下一步的模型请求
  const notePath = join(root, 'note.txt')
  await import('node:fs/promises').then((fs) => fs.writeFile(notePath, '这条来自附件\n', 'utf8'))
  const llm = await startFakeLlm([
    { toolCalls: [{ id: 'c1', name: 'write', args: { path: 'a.txt', content: 'hello\n' } }] },
    { text: '收到附件' },
  ])
  const host = new HostProc([
    '--cwd', root,
    '--data-dir', dataDir,
    '--base-url', llm.url,
    '--api-key', 'sk-x',
    '--model', 'demo-model',
  ])

  try {
    await host.next('ready')
    const sessionId = String(host.seen.find((e) => e.type === 'ready')!.session)
    host.send({ cmd: 'task', text: '创建 a.txt' })
    await host.next('turn-start')

    // 跑着的时候带附件插一句
    host.send({ cmd: 'insert', text: '顺便看看这个文件', files: [notePath] })
    const notice = await host.next('notice')
    assert.match(String(notice.text), /已插话（带 1 个附件）/)

    const ap = await host.next('approval')
    host.send({ cmd: 'approve', reqId: ap.reqId, decision: 'allowed-once' })
    await host.next('tool-end')
    assert.equal((await host.next('turn-end')).reason, 'done')
    assert.equal(host.count('turn-start'), 1, '插话带附件也不该另开一轮')

    // 模型下一步的请求里要有附件内容（文本类走内联），并且指明入库后的目录
    const last = JSON.stringify(llm.requests[llm.requests.length - 1])
    assert.match(last, /这条来自附件/)
    assert.ok(last.includes('files') && last.includes(sessionId), '请求里要带上入库目录和这一步的会话 id')

    // 会话里那条 user/message 带着 files（历史回放才能显出附件卡片）
    const raw = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(dataDir, 'sessions', sessionId, 'session.jsonl'), 'utf8'),
    )
    const inserted = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind?: string; files?: Array<{ name: string; path: string }> })
      .find((e) => e.kind === 'user/message' && JSON.stringify(e).includes('顺便看看这个文件'))
    assert.deepEqual(inserted?.files?.map((f) => f.name), ['note.txt'])
    assert.ok(String(inserted?.files?.[0]?.path).includes(sessionId), '附件要拷进这个会话的 files 目录')
  } finally {
    await host.close()
    await llm.close()
  }
})

test('insert: 没在跑的时候发 insert，等同于正常发一轮', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-insert2-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-insert2-data-'))
  const llm = await startFakeLlm([{ text: '在' }])
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
    await host.next('ready')
    host.send({ cmd: 'insert', text: '你好' })
    assert.equal((await host.next('turn-start')).text, '你好')
    const turn = await host.next('turn-end')
    assert.equal(turn.reason, 'done')
    assert.doesNotMatch(JSON.stringify(host.seen), /已插话/)
  } finally {
    await host.close()
    await llm.close()
  }
})
