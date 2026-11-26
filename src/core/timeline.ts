/**
 * 一轮的时间线：思考块 + 工具调用 + 汇总统计。
 *
 * 界面（ui/PackLeader.ps1）画的那条「思考 → 工具」时间线，字段就照这里来：
 *   状态行        → phase + elapsed（「思考中… 1:30」）
 *   思考摘要卡    → thoughts（「思考了片刻」+ 最新一段）
 *   工具聚合卡    → tools + stats()（「21 次工具调用 · 共 8.4s」/「fs.read ×9 · fs.grep ×7」）
 *
 * 统计只在这里算一处：界面自己实时算的是同一套口径，host 在 turn-end 里
 * 报一份 stats，审计和 CLI 用的数字才对得上。会话事件也能直接折出来
 * （foldEvents，历史回放与离线分析用）。
 */

import type { SessionEvent } from './events.ts'
import type { ToolCall } from './types.ts'

export type ToolState = 'running' | 'done' | 'failed'
export type TurnPhase = 'thinking' | 'tools' | 'answering' | 'done'

export interface ToolItem {
  id: string
  /** 工具名，等宽显示（fs.read / fs.grep / shell…） */
  name: string
  /** 一句话目标：路径 / 搜索词 / 命令行开头 */
  summary: string
  args?: Record<string, unknown>
  state: ToolState
  ms: number
  /** 结果开头一段：展开这一行看到的就是它 */
  preview: string
  error?: string
}

export interface ThoughtBlock {
  text: string
  /** 这一段思考花的时间（毫秒）；正在想的时候是 0 */
  ms: number
}

export interface TurnStats {
  tools: number
  failed: number
  steps: number
  /** 工具耗时合计（毫秒） */
  ms: number
  /** 按调用次数从多到少；同数按名字，界面右侧那一行就是它 */
  byName: Array<{ name: string; count: number }>
}

/** 结果预览截多长：够看出改了什么/查到了什么，又不至于把界面撑爆 */
export const PREVIEW_CHARS = 2000

/** 毫秒 → 「1:30」（状态行那颗计时器用，超过一小时是「1:02:03」） */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** 工具耗时合计：不足 1 秒报毫秒，一分钟内报一位小数秒（和界面组头的「共 8.4s」一致） */
export function formatToolSecs(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return formatClock(ms)
}

export class TurnTimeline {
  phase: TurnPhase = 'thinking'
  thoughts: ThoughtBlock[] = []
  tools: ToolItem[] = []
  steps = 1
  readonly startedAt: number
  endedAt = 0

  private open: ThoughtBlock | null = null
  private byId = new Map<string, ToolItem>()
  private counts = new Map<string, number>()

  constructor(at: number = Date.now()) {
    this.startedAt = at
  }

  /** 思考流式增量：接着当前这一段往下写；没有段落就开一段 */
  reason(text: string): ThoughtBlock {
    if (!this.open) {
      this.open = { text: '', ms: 0 }
      this.thoughts.push(this.open)
    }
    this.open.text += text
    return this.open
  }

  /** 一段思考结束：记下这段花了多久，下一段思考重新开一块 */
  closeThought(ms: number): void {
    if (!this.open) return
    this.open.ms = Math.max(0, Math.round(ms))
    this.open = null
  }

  step(n: number): void {
    const v = Number(n) || 0
    if (v > this.steps) this.steps = v
  }

  toolStart(call: Pick<ToolCall, 'id' | 'name' | 'args'>, summary: string): ToolItem {
    const item: ToolItem = {
      id: String(call.id),
      name: String(call.name),
      summary,
      args: call.args,
      state: 'running',
      ms: 0,
      preview: '',
    }
    this.tools.push(item)
    this.byId.set(item.id, item)
    this.counts.set(item.name, (this.counts.get(item.name) ?? 0) + 1)
    this.phase = 'tools'
    return item
  }

  toolEnd(id: string, r: { ok: boolean; ms: number; content?: string; preview?: string; error?: string }): ToolItem | null {
    const item = this.byId.get(id)
    if (!item) return null
    item.state = r.ok ? 'done' : 'failed'
    item.ms = Math.max(0, Math.round(r.ms))
    item.preview = String(r.preview ?? r.content ?? '').slice(0, PREVIEW_CHARS)
    if (!r.ok) item.error = String(r.error ?? item.preview).slice(0, PREVIEW_CHARS)
    // 状态回退到思考：下一步模型还要接着想（真正的 phase 由 answer/end 改）
    this.phase = 'thinking'
    return item
  }

  answer(): void {
    this.phase = 'answering'
  }

  end(at: number = Date.now()): void {
    this.phase = 'done'
    this.endedAt = at
    if (this.open) this.closeThought(this.elapsed)
  }

  /** 从这一轮开始到「现在」（已结束就定格）：状态行那颗计时器读它 */
  get elapsed(): number {
    const end = this.endedAt > 0 ? this.endedAt : Date.now()
    return Math.max(0, end - this.startedAt)
  }

  stats(): TurnStats {
    let ms = 0
    let failed = 0
    for (const t of this.tools) {
      ms += t.ms
      if (t.state === 'failed') failed++
    }
    const byName = [...this.counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    return { tools: this.tools.length, failed, steps: this.steps, ms, byName }
  }
}

/**
 * 从会话事件折出一轮的时间线（历史回放、离线分析）。
 * 只认 assistant/message 里的思考与工具调用、tool/result 的结果；
 * 一轮的边界由调用方切好（一般是两条 user/message 之间）。
 */
export function foldEvents(events: SessionEvent[]): TurnTimeline {
  const tx = new TurnTimeline(events[0]?.at ?? Date.now())
  let lastAt = tx.startedAt
  for (const e of events) {
    if (typeof e.at === 'number' && e.at > lastAt) lastAt = e.at
    if (e.kind === 'step/start') {
      tx.step(e.step)
    } else if (e.kind === 'assistant/message') {
      if (e.reasoning) {
        tx.reason(e.reasoning)
        tx.closeThought(e.ms)
      }
      for (const c of e.toolCalls) {
        tx.toolStart(c, typeof c.args?.path === 'string' ? c.args.path : '')
      }
    } else if (e.kind === 'tool/result') {
      tx.toolEnd(e.callId, { ok: e.ok, ms: e.ms, content: e.content })
    } else if (e.kind === 'turn/end') {
      lastAt = e.at
    }
  }
  tx.end(lastAt)
  return tx
}
