import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolContext } from '../src/core/tools.ts'
import { createTodoTools } from '../src/tools/todo.ts'
import { parseTodoContent } from '../src/core/timeline.ts'

const ctx = { root: process.cwd(), readFiles: new Set<string>() } as unknown as ToolContext

test('todo_write：还剩几项就提醒继续回写，全完成时换一句', async () => {
  const todo = createTodoTools()[0]!
  const half = await todo.run(ctx, { items: [{ text: 'a', done: true }, { text: 'b', done: false }] })
  assert.match(half.content, /^待办 1\/2/)
  assert.match(half.content, /还剩 1 项/)
  assert.match(half.content, /再调一次 todo_write/)

  const all = await todo.run(ctx, { items: [{ text: 'a', done: true }, { text: 'b', done: true }] })
  assert.match(all.content, /^待办 2\/2/)
  assert.match(all.content, /清单已全部完成/)
  // 结构化清单照旧给界面画卡
  assert.equal((all.data as { items: unknown[] }).items.length, 2)
})

test('提醒话术不会被 parseTodoContent 当成待办条目', async () => {
  const todo = createTodoTools()[0]!
  const r = await todo.run(ctx, { items: [{ text: 'a', done: false }, { text: 'b', done: false }] })
  const items = parseTodoContent(r.content)
  assert.deepEqual(items.map((i) => i.text), ['a', 'b'])
  assert.deepEqual(items.map((i) => i.done), [false, false])
})
