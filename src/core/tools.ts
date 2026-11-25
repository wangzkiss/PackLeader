/**
 * 工具契约与注册表。
 *
 * 与 DSH 的 `ctx.tools` 同形：schema 进提示词，permission 进策略，
 * run() 只负责「做这件事」，超时/截断/审批/审计都在外层流水线统一处理。
 */

import type { Permission, ToolResult, ToolSchema } from './types.ts'

/** 向用户提问：question + 2-4 个选项；返回选中的那一项，没作答返回 null */
export interface AskRequest {
  question: string
  options: string[]
}

export type Asker = (req: AskRequest) => Promise<string | null>

export interface ToolContext {
  root: string
  spillDir: string
  maxOutputBytes: number
  signal?: AbortSignal
  /** 会话内已读文件（供「先读后写」提示，不强制） */
  readFiles: Set<string>
  /** 提问通道：GUI 注入；没有时 ask 工具会返回「没有可用通道」 */
  ask?: Asker
}

export interface ToolOutcome {
  content: string
  exitCode?: number
  meta?: Record<string, unknown>
  /** 结构化结果（给界面画专用卡片，比如 todo 的 items） */
  data?: unknown
}

export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  permission: Permission
  /** 写类工具声明要快照的绝对路径（缺省则不快照） */
  targets?: (args: Record<string, unknown>) => string[]
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome>
}

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): this {
    this.tools.set(tool.name, tool)
    return this
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  all(): Tool[] {
    return [...this.tools.values()]
  }

  schemas(): ToolSchema[] {
    return this.all().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  }

  /** 面向模型的清单（用于系统提示） */
  describe(): string {
    return this.all()
      .map((t) => `- ${t.name}(${t.permission})：${t.description.split('\n')[0]}`)
      .join('\n')
  }
}

export function needString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || !v) throw new Error(`参数 ${key} 必填（string）`)
  return v
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v ? v : undefined
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

/** 统一的失败结果（不抛异常，让模型看到可读错误） */
export function fail(message: string, ms = 0): ToolResult {
  return { ok: false, content: message, ms }
}
