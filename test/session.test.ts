import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Session } from '../src/core/session.ts'

test('session: 追加、落盘、重开后事件一致', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-session-'))
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  await s.append({ kind: 'turn/start', turn: 1 })
  await s.append({ kind: 'user/message', text: '帮我读一下 README' })
  await s.append({
    kind: 'assistant/message',
    text: '',
    reasoning: 'r',
    toolCalls: [{ id: 'c1', name: 'read', args: { path: 'README.md' } }],
    ms: 12,
    finish: 'tool_calls',
  })
  await s.append({
    kind: 'tool/result',
    callId: 'c1',
    name: 'read',
    ok: true,
    content: 'hello',
    ms: 3,
  })
  await s.append({ kind: 'turn/end', turn: 1, reason: 'done' })

  const reopened = await Session.open(dataDir, s.id)
  assert.equal(reopened.events.length, s.events.length)
  assert.equal(reopened.lastSeq, s.events.length)
  assert.equal(reopened.title(), '帮我读一下 README')

  const msgs = reopened.deriveMessages()
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  )
  assert.equal(msgs[2]!.toolCallId, 'c1')
  assert.equal(msgs[2]!.content, 'hello')

  // 落盘确实是 NDJSON
  const raw = await readFile(join(dataDir, 'sessions', s.id, 'session.jsonl'), 'utf8')
  assert.equal(raw.trim().split('\n').length, s.events.length)
})

test('session: 损坏的半行不会阻断恢复', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-session-'))
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  await s.append({ kind: 'user/message', text: 'hi' })
  const file = join(dataDir, 'sessions', s.id, 'session.jsonl')
  const { appendFile } = await import('node:fs/promises')
  await appendFile(file, '{"seq":99,"at":1,"kind":"user/mess', 'utf8')

  const reopened = await Session.open(dataDir, s.id)
  assert.equal(reopened.events.length, 2)
})

test('session: 截断的工具结果在历史里带说明', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-session-'))
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  await s.append({ kind: 'user/message', text: '跑一下测试' })
  await s.append({
    kind: 'assistant/message',
    text: '',
    reasoning: '',
    toolCalls: [{ id: 'c9', name: 'shell', args: { command: 'npm test' } }],
    ms: 5,
    finish: 'tool_calls',
  })
  await s.append({
    kind: 'tool/result',
    callId: 'c9',
    name: 'shell',
    ok: true,
    content: 'head...tail',
    truncated: true,
    spill: 'C:/x/spill.log',
    ms: 1,
  })
  const msg = s.deriveMessages()[2]!
  assert.match(msg.content, /输出已截断/)
  assert.match(msg.content, /spill\.log/)
})

test('session: 工具跑到一半中断（缺 tool/result）在历史里补占位，不会拖垮后续请求', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-session-'))
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  await s.append({ kind: 'turn/start', turn: 1 })
  await s.append({ kind: 'user/message', text: '看看窗口' })
  // 一批两个调用：一个跑完了，另一个在落 tool/result 之前进程就停了
  await s.append({
    kind: 'assistant/message',
    text: '',
    reasoning: '',
    toolCalls: [
      { id: 'done1', name: 'read', args: { path: 'a.txt' } },
      { id: 'killed1', name: 'shell', args: { command: 'Get-Process' } },
    ],
    ms: 9,
    finish: 'tool_calls',
  })
  await s.append({ kind: 'tool/result', callId: 'done1', name: 'read', ok: true, content: 'ok', ms: 1 })
  await s.append({ kind: 'turn/end', turn: 1, reason: 'cancelled' })
  // 下一轮用户接着说话
  await s.append({ kind: 'turn/start', turn: 2 })
  await s.append({ kind: 'user/message', text: '继续' })

  const msgs = s.deriveMessages()
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'user'])
  // 每条 tool_call 都有对应的 tool 消息，且不缺、不重复
  const assistant = msgs[1]!
  const responses = msgs.filter((m) => m.role === 'tool').map((m) => m.toolCallId)
  assert.deepEqual(responses, assistant.toolCalls!.map((c) => c.id))
  assert.equal(msgs[2]!.content, 'ok')
  assert.match(msgs[3]!.content, /中断/)
})

test('session: 没有前置调用的 tool 消息会被丢掉（服务端也不收）', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-session-'))
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  await s.append({ kind: 'user/message', text: 'hi' })
  await s.append({ kind: 'tool/result', callId: 'ghost', name: 'read', ok: true, content: 'x', ms: 1 })
  await s.append({ kind: 'assistant/message', text: '好了', reasoning: '', toolCalls: [], ms: 1, finish: 'stop' })
  assert.deepEqual(s.deriveMessages().map((m) => m.role), ['user', 'assistant'])
})
