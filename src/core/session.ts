/**
 * Session：append-only JSONL 事件日志 + 模型历史投影。
 *
 * 布局：
 *   <data>/sessions/<id>/session.jsonl
 *
 * 为什么不写数据库：一个会话一个文件，崩溃最多丢最后一行；拷走即备份；
 * 审计库只是投影，随时可由这些 jsonl 重建（见 core/audit.ts rebuild）。
 */

import { appendFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { EventInput, SessionEvent } from './events.ts'
import type { LlmMessage } from './types.ts'

export function newSessionId(now = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 6)
  return `s-${now.toString(36)}-${rand}`
}

export class Session {
  readonly id: string
  readonly dir: string
  readonly file: string
  events: SessionEvent[]
  private seq: number

  private constructor(id: string, dir: string, events: SessionEvent[]) {
    this.id = id
    this.dir = dir
    this.file = join(dir, 'session.jsonl')
    this.events = events
    this.seq = events.length ? events[events.length - 1]!.seq : 0
  }

  static async create(
    dataDir: string,
    meta: { cwd: string; model: string; baseURL: string; mode: string; version: string },
  ): Promise<Session> {
    const id = newSessionId()
    const dir = join(dataDir, 'sessions', id)
    await mkdir(dir, { recursive: true })
    const session = new Session(id, dir, [])
    await session.append({ kind: 'session/start', id, ...meta })
    return session
  }

  static async open(dataDir: string, id: string): Promise<Session> {
    const dir = join(dataDir, 'sessions', id)
    const file = join(dir, 'session.jsonl')
    const text = await readFile(file, 'utf8')
    const events: SessionEvent[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as SessionEvent)
      } catch {
        // 崩溃留下的半行：忽略，不阻断恢复
      }
    }
    return new Session(id, dir, events)
  }

  /** 最近一个会话（按 session.jsonl 的 mtime） */
  static async latest(dataDir: string): Promise<Session | null> {
    const root = join(dataDir, 'sessions')
    const ids = await readdir(root).catch(() => [] as string[])
    let best: { id: string; mtime: number } | null = null
    for (const id of ids) {
      try {
        const s = await stat(join(root, id, 'session.jsonl'))
        if (!best || s.mtimeMs > best.mtime) best = { id, mtime: s.mtimeMs }
      } catch {
        /* 空目录 */
      }
    }
    return best ? Session.open(dataDir, best.id) : null
  }

  static async list(dataDir: string): Promise<Array<{ id: string; title: string; updatedAt: number; turns: number }>> {
    const root = join(dataDir, 'sessions')
    const ids = await readdir(root).catch(() => [] as string[])
    const out: Array<{ id: string; title: string; updatedAt: number; turns: number }> = []
    for (const id of ids) {
      try {
        const s = await Session.open(dataDir, id)
        out.push({
          id,
          title: s.title(),
          updatedAt: s.events.length ? s.events[s.events.length - 1]!.at : 0,
          turns: s.events.filter((e) => e.kind === 'turn/start').length,
        })
      } catch {
        /* 忽略损坏会话 */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * 删除会话：连同它的 checkpoint 一起删。
   * 只删 checkpoints 会留下悬空引用（undo 指向已经不存在的会话），只删会话则留一堆垃圾。
   */
  static async remove(dataDir: string, id: string): Promise<void> {
    // id 直接拼进路径，必须挡路径穿越
    if (!/^s-[a-z0-9]+-[a-z0-9]+$/.test(id)) throw new Error(`非法会话 id：${id}`)
    await rm(join(dataDir, 'sessions', id), { recursive: true, force: true })
    await rm(join(dataDir, 'ckpt', id), { recursive: true, force: true })
  }

  async append(payload: EventInput): Promise<SessionEvent> {    const event = { seq: this.seq + 1, at: Date.now(), ...payload } as SessionEvent
    this.seq = event.seq
    this.events.push(event)
    await mkdir(dirname(this.file), { recursive: true })
    await appendFile(this.file, `${JSON.stringify(event)}\n`, 'utf8')
    return event
  }

  get lastSeq(): number {
    return this.seq
  }

  title(): string {
    const first = this.events.find((e) => e.kind === 'user/message')
    if (!first || first.kind !== 'user/message') return '(empty)'
    const t = first.text.replace(/\s+/g, ' ').trim()
    return t.length > 48 ? `${t.slice(0, 48)}…` : t || '(empty)'
  }

  nextTurn(): number {
    let n = 0
    for (const e of this.events) if (e.kind === 'turn/start') n = Math.max(n, e.turn)
    return n + 1
  }

  /** 模型历史：只由持久事件投影，绝不额外拼装 */
  deriveMessages(): LlmMessage[] {
    const out: LlmMessage[] = []
    for (const e of this.events) {
      if (e.kind === 'user/message') out.push({ role: 'user', content: e.text })
      else if (e.kind === 'assistant/message')
        out.push({ role: 'assistant', content: e.text, toolCalls: e.toolCalls.length ? e.toolCalls : undefined })
      else if (e.kind === 'tool/result')
        out.push({
          role: 'tool',
          toolCallId: e.callId,
          content: e.truncated ? `${e.content}\n[输出已截断，完整内容见 ${e.spill ?? 'spill 文件'}]` : e.content,
        })
    }
    return out
  }
}
