import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
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
