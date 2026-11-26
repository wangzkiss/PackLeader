/**
 * 一轮时间线的状态流转：思考中 → 工具执行中 → 回答 → 完成。
 * 界面那条时间线的数字（N 次工具调用、fs.read ×9、共 8.4s）都从这里来，
 * 所以这里钉住三件事：计数实时、耗时合计、折叠后仍然完整。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TurnTimeline, foldEvents, formatClock, formatToolSecs, PREVIEW_CHARS } from '../src/core/timeline.ts'
import type { SessionEvent } from '../src/core/events.ts'

test('阶段 1：思考流式累加，工具逐步追加并处于执行中', () => {
  const tx = new TurnTimeline(1_000)

  // 思考按帧到达：一段完整的思考块，不是每帧一块
  tx.reason('先看 host.ts')
  tx.reason(' 里 tool-end 带了什么')
  tx.closeThought(1_800)
  assert.equal(tx.thoughts.length, 1)
  assert.equal(tx.thoughts[0].text, '先看 host.ts 里 tool-end 带了什么')
  assert.equal(tx.thoughts[0].ms, 1_800)
  assert.equal(tx.phase, 'thinking')

  // 一步里三个并行调用：都先是「执行中」
  tx.toolStart({ id: 'c1', name: 'fs.read', args: { path: 'src/host.ts' } }, 'src/host.ts')
  tx.toolStart({ id: 'c2', name: 'fs.grep', args: { pattern: 'tool-end' } }, 'tool-end')
  tx.toolStart({ id: 'c3', name: 'fs.read', args: { path: 'src/cli.ts' } }, 'src/cli.ts')
  assert.equal(tx.phase, 'tools')
  assert.deepEqual(tx.tools.map((t) => t.state), ['running', 'running', 'running'])
  // 进行中也要报数：界面上组头一开始就是「3 次工具调用」
  assert.deepEqual(tx.stats().byName, [
    { name: 'fs.read', count: 2 },
    { name: 'fs.grep', count: 1 },
  ])
  assert.equal(tx.stats().ms, 0)
})

test('阶段 2：调用陆续完成，统计与耗时实时更新，失败单独计数', () => {
  const tx = new TurnTimeline(0)
  tx.toolStart({ id: 'a', name: 'fs.read', args: {} }, 'src/host.ts')
  tx.toolStart({ id: 'b', name: 'fs.grep', args: {} }, 'config.json')
  tx.toolStart({ id: 'c', name: 'fs.edit', args: {} }, 'src/host.ts')

  tx.toolEnd('a', { ok: true, ms: 12, content: 'export const x = 1' })
  assert.equal(tx.stats().ms, 12)
  assert.equal(tx.tools[0].state, 'done')
  assert.equal(tx.tools[0].preview, 'export const x = 1')
  // 结果只留开头一段，展开才看得到、但不会把界面撑爆
  assert.ok(tx.tools[0].preview.length <= PREVIEW_CHARS)

  tx.toolEnd('b', { ok: false, ms: 30, error: 'ENOENT: 找不到 config.json' })
  const s = tx.stats()
  assert.equal(s.tools, 3)
  assert.equal(s.failed, 1)
  assert.equal(s.ms, 42)
  assert.equal(tx.tools[1].state, 'failed')
  assert.match(String(tx.tools[1].error), /ENOENT/)

  // 调用结果回来时状态词落回「思考中」，下一段思考接着开新块
  assert.equal(tx.phase, 'thinking')
  tx.toolEnd('c', { ok: true, ms: 8, content: 'ok' })
  assert.equal(tx.stats().ms, 50)
  assert.deepEqual(tx.stats().byName, [
    { name: 'fs.edit', count: 1 },
    { name: 'fs.grep', count: 1 },
    { name: 'fs.read', count: 1 },
  ])
})

test('阶段 3：一轮结束定格，折叠只影响展示不影响数据', () => {
  const tx = new TurnTimeline(0)
  tx.reason('想一下')
  tx.closeThought(400)
  tx.toolStart({ id: 'a', name: 'shell', args: { cmd: 'npm test' } }, 'npm test')
  tx.toolEnd('a', { ok: true, ms: 2_500, content: '143 passing' })
  tx.reason('测试全绿')
  tx.answer()
  assert.equal(tx.phase, 'answering')
  tx.end(91_000)

  assert.equal(tx.phase, 'done')
  assert.equal(tx.elapsed, 91_000)
  // 结束时还开着的那段思考要把耗时补上，不能留 0
  assert.equal(tx.thoughts[1].ms, 91_000)
  assert.equal(tx.stats().ms, 2_500)
  assert.equal(formatClock(tx.elapsed), '1:31')
})

test('计时与耗时写法：状态行 1:30，组头 8.4s', () => {
  assert.equal(formatClock(0), '0:00')
  assert.equal(formatClock(90_000), '1:30')
  assert.equal(formatClock(3_723_000), '1:02:03')
  assert.equal(formatToolSecs(0), '<1ms')
  assert.equal(formatToolSecs(42), '42ms')
  assert.equal(formatToolSecs(8_400), '8.4s')
})

test('套 steps：一次 3 步的循环报 3 步', () => {
  const tx = new TurnTimeline(0)
  tx.step(2)
  tx.step(3)
  tx.step(1)
  assert.equal(tx.stats().steps, 3)
})

test('foldEvents：会话事件也能折出同一条时间线（历史回放用）', () => {
  const at = (n: number) => ({ seq: n, at: 1_000 + n * 1_000 })
  const events = [
    { ...at(1), kind: 'step/start', turn: 1, step: 1 },
    {
      ...at(2),
      kind: 'assistant/message',
      text: '',
      reasoning: '先读文件',
      ms: 1_500,
      finish: 'tool_calls',
      toolCalls: [{ id: 'x1', name: 'fs.read', args: { path: 'a.ts' } }],
    },
    { ...at(3), kind: 'tool/call', turn: 1, step: 1, call: { id: 'x1', name: 'fs.read', args: { path: 'a.ts' } } },
    { ...at(5), kind: 'tool/result', callId: 'x1', name: 'fs.read', ok: true, content: 'let a', ms: 700 },
    {
      ...at(6),
      kind: 'assistant/message',
      text: '读完了',
      reasoning: '',
      ms: 300,
      finish: 'stop',
      toolCalls: [],
    },
    { ...at(8), kind: 'turn/end', turn: 1, reason: 'done' as const },
  ] as SessionEvent[]

  const tx = foldEvents(events)
  assert.equal(tx.tools.length, 1)
  assert.equal(tx.tools[0].summary, 'a.ts')
  assert.equal(tx.tools[0].state, 'done')
  assert.equal(tx.tools[0].preview, 'let a')
  assert.equal(tx.thoughts[0].text, '先读文件')
  assert.equal(tx.thoughts[0].ms, 1_500)
  assert.equal(tx.stats().steps, 1)
  assert.equal(tx.elapsed, 7_000)
})
