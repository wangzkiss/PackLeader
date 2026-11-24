#!/usr/bin/env node
/**
 * PackLeader 主机：给 GUI 用的 NDJSON 双向通道。
 *
 *   stdin  ← 命令（每行一个 JSON）
 *   stdout → 事件（每行一个 JSON）
 *
 * 命令：task / approve / abort / mode / model / new-session / list-sessions / load-session / ping
 * 事件：ready / turn-start / step / text / reasoning / assistant-end / tool-start / tool-end /
 *       approval / usage / turn-end / sessions / notice / error
 *
 * GUI 只做渲染，不碰 agent 逻辑；协议是纯 JSON 行，前端换成 WPF / 浏览器 / 终端都不用改核心。
 */

import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ApprovalBroker, type ApprovalRequest, type Approver } from './core/approval.ts'
import { Checkpoints } from './core/checkpoint.ts'
import { Agent, type Renderer } from './core/loop.ts'
import { Policy } from './core/policy.ts'
import { Session } from './core/session.ts'
import type { Decision, Mode, ToolCall } from './core/types.ts'
import { OpenAiClient } from './llm/openai.ts'
import { createDefaultTools } from './tools/index.ts'
import type { Audit } from './core/audit.ts'

const send = (e: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ ...e, at: Date.now() })}\n`)
}

// ---------- 参数 ----------

interface Opts {
  dataDir: string
  root: string
  mode: Mode
  apiKey: string
  baseURL: string
  model: string
  maxSteps: number
  session?: string
  cont: boolean
}

function parseArgs(argv: string[]): Opts {
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else flags[key] = true
  }
  const s = (k: string): string | undefined => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
  const mode = (s('mode') ?? process.env.PL_MODE ?? 'guarded') as Mode
  if (!['read-only', 'guarded', 'full'].includes(mode)) throw new Error('--mode 只能是 read-only / guarded / full')
  return {
    dataDir: resolve(s('data-dir') ?? process.env.PACKLEADER_HOME ?? join(homedir(), '.packleader')),
    root: resolve(s('cwd') ?? process.cwd()),
    mode,
    apiKey: s('api-key') ?? process.env.PL_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    baseURL: s('base-url') ?? process.env.PL_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    model: s('model') ?? process.env.PL_MODEL ?? 'deepseek-chat',
    maxSteps: Number(s('max-steps') ?? 40) || 40,
    session: s('resume'),
    cont: flags.continue === true,
  }
}

// ---------- 审批 ----------

class HostApprover implements Approver {
  private pending = new Map<string, (d: Decision) => void>()

  ask(req: ApprovalRequest): Promise<Decision> {
    send({ type: 'approval', reqId: req.reqId, tool: req.tool, reason: req.reason, detail: req.detail ?? '' })
    return new Promise<Decision>((resolve) => this.pending.set(req.reqId, resolve))
  }

  decide(reqId: string, decision: Decision): void {
    const r = this.pending.get(reqId)
    if (!r) return
    this.pending.delete(reqId)
    r(decision)
  }

  /** GUI 被关掉 / 轮次被中断时：悬着的审批一律拒（fail-closed） */
  rejectAll(): void {
    for (const [id, r] of this.pending) {
      this.pending.delete(id)
      r('denied')
    }
  }
}

// ---------- 给 UI 用的一行摘要 ----------

export function summarizeCall(name: string, args: Record<string, unknown>): string {
  const pick = (k: string): string | undefined => (typeof args[k] === 'string' ? (args[k] as string) : undefined)
  const one = (s: string): string => (s.length > 100 ? `${s.slice(0, 100)}…` : s)
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
      return one(pick('path') ?? '')
    case 'glob':
      return one(pick('pattern') ?? '')
    case 'grep':
      return one([pick('pattern'), pick('path') ? `in ${pick('path')}` : ''].filter(Boolean).join(' '))
    case 'shell':
      return one(pick('command') ?? '')
    case 'todo_write':
      return 'todo'
    default:
      return one(JSON.stringify(args))
  }
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.apiKey) {
    send({ type: 'error', message: '缺少 API key：设置 PL_API_KEY，或在启动参数里给 --api-key', fatal: true })
    process.exitCode = 2
    return
  }

  const { Audit: AuditClass } = await import('./core/audit.ts')
  const audit: Audit = await AuditClass.open(join(opts.dataDir, 'audit.sqlite'))
  const checkpoints = new Checkpoints(join(opts.dataDir, 'ckpt'))
  const tools = createDefaultTools({ root: opts.root })
  const llm = new OpenAiClient({ baseURL: opts.baseURL, apiKey: opts.apiKey, model: opts.model })
  const policy = new Policy(opts.root, opts.mode)
  const approver = new HostApprover()
  const broker = new ApprovalBroker('ask', approver)

  const meta = (): Record<string, unknown> => ({
    cwd: opts.root,
    mode: policy.mode,
    model: llm.cfg.model,
    baseURL: opts.baseURL,
    startedAt: Date.now(),
  })

  let session: Session
  if (opts.session) session = await Session.open(opts.dataDir, opts.session)
  else if (opts.cont) session = (await Session.latest(opts.dataDir)) ?? (await Session.create(opts.dataDir, meta()))
  else session = await Session.create(opts.dataDir, meta())

  const renderer: Renderer = {
    onTurnStart: (_turn, text) => send({ type: 'turn-start', text }),
    onStepStart: (step) => send({ type: 'step', step }),
    onText: (delta) => send({ type: 'text', delta }),
    onReasoning: (delta) => send({ type: 'reasoning', delta }),
    onAssistantEnd: (text) => send({ type: 'assistant-end', text }),
    onNotice: (text) => send({ type: 'notice', text }),
    onToolStart: (call: ToolCall) =>
      send({ type: 'tool-start', id: call.id, name: call.name, summary: summarizeCall(call.name, call.args), args: call.args }),
    onToolEnd: (call: ToolCall, result) =>
      send({
        type: 'tool-end',
        id: call.id,
        name: call.name,
        ok: result.ok,
        ms: result.ms,
        bytes: result.content.length,
        error: result.ok ? '' : result.content.slice(0, 500),
      }),
  }

  const buildAgent = (): Agent =>
    new Agent({
      session,
      llm,
      tools,
      policy,
      broker,
      checkpoints,
      audit,
      dataDir: opts.dataDir,
      renderer,
      maxSteps: opts.maxSteps,
    })

  let agent = buildAgent()

  const state = (): Record<string, unknown> => ({
    type: 'ready',
    session: session.id,
    title: session.title(),
    cwd: opts.root,
    mode: policy.mode,
    model: llm.cfg.model,
    maxSteps: opts.maxSteps,
    events: session.events,
  })

  send(state())

  let running = false
  let controller: AbortController | undefined
  let current: Promise<void> | undefined

  // 本会话的用量（audit.cost() 是全库累计，界面上看着会误导）
  const sessionUsage = (): { calls: number; prompt: number; completion: number; cacheRead: number } => {
    let calls = 0
    let prompt = 0
    let completion = 0
    let cacheRead = 0
    for (const e of session.events) {
      if (e.kind !== 'llm/usage') continue
      calls++
      prompt += e.prompt
      completion += e.completion
      cacheRead += e.cacheRead
    }
    return { calls, prompt, completion, cacheRead }
  }

  const runTask = async (text: string): Promise<void> => {
    if (running) {
      send({ type: 'error', message: '上一轮还没结束（可先点停止）' })
      return
    }
    running = true
    controller = new AbortController()
    agent.signal = controller.signal
    const t0 = Date.now()
    try {
      const r = await agent.runTurn(text)
      send({ type: 'turn-end', reason: r.reason, ms: Date.now() - t0, text: r.text })
    } catch (e) {
      send({ type: 'error', message: (e as Error).message })
      send({ type: 'turn-end', reason: 'error', ms: Date.now() - t0, text: '' })
    } finally {
      running = false
      controller = undefined
      agent.signal = undefined
      send({ type: 'usage', ...sessionUsage() })
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const raw of rl) {
    const line = raw.trim()
    if (!line) continue
    let cmd: Record<string, unknown>
    try {
      cmd = JSON.parse(line) as Record<string, unknown>
    } catch {
      send({ type: 'error', message: `无法解析命令：${line.slice(0, 80)}` })
      continue
    }

    switch (cmd.cmd) {
      case 'task': {
        const text = String(cmd.text ?? '').trim()
        // 关键：不能 await —— 否则执行期间读不到 stdin，approve/abort 永远进不来（死锁）
        if (text) current = runTask(text).finally(() => { current = undefined })
        break
      }
      case 'approve': {
        approver.decide(String(cmd.reqId ?? ''), cmd.decision === 'allowed-once' ? 'allowed-once' : 'denied')
        break
      }
      case 'abort': {
        controller?.abort()
        approver.rejectAll()
        send({ type: 'notice', text: '已中断当前轮' })
        break
      }
      case 'mode': {
        const m = String(cmd.mode ?? '') as Mode
        if (['read-only', 'guarded', 'full'].includes(m)) {
          policy.setMode(m)
          send({ type: 'mode', mode: m })
        } else send({ type: 'error', message: `未知权限档：${m}` })
        break
      }
      case 'model': {
        const m = String(cmd.model ?? '').trim()
        if (m) {
          llm.cfg.model = m
          send({ type: 'model', model: m })
        }
        break
      }
      case 'cwd': {
        // 切 workspace：策略与工具都要重建（GUI 里换项目）
        const dir = resolve(String(cmd.dir ?? ''))
        if (running) {
          send({ type: 'error', message: '请先等当前轮结束' })
          break
        }
        opts.root = dir
        policy.setRoot(dir)
        const t = createDefaultTools({ root: dir })
        for (const [k, v] of t) tools.set(k, v)
        send({ type: 'cwd', cwd: dir })
        break
      }
      case 'new-session': {
        if (running) {
          send({ type: 'error', message: '请先等当前轮结束' })
          break
        }
        session = await Session.create(opts.dataDir, meta())
        agent = buildAgent()
        send(state())
        break
      }
      case 'list-sessions': {
        send({ type: 'sessions', items: await Session.list(opts.dataDir) })
        break
      }
      case 'load-session': {
        if (running) {
          send({ type: 'error', message: '请先等当前轮结束' })
          break
        }
        try {
          session = await Session.open(opts.dataDir, String(cmd.id ?? ''))
          agent = buildAgent()
          send(state())
        } catch (e) {
          send({ type: 'error', message: `打开会话失败：${(e as Error).message}` })
        }
        break
      }
      case 'ping':
        send({ type: 'pong' })
        break
      default:
        send({ type: 'error', message: `未知命令：${String(cmd.cmd)}` })
    }
  }

  // GUI 关掉（stdin 结束）时：中断在跑的轮次，把所有悬着的审批拒掉，再退出
  controller?.abort()
  await current
  approver.rejectAll()
  audit.close()
}

main().catch((e) => {
  send({ type: 'error', message: (e as Error).message, fatal: true })
  process.exitCode = 1
})
