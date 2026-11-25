/**
 * 会话事件词汇（append-only 日志的唯一真相）。
 *
 * 设计约束（与 DSH 的 session 语义一致）：
 *  - 模型可见即已记录：每个模型请求都能从日志重建（deriveMessages）
 *  - 工具结果只有一条持久事实（tool/result），不会出现「半条」
 *  - 审批是审计事件（approval/asked → approval/decided），模型看不到过程
 */

import type { Attachment, Decision, ToolCall } from './types.ts'

export type EventPayload =
  | { kind: 'session/start'; id: string; cwd: string; model: string; baseURL: string; mode: string; version: string }
  | { kind: 'turn/start'; turn: number }
  | { kind: 'user/message'; text: string; files?: Attachment[] }
  | { kind: 'step/start'; turn: number; step: number }
  | { kind: 'assistant/message'; text: string; reasoning: string; toolCalls: ToolCall[]; ms: number; finish: string | null }
  | { kind: 'tool/call'; turn: number; step: number; call: ToolCall }
  | { kind: 'approval/asked'; reqId: string; tool: string; reason: string }
  | { kind: 'approval/decided'; reqId: string; decision: Decision; auto?: boolean }
  | {
      kind: 'tool/result'
      callId: string
      name: string
      ok: boolean
      content: string
      exitCode?: number
      truncated?: boolean
      spill?: string
      ms: number
    }
  | { kind: 'step/end'; turn: number; step: number; toolCalls: number }
  | { kind: 'verify/start'; turn: number; round: number; label: string }
  | {
      kind: 'verify/end'
      turn: number
      round: number
      label: string
      ok: boolean
      exitCode: number
      ms: number
      output: string
      timedOut: boolean
    }
  | { kind: 'turn/end'; turn: number; reason: 'done' | 'max-steps' | 'error' | 'cancelled'; error?: string }
  | { kind: 'memory/saved'; items: Array<{ id: string; text: string; at: number }> }
  | { kind: 'memory/undone'; ids: string[] }
  | { kind: 'llm/usage'; turn: number; step: number; prompt: number; completion: number; cacheRead: number; ms: number; model: string }

export interface EventBase {
  seq: number
  at: number
}

export type SessionEvent = EventBase & EventPayload

export type EventInput = EventPayload
