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

// ---------------------------------------------------------------- 多轮模型
// 一条时间线 = 一轮。前四例是单轮里的流转，下面几例钉住「多轮执行流」的四个面板：
// 阶段性正文（turnMessages）、执行方案（todoPlan）、底部胶囊（activeBottomStatus）、
// 以及状态行那个「现在在干嘛」（latestAction）。

import {
  formatElapsedCn,
  mockBugHuntEvents,
  mockBugHuntTimelines,
  parseTodoContent,
  TurnTimeline as Tx,
} from '../src/core/timeline.ts'

test('阶段性正文：每步一段，带 step 与 model，按时间顺序累计', () => {
  const tx = new Tx(0, 'deepseek-flash')
  tx.reason('先看看现有实现')
  tx.closeThought(500)
  tx.step(1)
  tx.message('先看导出实现，再确认需求。', 600)
  tx.toolStart({ id: 'a', name: 'fs.read', args: {} }, 'src/export.ts', 700)
  tx.toolEnd('a', { ok: true, ms: 10, content: 'ok', at: 710 })
  tx.step(2)
  tx.message('确认了 `GridLength::new` 可用。', 800)

  assert.equal(tx.messages.length, 2)
  assert.deepEqual(
    tx.messages.map((m) => [m.step, m.model]),
    [
      [1, 'deepseek-flash'],
      [2, 'deepseek-flash'],
    ],
  )
  // 快照里也要带着，离线看 / CLI 输出用的是同一份
  assert.equal(tx.snapshot(900).turnMessages.length, 2)
})

test('执行方案：todo_write 覆盖整份，完成度计数跟着走', () => {
  const tx = new Tx(0)
  assert.equal(tx.snapshot().todoPlan, null)

  tx.setTodos([
    { text: '定位掉帧来源', done: true },
    { text: '加去重与合并', done: true },
    { text: '补回归测试', done: false },
    { text: '清理多余调度', done: false },
  ])
  const plan = tx.todoPlan
  assert.equal(plan.total, 4)
  assert.equal(plan.done, 2)
  assert.equal(tx.snapshot().todoPlan?.done, 2)

  // 再写一次是覆盖，不是追加
  tx.setTodos([{ text: '只有一个', done: true }])
  assert.equal(tx.todoPlan.total, 1)
})

test('底部胶囊：跑最久的那个调用，全部回来就撤掉', () => {
  const tx = new Tx(0)
  assert.equal(tx.activeBottomStatus, null)

  tx.toolStart({ id: 'a', name: 'fs.read', args: {} }, 'a.ts', 1_000)
  tx.toolStart({ id: 'b', name: 'shell', args: {} }, 'npm test', 1_200)
  // 状态行报「最新开始的那个」，胶囊报「跑得最久的那个」
  assert.equal(tx.latestAction, '执行 shell')
  // 并行时胶囊报跑得最久的那件（不是最后开始的）
  assert.deepEqual(tx.activeBottomStatus, { label: '执行 fs.read', since: 1_000, running: true })

  // read 先回来，胶囊换成还在跑的 shell
  tx.toolEnd('a', { ok: true, ms: 5, content: 'ok', at: 1_005 })
  assert.equal(tx.activeBottomStatus?.label, '执行 shell')
  // 合计只算已回来的，不随墙上时间自己跳
  assert.equal(tx.stats(9_999).ms, 5)
  assert.equal(tx.stats(9_999).running, 1)

  tx.toolEnd('b', { ok: true, ms: 2_000, content: '143 passing', at: 3_200 })
  assert.equal(tx.activeBottomStatus, null)
  assert.equal(tx.latestAction, '思考中')
})

test('状态行：回答中 / 已完成 / 被中断的调用不留「运行中」', () => {
  const tx = new Tx(0)
  tx.toolStart({ id: 'a', name: 'shell', args: {} }, 'npm test', 100)
  // 运行中的调用优先于阶段词：界面要能看见「● 执行 shell」
  assert.equal(tx.latestAction, '执行 shell')
  tx.toolEnd('a', { ok: true, ms: 300, content: 'ok', at: 400 })
  tx.answer()
  assert.equal(tx.latestAction, '回答中')
  // 收尾时还挂着的那个（比如用户点了停止）按中断算，不能永远显示运行中
  tx.toolStart({ id: 'b', name: 'fs.grep', args: {} }, 'TODO', 450)
  tx.end(500)
  assert.equal(tx.latestAction, '已完成')
  assert.equal(tx.phase, 'done')
  assert.equal(tx.stats().running, 0)
  assert.equal(tx.tools[1].state, 'failed')
  assert.match(String(tx.tools[1].error), /中断/)
})

test('时长写法：底部胶囊 27分37秒，不足一分钟报秒', () => {
  assert.equal(formatElapsedCn(37_000), '37 秒')
  assert.equal(formatElapsedCn(1_657_000), '27分37秒')
  assert.equal(formatElapsedCn(3_930_000), '1小时05分')
})

test('todo_write 的文本结果也能解析回清单（历史回放只有 content）', () => {
  const items = parseTodoContent('待办 2/3\n[x] 定位掉帧\n[ ] 加去重\n[X] 补测试')
  assert.deepEqual(items, [
    { text: '定位掉帧', done: true },
    { text: '加去重', done: false },
    { text: '补测试', done: true },
  ])
  assert.deepEqual(parseTodoContent('没有清单'), [])
})

test('演示数据：三轮连续排查，每轮都有正文、方案与工具', () => {
  const txs = mockBugHuntTimelines(1_000_000)
  assert.equal(txs.length, 3)
  for (const t of txs) {
    assert.equal(t.phase, 'done')
    assert.ok(t.messages.length >= 1, '每轮都要出阶段性正文')
    assert.equal(t.model, 'deepseek-flash')
  }
  // 执行方案一路推进：0/3 → 3/3 → 3/4（最后一步还没做完）
  assert.equal(txs[0].todoPlan.done, 0)
  assert.equal(txs[1].todoPlan.done, 3)
  assert.equal(txs[2].todoPlan.done, 3)
  assert.equal(txs[2].todoPlan.total, 4)
  // 第三轮末尾那次测试是红的，失败单独计数
  assert.ok(txs[2].stats().failed >= 1)
  // 事件流本身能按顺序喂给界面
  const ev = mockBugHuntEvents()
  assert.equal(ev.filter((e) => e.type === 'turn-start').length, 3)
  assert.equal(ev.filter((e) => e.type === 'turn-end').length, 3)
  assert.ok(ev.some((e) => e.type === 'tool-start' && e.name === 'todo_write'))
})
