#!/usr/bin/env node
/**
 * PackLeader 主机：给 GUI 用的 NDJSON 双向通道。
 *
 *   stdin  ← 命令（每行一个 JSON）
 *   stdout → 事件（每行一个 JSON）
 *
 * 命令：task / approve / abort / mode / model / config / load-config / cwd / new-session / delete-session /
 *       list-sessions / load-session / history-slice / rename-session / group-session / ping
 * 事件：ready / turn-start / step / text / reasoning / assistant-end / tool-start / tool-end /
 *       approval / usage / turn-end / sessions / history-slice / config / config-loaded / notice / error
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
import { ingestFiles } from './core/attach.ts'
import { loadSettings, maskKey, saveSettings, visionFrom } from './core/settings.ts'
import { registerSecret } from './core/redact.ts'
import type { AskRequest } from './core/tools.ts'
import { MemoryStore } from './core/memory.ts'
import type { Attachment, Decision, Mode, ToolCall } from './core/types.ts'
import { OpenAiClient } from './llm/openai.ts'
import { createDefaultTools } from './tools/index.ts'
import type { Audit } from './core/audit.ts'

// 事件归属哪个会话：正在跑的那一轮产生的事件都带上它。
// 界面据此把「别的会话里跑着的那一轮」认出来（不画进当前聊天区，只提示状态）。
// 同一时间只允许一轮在跑，所以一个变量够用。
let eventSession: string | undefined

// 只有轮次里产生的事件才带会话归属。ready / sessions / config 这些是全局状态，
// 给它们补上「正在跑的那个会话」会让界面把它们当成别的会话的事件丢掉。
const TURN_EVENT_TYPES = new Set([
  'turn-start', 'step', 'text', 'reasoning', 'assistant-end', 'tool-start', 'tool-end',
  'approval', 'question', 'usage', 'turn-end', 'memory-saved', 'memory-undone',
])

const send = (e: Record<string, unknown>): void => {
  const out =
    e.session === undefined && eventSession && TURN_EVENT_TYPES.has(String(e.type))
      ? { ...e, session: eventSession }
      : e
  process.stdout.write(`${JSON.stringify({ ...out, at: Date.now() })}\n`)
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
  /** 验证命令：空串＝自动识别项目 */
  verify: string
  noVerify: boolean
  /** 模型能不能看图（决定图片是否作为 image part 发过去） */
  vision: boolean
  /** vision 是否由命令行/环境变量显式指定（否则以 config.json 为准，缺省开） */
  visionSet: boolean
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
    maxSteps: Number(s('max-steps') ?? 100) || 100,
    session: s('resume'),
    cont: flags.continue === true,
    verify: s('verify') ?? '',
    noVerify: flags['no-verify'] === true,
    // 命令行 --vision / --no-vision 可以强制；没给就先记"未指定"，等读到 config.json 再定
    vision: flags.vision === true || process.env.PL_VISION === '1',
    visionSet: flags.vision === true || flags['no-vision'] === true || process.env.PL_VISION !== undefined,
  }
}

// ---------- 审批 ----------

/** 提问通道：把问题发给界面，等用户点一个选项（跳过则返回 null） */
class HostAsker {
  private pending = new Map<string, (v: string | null) => void>()
  /** 最近一次挂起的提问：切回这个会话时要重新画出来，否则看着在跑却没地方答 */
  last: Record<string, unknown> | undefined

  ask(req: AskRequest): Promise<string | null> {
    const reqId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const payload = { type: 'question', reqId, question: req.question, options: req.options }
    this.last = payload
    send(payload)
    return new Promise<string | null>((resolve) => this.pending.set(reqId, resolve))
  }

  answer(reqId: string, value: string | null): void {
    const r = this.pending.get(reqId)
    if (!r) return
    this.pending.delete(reqId)
    if (!this.pending.size) this.last = undefined
    r(value)
  }

  rejectAll(): void {
    for (const [k, r] of [...this.pending]) {
      this.pending.delete(k)
      r(null)
    }
    this.last = undefined
  }
}

class HostApprover implements Approver {
  private pending = new Map<string, (d: Decision) => void>()
  /** 最近一次挂起的审批：切回这个会话时要重新画出来，否则看着在跑却没地方点 */
  last: Record<string, unknown> | undefined

  ask(req: ApprovalRequest): Promise<Decision> {
    const payload = { type: 'approval', reqId: req.reqId, tool: req.tool, reason: req.reason, detail: req.detail ?? '' }
    this.last = payload
    send(payload)
    return new Promise<Decision>((resolve) => this.pending.set(req.reqId, resolve))
  }

  decide(reqId: string, decision: Decision): void {
    const r = this.pending.get(reqId)
    if (!r) return
    this.pending.delete(reqId)
    if (!this.pending.size) this.last = undefined
    r(decision)
  }

  /** GUI 被关掉 / 轮次被中断时：悬着的审批一律拒（fail-closed） */
  rejectAll(): void {
    for (const [id, r] of this.pending) {
      this.pending.delete(id)
      r('denied')
    }
    this.last = undefined
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
  const saved = await loadSettings(opts.dataDir)
  // 没有 key 也要开窗口：第一次用的人是先在界面上填端点/Key 的。
  // 真正拦在 runTask 里（见下），而不是启动时直接死掉。
  if (!opts.apiKey) {
    if (saved.apiKey) opts.apiKey = saved.apiKey
    if (saved.baseURL) opts.baseURL = saved.baseURL
    if (saved.model) opts.model = saved.model
    if (saved.verify && !opts.noVerify) opts.verify = saved.verify
  }
  // 看图：命令行/环境变量没显式指定就听 config.json 的，那里也没有就按默认（开）。
  // 注意这条不能塞进上面的 if：Key 来自环境变量时也得读到用户存过的开关。
  if (!opts.visionSet) opts.vision = visionFrom(saved)

  const { Audit: AuditClass } = await import('./core/audit.ts')
  const audit: Audit = await AuditClass.open(join(opts.dataDir, 'audit.sqlite'))
  // 把当前 key 登记进脉教器：日志/审计落盘时按字面遮掉它
  registerSecret(opts.apiKey)
  const checkpoints = new Checkpoints(join(opts.dataDir, 'ckpt'))
  // 记忆按工作目录分文件；切 cwd 时要重建，否则会往上一个仓库的记忆文件里写
  let memory = new MemoryStore(opts.dataDir, opts.root)
  let tools = createDefaultTools({ root: opts.root, memory })
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
    onTurnStart: (_turn, text, files) => send({ type: 'turn-start', text, files: files ?? [] }),
    onStepStart: (step) => {
      runningStep = step
      send({ type: 'step', step })
    },
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
        // 结构化结果：界面据此画专用卡片（todo → 计划卡）
        data: result.data,
      }),
    onVerifyStart: (label, round) => send({ type: 'verify-start', label, round }),
    onVerifyEnd: (r, round) =>
      send({
        type: 'verify-end',
        label: r.label,
        round,
        ok: r.ok,
        exitCode: r.exitCode,
        ms: r.ms,
        timedOut: r.timedOut,
        output: r.output.slice(0, 3000),
      }),
  }

  /** 记忆注入：建 agent 时读一次（同一目录下之前会话记的也在里面） */
  const memoryPrompt = (items: Array<{ text: string }>): string => {
    const head =
      '记忆规则：每轮结束前，把值得长期记住的事实写进记忆（remember 工具），默认就记，不要问用户要不要记。' +
      '决定了某个做法、发现了项目的坑或约定、用户表达了偏好或禁忌，都记一条；一条只写一件事，写成陈述句。'
    if (!items.length) return head
    const shown = items.slice(-40)
    const body = shown.map((i) => `- ${i.text}`).join('\n')
    const more = items.length > shown.length ? `\n（更早的 ${items.length - shown.length} 条省略）` : ''
    return `${head}\n\n当前工作目录已有的记忆（${items.length} 条）：\n${body}${more}`
  }

  const asker = new HostAsker()

  const buildAgent = async (): Promise<Agent> =>
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
      verify: opts.noVerify ? null : opts.verify === '' ? undefined : { label: opts.verify },
      systemPrompt: memoryPrompt(await memory.all()),
      ask: (req) => asker.ask(req),
    })

  let agent = await buildAgent()

  const questionPositions = (): Array<{ eventIndex: number; seq: number; text: string; at: number }> =>
    session.events.flatMap((event, eventIndex) =>
      event.kind === 'user/message' && !event.text.startsWith('[自动验证]')
        ? [{ eventIndex, seq: event.seq, text: event.text.replace(/\s+/g, ' ').trim().slice(0, 100), at: event.at }]
        : [],
    )

  // 正在跑的那一轮：属于哪个会话、跑到第几步。切会话不打断它，界面靠这两个值
  // 判断「当前会话忙不忙」，以及切回来时要显示「运行中」。
  // running 必须在这之前声明：state() 里要用它判断「这一轮是不是正跑着」，
  // 声明放到下面会让 state() 头一次调用就撞上 TDZ（Cannot access 'running' before initialization）。
  let running = false
  let runningSession: string | undefined
  let runningStep = 0

  /** 最后一轮有没有收尾（进程被杀/崩掉时 turn/start 后面就不会有 turn/end 了） */
  const unfinishedTurn = (): boolean => {
    let open = false
    for (const ev of session.events) {
      if (ev.kind === 'turn/start') open = true
      else if (ev.kind === 'turn/end') open = false
    }
    return open
  }

  const state = (): Record<string, unknown> => ({
    type: 'ready',
    session: session.id,
    title: session.title(),
    cwd: opts.root,
    mode: policy.mode,
    model: llm.cfg.model,
    baseURL: opts.baseURL,
    apiKeyMasked: maskKey(opts.apiKey),
    hasKey: Boolean(opts.apiKey),
    maxSteps: opts.maxSteps,
    verify: opts.verify,
    vision: opts.vision,
    historyCount: session.events.length,
    questions: questionPositions(),
    // 工具调用日志目录：界面上「设置」里直接显示出来，方便按日志改
    logsDir: audit.logsDir,
    // 有轮次在跑时把归属会话报出来：可能不是当前会话（切走了它还在跑）
    runningSession: runningSession ?? null,
    runningStep: runningSession ? runningStep : 0,
    // 上一次进程退出时这一轮没跑完：界面上如实标出来，别看着像正常结束
    // 正在跑的这一轮本来就没闭合，不算「没跑完」——切回正在跑的会话时别多一条黄字吓人
    unfinished: running && runningSession === session.id ? false : unfinishedTurn(),
    // 切回正在跑的会话时，挂着的审批/提问要重新画出来，否则看着在跑却没法继续
    pendingApproval: approver.last ?? null,
    pendingQuestion: asker.last ?? null,
  })

  send(state())

  let controller: AbortController | undefined
  let current: Promise<void> | undefined

  // 本会话的用量（audit.cost() 是全库累计，界面上看着会误导）
  const sessionUsage = (forSession: Session = session): { calls: number; prompt: number; completion: number; cacheRead: number } => {
    let calls = 0
    let prompt = 0
    let completion = 0
    let cacheRead = 0
    for (const e of forSession.events) {
      if (e.kind !== 'llm/usage') continue
      calls++
      prompt += e.prompt
      completion += e.completion
      cacheRead += e.cacheRead
    }
    return { calls, prompt, completion, cacheRead }
  }

  // 把「文字 + 本地文件」整理成一条要落进会话的用户消息：
  // 附件先入库（拷进数据目录），文本类内联，图片留给 deriveMessages 按需读成 base64。
  // 正着一轮（task）和插队（insert）共用，插话带附件才不会有第二套逻辑。
  const prepare = async (
    text: string,
    paths: string[],
    forSession: Session = session,
  ): Promise<{ text: string; files?: Attachment[] }> => {
    if (!paths.length) return { text }
    const ing = await ingestFiles(opts.dataDir, forSession.id, paths, { vision: opts.vision })
    if (ing.attachments.length) return { text: `${text}\n\n${ing.text}`, files: ing.attachments }
    // 拷贝失败/被删就让模型知道，而不是静默少一个文件
    return { text: `${text}\n\n[附件] 指定的 ${paths.length} 个文件都没读到（可能已被删除或没有权限）` }
  }

  const runTask = async (
    text: string,
    files?: Attachment[],
    target?: { session: Session; agent: Agent },
  ): Promise<void> => {
    if (running) {
      // 同一时间只允许一轮：如果它在别的会话里跑着，说清是哪个会话，别让人以为卡住
      const where = runningSession && runningSession !== session.id ? '（在另一个会话里跑着）' : ''
      send({
        type: 'error',
        message: `上一轮还没结束${where}：等它跑完，或切回去点停止`,
        runningSession: runningSession ?? null,
      })
      return
    }
    if (!opts.apiKey) {
      send({ type: 'error', message: '还没配置模型：点右上角的设置，填端点地址和 API Key', needsSetup: true })
      return
    }
    // 这一轮绑定发起时的会话与 agent：中途切到别的会话时，内容、记忆、用量都要落回原会话
    const turnSession = target?.session ?? session
    const turnAgent = target?.agent ?? agent
    running = true
    controller = new AbortController()
    turnAgent.signal = controller.signal
    eventSession = turnSession.id
    runningSession = turnSession.id
    runningStep = 0
    const t0 = Date.now()
    try {
      const r = await turnAgent.runTurn(text, files)
      // 本轮记下的记忆：按时间戳挑出这一轮新写的，落进会话事件（历史回放要用）
      try {
        const fresh = (await memory.all()).filter((m) => m.at >= t0 - 1)
        if (fresh.length) {
          const items = fresh.map((m) => ({ id: m.id, text: m.text, at: m.at }))
          await turnSession.append({ kind: 'memory/saved', items })
          send({ type: 'memory-saved', items })
        }
      } catch (e) {
        send({ type: 'error', message: `记忆收尾失败：${(e as Error).message}` })
      }
      send({ type: 'turn-end', reason: r.reason, ms: Date.now() - t0, text: r.text })
    } catch (e) {
      send({ type: 'error', message: (e as Error).message })
      send({ type: 'turn-end', reason: 'error', ms: Date.now() - t0, text: '' })
    } finally {
      running = false
      controller = undefined
      turnAgent.signal = undefined
      send({ type: 'usage', ...sessionUsage(turnSession) })
      // 上面的收尾事件还得带这一轮的会话，清空放最后
      eventSession = undefined
      runningSession = undefined
      runningStep = 0
    }
  }

  /**
   * 切会话 / 切目录 / 删会话之前，先把当前这一轮停干净：
   * abort 掉模型请求与工具，把挂着的审批、提问当作取消，再等它走完收尾（最多 5 秒）。
   * 返回 false 表示没停下来（有工具不响应中断）。
   */
  const stopCurrentTurn = async (): Promise<boolean> => {
    if (!running) return true
    controller?.abort()
    approver.rejectAll()
    asker.rejectAll()
    const c = current
    if (c) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cap = new Promise<void>((ok) => {
        timer = setTimeout(ok, 5000)
      })
      try {
        await Promise.race([c.catch(() => {}), cap])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    return !running
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
        const paths = Array.isArray(cmd.files) ? (cmd.files as unknown[]).filter((x): x is string => typeof x === 'string') : []
        const run = async (): Promise<void> => {
          // 这一轮绑定发起时的会话与 agent：中途切到别的会话也不会把内容写错地方
          const target = { session, agent }
          const p = await prepare(text, paths, target.session)
          await runTask(p.text, p.files, target)
        }
        // 关键：不能 await —— 否则执行期间读不到 stdin，approve/abort 永远进不来（死锁）
        if (text || paths.length) current = run().finally(() => { current = undefined })
        break
      }
      // 插队：这一轮还在跑的时候，用户这句话（连同附件）直接落进当前会话，模型下一步就能看到
      // （不做新一轮：不重新计 turn、不动正在跑的工具）
      case 'insert': {
        const text = String(cmd.text ?? '').trim()
        const paths = Array.isArray(cmd.files) ? (cmd.files as unknown[]).filter((x): x is string => typeof x === 'string') : []
        if (!text && !paths.length) break
        if (running) {
          // 正在跑的是别的会话：这条插话落不进那一轮的上下文，说清楚别让人以为没生效
          if (runningSession && runningSession !== session.id) {
            send({ type: 'error', message: '另一个会话还在跑：插话要用在那个会话里，先切回去', runningSession })
            break
          }
          // 附件照样先入库再追加：图片会被 deriveMessages 读成 base64，文本类内联，
          // 所以插话带图和带文件跟正常发一轮是同一套处理
          const target = session
          const p = await prepare(text, paths, target)
          await target.append({ kind: 'user/message', text: p.text, ...(p.files?.length ? { files: p.files } : {}) })
          const n = p.files?.length ?? 0
          send({ type: 'notice', text: n ? `已插话（带 ${n} 个附件）：模型下一步就能看到` : '已插话：模型下一步就能看到' })
        } else {
          // 没在跑就等同于正常发一轮
          const run = async (): Promise<void> => {
            const target = { session, agent }
            const p = await prepare(text, paths, target.session)
            await runTask(p.text, p.files, target)
          }
          current = run().finally(() => { current = undefined })
        }
        break
      }
      case 'list-models': {
        const baseURL = String(cmd.baseURL ?? '').trim() || opts.baseURL
        const apiKey = String(cmd.apiKey ?? '').trim() || opts.apiKey
        if (!apiKey) {
          send({ type: 'error', message: '先填 API Key，再拉取模型列表', needsSetup: true })
          break
        }
        try {
          const r = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
            headers: { authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15_000),
          })
          const body = (await r.json().catch(() => ({}))) as { data?: Array<{ id?: string }>; error?: { message?: string } }
          if (!r.ok) {
            send({ type: 'error', message: `拉取失败（HTTP ${r.status}）：${body.error?.message ?? '端点没有返回模型列表'}` })
            break
          }
          const items = (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean).sort()
          send({ type: 'models', items })
        } catch (e) {
          send({ type: 'error', message: `拉取模型失败：${(e as Error).message}` })
        }
        break
      }
      case 'approve': {
        // 界面发 decision（allowed-once / denied）；老版本发 allowed:true/false，两种都认
        const dec: Decision =
          cmd.decision === 'allowed-once' || cmd.allowed === true
            ? 'allowed-once'
            : cmd.decision === 'allowed-session'
              ? 'allowed-session'
              : 'denied'
        approver.decide(String(cmd.reqId ?? ''), dec)
        break
      }
      case 'abort': {
        // 界面只在「当前会话在跑」时给停止键，但保险起见再核对一次：
        // 别让一次误点把另一个会话里跑着的活干掉
        const want = String(cmd.session ?? '')
        if (runningSession && want && want !== runningSession) {
          send({ type: 'error', message: '当前会话没有在跑的轮次（另一个会话在跑，切回去再停）' })
          break
        }
        controller?.abort()
        approver.rejectAll()
        asker.rejectAll()
        send({ type: 'notice', text: '已中断当前轮' })
        break
      }
      case 'answer': {
        // ask 工具的答复：value 是用户点中的选项原文，null = 跳过
        const value = typeof cmd.value === 'string' && cmd.value ? cmd.value : null
        asker.answer(String(cmd.reqId ?? ''), value)
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
          opts.model = m
          // 界面里直接改模型名也要能留住，不然下次启动又变回去
          void saveSettings(opts.dataDir, { model: m }).catch(() => {})
          send({ type: 'model', model: m })
        }
        break
      }
      case 'load-config': {
        // 设置文件可能在进程运行期间被手动编辑。打开设置时重新读取磁盘，
        // 同步更新当前客户端和 agent，让修改无需重启或再点一次保存就生效。
        const saved = await loadSettings(opts.dataDir)
        if (saved.baseURL) {
          opts.baseURL = saved.baseURL
          llm.cfg.baseURL = saved.baseURL
        }
        if (saved.apiKey) {
          opts.apiKey = saved.apiKey
          llm.cfg.apiKey = saved.apiKey
          registerSecret(saved.apiKey)
        }
        if (saved.model) {
          opts.model = saved.model
          llm.cfg.model = saved.model
        }
        opts.verify = saved.verify ?? ''
        opts.vision = visionFrom(saved)
        agent = await buildAgent()
        send({
          type: 'config-loaded',
          baseURL: opts.baseURL,
          model: llm.cfg.model,
          apiKeyMasked: maskKey(opts.apiKey),
          hasKey: Boolean(opts.apiKey),
          verify: opts.verify,
          vision: opts.vision,
          logsDir: audit.logsDir,
        })
        break
      }
      case 'config': {
        // 界面上填的端点 / Key：立刻生效（不用重启），并落盘给下次启动用
        const baseURL = String(cmd.baseURL ?? '').trim()
        const apiKey = String(cmd.apiKey ?? '').trim()
        const model = String(cmd.model ?? '').trim()
        // verify 允许被"清空成自动识别"，所以单独判断有没有传这个字段
        const hasVerify = Object.prototype.hasOwnProperty.call(cmd, 'verify')
        const verify = String(cmd.verify ?? '').trim()
        const hasVision = Object.prototype.hasOwnProperty.call(cmd, 'vision')
        if (baseURL) {
          opts.baseURL = baseURL
          llm.cfg.baseURL = baseURL
        }
        if (apiKey) {
          opts.apiKey = apiKey
          llm.cfg.apiKey = apiKey
        }
        if (model) {
          opts.model = model
          llm.cfg.model = model
        }
        if (!opts.apiKey) {
          send({ type: 'error', message: 'API Key 不能为空' })
          break
        }
        if (hasVerify) opts.verify = verify
        if (hasVision) opts.vision = Boolean(cmd.vision)
        try {
          await saveSettings(opts.dataDir, {
            baseURL: opts.baseURL,
            apiKey: opts.apiKey,
            model: llm.cfg.model,
            verify: hasVerify ? verify : undefined,
            vision: hasVision ? Boolean(cmd.vision) : undefined,
          })
          // 换了 key 也要登记，否则新 key 不会被脱敏
          registerSecret(opts.apiKey)
          // 验证命令变了要重建 agent，否则还用着旧的
          agent = await buildAgent()
          send({
            type: 'config',
            baseURL: opts.baseURL,
            model: llm.cfg.model,
            apiKeyMasked: maskKey(opts.apiKey),
            verify: opts.verify,
            vision: opts.vision,
            saved: true,
            logsDir: audit.logsDir,
          })
        } catch (e) {
          send({ type: 'error', message: `配置已生效，但没写进磁盘：${(e as Error).message}` })
        }
        break
      }
      case 'cwd': {
        // 切 workspace：策略与工具都要重建（GUI 里换项目）。
        // 只在「当前会话自己这一轮在跑」时停：换了工具根，这一轮继续跑在旧根上会让人意外。
        // 另一个会话在跑不受影响（它用着自己那份 tools/agent）。
        const dir = resolve(String(cmd.dir ?? ''))
        if (running && runningSession === session.id && !(await stopCurrentTurn())) {
          send({ type: 'error', message: '这一轮没停下来（可能有工具不响应），稍后再切目录' })
          break
        }
        opts.root = dir
        policy.setRoot(dir)
        // createDefaultTools 返回的是 ToolRegistry，不是 Map。原来这里是 for..of 遍历它，
        // 直接抛 "t is not iterable"（换目录必现）。整个换掉，再重建 agent 让它用上新工具
        memory = new MemoryStore(opts.dataDir, dir)
        tools = createDefaultTools({ root: dir, memory })
        agent = await buildAgent()
        send({ type: 'cwd', cwd: dir })
        break
      }
      case 'new-session': {
        // 新建会话不打断正在跑的那一轮：它在原会话里继续跑
        session = await Session.create(opts.dataDir, meta())
        agent = await buildAgent()
        send(state())
        break
      }
      case 'delete-session': {
        const id = String(cmd.id ?? '')
        // 删掉的正是正在跑的那个会话：先停下再删，否则它还会往已删除的目录里写
        if (running && runningSession === id && !(await stopCurrentTurn())) {
          send({ type: 'error', message: '这一轮没停下来（可能有工具不响应），稍后再删' })
          break
        }
        try {
          await Session.remove(opts.dataDir, id)
          // 删掉的正好是当前会话：得换一个新的，否则 agent 还指着已删除的文件
          if (id === session.id) {
            session = await Session.create(opts.dataDir, meta())
            agent = await buildAgent()
            send(state())
          }
          send({ type: 'sessions', items: await Session.list(opts.dataDir) })
        } catch (e) {
          send({ type: 'error', message: `删除会话失败：${(e as Error).message}` })
        }
        break
      }
      case 'rename-session': {
        try {
          await Session.setMeta(opts.dataDir, String(cmd.id ?? ''), { title: String(cmd.title ?? '') })
          send({ type: 'sessions', items: await Session.list(opts.dataDir) })
        } catch (e) {
          send({ type: 'error', message: `重命名失败：${(e as Error).message}` })
        }
        break
      }
      case 'group-session': {
        try {
          await Session.setMeta(opts.dataDir, String(cmd.id ?? ''), { group: String(cmd.group ?? '') })
          send({ type: 'sessions', items: await Session.list(opts.dataDir) })
        } catch (e) {
          send({ type: 'error', message: `分组失败：${(e as Error).message}` })
        }
        break
      }
      case 'undo-memory': {
        const ids = Array.isArray(cmd.ids) ? (cmd.ids as unknown[]).filter((x): x is string => typeof x === 'string') : []
        try {
          const removed = await memory.remove(ids)
          if (removed.length) {
            await session.append({ kind: 'memory/undone', ids: removed })
            send({ type: 'memory-undone', ids: removed })
          }
        } catch (e) {
          send({ type: 'error', message: `撤销记忆失败：${(e as Error).message}` })
        }
        break
      }
      case 'list-sessions': {
        send({ type: 'sessions', items: await Session.list(opts.dataDir) })
        break
      }
      case 'load-session': {
        // 切会话不中断正在跑的那一轮：它在原会话里继续跑（事件带它自己的 session），
        // 切回来还能接着看、接着停。要停就切回去点停止。
        try {
          session = await Session.open(opts.dataDir, String(cmd.id ?? ''))
          agent = await buildAgent()
          send(state())
        } catch (e) {
          send({ type: 'error', message: `打开会话失败：${(e as Error).message}` })
        }
        break
      }
      case 'history-slice': {
        const requestId = Number(cmd.requestId ?? 0)
        const requestedSession = String(cmd.session ?? '')
        if (requestedSession !== session.id) break
        const mode = String(cmd.mode ?? 'tail')
        const cursor = Math.max(0, Math.min(session.events.length, Number(cmd.cursor ?? session.events.length)))
        const target = Math.max(0, Math.min(session.events.length - 1, Number(cmd.target ?? 0)))
        const questions = questionPositions().map((q) => q.eventIndex)
        const questionBefore = (limit: number): number => {
          for (let i = questions.length - 1; i >= 0; i--) if (questions[i]! < limit) return questions[i]!
          return 0
        }
        const turnStart = (question: number): number => {
          for (let i = question; i >= 0; i--) if (session.events[i]?.kind === 'turn/start') return i
          return question
        }
        let from = 0
        let to = session.events.length
        let jumpTo: number | undefined
        if (mode === 'before') {
          to = cursor
          from = turnStart(questionBefore(to))
        } else if (mode === 'after') {
          from = cursor
          const question = questions.find((index) => index >= from)
          const next = question === undefined ? undefined : questions.find((index) => index > question)
          to = next === undefined ? session.events.length : turnStart(next)
        } else if (mode === 'around') {
          const question = questionBefore(target + 1)
          from = turnStart(question)
          const next = questions.find((index) => index > question)
          to = next === undefined ? session.events.length : turnStart(next)
          jumpTo = question
        } else {
          // 首屏：最后几轮一起给。只给最后一轮的话，长对话一打开就得往上翻几十次，
          // 每翻一次一次往返（~270ms），体验上跟"卡"没区别。
          const maxTailTurns = Math.max(1, Math.min(50, Number(cmd.turns ?? 6)))
          const startAt = Math.max(0, questions.length - maxTailTurns)
          from = turnStart(questions[startAt] ?? 0)
        }
        // 一次别把整段历史塞成一行大 JSON：PowerShell 侧 ConvertFrom-Json 是同步的，
        // 几 MB 的一行会把 UI 线程卡住。按字节切，切了就让前端接着拉下一段。
        const maxBytes = Math.max(16 * 1024, Math.min(4 * 1024 * 1024, Number(cmd.maxBytes ?? 512 * 1024)))
        let bytes = 0
        let cut = to
        for (let i = from; i < to; i++) {
          bytes += JSON.stringify(session.events[i]).length + 1
          if (bytes > maxBytes && i > from) {
            cut = i
            break
          }
        }
        send({
          type: 'history-slice',
          session: session.id,
          requestId,
          mode,
          from,
          to: cut,
          truncated: cut < to,
          nextFrom: cut,
          jumpTo,
          events: session.events.slice(from, cut),
        })
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
