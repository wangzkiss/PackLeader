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
  /** 可重试失败的次数（429 / 5xx / 网络错误），默认 2 */
  retries?: number
  /** 退避基数：第 n 次重试等 base × 3^(n-1)，默认 500ms */
  retryBaseMs?: number
  /** 首字节超时：请求发出去多久还没等到第一个字节就算失败，默认 30s */
  firstByteMs?: number
  /** 流空闲超时：两个数据块之间最多等多久，默认 90s */
  idleMs?: number
}

/** 请求层错误：retryable 决定外层要不要退避重试 */
export class LlmError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'LlmError'
    this.retryable = retryable
  }
}

/** 退避：1 → base，2 → 3×base，3 → 9×base……封顶 30s */
function backoffMs(base: number, attempt: number): number {
  return Math.min(30_000, base * 3 ** (attempt - 1))
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
    const retries = Math.max(0, this.cfg.retries ?? 2)
    const base = Math.max(1, this.cfg.retryBaseMs ?? 500)
    let lastErr: unknown = new Error('LLM 请求失败')
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await this.wait(backoffMs(base, attempt), opts.signal)
      try {
        return await this.once(opts, started)
      } catch (e) {
        lastErr = e
        // 只有标了 retryable 的（429 / 5xx / 连不上 / 首字节超时）才重来；
        // 401 这类配置错误重试多少次都一样，用户取消更不能重试
        if (!(e instanceof LlmError) || !e.retryable || attempt >= retries) throw e
        if (opts.signal?.aborted) throw e
      }
    }
    throw lastErr
  }

  /** 退避等待；中途被取消就立刻结束，不白等 */
  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((ok, fail) => {
      if (signal?.aborted) {
        fail(new LlmError('LLM 请求已取消', false))
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        fail(new LlmError('LLM 请求已取消', false))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        ok()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** 单次请求：首字节超时、块间空闲超时都在这一层看着 */
  private async once(opts: ChatOptions, started: number): Promise<ChatResult> {
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

    const firstByteMs = this.cfg.firstByteMs ?? 30_000
    const idleMs = this.cfg.idleMs ?? 90_000
    const hardMs = this.cfg.timeoutMs ?? 300_000

    // 三层计时：首字节（连不上/不回包）、块间空闲、整体兜底；任一层到期都 abort
    const ctrl = new AbortController()
    let why: '' | 'user' | 'first-byte' | 'idle' | 'hard' = ''
    const abortWith = (kind: typeof why) => {
      if (ctrl.signal.aborted) return
      why = kind
      ctrl.abort()
    }
    const onUserAbort = () => abortWith('user')
    if (opts.signal) {
      if (opts.signal.aborted) throw new LlmError('LLM 请求已取消', false)
      opts.signal.addEventListener('abort', onUserAbort, { once: true })
    }
    let firstTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => abortWith('first-byte'), firstByteMs)
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const hardTimer = setTimeout(() => abortWith('hard'), hardMs)
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => abortWith('idle'), idleMs)
    }
    const clearFirst = () => {
      if (firstTimer) {
        clearTimeout(firstTimer)
        firstTimer = null
      }
    }
    const cleanup = () => {
      if (firstTimer) clearTimeout(firstTimer)
      if (idleTimer) clearTimeout(idleTimer)
      clearTimeout(hardTimer)
      opts.signal?.removeEventListener('abort', onUserAbort)
    }
    /** 把底层中断 / 网络错误翻成人话；retryable 交给外层决定要不要再试 */
    const translate = (e: unknown): LlmError => {
      if (e instanceof LlmError) return e
      if (why === 'user') return new LlmError('LLM 请求已取消', false)
      if (why === 'first-byte') return new LlmError(`LLM 首字节超时（${firstByteMs}ms 内没收到任何数据）`, true)
      if (why === 'idle') return new LlmError(`LLM 流空闲超时（${idleMs}ms 没收到新数据，连接已中断）`, false)
      if (why === 'hard') return new LlmError(`LLM 请求超时（${hardMs}ms）`, true)
      const msg = e instanceof Error ? e.message : String(e)
      return new LlmError(`LLM 请求失败：${msg}`, true)
    }

    let res: Awaited<ReturnType<typeof fetch>>
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (e) {
      cleanup()
      throw translate(e)
    }
    // 响应头到了就算首字节到了，之后盯「块与块之间」的间隔
    clearFirst()

    if (!res.ok || !res.body) {
      resetIdle()
      const detail = await res.text().catch(() => '')
      cleanup()
      const retryable = res.status === 429 || res.status >= 500
      throw new LlmError(`LLM ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`, retryable)
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
    resetIdle()
    let done = false
    try {
      while (!done) {
        const { value, done: eof } = await reader.read()
        if (eof) break
        resetIdle()
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
    } catch (e) {
      throw translate(e)
    } finally {
      cleanup()
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
