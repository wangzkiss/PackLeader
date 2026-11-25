/**
 * 主循环：turn → step → tool batch，全程落事件。
 *
 * 与 DSH agent-loop 同构的最小实现：
 *   1. 请求前从日志投影消息（deriveMessages），不维护第二份状态
 *   2. 工具调用逐条过流水线：策略 → 审批 → 快照 → 执行 → 截断 → 审计
 *   3. 每一步结束落 step/end，每轮结束落 turn/end；崩溃只会丢最后一条
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Audit } from './audit.ts'
import type { ApprovalBroker } from './approval.ts'
import type { Checkpoints } from './checkpoint.ts'
import type { Policy } from './policy.ts'
import { dangerOf } from './policy.ts'
import type { Session } from './session.ts'
import type { ToolRegistry } from './tools.ts'
import { compactMessages } from './compact.ts'
import type { Attachment, Decision, LlmMessage, ToolCall, ToolResult } from './types.ts'
import { detectVerifier, runVerifier, type VerifyResult } from './verify.ts'
import type { OpenAiClient } from '../llm/openai.ts'

export interface Renderer {
  onTurnStart?(turn: number, text: string, files?: Attachment[]): void
  onStepStart?(step: number): void
  onReasoning?(chunk: string): void
  onText?(chunk: string): void
  onAssistantEnd?(text: string): void
  onToolStart?(call: ToolCall): void
  onToolEnd?(call: ToolCall, result: ToolResult): void
  onVerifyStart?(label: string, round: number): void
  onVerifyEnd?(r: VerifyResult, round: number): void
  onNotice?(text: string): void
}

export interface AgentOptions {
  session: Session
  llm: OpenAiClient
  tools: ToolRegistry
  policy: Policy
  broker: ApprovalBroker
  checkpoints: Checkpoints
  audit: Audit
  dataDir: string
  renderer?: Renderer
  maxSteps?: number
  maxOutputBytes?: number
  systemPrompt?: string
  signal?: AbortSignal
  /**
   * 验证闭环：改过文件后自动跑的项目测试。
   *  - undefined：自动识别（detectVerifier）
   *  - null：关掉
   *  - {label}：用指定的命令
   */
  verify?: { label: string } | null
  /** 验证失败后最多让它自己修几轮（默认 1，够用又不至于上头） */
  maxVerifyRounds?: number
  /** 验证超时，默认 180s */
  verifyTimeoutMs?: number
  /** 上下文压缩阈值（估算字符数，默认 240k ≈ 60k token） */
  maxContextChars?: number
  /** 提问通道（GUI 注入；没有时 ask 工具会如实说没通道） */
  ask?: Asker
}

export interface TurnResult {
  text: string
  steps: number
  toolCalls: number
  reason: 'done' | 'max-steps' | 'error' | 'cancelled'
}

// 单轮步数上限：复杂任务（多文件改动 + 验证闭环）40 步常常不够，中途被强制收尾；
// 提到 100 步，仍然有硬上限，不会无限跑。命令行 --max-steps 可覆盖。
const DEFAULT_MAX_STEPS = 100
const DEFAULT_MAX_OUTPUT = 64 * 1024
/** 上下文压缩阈值：估算字符数超了就把早期的工具结果压成摘要 */
const DEFAULT_MAX_CONTEXT = 240_000

/** 按字节预算取一段前缀，不把多字节字符切碎 */
function headOfBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid
    else hi = mid - 1
  }
  // 最后一格可能正好落在 emoji 的代理对中间，退回去一个，别留下孤立代理项
  if (lo > 0 && isHighSurrogate(s.charCodeAt(lo - 1))) lo--
  return s.slice(0, lo)
}

/** 按字节预算取一段后缀，不把多字节字符切碎 */
function tailOfBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (Buffer.byteLength(s.slice(mid), 'utf8') <= maxBytes) hi = mid
    else lo = mid + 1
  }
  // 起点落在代理对的后半截时往后挪一格
  if (lo < s.length && isLowSurrogate(s.charCodeAt(lo))) lo++
  return s.slice(lo)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * 把超长输出裁到 max 字节以内：头 60% + 尾 25% 的字节预算。
 * 早先按「原内容的 60% 字符 + 25% 字符」切，758KB 的输出裁完还剩 645KB，
 * 64KB 的上限等于没设——按预算切才能真正把上下文压住。
 */
export function truncateOutput(
  content: string,
  max: number,
  spill?: string,
): { content: string; truncated: boolean; omittedChars: number } {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes <= max) return { content, truncated: false, omittedChars: 0 }
  const head = headOfBytes(content, Math.floor(max * 0.6))
  const tail = tailOfBytes(content, Math.floor(max * 0.25))
  const omitted = content.length - head.length - tail.length
  const where = spill ? `，完整内容见 ${spill}` : ''
  return {
    content: `${head}\n\n… [省略 ${omitted} 字符 / 共 ${bytes} 字节${where}] …\n\n${tail}`,
    truncated: true,
    omittedChars: omitted,
  }
}

export class Agent {
  private opts: AgentOptions
  private pendingApproval: string | null = null
  /** 本会话内已授权「同类操作不再问」的 key（tool:目标） */
  private readonly sessionAllowed = new Set<string>()
  /** 可逐轮设置：GUI 点「停止」时中断当前轮，不需要重建 Agent */
  signal?: AbortSignal

  constructor(opts: AgentOptions) {
    this.opts = opts
    this.signal = opts.signal
  }

  get session(): Session {
    return this.opts.session
  }

  private systemPrompt(): string {
    const { policy, tools } = this.opts
    const base = this.opts.systemPrompt ?? ''
    return [
      base,
      base ? '' : '你是一个在本机工作的软件工程助手。',
      `工作目录：${policy.root}`,
      `当前模式：${policy.mode}（read-only 只能读；guarded 写/执行需逐条确认；full 不询问）`,
      '',
      '工作规则：',
      '1. 先读再改。改之前用一句话说明改什么，然后直接动手。',
      '2. 不要凭记忆猜文件内容，用 read；不要猜路径，用 glob/grep。',
      '3. 命令输出很长时自己挑重点，不要把整段贴回用户。',
      '4. 任务完成后给结论和验证方式，不要罗列过程。',
      `5. 预算意识：单轮最多 ${this.opts.maxSteps ?? DEFAULT_MAX_STEPS} 步，到上限会被强制收尾。` +
        '证据够了就回答，不要为了“更全面”无限探索。',
      '6. 大文件别整篇翻：先用 grep 定位行号，再 read 带 offset/limit 精确取几段。同一个文件反复分页读通常说明该换搜索词了。',
      '',
      '可用工具：',
      tools.describe(),
    ]
      .filter((s) => s !== '')
      .join('\n')
  }

  private messages(): LlmMessage[] {
    const history = this.opts.session.deriveMessages()
    // 长会话别把窗口撑爆：早期工具结果压成摘要，最近几条原样留着
    const { messages } = compactMessages(history, this.opts.maxContextChars ?? DEFAULT_MAX_CONTEXT)
    return [{ role: 'system', content: this.systemPrompt() }, ...messages]
  }

  /** 截断 + 溢出落盘：这是上下文不炸的关键 */
  private async truncate(content: string): Promise<{ content: string; truncated: boolean; spill?: string }> {
    const max = this.opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes <= max) return { content, truncated: false }

    const hash = createHash('sha256').update(content).digest('hex').slice(0, 12)
    const spillDir = join(this.opts.dataDir, 'spill')
    const spill = join(spillDir, `${Date.now()}-${hash}.log`)
    await mkdir(spillDir, { recursive: true }).catch(() => undefined)
    await writeFile(spill, content, 'utf8').catch(() => undefined)

    const clipped = truncateOutput(content, max, spill)
    return { content: clipped.content, truncated: true, spill }
  }

  private async executeTool(
    call: ToolCall,
    turn: number,
    step: number,
  ): Promise<{ result: ToolResult; decision?: Decision }> {
    const { tools, policy, broker, checkpoints, audit, session, renderer } = this.opts
    const startedAt = Date.now()
    renderer?.onToolStart?.(call)

    const tool = tools.get(call.name)
    if (!tool) {
      // 模型编了个不存在的工具也要留痕：这是提示词/工具描述该修的信号
      const error = `没有名为 ${call.name} 的工具`
      audit.recordToolCall({
        sessionId: session.id,
        turn,
        step,
        callId: call.id,
        tool: call.name,
        argsJson: JSON.stringify(call.args).slice(0, 2000),
        decision: 'unknown-tool',
        status: 'failed',
        ok: false,
        error,
        ms: 0,
        outBytes: 0,
        startedAt,
        finishedAt: Date.now(),
      })
      const result: ToolResult = { ok: false, content: error, ms: 0 }
      renderer?.onToolEnd?.(call, result)
      return { result }
    }

    const targets = (() => {
      try {
        return tool.targets?.(call.args) ?? []
      } catch {
        return []
      }
    })()

    // 1) 策略 + 危险命令升级
    const cmdText = String(call.args.command ?? call.args.cmd ?? '')
    const danger = cmdText ? dangerOf(cmdText) : null
    const allowKey = `${tool.name}:${targets[0] ?? (cmdText.slice(0, 120) || '*')}`
    let gate = policy.gate(tool.permission, targets[0], cmdText)
    // 危险命令：full 档也要问一次
    if (danger) gate = 'ask'
    let decision: Decision | undefined
    let autoApproved = false
    if (gate === 'deny') {
      decision = 'denied'
      const reason =
        policy.mode === 'read-only'
          ? `read-only 模式下不允许 ${tool.name}`
          : `路径越界（${policy.mode}）：${targets[0] ?? ''}`
      const result: ToolResult = { ok: false, content: `已拒绝：${reason}`, ms: 0 }
      await session.append({ kind: 'approval/decided', reqId: `deny-${startedAt}`, decision })
      audit.recordApproval({
        sessionId: session.id,
        reqId: `deny-${startedAt}`,
        tool: tool.name,
        reason,
        decision,
        at: Date.now(),
      })
      audit.recordToolCall({
        sessionId: session.id,
        turn,
        step,
        callId: call.id,
        tool: tool.name,
        argsJson: JSON.stringify(call.args),
        decision,
        status: 'denied',
        ok: false,
        error: reason,
        ms: 0,
        outBytes: 0,
        startedAt,
        finishedAt: Date.now(),
      })
      renderer?.onToolEnd?.(call, result)
      return { result, decision }
    }

    // 2) 审批：本会话授权过的同类操作直接放行，其余问一次
    if (gate === 'ask') {
      const reqId = `ap-${startedAt}-${call.id}`
      const reason = danger
        ? `${tool.name} 命中危险操作：${danger.why}（${danger.match}）`
        : `${tool.name} 需要写权限`
      if (this.sessionAllowed.has(allowKey)) {
        decision = 'allowed-session'
        autoApproved = true
        await session.append({ kind: 'approval/decided', reqId, decision, auto: autoApproved || undefined })
      } else {
        // --yes / PL_APPROVAL=allow 时没经过人，审计要能区分
        autoApproved = broker.policy !== 'ask'
        await session.append({ kind: 'approval/asked', reqId, tool: tool.name, reason })
        this.pendingApproval = reqId
        decision = await broker.decide({
          reqId,
          tool: tool.name,
          reason,
          detail: danger ? `${danger.why}｜${cmdText.slice(0, 300)}` : targets[0] ?? JSON.stringify(call.args).slice(0, 300),
        })
        this.pendingApproval = null
        // 「本会话都允许」：只对这同一个工具 + 同一个目标生效
        if (decision === 'allowed-session') this.sessionAllowed.add(allowKey)
        await session.append({ kind: 'approval/decided', reqId, decision, auto: autoApproved || undefined })
        audit.recordApproval({ sessionId: session.id, reqId, tool: tool.name, reason, decision, at: Date.now() })
      }

      if (decision !== 'allowed-once' && decision !== 'allowed-session') {
        const why = decision === 'denied' ? '用户拒绝' : decision === 'unavailable' ? '没有可用的审批通道' : '已取消'
        const result: ToolResult = { ok: false, content: `已拒绝（${why}）：${tool.name}`, ms: 0 }
        audit.recordToolCall({
          sessionId: session.id,
          turn,
          step,
          callId: call.id,
          tool: tool.name,
          argsJson: JSON.stringify(call.args),
          decision,
          status: 'denied',
          ok: false,
          error: why,
          ms: 0,
          outBytes: 0,
          startedAt,
          finishedAt: Date.now(),
        })
        renderer?.onToolEnd?.(call, result)
        return { result, decision }
      }
    }

    // 3) 写前快照
    let manifest: Awaited<ReturnType<Checkpoints['snapshot']>> | undefined
    if (targets.length && tool.permission === 'write') {
      manifest = await checkpoints
        .snapshot(session.id, { turn, step, callId: call.id, cwd: policy.root }, targets)
        .catch(() => undefined)
    }

    // 4) 执行
    const t0 = Date.now()
    let result: ToolResult
    try {
      const out = await tool.run(
        {
          root: policy.root,
          spillDir: join(this.opts.dataDir, 'spill'),
          maxOutputBytes: this.opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
          signal: this.signal,
          readFiles: new Set(),
          ask: this.opts.ask,
        },
        call.args,
      )
      const t = await this.truncate(out.content)
      result = {
        ok: out.exitCode === undefined || out.exitCode === 0,
        content: t.content,
        truncated: t.truncated,
        spill: t.spill,
        exitCode: out.exitCode,
        ms: Date.now() - t0,
        meta: out.meta,
        data: out.data,
      }
    } catch (e) {
      result = { ok: false, content: `工具执行失败：${(e as Error).message}`, ms: Date.now() - t0 }
    }

    if (manifest) await checkpoints.finalize(session.id, manifest).catch(() => undefined)

    audit.recordToolCall({
      sessionId: session.id,
      turn,
      step,
      callId: call.id,
      tool: tool.name,
      argsJson: JSON.stringify(call.args),
      decision: decision ?? 'allowed',
      auto: autoApproved,
      status: result.ok ? 'done' : 'failed',
      ok: result.ok,
      exitCode: result.exitCode,
      error: result.ok ? undefined : result.content.slice(0, 500),
      ms: result.ms,
      outBytes: Buffer.byteLength(result.content, 'utf8'),
      truncated: result.truncated,
      startedAt,
      finishedAt: Date.now(),
    })
    renderer?.onToolEnd?.(call, result)
    return { result, decision }
  }

  async runTurn(userText: string, files?: Attachment[]): Promise<TurnResult> {
    const { session, llm, renderer, audit, policy, tools } = this.opts
    const turn = session.nextTurn()
    const maxSteps = this.opts.maxSteps ?? DEFAULT_MAX_STEPS

    await session.append({ kind: 'turn/start', turn })
    await session.append({ kind: 'user/message', text: userText, ...(files?.length ? { files } : {}) })
    renderer?.onTurnStart?.(turn, userText, files)

    let finalText = ''
    let reason: TurnResult['reason'] = 'done'
    let steps = 0
    let totalCalls = 0

    // 验证闭环用的状态
    const maxVerifyRounds = this.opts.maxVerifyRounds ?? 1
    const touched = new Set<string>()
    let verifyRound = 0
    let stepBase = 0

    // 本回合内出现过的 tool+args，用提示「这一步和前面某步完全一样」
    const seenCalls = new Map<string, number>()

    try {
      for (;;) {
        for (let i = 1; i <= maxSteps; i++) {
          // step 编号跨验证轮次连续递增，日志里不会出现两个 step 1
          const step = stepBase + i
          if (this.signal?.aborted) {
            reason = 'cancelled'
            break
          }
          steps = step
        await session.append({ kind: 'step/start', turn, step })
        renderer?.onStepStart?.(step)

        const messages = this.messages()
        const res = await llm.chat({
          messages,
          tools: tools.schemas(),
          signal: this.signal,
          onText: (c) => renderer?.onText?.(c),
          onReasoning: (c) => renderer?.onReasoning?.(c),
        })

        await session.append({
          kind: 'assistant/message',
          text: res.text,
          reasoning: res.reasoning,
          toolCalls: res.toolCalls,
          ms: res.ms,
          finish: res.finish,
        })
        await session.append({
          kind: 'llm/usage',
          turn,
          step,
          prompt: res.usage.prompt,
          completion: res.usage.completion,
          cacheRead: res.usage.cacheRead,
          ms: res.ms,
          model: llm.cfg.model,
        })
        audit.recordLlmCall({
          sessionId: session.id,
          turn,
          step,
          model: llm.cfg.model,
          msgs: messages.length,
          toolsN: tools.all().length,
          prompt: res.usage.prompt,
          completion: res.usage.completion,
          cacheRead: res.usage.cacheRead,
          ms: res.ms,
          finish: res.finish,
          at: Date.now(),
        })
        renderer?.onAssistantEnd?.(res.text)
        if (res.text) finalText = res.text

        if (!res.toolCalls.length) {
          await session.append({ kind: 'step/end', turn, step, toolCalls: 0 })
          break
        }

        for (const call of res.toolCalls) {
          totalCalls++
          await session.append({ kind: 'tool/call', turn, step, call })
          const sig = `${call.name}:${JSON.stringify(call.args)}`
          const dupOf = seenCalls.get(sig)
          if (dupOf === undefined) seenCalls.set(sig, step)
          const { result } = await this.executeTool(call, turn, step)
          // 一字不差的重复调用：结果照给，但提醒一句，别让模型把它当新信息
          if (dupOf !== undefined) {
            result.content = `[提示] 这一步的调用与第 ${dupOf} 步完全相同，结果应当一致；若确实没变化，就换别的查法。\n${result.content}`
          }
          // 只有真的写成功了才算"改过文件"，后面据此决定要不要跑验证
          if (result.ok && (call.name === 'write' || call.name === 'edit')) {
            const p = (call.args as Record<string, unknown> | undefined)?.path
            if (typeof p === 'string' && p) touched.add(p)
          }
          await session.append({
            kind: 'tool/result',
            callId: call.id,
            name: call.name,
            ok: result.ok,
            content: result.content,
            exitCode: result.exitCode,
            truncated: result.truncated,
            spill: result.spill,
            ms: result.ms,
          })
        }
        await session.append({ kind: 'step/end', turn, step, toolCalls: res.toolCalls.length })

        if (i === maxSteps) {
          reason = 'max-steps'
          renderer?.onNotice?.(`已达单轮步数上限（${maxSteps}），让模型基于现有信息收尾`)
          // 收尾：不给工具，逼它把已经看到的东西整理成答案（生产 agent 的常见做法）
          const wrapMessages: LlmMessage[] = [
            ...this.messages(),
            {
              role: 'user',
              content:
                `[系统] 本轮步数已达上限（${maxSteps}），不能再调用工具。` +
                '请直接基于上面已获得的信息给出最终回答；信息不足的地方明确说明缺什么、下一步该查哪。',
            },
          ]
          const wrap = await llm.chat({
            messages: wrapMessages,
            tools: [],
            signal: this.signal,
            onText: (c) => renderer?.onText?.(c),
            onReasoning: (c) => renderer?.onReasoning?.(c),
          })
          await session.append({
            kind: 'assistant/message',
            text: wrap.text,
            reasoning: wrap.reasoning,
            toolCalls: [],
            ms: wrap.ms,
            finish: wrap.finish,
          })
          await session.append({
            kind: 'llm/usage',
            turn,
            step: step + 1,
            prompt: wrap.usage.prompt,
            completion: wrap.usage.completion,
            cacheRead: wrap.usage.cacheRead,
            ms: wrap.ms,
            model: llm.cfg.model,
          })
          audit.recordLlmCall({
            sessionId: session.id,
            turn,
            step: step + 1,
            model: llm.cfg.model,
            msgs: wrapMessages.length,
            toolsN: 0,
            prompt: wrap.usage.prompt,
            completion: wrap.usage.completion,
            cacheRead: wrap.usage.cacheRead,
            ms: wrap.ms,
            finish: wrap.finish,
            at: Date.now(),
          })
          renderer?.onAssistantEnd?.(wrap.text)
          if (wrap.text) finalText = wrap.text
        }
        }

        // ---- 验证闭环：这一轮改过文件，就在收尾前跑一遍项目测试 ----
        stepBase += maxSteps
        if (reason !== 'done' || this.signal?.aborted) break
        const v = await this.maybeVerify(turn, touched, verifyRound, maxVerifyRounds)
        if (!v.retry) break
        verifyRound++
        if (v.message) await session.append({ kind: 'user/message', text: v.message })
      }
    } catch (e) {
      reason = this.signal?.aborted ? 'cancelled' : 'error'
      const message = (e as Error).message
      await session.append({ kind: 'turn/end', turn, reason, error: message })
      this.syncAudit()
      throw e
    }

    await session.append({ kind: 'turn/end', turn, reason })
    this.syncAudit()
    if (reason === 'max-steps') {
      renderer?.onNotice?.(`已达单轮步数上限（${maxSteps}），本轮停止`)
    }
    return { text: finalText, steps, toolCalls: totalCalls, reason }
  }

  /**
   * 跑一次验证，并把结论决定成"继续修"还是"收尾"。
   * 只在真改过文件、且认得出测试入口时才动手。
   */
  private async maybeVerify(
    turn: number,
    touched: Set<string>,
    round: number,
    maxVerifyRounds: number,
  ): Promise<{ retry: boolean; message?: string }> {
    const { session, renderer, policy } = this.opts
    if (this.opts.verify === null) return { retry: false }
    if (touched.size === 0) return { retry: false }

    const verifier = this.opts.verify ?? detectVerifier(policy.root)
    if (!verifier) {
      if (round === 0) {
        renderer?.onNotice?.(
          '这一轮改了文件，但没认出项目的测试入口（package.json 的 test script / Cargo.toml / go.mod / pytest），跳过自动验证',
        )
      }
      return { retry: false }
    }

    renderer?.onVerifyStart?.(verifier.label, round + 1)
    await session.append({ kind: 'verify/start', turn, round: round + 1, label: verifier.label })
    const r = await runVerifier(verifier, {
      root: policy.root,
      timeoutMs: this.opts.verifyTimeoutMs,
      signal: this.signal,
    })
    await session.append({
      kind: 'verify/end',
      turn,
      round: round + 1,
      label: verifier.label,
      ok: r.ok,
      exitCode: r.exitCode,
      ms: r.ms,
      output: r.output,
      timedOut: r.timedOut,
    })
    renderer?.onVerifyEnd?.(r, round + 1)
    if (r.ok) return { retry: false }

    if (round >= maxVerifyRounds) {
      renderer?.onNotice?.(`验证仍未通过（已让它自己修 ${round} 次），停在这里，失败输出留给你判断`)
      return { retry: false }
    }

    const why = r.timedOut ? `超时 ${Math.round(r.ms / 1000)}s` : `退出码 ${r.exitCode}`
    return {
      retry: true,
      message:
        `[自动验证] 你改完文件后，我跑了 \`${verifier.label}\`，结果是失败（${why}）。\n` +
        '请按下面的输出把它修好，然后给出最终回答；不要只说"应该没问题"。\n\n' +
        '```\n' +
        r.output.slice(0, 6000) +
        '\n```',
    }
  }

  syncAudit(): void {
    const { session, audit, policy } = this.opts
    audit.upsertSession({
      id: session.id,
      title: session.title(),
      cwd: policy.root,
      model: this.opts.llm.cfg.model,
      mode: policy.mode,
      createdAt: session.events[0]?.at ?? Date.now(),
      updatedAt: session.events[session.events.length - 1]?.at ?? Date.now(),
      turns: session.events.filter((e) => e.kind === 'turn/start').length,
      events: session.events.length,
    })
  }
}
