/**
 * Session：append-only JSONL 事件日志 + 模型历史投影。
 *
 * 布局：
 *   <data>/sessions/<id>/session.jsonl
 *
 * 为什么不写数据库：一个会话一个文件，崩溃最多丢最后一行；拷走即备份；
 * 审计库只是投影，随时可由这些 jsonl 重建（见 core/audit.ts rebuild）。
 */

import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EventInput, SessionEvent } from './events.ts'
import type { ImagePart, LlmMessage } from './types.ts'

/** 会话元信息：不进入 session.jsonl，避免污染模型历史投影 */
export interface SessionMeta {
  /** 自定义标题；空/缺省 = 用首条用户消息自动生成 */
  title?: string
  /** 分组名；空/缺省 = 未分组 */
  group?: string
  /** 这个会话的工作目录：切会话时工具根跟着它走（缺省 = 启动时的工作目录） */
  cwd?: string
}

/** id 会直接拼进路径，所有对外接 id 的入口都得先过这道 */
function assertSessionId(id: string): void {
  if (!/^s-[a-z0-9]+-[a-z0-9]+$/.test(id)) throw new Error(`非法会话 id：${id}`)
}

/** list() 的摘要缓存：key 是会话 id，带上 session.jsonl 与 meta.json 的 mtime/size，
 *  变了才重读。切会话后界面每次都会要一次会话列表，不缓存的话每个会话文件
 *  都要整份读+解析一遍，光为了拿标题 / 轮数 / 时间。 */
const summaryCache = new Map<
  string,
  {
    jsonl: { mtimeMs: number; size: number }
    meta: { mtimeMs: number; size: number } | null
    title: string
    group: string
    updatedAt: number
    turns: number
    /** 有内容才进列表：空壳会话（只写了 session/start，或干脆还没落盘）不算一"条"对话 */
    visible: boolean
  }
>()

async function statOrNull(p: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const s = await stat(p)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return null
  }
}

async function readMeta(dir: string): Promise<SessionMeta> {
  try {
    const raw = await readFile(join(dir, 'meta.json'), 'utf8')
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' ? (v as SessionMeta) : {}
  } catch {
    // 没有 meta.json 是常态（老会话、新建会话），不是错误
    return {}
  }
}

export function newSessionId(now = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 6)
  return `s-${now.toString(36)}-${rand}`
}

export class Session {
  readonly id: string
  readonly dir: string
  readonly file: string
  events: SessionEvent[]
  meta: SessionMeta
  private seq: number

  private constructor(id: string, dir: string, events: SessionEvent[], meta: SessionMeta) {
    this.id = id
    this.dir = dir
    this.file = join(dir, 'session.jsonl')
    this.events = events
    this.meta = meta
    this.seq = events.length ? events[events.length - 1]!.seq : 0
  }

  static async create(
    dataDir: string,
    meta: { cwd: string; model: string; baseURL: string; mode: string; version: string },
  ): Promise<Session> {
    const id = newSessionId()
    const dir = join(dataDir, 'sessions', id)
    await mkdir(dir, { recursive: true })
    const session = new Session(id, dir, [], { cwd: meta.cwd })
    await session.append({ kind: 'session/start', id, ...meta })
    // 工作目录另存一份到 meta.json：切会话时只读这个小文件就能恢复工具根，
    // 不必为了拿一个路径把整份 session.jsonl 解析一遍
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify(session.meta, null, 2)}\n`, 'utf8')
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
    return new Session(id, dir, events, await readMeta(dir))
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

  static async list(
    dataDir: string,
  ): Promise<Array<{ id: string; title: string; group: string; updatedAt: number; turns: number }>> {
    const root = join(dataDir, 'sessions')
    const ids = await readdir(root).catch(() => [] as string[])
    const out: Array<{ id: string; title: string; group: string; updatedAt: number; turns: number }> = []
    for (const id of ids) {
      try {
        const dir = join(root, id)
        const jsonl = await statOrNull(join(dir, 'session.jsonl'))
        if (!jsonl) continue
        const meta = await statOrNull(join(dir, 'meta.json'))
        const hit = summaryCache.get(id)
        const sameJsonl =
          hit && hit.jsonl.mtimeMs === jsonl.mtimeMs && hit.jsonl.size === jsonl.size
        const sameMeta =
          hit &&
          ((hit.meta === null && meta === null) ||
            (hit.meta !== null && meta !== null && hit.meta.mtimeMs === meta.mtimeMs && hit.meta.size === meta.size))
        if (hit && sameJsonl && sameMeta) {
          if (hit.visible) {
            out.push({ id, title: hit.title, group: hit.group, updatedAt: hit.updatedAt, turns: hit.turns })
          }
          continue
        }
        const s = await Session.open(dataDir, id)
        const item = {
          id,
          title: s.title(),
          group: (s.meta.group ?? '').trim(),
          updatedAt: s.events.length ? s.events[s.events.length - 1]!.at : 0,
          turns: s.events.filter((e) => e.kind === 'turn/start').length,
        }
        // 只有 session/start 的空会话不进列表：删掉当前会话后 host 会立刻新建一个空会话接着用，
        // 要是它也占一行，界面上就变成"删掉一个新对话、又冒出一个新对话"。
        // 给了标题/分组的（老数据、手工 meta.json）仍然留着，免得把用户明确命名过的会话藏起来。
        const visible =
          s.events.some((e) => e.kind === 'user/message') || Boolean((s.meta.title ?? '').trim()) || Boolean(item.group)
        summaryCache.set(id, {
          jsonl,
          meta,
          title: item.title,
          group: item.group,
          updatedAt: item.updatedAt,
          turns: item.turns,
          visible,
        })
        if (visible) out.push(item)
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
    assertSessionId(id)
    await rm(join(dataDir, 'sessions', id), { recursive: true, force: true })
    await rm(join(dataDir, 'ckpt', id), { recursive: true, force: true })
    // 附件也归会话：留着就是孤儿文件，用户还会以为"删干净了"
    await rm(join(dataDir, 'files', id), { recursive: true, force: true })
  }

  /**
   * 改标题 / 分组：写 sessions/<id>/meta.json。
   * 没传的字段保持原样；传空串表示清掉（回到自动标题 / 未分组）。
   */
  static async setMeta(dataDir: string, id: string, patch: SessionMeta): Promise<SessionMeta> {
    assertSessionId(id)
    const dir = join(dataDir, 'sessions', id)
    const next: SessionMeta = { ...(await readMeta(dir)) }
    if (patch.title !== undefined) {
      const t = patch.title.trim()
      if (t) next.title = t
      else delete next.title
    }
    if (patch.group !== undefined) {
      const g = patch.group.trim()
      if (g) next.group = g
      else delete next.group
    }
    if (patch.cwd !== undefined) {
      const c = patch.cwd.trim()
      if (c) next.cwd = c
      else delete next.cwd
    }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return next
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
    const custom = (this.meta.title ?? '').trim()
    if (custom) return custom
    const first = this.events.find((e) => e.kind === 'user/message')
    if (!first || first.kind !== 'user/message') return '新对话'
    const t = first.text.replace(/\s+/g, ' ').trim()
    return t.length > 48 ? `${t.slice(0, 48)}…` : t || '新对话'
  }

  nextTurn(): number {
    let n = 0
    for (const e of this.events) if (e.kind === 'turn/start') n = Math.max(n, e.turn)
    return n + 1
  }

  /**
   * 模型历史：只由持久事件投影，绝不额外拼装。
   *
   * 工具产出的截图（tool/result.images）会被投影成紧跟这批工具结果之后的一条 user 消息：
   * tool 消息只能放文本，图片得单独给；但又不能插在 tool_calls → tool 中间（顺序一乱模型就串台），
   * 所以先攒着，等下一批 tool/result 结束才 flush。
   * vision === false 时只给路径、不读 base64（给不支持看图的模型时不能硬塞图片）。
   */
  deriveMessages(opts: { vision?: boolean } = {}): LlmMessage[] {
    const out: LlmMessage[] = []
    const pendingPaths: string[] = []
    const pendingImages: ImagePart[] = []
    const flushShots = (): void => {
      if (!pendingPaths.length) return
      const paths = pendingPaths.splice(0).join('、')
      const images = pendingImages.splice(0)
      out.push({
        role: 'user',
        content: images.length ? `[截图] 上面工具产出的图片（${paths}）。` : `[截图] 已存到 ${paths}（设置里关掉了看图，图片没有发给模型）。`,
        ...(images.length ? { images } : {}),
      })
    }
    for (const e of this.events) {
      if (e.kind === 'tool/result') {
        out.push({
          role: 'tool',
          toolCallId: e.callId,
          content: e.truncated ? `${e.content}\n[输出已截断，完整内容见 ${e.spill ?? 'spill 文件'}]` : e.content,
        })
        for (const img of e.images ?? []) {
          pendingPaths.push(img.path)
          if (opts.vision === false) continue
          try {
            pendingImages.push({ mime: img.mime, dataBase64: readFileSync(img.path).toString('base64') })
          } catch {
            // 截图文件被删了：路径还在，模型至少知道曾经截过一张
          }
        }
      } else {
        // 一批 tool/result 到此结束，截图可以补上了
        flushShots()
        if (e.kind === 'user/message') {
          // 图片存在 attachment 目录里，请求前才读成 base64：日志里不存二进制
          const images = (e.files ?? [])
            .filter((f) => f.mime.startsWith('image/'))
            .map((f) => {
              try {
                return { mime: f.mime, dataBase64: readFileSync(f.path).toString('base64') }
              } catch {
                return null
              }
            })
            .filter((x): x is { mime: string; dataBase64: string } => x !== null)
          out.push({ role: 'user', content: e.text, ...(images.length ? { images } : {}) })
        } else if (e.kind === 'assistant/message') {
          out.push({ role: 'assistant', content: e.text, toolCalls: (e.toolCalls ?? []).length ? e.toolCalls : undefined })
        }
      }
    }
    flushShots()
    // 插话（界面上的「插一句」）是在某一轮跑到一半时 append 进日志的，落点常常正好在
    // assistant(tool_calls) 与它的 tool/result 之间。带 tool_calls 的 assistant 后面必须
    // 紧跟对应的 tool 消息，中间夹一条 user 会让服务端把整批工具结果判为无效 ——
    // 表现就是「插话没生效」：模型照旧按老计划走，那句提醒等于没发。
    // 这里不改日志，只在投影结果上把这句 user 挪到这批工具结果之后。
    function hoistInterjections(msgs: LlmMessage[]): void {
      // 思路：一趟扫过去，遇到「带 tool_calls 的 assistant」就把它后面属于这批的 tool 消息
      // 全部收齐，夹在中间的其它消息（插话）排到这批 tool 之后。这样产出的序列永远满足
      // 「assistant(tool_calls) → 紧跟着它的 tool 消息」。
      const out2: LlmMessage[] = []
      let i = 0
      while (i < msgs.length) {
        const m = msgs[i]!
        out2.push(m)
        i++
        if (m.role !== 'assistant' || !m.toolCalls?.length) continue
        const ids = new Set(m.toolCalls.map((c) => c.id))
        const tools: LlmMessage[] = []
        const strays: LlmMessage[] = []
        // 往后看：连续的 tool 属于这批；夹在其中的非 tool 先攒着；遇到别的东西就停
        while (i < msgs.length) {
          const n = msgs[i]!
          if (n.role === 'tool') {
            tools.push(n)
            i++
            continue
          }
          // 非 tool：这批结果还没收齐时可能是被插话打断（说明工具还在跑、result 尚未写入），
          // 记下来；收齐之后遇到的就不是打断，而是下一段对话，停止。
          if (tools.length < ids.size) {
            strays.push(n)
            i++
            continue
          }
          break
        }
        // 一条 tool 结果都没有（工具正在执行中）：原样保留，插话照旧排在 assistant 之后，
        // 等下一轮投影时 result 已经写入，自然会走到上面的重排分支。
        if (!tools.length) {
          out2.push(...strays)
          continue
        }
        out2.push(...tools, ...strays)
      }
      msgs.length = 0
      msgs.push(...out2)
    }

    hoistInterjections(out)
    return out
  }
}
