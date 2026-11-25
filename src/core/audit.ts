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
  /** 语句缓存：审计每轮要写十几条，原先每条都 prepare 一次 */
  private readonly stmts = new Map<string, ReturnType<DatabaseSync['prepare']>>()
  /** 写库失败次数与最后一次错误：审计坏掉不阻断主链路，但得让人能看见 */
  private failures = 0
  private lastError = ''

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
    this.stmts.clear()
    try {
      this.db?.close()
    } catch {
      /* 忽略 */
    }
    this.db = undefined
  }

  /** 审计库的健康状况（给 doctor / 界面显示：坏掉了要能看出来） */
  health(): { enabled: boolean; failures: number; lastError: string } {
    return { enabled: this.enabled, failures: this.failures, lastError: this.lastError }
  }

  private noteFailure(e: unknown): void {
    this.failures++
    this.lastError = (e as Error)?.message ?? String(e)
    // 只提示第一次：真出问题时叫一嗓子，之后别把终端刷满
    if (this.failures === 1) {
      try {
        process.emitWarning(`审计写库失败，会话/日志照常记录（pl doctor 可查）：${this.lastError}`)
      } catch {
        /* 连提示都失败就算了 */
      }
    }
  }

  private stmt(sql: string): ReturnType<DatabaseSync['prepare']> | undefined {
    const db = this.db
    if (!db) return undefined
    const hit = this.stmts.get(sql)
    if (hit) return hit
    try {
      const s = db.prepare(sql)
      this.stmts.set(sql, s)
      return s
    } catch (e) {
      this.noteFailure(e)
      return undefined
    }
  }

  /**
   * 审计是投影，写失败绝不能打断主链路（DESIGN 的铁律）。
   *
   * 早先这里写的是裸的 `this.db?.prepare(...).run(...)`：磁盘满、SQLITE_BUSY、
   * 库被别的进程锁住时，异常会从 executeTool 一路冒到 runTurn，
   * 整轮对话被判成 error 并抛出——投影反客为主，把主链路带崩了。
   */
  private exec(sql: string, params: Array<string | number | null>): void {
    const st = this.stmt(sql)
    if (!st) return
    try {
      st.run(...params)
    } catch (e) {
      this.noteFailure(e)
    }
  }

  private all(sql: string, params: Array<string | number | null>): Array<Record<string, unknown>> {
    const st = this.stmt(sql)
    if (!st) return []
    try {
      return st.all(...params) as Array<Record<string, unknown>>
    } catch (e) {
      this.noteFailure(e)
      return []
    }
  }

  private get(sql: string, params: Array<string | number | null> = []): Record<string, unknown> | undefined {
    const st = this.stmt(sql)
    if (!st) return undefined
    try {
      return st.get(...params) as Record<string, unknown> | undefined
    } catch (e) {
      this.noteFailure(e)
      return undefined
    }
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
    this.exec(
      `INSERT INTO sessions (id,title,cwd,model,mode,created_at,updated_at,turns,events)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at,
         turns=excluded.turns, events=excluded.events`,
      [s.id, s.title, s.cwd, s.model, s.mode, s.createdAt, s.updatedAt, s.turns, s.events],
    )
  }

  /**
   * 记一次工具调用。
   * `log: false` 供 rebuild 用：重建是「把 jsonl 投影进库」，不该反过来再往
   * 按天的 tool-calls jsonl 里追加一份全量副本（那样重建一次日志就翻一倍）。
   */
  recordToolCall(r: ToolCallRow, opts: { log?: boolean } = {}): void {
    // 先写人类可读的日志：它跟 sqlite 是两条独立通道，谁挂了都不该带走另一个
    if (opts.log !== false) this.writeToolLog(r)
    this.exec(
      `INSERT INTO tool_calls (session_id,turn,step,call_id,tool,args_json,decision,status,ok,
         exit_code,error,ms,out_bytes,truncated,auto,started_at,finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
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
      ],
    )
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
    this.exec(
      `INSERT INTO llm_calls (session_id,turn,step,model,msgs,tools_n,prompt,completion,
         cache_read,ms,finish,error,at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
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
      ],
    )
  }

  recordApproval(r: { sessionId: string; reqId: string; tool: string; reason: string; decision: string; at: number }): void {
    this.exec(`INSERT INTO approvals (session_id,req_id,tool,reason,decision,at) VALUES (?,?,?,?,?,?)`, [
      r.sessionId,
      r.reqId,
      r.tool,
      r.reason,
      r.decision,
      r.at,
    ])
  }

  queryToolCalls(opts: { sessionId?: string; tool?: string; limit?: number } = {}): Array<Record<string, unknown>> {
    const where: string[] = []
    const args: Array<string | number | null> = []
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
    return this.all(sql, args)
  }

  queryLlmCalls(opts: { sessionId?: string; limit?: number } = {}): Array<Record<string, unknown>> {
    const args: Array<string | number | null> = []
    let where = ''
    if (opts.sessionId) {
      where = 'WHERE session_id = ?'
      args.push(opts.sessionId)
    }
    args.push(opts.limit ?? 20)
    return this.all(`SELECT * FROM llm_calls ${where} ORDER BY id DESC LIMIT ?`, args)
  }

  cost(): { calls: number; prompt: number; completion: number; cacheRead: number } {
    const row = this.get(
      'SELECT count(*) AS calls, coalesce(sum(prompt),0) AS p, coalesce(sum(completion),0) AS c, coalesce(sum(cache_read),0) AS cr FROM llm_calls',
    ) as { calls: number; p: number; c: number; cr: number } | undefined
    if (!row) return { calls: 0, prompt: 0, completion: 0, cacheRead: 0 }
    return { calls: Number(row.calls), prompt: Number(row.p), completion: Number(row.c), cacheRead: Number(row.cr) }
  }

  /**
   * 从 sessions/<id>/session.jsonl 全量重建（唯一真相在这些文件里）。
   *
   * 两处讲究：
   *  1. 整体包一个事务——中途失败不能留下「表已清空、数据只写了一半」的库；
   *  2. 写库时不落 tool-calls 日志（log: false）。重建是「把 jsonl 投影进库」，
   *     要是顺手再往按天的日志文件里追加一遍，重建几次日志就涨几倍。
   */
  async rebuild(sessionsRoot: string): Promise<{ sessions: number; toolCalls: number; llmCalls: number; approvals: number }> {
    const out = { sessions: 0, toolCalls: 0, llmCalls: 0, approvals: 0 }
    const db = this.db
    if (!db) return out
    const ids = await readdir(sessionsRoot).catch(() => [] as string[])

    // 先把 jsonl 全读进内存再开事务：事务里不做 await，不长期占着写锁
    const sources: Array<{ id: string; events: Array<Record<string, unknown>> }> = []
    for (const id of ids) {
      try {
        const text = await readFile(join(sessionsRoot, id, 'session.jsonl'), 'utf8')
        sources.push({
          id,
          events: text
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>),
        })
      } catch {
        /* 单个损坏的会话不阻断整体重建 */
      }
    }

    let inTx = false
    try {
      db.exec('BEGIN')
      inTx = true
      db.exec('DELETE FROM tool_calls; DELETE FROM llm_calls; DELETE FROM approvals; DELETE FROM sessions;')
      this.writeSources(sources, out)
      db.exec('COMMIT')
      inTx = false
    } catch (e) {
      if (inTx) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 回滚也失败就只能这样了 */
        }
      }
      this.noteFailure(e)
      // 重建是显式命令，失败要让退出码非零，不能装作成功
      throw e
    }
    return out
  }

  /** rebuild 的同步写入段：调用方已开事务，这里不能出现 await */
  private writeSources(
    sources: Array<{ id: string; events: Array<Record<string, unknown>> }>,
    out: { sessions: number; toolCalls: number; llmCalls: number; approvals: number },
  ): void {
    for (const { id, events } of sources) {
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
          out.approvals++
          pendingDecision = String(e.decision)
          pendingAuto = e.auto === true
        }
        if (e.kind === 'tool/result') {
          out.toolCalls++
          const callId = String(e.callId)
          const matched = callId === pendingCall
          this.recordToolCall(
            {
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
            },
            { log: false },
          )
          pendingCall = undefined
        }
        if (e.kind === 'llm/usage') out.llmCalls++
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
      out.sessions++
    }
  }
}
