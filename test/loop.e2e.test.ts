import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Audit } from '../src/core/audit.ts'
import { ApprovalBroker } from '../src/core/approval.ts'
import { Checkpoints } from '../src/core/checkpoint.ts'
import { Agent, type Renderer } from '../src/core/loop.ts'
import { Policy } from '../src/core/policy.ts'
import { Session } from '../src/core/session.ts'
import type { Mode } from '../src/core/types.ts'
import { OpenAiClient } from '../src/llm/openai.ts'
import { createDefaultTools } from '../src/tools/index.ts'
import { startFakeLlm, type ScriptStep } from './fake-llm.ts'

async function setup(
  steps: ScriptStep[],
  opts: { mode?: Mode; approval?: 'ask' | 'allow' | 'deny'; renderer?: Renderer } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'pl-e2e-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-data-'))
  const llmServer = await startFakeLlm(steps)
  const audit = await Audit.open(join(dataDir, 'audit.sqlite'))
  const session = await Session.create(dataDir, {
    cwd: root,
    model: 'test-model',
    baseURL: llmServer.url,
    mode: opts.mode ?? 'guarded',
    version: '0.1.0',
  })
  const agent = new Agent({
    session,
    llm: new OpenAiClient({ baseURL: llmServer.url, apiKey: 'sk-test', model: 'test-model' }),
    tools: createDefaultTools({ root }),
    policy: new Policy(root, opts.mode ?? 'guarded'),
    broker: new ApprovalBroker(opts.approval ?? 'allow'),
    checkpoints: new Checkpoints(join(dataDir, 'ckpt')),
    audit,
    dataDir,
    ...(opts.renderer ? { renderer: opts.renderer } : {}),
  })
  const close = async () => {
    audit.close()
    await llmServer.close()
  }
  return { root, dataDir, agent, audit, session, llmServer, close }
}

test('e2e: 模型调用工具 → 结果入历史 → 最终答复', async () => {
  const s = await setup(
    [
      { reasoning: '先写文件', toolCalls: [{ id: 'call_w1', name: 'write', args: { path: 'notes/a.txt', content: 'hello world' } }] },
      { text: '已写入 notes/a.txt' },
    ],
    { mode: 'guarded', approval: 'allow' },
  )
  try {
    const result = await s.agent.runTurn('把 hello world 写到 notes/a.txt')
    assert.equal(result.reason, 'done')
    assert.equal(result.toolCalls, 1)
    assert.equal(result.steps, 2)
    assert.equal(result.text, '已写入 notes/a.txt')

    assert.equal(await readFile(join(s.root, 'notes/a.txt'), 'utf8'), 'hello world')

    const kinds = s.session.events.map((e) => e.kind)
    assert.deepEqual(kinds.slice(0, 4), ['session/start', 'turn/start', 'user/message', 'step/start'])
    assert.ok(kinds.includes('tool/call'))
    assert.ok(kinds.includes('tool/result'))
    assert.equal(kinds[kinds.length - 1], 'turn/end')

    // 第二次请求必须带上 assistant 的 tool_calls 与 tool 结果
    const second = s.llmServer.requests[1]!
    assert.ok(second.messages.some((m: any) => m.role === 'assistant' && m.tool_calls?.length))
    assert.ok(second.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call_w1'))
    // 工具集扩过（list/find/outline/logtail… 陆续加），这里断言「该有的都在、名字不重复」，
    // 而不是把数量写死 —— 数量写死会让每次加工具都要来改这一行
    const toolNames: string[] = second.tools.map((t: any) => t.function?.name ?? t.name)
    for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'shell', 'list', 'find', 'outline', 'logtail', 'netprobe']) {
      assert.ok(toolNames.includes(name), `发给模型的 schema 里缺 ${name}`)
    }
    assert.equal(new Set(toolNames).size, toolNames.length, '工具名不该重复')
    assert.equal(second.model, 'test-model')

    // 审计
    const rows = s.audit.queryToolCalls({ limit: 10 })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.tool, 'write')
    assert.equal(rows[0]!.status, 'done')
    assert.equal(Number(rows[0]!.ok), 1)
    assert.equal(s.audit.queryLlmCalls({ limit: 10 }).length, 2)
    const cost = s.audit.cost()
    assert.equal(cost.calls, 2)
    assert.equal(cost.prompt, 200)
  } finally {
    await s.close()
  }
})

test('e2e: 拒绝审批 → 工具不执行、文件不存在、审计留痕', async () => {
  const s = await setup(
    [
      { toolCalls: [{ name: 'write', args: { path: 'x.txt', content: 'nope' } }] },
      { text: '好的，不动文件' },
    ],
    { mode: 'guarded', approval: 'deny' },
  )
  try {
    const r = await s.agent.runTurn('写个文件')
    assert.equal(r.reason, 'done')
    await assert.rejects(() => stat(join(s.root, 'x.txt')))

    const rows = s.audit.queryToolCalls({ limit: 5 })
    assert.equal(rows[0]!.decision, 'denied')
    assert.equal(rows[0]!.status, 'denied')
    // 模型看到的是一条失败结果，而不是「悄悄跳过」
    const toolMsg = s.session.deriveMessages().find((m) => m.role === 'tool')!
    assert.match(toolMsg.content, /已拒绝/)
  } finally {
    await s.close()
  }
})

test('e2e: read-only 档即使 --yes 也写不进去', async () => {
  const s = await setup(
    [{ toolCalls: [{ name: 'write', args: { path: 'y.txt', content: 'x' } }] }, { text: '被拒了' }],
    { mode: 'read-only', approval: 'allow' },
  )
  try {
    await s.agent.runTurn('写文件')
    await assert.rejects(() => stat(join(s.root, 'y.txt')))
    const row = s.audit.queryToolCalls({ limit: 1 })[0]!
    assert.equal(row.decision, 'denied')
    assert.match(String(row.error), /read-only/)
  } finally {
    await s.close()
  }
})

test('e2e: ask 但没有审批通道 → unavailable（fail-closed）', async () => {
  const s = await setup(
    [{ toolCalls: [{ name: 'write', args: { path: 'z.txt', content: 'x' } }] }, { text: '写不了' }],
    { mode: 'guarded', approval: 'ask' },
  )
  try {
    await s.agent.runTurn('写文件')
    await assert.rejects(() => stat(join(s.root, 'z.txt')))
    const row = s.audit.queryToolCalls({ limit: 1 })[0]!
    assert.equal(row.decision, 'unavailable')
    assert.match(String(row.error), /审批通道/)
  } finally {
    await s.close()
  }
})

test('e2e: 模型编出不存在的工具，也进审计（unknown-tool）', async () => {
  const s = await setup(
    [{ toolCalls: [{ name: 'delete_everything', args: { path: '/' } }] }, { text: '没有这个工具' }],
    { mode: 'guarded', approval: 'allow' },
  )
  try {
    const r = await s.agent.runTurn('删库')
    assert.equal(r.reason, 'done')
    const row = s.audit.queryToolCalls({ limit: 1 })[0]!
    assert.equal(row.tool, 'delete_everything')
    assert.equal(row.decision, 'unknown-tool')
    assert.equal(row.status, 'failed')
    const toolMsg = s.session.deriveMessages().find((m) => m.role === 'tool')!
    assert.match(toolMsg.content, /没有名为 delete_everything 的工具/)
  } finally {
    await s.close()
  }
})

test('e2e: 到步数上限会强制收尾（不给工具，逼出答案）', async () => {
  const notices: string[] = []
  const s = await setup(
    [
      { toolCalls: [{ name: 'read', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'read', args: { path: 'a.txt' } }] },
      { text: '基于已读到的内容，结论是……' },
    ],
    { mode: 'read-only', approval: 'allow', renderer: { onNotice: (t) => notices.push(t) } },
  )
  try {
    const agent = s.agent
    // @ts-expect-error 测试里直接调窄 maxSteps
    agent.opts.maxSteps = 2
    const r = await agent.runTurn('读一下 a.txt')
    assert.equal(r.reason, 'max-steps')
    assert.match(r.text, /结论/)
    // 收尾那次请求不带工具
    const last = s.llmServer.requests.at(-1)!
    assert.equal(last.tools, undefined)
    assert.ok(last.messages.at(-1).content.includes('步数已达上限'))
    // 到上限只提示一次（不再另发一条「本轮停止」）
    assert.equal(notices.filter((t) => t.includes('步数上限')).length, 1, '到步数上限只该提示一次')
    assert.match(notices.find((t) => t.includes('步数上限'))!, /转入收尾/)
  } finally {
    await s.close()
  }
})

test('e2e: 预算将尽时每步提醒还剩几步，提醒只进请求、不进历史', async () => {
  const four = Array.from({ length: 4 }, () => ({ toolCalls: [{ name: 'read', args: { path: 'a.txt' } }] }))
  const s = await setup([...four, { text: '读完了' }], { mode: 'read-only', approval: 'allow' })
  try {
    // maxSteps=8 → 剩 5 步起提醒：第 3 步（剩 5）与第 4 步（剩 4）带提醒
    // @ts-expect-error 测试里直接调窄 maxSteps
    s.agent.opts.maxSteps = 8
    const r = await s.agent.runTurn('把 a.txt 读四遍')
    assert.equal(r.reason, 'done')
    const tail = (i: number) => String(s.llmServer.requests[i]!.messages.at(-1).content ?? '')
    assert.ok(!tail(0).includes('还剩'), '预算充足时不该提醒')
    assert.match(tail(3), /还剩 4 步/)
    assert.match(tail(3), /开始收尾|必须收尾/)
    // 提醒是临时插进请求的，不落会话历史（回放干净）
    const inHistory = s.session.events.filter(
      (e) => e.kind === 'user/message' && typeof (e as { text?: string }).text === 'string' && (e as { text: string }).text.includes('还剩'),
    )
    assert.equal(inHistory.length, 0)
  } finally {
    await s.close()
  }
})

test('e2e: 两轮编辑后 undo 回到第一轮内容', async () => {
  const s = await setup(
    [
      { toolCalls: [{ name: 'write', args: { path: 'f.txt', content: 'v1' } }] },
      { text: 'ok' },
      { toolCalls: [{ name: 'edit', args: { path: 'f.txt', old: 'v1', new: 'v2' } }] },
      { text: 'ok2' },
    ],
    { mode: 'guarded', approval: 'allow' },
  )
  try {
    await s.agent.runTurn('创建 f.txt')
    assert.equal(await readFile(join(s.root, 'f.txt'), 'utf8'), 'v1')

    await s.agent.runTurn('改成 v2')
    assert.equal(await readFile(join(s.root, 'f.txt'), 'utf8'), 'v2')

    const ck = new Checkpoints(join(s.dataDir, 'ckpt'))
    const r = await ck.undo(s.session.id, 2)
    assert.deepEqual(r.restored, [join(s.root, 'f.txt')])
    assert.equal(await readFile(join(s.root, 'f.txt'), 'utf8'), 'v1')
  } finally {
    await s.close()
  }
})

test('e2e: guarded 下 move 的 to 越界被拒（不能借第一个 target 混过去）', async () => {
  // 源在 workspace 内、目标在 workspace 外：早先 gate 只看 targets[0]，整条会放行
  const outsideDir = await mkdtemp(join(tmpdir(), 'pl-outside-'))
  const s = await setup(
    [
      { toolCalls: [{ id: 'call_m1', name: 'move', args: { from: 'a.txt', to: join(outsideDir, 'stolen.txt') } }] },
      { text: '被拒了' },
    ],
    { mode: 'guarded', approval: 'allow' },
  )
  try {
    await writeFile(join(s.root, 'a.txt'), 'keep me', 'utf8')
    const r = await s.agent.runTurn('把 a.txt 挪到外面去')
    assert.equal(r.reason, 'done')

    // 源文件没动，目标没出现
    assert.equal(await readFile(join(s.root, 'a.txt'), 'utf8'), 'keep me')
    await assert.rejects(() => stat(join(outsideDir, 'stolen.txt')))

    // 拒绝原因要点出越界的那个路径，而不是含糊的「不允许」
    const row = s.audit.queryToolCalls({ limit: 1 })[0]!
    assert.equal(row.decision, 'denied')
    assert.match(String(row.error), /越界/)
    assert.match(String(row.error), /stolen\.txt/)
  } finally {
    await s.close()
  }
})

test('e2e: 工具输出远超上限时按 64KB 预算截断（不是只裁 15%）', async () => {
  const s = await setup(
    [
      { toolCalls: [{ name: 'shell', args: { command: `node -e "process.stdout.write('x'.repeat(300*1024))"` } }] },
      { text: 'done' },
    ],
    { mode: 'full', approval: 'allow' },
  )
  try {
    await s.agent.runTurn('吐一大段输出')
    const res = s.session.events.find((e) => e.kind === 'tool/result') as
      | { content?: string; truncated?: boolean }
      | undefined
    assert.ok(res, '要有 tool/result')
    const bytes = Buffer.byteLength(String(res.content), 'utf8')
    assert.equal(res.truncated, true)
    assert.ok(bytes < 90 * 1024, `截断后 ${bytes} 字节，应回到 64KB 量级而不是原内容的 85%`)
    assert.match(String(res.content), /省略/)
  } finally {
    await s.close()
  }
})

test('e2e: 一字不差的重复调用不再整段回灌输出', async () => {
  const big = `node -e "process.stdout.write('y'.repeat(4000))"`
  const s = await setup(
    [
      { toolCalls: [{ name: 'shell', args: { command: big } }] },
      { toolCalls: [{ name: 'shell', args: { command: big } }] },
      { text: 'done' },
    ],
    { mode: 'full', approval: 'allow' },
  )
  try {
    await s.agent.runTurn('同一条命令跑两次')
    const results = s.session.events.filter((e) => e.kind === 'tool/result') as Array<{
      content?: string
      ok?: boolean
    }>
    assert.equal(results.length, 2)
    assert.doesNotMatch(String(results[0]!.content), /完全相同/, '第一次不该带重复提示')
    const dup = String(results[1]!.content)
    assert.match(dup, /完全相同/)
    assert.match(dup, /正文已省略/)
    assert.ok(dup.length < 400, `重复结果应被压到一两百字，实际 ${dup.length}`)
  } finally {
    await s.close()
  }
})

test('e2e: 系统提示要求思考过程用中文', async () => {
  const s = await setup([{ reasoning: '先想一想', text: '好' }])
  try {
    await s.agent.runTurn('随便说一句')
    const sys = s.llmServer.requests[0]!.messages.find((m: Record<string, any>) => m.role === 'system')
    assert.ok(sys, '请求里要有 system 消息')
    assert.match(String(sys.content), /思考过程一律用中文/)
  } finally {
    await s.close()
  }
})
