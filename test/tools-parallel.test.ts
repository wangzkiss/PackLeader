/**
 * 工具批次的并发策略：只读工具可以同时跑，写类工具必须串行；
 * 不管谁先跑完，落进历史的 tool 结果都要保持模型给的顺序。
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Audit } from '../src/core/audit.ts'
import { ApprovalBroker } from '../src/core/approval.ts'
import { Checkpoints } from '../src/core/checkpoint.ts'
import { Agent } from '../src/core/loop.ts'
import { Policy } from '../src/core/policy.ts'
import { Session } from '../src/core/session.ts'
import { ToolRegistry, type Tool } from '../src/core/tools.ts'
import type { Permission } from '../src/core/types.ts'
import { OpenAiClient } from '../src/llm/openai.ts'
import { startFakeLlm, type ScriptStep } from './fake-llm.ts'

interface Probe {
  log: string[]
  peak: number
  /** 当前正在跑的数量（三个工具共享同一个计数器，各管各的就测不出重叠） */
  active: number
}

/** 探针工具：记录开始/结束，用来观察有没有真的重叠执行 */
function probeTool(name: string, delayMs: number, permission: Permission, state: Probe): Tool {
  return {
    name,
    description: `probe ${name}`,
    parameters: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] },
    permission,
    async run(_ctx, args) {
      state.active++
      state.peak = Math.max(state.peak, state.active)
      state.log.push(`start:${String(args.tag)}`)
      await new Promise((r) => setTimeout(r, delayMs))
      state.log.push(`end:${String(args.tag)}`)
      state.active--
      return { content: `probe ${String(args.tag)}` }
    },
  }
}

async function setup(steps: ScriptStep[], extra: Tool[]) {
  const root = await mkdtemp(join(tmpdir(), 'pl-par-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-par-data-'))
  const llmServer = await startFakeLlm(steps)
  const audit = await Audit.open(join(dataDir, 'audit.sqlite'))
  const session = await Session.create(dataDir, {
    cwd: root,
    model: 'test-model',
    baseURL: llmServer.url,
    mode: 'full',
    version: '0.1.0',
  })
  const tools = new ToolRegistry()
  for (const t of extra) tools.register(t)
  const agent = new Agent({
    session,
    llm: new OpenAiClient({ baseURL: llmServer.url, apiKey: 'sk-test', model: 'test-model' }),
    tools,
    policy: new Policy(root, 'full'),
    broker: new ApprovalBroker('allow'),
    checkpoints: new Checkpoints(join(dataDir, 'ckpt')),
    audit,
    dataDir,
    verify: null,
    maxSteps: 5,
  })
  return {
    root,
    agent,
    session,
    llmServer,
    close: async () => {
      audit.close()
      await llmServer.close()
    },
  }
}

test('三个只读工具同时跑：执行区间重叠，结果仍按原始顺序入历史', async () => {
  const state: Probe = { log: [], peak: 0, active: 0 }
  // 越靠前的越慢，跑完顺序会是 3 → 2 → 1
  const tools = [
    probeTool('probe_a', 120, 'read', state),
    probeTool('probe_b', 60, 'read', state),
    probeTool('probe_c', 20, 'read', state),
  ]
  const s = await setup(
    [
      {
        toolCalls: [
          { id: 'call_a', name: 'probe_a', args: { tag: 'A' } },
          { id: 'call_b', name: 'probe_b', args: { tag: 'B' } },
          { id: 'call_c', name: 'probe_c', args: { tag: 'C' } },
        ],
      },
      { text: '都跑完了' },
    ],
    tools,
  )
  try {
    const result = await s.agent.runTurn('并行跑三个探针')
    assert.equal(result.reason, 'done')
    assert.equal(result.toolCalls, 3)
    assert.equal(state.peak, 3, `只读工具应该同时跑，实际最多同时 ${state.peak} 个：${state.log.join(' ')}`)
    assert.deepEqual(state.log.slice(0, 3).sort(), ['start:A', 'start:B', 'start:C'], '三个都该先开始再结束')

    // 落进 session 的 tool/result 顺序必须是模型给的 A、B、C
    const ids = s.session.events
      .filter((e) => e.kind === 'tool/result')
      .map((e) => (e as unknown as { callId: string }).callId)
    assert.deepEqual(ids, ['call_a', 'call_b', 'call_c'])

    // 下一次请求里 tool 消息的顺序也要与 tool_calls 对齐
    const next = s.llmServer.requests[1]!
    const toolMsgs = next.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id)
    assert.deepEqual(toolMsgs, ['call_a', 'call_b', 'call_c'])
  } finally {
    await s.close()
  }
})

test('写类工具串行：两个写探针不重叠', async () => {
  const state: Probe = { log: [], peak: 0, active: 0 }
  const tools = [probeTool('probe_w1', 40, 'write', state), probeTool('probe_w2', 40, 'write', state)]
  const s = await setup(
    [
      {
        toolCalls: [
          { id: 'call_w1', name: 'probe_w1', args: { tag: 'W1' } },
          { id: 'call_w2', name: 'probe_w2', args: { tag: 'W2' } },
        ],
      },
      { text: '写完了' },
    ],
    tools,
  )
  try {
    const result = await s.agent.runTurn('串行写两个')
    assert.equal(result.reason, 'done')
    assert.equal(state.peak, 1, `写类工具不该并行，实际最多同时 ${state.peak} 个`)
    assert.deepEqual(state.log, ['start:W1', 'end:W1', 'start:W2', 'end:W2'])
  } finally {
    await s.close()
  }
})

test('只读和写混在一起：只读的并发、写的各自独占', async () => {
  const state: Probe = { log: [], peak: 0, active: 0 }
  const tools = [
    probeTool('probe_r1', 60, 'read', state),
    probeTool('probe_r2', 60, 'read', state),
    probeTool('probe_w1', 40, 'write', state),
  ]
  const s = await setup(
    [
      {
        toolCalls: [
          { id: 'call_w1', name: 'probe_w1', args: { tag: 'W1' } },
          { id: 'call_r1', name: 'probe_r1', args: { tag: 'R1' } },
          { id: 'call_r2', name: 'probe_r2', args: { tag: 'R2' } },
        ],
      },
      { text: '好' },
    ],
    tools,
  )
  try {
    const result = await s.agent.runTurn('混合跑')
    assert.equal(result.reason, 'done')
    // 两个读重叠，写不与任何东西重叠：峰值 2 就够了，但写不能在别人跑的时候开始
    assert.equal(state.peak, 2, `读写混合时并发峰值应为 2，实际 ${state.peak}`)
    const wStart = state.log.indexOf('start:W1')
    const wEnd = state.log.indexOf('end:W1')
    assert.ok(wStart >= 0 && wEnd > wStart, `缺少写的开始/结束：${state.log.join(' ')}`)
    // 写执行期间不能插进任何别的工具（只读也不行）
    assert.deepEqual(state.log.slice(wStart, wEnd + 1), ['start:W1', 'end:W1'], `写不独占：${state.log.join(' ')}`)
    const ids = s.session.events
      .filter((e) => e.kind === 'tool/result')
      .map((e) => (e as unknown as { callId: string }).callId)
    assert.deepEqual(ids, ['call_w1', 'call_r1', 'call_r2'])
  } finally {
    await s.close()
  }
})
