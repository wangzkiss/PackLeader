/**
 * 公共类型：消息、工具、权限、决策。
 *
 * 这里的词汇刻意与 DeepSeek Harness 的 seam 对齐（见 DESIGN.md §5）：
 *   LlmMessage   ↔ dsh-llm 的 message 词汇
 *   ToolSchema   ↔ ctx.tools 注册的 schema
 *   Permission   ↔ ToolDefinition.permission
 *   Decision     ↔ approval 的结果词汇（allowed-once / denied / unavailable / cancelled）
 * 以后要换成 DSH 运行时，替换的是实现，不是这些类型。
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  /** 已解析的参数；解析失败时保留原始字符串在 rawArguments */
  args: Record<string, unknown>
  rawArguments?: string
}

export interface LlmMessage {
  role: Role
  content: string
  /**
   * 图片（只给支持视觉的模型用）。base64 不带前缀，mime 单独存，
   * 因为落盘到事件日志时要能原样读回来。
   */
  images?: ImagePart[]
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export interface ImagePart {
  mime: string
  dataBase64: string
}

/** 用户带进来的附件：拷贝到数据目录后只记路径，不把内容塞进日志 */
export interface Attachment {
  name: string
  path: string
  bytes: number
  mime: string
  /** 文本类附件已把内容拼进消息正文，这里标一下，回头知道为什么模型"没读文件也看得到" */
  inlined?: boolean
}

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema（object 根） */
  parameters: Record<string, unknown>
}

/** 工具对世界的副作用级别：read 无需审批，write 需要过策略 */
export type Permission = 'read' | 'write'

export interface ToolResult {
  ok: boolean
  content: string
  /** 进程退出码（仅命令类工具有） */
  exitCode?: number
  truncated?: boolean
  /** 被截断时完整输出的落盘路径 */
  spill?: string
  ms: number
  meta?: Record<string, unknown>
  /** 结构化结果（给界面画专用卡片用，比如计划卡读 todo 的 items） */
  data?: unknown
}

/** 审批结果词汇：一次性 / 本会话内对同类操作不再问 / 拒绝 / 无通道 / 取消 */
export type Decision = 'allowed-once' | 'allowed-session' | 'denied' | 'unavailable' | 'cancelled'

/** 运行模式：三档，与 DESIGN.md §6.3 一致 */
export type Mode = 'read-only' | 'guarded' | 'full'
