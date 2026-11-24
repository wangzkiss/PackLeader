import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Audit } from '../src/core/audit.ts'
import { ApprovalBroker } from '../src/core/approval.ts'
import { Checkpoints } from '../src/core/checkpoint.ts'
import { Agent } from '../src/core/loop.ts'
import { Policy } from '../src/core/policy.ts'
import { Session } from '../src/core/session.ts'
import type { Mode } from '../src/core/types.ts'
import { OpenAiClient } from '../src/llm/openai.ts'
import { createDefaultTools } from '../src/tools/index.ts'
import { startFakeLlm, type ScriptStep } from './fake-llm.ts'

async function setup(steps: ScriptStep[], opts: { mode?: Mode; approval?: 'ask' | 'allow' | 'deny' } = {}) {
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
    assert.equal(second.tools.length, 7)
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
