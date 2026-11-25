/**
 * 审计：把会话事件投影成 SQLite，供查询与对账。
 *
 * 铁律：**唯一真相是 session.jsonl**，这里只是投影。
 * 因此任何时候都能 `pl audit rebuild` 全量重建；写库失败也不阻断主链路。
 */

import { mkdir, readdir, readFile } from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { redact } from './redact.ts'

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, title TEXT, cwd TEXT, model TEXT, mode TEXT,
  created_at INTEGER, updated_at INTEGER, turns INTEGER DEFAULT 0, events INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn INTEGER, step INTEGER,
  call_id TEXT, tool TEXT NOT NULL, args_json TEXT NOT NULL, decision TEXT,
  status TEXT NOT NULL, ok INTEGER, exit_code INTEGER, error TEXT,
  ms INTEGER, out_bytes INTEGER, truncated INTEGER DEFAULT 0, auto INTEGER DEFAULT 0,
  started_at INTEGER, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn INTEGER, step INTEGER,
  model TEXT NOT NULL, msgs INTEGER, tools_n INTEGER,
  prompt INTEGER, completion INTEGER, cache_read INTEGER,
  ms INTEGER, finish TEXT, error TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_session ON llm_calls(session_id, id);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, req_id TEXT NOT NULL,
  tool TEXT NOT NULL, reason TEXT, decision TEXT NOT NULL, at INTEGER NOT NULL
);
`

// 日志里长字段截一刀，别把整份文件内容写进去
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…(共 ${s.length} 字符)` : s)

export interface ToolCallRow {
  sessionId: string
  turn: number
  step: number
  callId: string
  tool: string
  argsJson: string
  decision?: string
  status: 'done' | 'failed' | 'denied'
  ok: boolean
  exitCode?: number
  error?: string
  ms: number
  outBytes: number
  truncated?: boolean
  /** true = 没经过人，由 --yes / PL_APPROVAL=allow 自动放行 */
  auto?: boolean
  startedAt: number
  finishedAt: number
}

export interface LlmCallRow {
  sessionId: string
  turn: number
  step: number
  model: string
  msgs: number
  toolsN: number
  prompt: number
  completion: number
  cacheRead: number
  ms: number
  finish: string | null
  error?: string
  at: number
}

export class Audit {
  private db: DatabaseSync | undefined
  readonly path: string
  readonly enabled: boolean
  /** 人类可读的工具调用日志目录（按天一个 jsonl）：<dataDir>/logs */
  readonly logsDir: string
  private toolLogDay = ''
  private toolLogFile = ''

  private constructor(path: string, db: DatabaseSync | undefined, logsDir: string) {
    this.path = path
    this.db = db
    this.enabled = Boolean(db)
    this.logsDir = logsDir
  }

  static async open(path: string): Promise<Audit> {
    // 工具调用日志和 sqlite 审计并行：谁也不依赖谁，sqlite 挂了日志照样要有
    const logsDir = join(dirname(path), 'logs')
    try {
      mkdirSync(logsDir, { recursive: true })
    } catch {
      /* 建不了目录不影响主链路 */
    }
    try {
      await mkdir(dirname(path), { recursive: true })
      const db = new DatabaseSync(path)
      db.exec('PRAGMA journal_mode=WAL;')
      db.exec(DDL)
      // 老库补列（审计是投影，迁移失败也不影响主链路）
      try {
        db.exec('ALTER TABLE tool_calls ADD COLUMN auto INTEGER DEFAULT 0')
      } catch {
        /* 列已存在 */
      }
      return new Audit(path, db, logsDir)
    } catch {
      // 审计不可用不是致命错误：主链路照跑
      return new Audit(path, undefined, logsDir)
    }
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      /* 忽略 */
    }
    this.db = undefined
  }

  upsertSession(s: {
    id: string
    title: string
    cwd: string
    model: string
    mode: string
    createdAt: number
    updatedAt: number
    turns: number
    events: number
  }): void {
    this.db
      ?.prepare(
        `INSERT INTO sessions (id,title,cwd,model,mode,created_at,updated_at,turns,events)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at,
           turns=excluded.turns, events=excluded.events`,
      )
      .run(s.id, s.title, s.cwd, s.model, s.mode, s.createdAt, s.updatedAt, s.turns, s.events)
  }

  recordToolCall(r: ToolCallRow): void {
    this.db
      ?.prepare(
        `INSERT INTO tool_calls (session_id,turn,step,call_id,tool,args_json,decision,status,ok,
           exit_code,error,ms,out_bytes,truncated,auto,started_at,finished_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.sessionId,
        r.turn,
        r.step,
        r.callId,
        r.tool,
        redact(r.argsJson),
        r.decision ?? null,
        r.status,
        r.ok ? 1 : 0,
        r.exitCode ?? null,
        r.error ? redact(r.error) : null,
        r.ms,
        r.outBytes,
        r.truncated ? 1 : 0,
        r.auto ? 1 : 0,
        r.startedAt,
        r.finishedAt,
      )
    this.writeToolLog(r)
  }

  /**
   * 追加一行到 <logsDir>/tool-calls-YYYY-MM-DD.jsonl。
   * 给人和脚本直接读：sqlite 适合聚合，这里适合“一眼看这一轮模型都干了什么、为什么失败”。
   * 写不进去就算了，绝不影响主链路。
   */
  private writeToolLog(r: ToolCallRow): void {
    try {
      const day = new Date(r.finishedAt || Date.now()).toISOString().slice(0, 10)
      if (day !== this.toolLogDay) {
        this.toolLogDay = day
        this.toolLogFile = join(this.logsDir, `tool-calls-${day}.jsonl`)
      }
      appendFileSync(
        this.toolLogFile,
        `${JSON.stringify({
          at: new Date(r.finishedAt || Date.now()).toISOString(),
          session: r.sessionId,
          turn: r.turn,
          step: r.step,
          tool: r.tool,
          decision: r.decision ?? null,
          status: r.status,
          ok: Boolean(r.ok),
          exit: r.exitCode ?? null,
          ms: r.ms,
          out: r.outBytes,
          truncated: Boolean(r.truncated),
          error: r.error ? redact(r.error) : null,
          args: clip(redact(r.argsJson), 600),
        })}\n`,
        'utf8',
      )
    } catch {
      /* 日志写不进去不影响主线 */
    }
  }

  recordLlmCall(r: LlmCallRow): void {
    this.db
      ?.prepare(
        `INSERT INTO llm_calls (session_id,turn,step,model,msgs,tools_n,prompt,completion,
           cache_read,ms,finish,error,at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.sessionId,
        r.turn,
        r.step,
        r.model,
        r.msgs,
        r.toolsN,
        r.prompt,
        r.completion,
        r.cacheRead,
        r.ms,
        r.finish,
        r.error ? redact(r.error) : null,
        r.at,
      )
  }

  recordApproval(r: { sessionId: string; reqId: string; tool: string; reason: string; decision: string; at: number }): void {
    this.db
      ?.prepare(`INSERT INTO approvals (session_id,req_id,tool,reason,decision,at) VALUES (?,?,?,?,?,?)`)
      .run(r.sessionId, r.reqId, r.tool, r.reason, r.decision, r.at)
  }

  queryToolCalls(opts: { sessionId?: string; tool?: string; limit?: number } = {}): Array<Record<string, unknown>> {
    if (!this.db) return []
    const where: string[] = []
    const args: Array<string | number> = []
    if (opts.sessionId) {
      where.push('session_id = ?')
      args.push(opts.sessionId)
    }
    if (opts.tool) {
      where.push('tool = ?')
      args.push(opts.tool)
    }
    const sql = `SELECT * FROM tool_calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
    args.push(opts.limit ?? 20)
    return this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>
  }

  queryLlmCalls(opts: { sessionId?: string; limit?: number } = {}): Array<Record<string, unknown>> {
    if (!this.db) return []
    const args: Array<string | number> = []
    let where = ''
    if (opts.sessionId) {
      where = 'WHERE session_id = ?'
      args.push(opts.sessionId)
    }
    args.push(opts.limit ?? 20)
    return this.db.prepare(`SELECT * FROM llm_calls ${where} ORDER BY id DESC LIMIT ?`).all(...args) as Array<
      Record<string, unknown>
    >
  }

  cost(): { calls: number; prompt: number; completion: number; cacheRead: number } {
    if (!this.db) return { calls: 0, prompt: 0, completion: 0, cacheRead: 0 }
    const row = this.db
      .prepare('SELECT count(*) AS calls, coalesce(sum(prompt),0) AS p, coalesce(sum(completion),0) AS c, coalesce(sum(cache_read),0) AS cr FROM llm_calls')
      .get() as { calls: number; p: number; c: number; cr: number }
    return { calls: Number(row.calls), prompt: Number(row.p), completion: Number(row.c), cacheRead: Number(row.cr) }
  }

  /** 从 sessions/<id>/session.jsonl 全量重建（唯一真相在这些文件里） */
  async rebuild(sessionsRoot: string): Promise<{ sessions: number; toolCalls: number; llmCalls: number; approvals: number }> {
    if (!this.db) return { sessions: 0, toolCalls: 0, llmCalls: 0, approvals: 0 }
    this.db.exec('DELETE FROM tool_calls; DELETE FROM llm_calls; DELETE FROM approvals; DELETE FROM sessions;')
    const ids = await readdir(sessionsRoot).catch(() => [] as string[])
    let sessions = 0
    let toolCalls = 0
    let llmCalls = 0
    let approvals = 0
    for (const id of ids) {
      let events: Array<Record<string, unknown>>
      try {
        const text = await readFile(join(sessionsRoot, id, 'session.jsonl'), 'utf8')
        events = text
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      } catch {
        continue
      }
      const start = events.find((e) => e.kind === 'session/start') as Record<string, string> | undefined
      if (!start) continue
      const firstUser = events.find((e) => e.kind === 'user/message') as { text: string } | undefined
      // 从事件本身恢复参数与审批结论，避免重建后只剩「某工具跑过」
      const argsByCall = new Map<string, string>()
      for (const e of events) {
        if (e.kind === 'tool/call') {
          const call = e.call as { id?: string; args?: unknown } | undefined
          if (call?.id) argsByCall.set(call.id, JSON.stringify(call.args ?? {}))
        }
      }
      let cur = { turn: 0, step: 0 }
      let pendingCall: string | undefined
      let pendingDecision: string | undefined
      let pendingAuto = false
      for (const e of events) {
        if (e.kind === 'turn/start') {
          cur = { turn: Number(e.turn), step: 0 }
          pendingCall = undefined
        }
        if (e.kind === 'step/start') cur = { turn: cur.turn, step: Number(e.step) }
        if (e.kind === 'tool/call') {
          pendingCall = String((e.call as { id?: string } | undefined)?.id ?? '')
          pendingDecision = undefined
          pendingAuto = false
        }
        if (e.kind === 'approval/decided') {
          approvals++
          pendingDecision = String(e.decision)
          pendingAuto = e.auto === true
        }
        if (e.kind === 'tool/result') {
          toolCalls++
          const callId = String(e.callId)
          const matched = callId === pendingCall
          this.recordToolCall({
            sessionId: id,
            turn: cur.turn,
            step: cur.step,
            callId,
            tool: String(e.name),
            argsJson: argsByCall.get(callId) ?? '{}',
            decision: matched ? pendingDecision : undefined,
            status: e.ok ? 'done' : 'failed',
            ok: Boolean(e.ok),
            exitCode: e.exitCode as number | undefined,
            ms: Number(e.ms ?? 0),
            outBytes: Buffer.byteLength(String(e.content ?? ''), 'utf8'),
            truncated: Boolean(e.truncated),
            auto: matched && pendingAuto,
            startedAt: Number(e.at),
            finishedAt: Number(e.at),
          })
          pendingCall = undefined
        }
        if (e.kind === 'llm/usage') llmCalls++
      }
      const last = events[events.length - 1] as { at: number }
      this.upsertSession({
        id,
        title: firstUser?.text?.slice(0, 48) ?? '(empty)',
        cwd: start.cwd ?? '',
        model: start.model ?? '',
        mode: start.mode ?? '',
        createdAt: Number(events[0]!.at),
        updatedAt: Number(last.at),
        turns: events.filter((e) => e.kind === 'turn/start').length,
        events: events.length,
      })
      sessions++
    }
    return { sessions, toolCalls, llmCalls, approvals }
  }
}
