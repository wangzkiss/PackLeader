/**
 * 上下文压缩：长会话把早期的工具结果和超长文本压成摘要，别让 messages 无限长。
 *
 * 只做「丢细节」：不发额外的模型调用去总结——那要多花一次钱，
 * 而且模型自己也在看这些历史，摘要未必比首行更准。等确实需要再加。
 *
 * 触发条件：估算字符数超过 maxChars。压缩顺序：从最早的消息开始，
 * 最近 keepRecent 条一律不动（模型手头正在用的证据不能丢）。
 */

import type { LlmMessage } from './types.ts'

export interface CompactResult {
  messages: LlmMessage[]
  /** 被压缩的消息条数（0 = 没动） */
  compacted: number
  /** 压缩前 / 后的估算字符数 */
  before: number
  after: number
}

const TOOL_KEEP = 600
const TOOL_KEEP_HARD = 200
const ASSISTANT_KEEP = 1200
const USER_KEEP = 1500

/** 一条消息的估算字符数（图片按 2000 字符/张粗算） */
export function messageChars(m: LlmMessage): number {
  let n = m.content?.length ?? 0
  if (m.toolCalls?.length) n += JSON.stringify(m.toolCalls).length
  if (m.images?.length) n += m.images.length * 2000
  return n
}

export function historyChars(history: LlmMessage[]): number {
  let n = 0
  for (const m of history) n += messageChars(m)
  return n
}

/** 压成「首行 + 一句说明」，首行都没有就是开头 n 个字符 */
function condense(text: string, keep: number): string {
  if (text.length <= keep) return text
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? ''
  const picked = firstLine.length <= keep ? firstLine : firstLine.slice(0, keep)
  return `${picked}\n… [已压缩 ${text.length - picked.length} 字符]`
}

export function compactMessages(history: LlmMessage[], maxChars: number, keepRecent = 6): CompactResult {
  const before = historyChars(history)
  if (before <= maxChars || history.length === 0) {
    return { messages: history, compacted: 0, before, after: before }
  }

  const out = history.map((m) => ({ ...m }))
  const target = Math.floor(maxChars * 0.7)
  let total = before
  let compacted = 0
  const limit = Math.max(0, out.length - keepRecent)

  const shrink = (i: number, keep: number): void => {
    const m = out[i]
    const cur = m.content ?? ''
    const next = condense(cur, keep)
    if (next.length >= cur.length) return
    total -= cur.length - next.length
    m.content = next
    compacted++
  }

  // 第一轮：工具结果压到 600 字，助手长文本压到 1200 字
  for (let i = 0; i < limit && total > target; i++) {
    const m = out[i]
    if (m.role === 'tool') shrink(i, TOOL_KEEP)
    else if (m.role === 'assistant') shrink(i, ASSISTANT_KEEP)
    else if (m.role === 'user') shrink(i, USER_KEEP)
  }

  // 第二轮：还不够就压得更狠（工具结果 200 字），最近若干条依旧不动
  for (let i = 0; i < limit && total > target; i++) {
    if (out[i].role === 'tool') shrink(i, TOOL_KEEP_HARD)
  }

  return { messages: out, compacted, before, after: total }
}
