import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Audit } from '../src/core/audit.ts'
import { Session } from '../src/core/session.ts'

test('audit: 删库后能从 jsonl 重建出参数、审批结论与 auto 标记', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-audit-'))
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  await s.append({ kind: 'turn/start', turn: 1 })
  await s.append({ kind: 'user/message', text: '写个文件' })
  await s.append({ kind: 'step/start', turn: 1, step: 1 })
  await s.append({ kind: 'tool/call', turn: 1, step: 1, call: { id: 'c1', name: 'write', args: { path: 'a.txt' } } })
  await s.append({ kind: 'approval/asked', reqId: 'r1', tool: 'write', reason: '需要写权限' })
  await s.append({ kind: 'approval/decided', reqId: 'r1', decision: 'allowed-once', auto: true })
  await s.append({ kind: 'tool/result', callId: 'c1', name: 'write', ok: true, content: 'ok', ms: 2 })
  await s.append({ kind: 'step/end', turn: 1, step: 1, toolCalls: 1 })
  await s.append({ kind: 'turn/end', turn: 1, reason: 'done' })

  const dbPath = join(dataDir, 'audit.sqlite')
  const audit = await Audit.open(dbPath)
  try {
    const r = await audit.rebuild(join(dataDir, 'sessions'))
    assert.equal(r.sessions, 1)
    assert.equal(r.toolCalls, 1)
    assert.equal(r.approvals, 1)

    const row = audit.queryToolCalls({ limit: 5 })[0]!
    assert.equal(row.tool, 'write')
    assert.match(String(row.args_json), /a\.txt/)
    assert.equal(row.decision, 'allowed-once')
    assert.equal(Number(row.auto), 1)
    assert.equal(row.turn, 1)
    assert.equal(row.step, 1)
    assert.equal(Number(row.ok), 1)
  } finally {
    audit.close()
  }
})

test('audit: 写库失败不抛错，tool-calls 日志照写（投影不能反客为主）', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-audit-bad-'))
  const audit = await Audit.open(join(dataDir, 'audit.sqlite'))
  try {
    assert.equal(audit.health().failures, 0)
    // 把表删掉，模拟库损坏 / 磁盘满 / 被别的进程锁住
    ;(audit as unknown as { db: { exec: (sql: string) => void } }).db.exec('DROP TABLE tool_calls')

    assert.doesNotThrow(() =>
      audit.recordToolCall({
        sessionId: 's1',
        turn: 1,
        step: 1,
        callId: 'c1',
        tool: 'read',
        argsJson: '{}',
        status: 'done',
        ok: true,
        ms: 1,
        outBytes: 2,
        startedAt: 1,
        finishedAt: 1,
      }),
    )
    assert.equal(audit.health().failures, 1)
    assert.ok(audit.health().lastError, '要留下最后一次错误，doctor 才能显示')

    // sqlite 挂了，人类可读的日志不能跟着挂
    const logs = await readdir(join(dataDir, 'logs'))
    assert.equal(logs.length, 1)
    const text = await readFile(join(dataDir, 'logs', logs[0]!), 'utf8')
    assert.match(text, /"tool":"read"/)
  } finally {
    audit.close()
  }
})

test('audit: rebuild 不会往 tool-calls 日志里追加副本', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-audit-re-'))
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  await s.append({ kind: 'turn/start', turn: 1 })
  await s.append({ kind: 'step/start', turn: 1, step: 1 })
  await s.append({ kind: 'tool/call', turn: 1, step: 1, call: { id: 'c1', name: 'read', args: { path: 'a.txt' } } })
  await s.append({ kind: 'tool/result', callId: 'c1', name: 'read', ok: true, content: 'ok', ms: 1 })
  await s.append({ kind: 'turn/end', turn: 1, reason: 'done' })

  const audit = await Audit.open(join(dataDir, 'audit.sqlite'))
  try {
    const logsDir = join(dataDir, 'logs')
    assert.deepEqual(await readdir(logsDir), [], '重建前不该有工具日志')

    await audit.rebuild(join(dataDir, 'sessions'))
    await audit.rebuild(join(dataDir, 'sessions'))
    assert.equal(audit.queryToolCalls({ limit: 10 }).length, 1, '重建两次不该变成两行')
    assert.deepEqual(await readdir(logsDir), [], '重建是投影进库，不该回写日志文件')
  } finally {
    audit.close()
  }
})
