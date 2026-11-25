/**
 * OpenAI 兼容适配器（`POST {baseURL}/chat/completions`，SSE 流式）。
 *
 * 为什么自己写：DSH 只随附 DeepSeek 的 Messages wire，而现场网关
 * （one-api / vLLM / LM Studio / Ollama / LiteLLM）绝大多数是 OpenAI 形态。
 *
 * 两个容易写错的点，这里显式处理：
 *  1. `delta.tool_calls[].function.arguments` 是**按 index 分片**到达的，必须聚合再 JSON.parse
 *  2. `usage` 只在带 `stream_options.include_usage` 时出现，且常与空 choices 同帧
 */

import type { LlmMessage, ToolCall, ToolSchema } from '../core/types.ts'

export interface OpenAiConfig {
  baseURL: string
  apiKey: string
  model: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  /** 透传给厂商的额外字段，如 { thinking: { type: 'enabled' } } */
  extraBody?: Record<string, unknown>
}

export interface ChatOptions {
  messages: LlmMessage[]
  tools: ToolSchema[]
  signal?: AbortSignal
  onText?: (chunk: string) => void
  onReasoning?: (chunk: string) => void
}

export interface ChatResult {
  text: string
  reasoning: string
  toolCalls: ToolCall[]
  usage: { prompt: number; completion: number; cacheRead: number }
  finish: string | null
  ms: number
}

interface WireMessage {
  role: string
  content: string | null | Array<Record<string, unknown>>
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export class OpenAiClient {
  readonly cfg: OpenAiConfig

  constructor(cfg: OpenAiConfig) {
    this.cfg = { timeoutMs: 300_000, temperature: 0.2, ...cfg }
  }

  private toWire(messages: LlmMessage[]): WireMessage[] {
    return messages.map((m) => {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: c.rawArguments ?? JSON.stringify(c.args ?? {}) },
          })),
        }
      }
      if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' }
      // 带图片时 content 变成 parts 数组（OpenAI 多模态格式）；没有图片就还是纯字符串，
      // 这样老网关/老模型的行为完全不变
      if (m.role === 'user' && m.images?.length) {
        return {
          role: 'user',
          content: [
            { type: 'text', text: m.content },
            ...m.images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mime};base64,${img.dataBase64}` },
            })),
          ],
        }
      }
      return { role: m.role, content: m.content }
    })
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const started = Date.now()
    const url = `${this.cfg.baseURL.replace(/\/+$/, '')}/chat/completions`
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: this.toWire(opts.messages),
      stream: true,
      stream_options: { include_usage: true },
      temperature: this.cfg.temperature,
      ...(this.cfg.maxTokens ? { max_tokens: this.cfg.maxTokens } : {}),
      ...(this.cfg.extraBody ?? {}),
    }
    if (opts.tools.length) {
      body.tools = opts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
      body.tool_choice = 'auto'
    }

    const timeout = AbortSignal.timeout(this.cfg.timeoutMs ?? 300_000)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      throw new Error(`LLM ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`)
    }

    let text = ''
    let reasoning = ''
    let finish: string | null = null
    const usage = { prompt: 0, completion: 0, cacheRead: 0 }
    /** index → 聚合中的调用 */
    const pending = new Map<number, { id: string; name: string; args: string }>()

    const decoder = new TextDecoder()
    let buffer = ''
    const consume = (raw: string): boolean => {
      // 一个 SSE 事件可能有多行 data:
      const data = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('')
      if (!data) return true
      if (data === '[DONE]') return false
      let chunk: any
      try {
        chunk = JSON.parse(data)
      } catch {
        return true
      }
      if (chunk.usage) {
        usage.prompt = chunk.usage.prompt_tokens ?? usage.prompt
        usage.completion = chunk.usage.completion_tokens ?? usage.completion
        usage.cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens ?? usage.cacheRead
      }
      const choice = chunk.choices?.[0]
      if (!choice) return true
      if (choice.finish_reason) finish = choice.finish_reason
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content
        opts.onText?.(delta.content)
      }
      const r = delta.reasoning_content ?? delta.reasoning
      if (typeof r === 'string' && r) {
        reasoning += r
        opts.onReasoning?.(r)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0
          const cur = pending.get(idx) ?? { id: '', name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name += tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          pending.set(idx, cur)
        }
      }
      return true
    }

    const reader = res.body.getReader()
    let done = false
    while (!done) {
      const { value, done: eof } = await reader.read()
      if (eof) break
      buffer += decoder.decode(value, { stream: true })
      let sep = buffer.indexOf('\n\n')
      while (sep !== -1) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        if (!consume(raw)) {
          done = true
          break
        }
        sep = buffer.indexOf('\n\n')
      }
    }
    if (!done && buffer.trim()) consume(buffer)

    const toolCalls: ToolCall[] = [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c], i) => {
        const id = c.id || `call_${i}`
        let args: Record<string, unknown> = {}
        try {
          args = c.args ? (JSON.parse(c.args) as Record<string, unknown>) : {}
        } catch {
          args = {}
        }
        return { id, name: c.name, args, rawArguments: c.args || '{}' }
      })
      .filter((c) => c.name)

    if (finish === null && toolCalls.length) finish = 'tool_calls'
    if (!text && !toolCalls.length && !reasoning) {
      throw new Error(`LLM 返回空响应（finish=${finish ?? 'null'}）`)
    }
    return { text, reasoning, toolCalls, usage, finish, ms: Date.now() - started }
  }
}
