import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compactMessages, historyChars } from '../src/core/compact.ts'
import type { LlmMessage } from '../src/core/types.ts'

const tool = (text: string): LlmMessage => ({ role: 'tool', content: text })
const user = (text: string): LlmMessage => ({ role: 'user', content: text })

test('没超阈值时原样返回', () => {
  const history = [user('你好'), tool('短结果')]
  const r = compactMessages(history, 10_000)
  assert.equal(r.compacted, 0)
  assert.equal(r.messages.length, 2)
  assert.equal(r.messages[1].content, '短结果')
})

test('超阈值时工具结果被压成摘要，成本降下来', () => {
  const big = '第一行摘要\n' + 'x'.repeat(5000)
  const history = [tool(big), user('a'), user('b'), user('c'), user('d'), user('e'), user('f'), user('g')]
  const before = historyChars(history)
  const r = compactMessages(history, 1000)
  assert.ok(r.compacted > 0)
  assert.ok(r.after < before)
  assert.ok(r.messages[0].content.includes('第一行摘要'))
  assert.ok(r.messages[0].content.includes('已压缩'))
  assert.ok(r.messages[0].content.length < big.length)
})

test('最近 keepRecent 条一律不动', () => {
  const big = 'z'.repeat(3000)
  const history = [tool('旧'), tool(big), tool('最近1'), tool('最近2')]
  const r = compactMessages(history, 500, 2)
  const n = r.messages.length
  assert.equal(r.messages[n - 1].content, '最近2')
  assert.equal(r.messages[n - 2].content, '最近1')
})

test('原始数组不被改动', () => {
  const big = 'y'.repeat(4000)
  const history = [tool(big), user('a'), user('b'), user('c'), user('d'), user('e'), user('f'), user('g')]
  compactMessages(history, 500)
  assert.equal(history[0].content.length, 4000)
})
