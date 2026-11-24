/**
 * 终端渲染：行式输出（不做全屏 alt-buffer）。
 *
 * 设计取舍：首版用行式流，稳定、可复制、可进 CI 日志；
 * 需要全屏交互时再换 Ink，`Renderer` 接口不变（见 DESIGN.md §5.5）。
 */

import type { Renderer } from '../core/loop.ts'
import type { ToolCall, ToolResult } from '../core/types.ts'

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

const wrap = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
export const dim = (s: string) => wrap('2', s)
export const bold = (s: string) => wrap('1', s)
export const cyan = (s: string) => wrap('36', s)
export const green = (s: string) => wrap('32', s)
export const red = (s: string) => wrap('31', s)
export const yellow = (s: string) => wrap('33', s)
export const gray = (s: string) => wrap('90', s)

const out = (s: string) => process.stdout.write(s)

/** 从参数里挑一个最能说明意图的值做卡片标题 */
export function argSummary(call: ToolCall): string {
  const a = call.args ?? {}
  for (const k of ['path', 'command', 'pattern', 'query', 'include']) {
    const v = a[k]
    if (typeof v === 'string' && v) {
      const s = v.replace(/\s+/g, ' ')
      return s.length > 72 ? `${s.slice(0, 72)}…` : s
    }
  }
  const json = JSON.stringify(a)
  return json.length > 72 ? `${json.slice(0, 72)}…` : json
}

export interface CliRendererOptions {
  showReasoning?: boolean
  /** JSON 模式：不打印人类可读内容，只把事件交给 onEvent */
  json?: boolean
  onEvent?: (e: Record<string, unknown>) => void
}

export class CliRenderer implements Renderer {
  private streaming = false
  private reasoningOpen = false
  private opts: CliRendererOptions
  private step = 0

  constructor(opts: CliRendererOptions = {}) {
    this.opts = opts
  }

  private emit(kind: string, data: Record<string, unknown> = {}): void {
    this.opts.onEvent?.({ kind, at: Date.now(), ...data })
  }

  onTurnStart(turn: number, text: string): void {
    if (this.opts.json) {
      this.emit('turn/start', { turn, text })
      return
    }
    out(`\n${cyan('›')} ${text}\n`)
  }

  onStepStart(step: number): void {
    this.step = step
    this.emit('step/start', { step })
  }

  onReasoning(chunk: string): void {
    if (!this.opts.showReasoning || this.opts.json) return
    if (!this.reasoningOpen) {
      out(dim('\n  thinking: '))
      this.reasoningOpen = true
    }
    out(dim(chunk.replace(/\n/g, '\n  ')))
  }

  onText(chunk: string): void {
    if (this.opts.json) return
    if (this.reasoningOpen) {
      out('\n')
      this.reasoningOpen = false
    }
    if (!this.streaming) {
      out('\n')
      this.streaming = true
    }
    out(chunk)
  }

  onAssistantEnd(text: string): void {
    this.emit('assistant/message', { step: this.step, text })
    if (this.opts.json) return
    if (this.streaming) out('\n')
    this.streaming = false
    if (this.reasoningOpen) {
      out('\n')
      this.reasoningOpen = false
    }
  }

  onToolStart(call: ToolCall): void {
    this.emit('tool/call', { id: call.id, name: call.name, args: call.args })
    if (this.opts.json) return
    out(`  ${dim('⚙')} ${bold(call.name)} ${gray(argSummary(call))}\n`)
  }

  onToolEnd(call: ToolCall, result: ToolResult): void {
    this.emit('tool/result', {
      id: call.id,
      name: call.name,
      ok: result.ok,
      ms: result.ms,
      exitCode: result.exitCode,
      truncated: result.truncated === true,
      content: result.content.slice(0, 2000),
    })
    if (this.opts.json) return
    const mark = result.ok ? green('✓') : red('✗')
    out(`    ${mark} ${gray(`${result.ms}ms`)}${result.truncated ? yellow(' (已截断)') : ''}\n`)
    if (!result.ok) {
      const lines = result.content.split('\n').slice(0, 4)
      for (const l of lines) out(dim(`    │ ${l.slice(0, 160)}`) + '\n')
    }
  }

  onNotice(text: string): void {
    this.emit('notice', { text })
    if (!this.opts.json) out(yellow(`\n  ! ${text}\n`))
  }

  banner(meta: { model: string; mode: string; root: string; session: string; version: string }): void {
    if (this.opts.json) return
    out(bold(`\n PackLeader v${meta.version}`) + dim(`  ·  ${meta.model}  ·  ${meta.mode}\n`))
    out(dim(` cwd: ${meta.root}\n session: ${meta.session}\n\n`))
  }
}
