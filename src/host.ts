#!/usr/bin/env node
/**
 * PackLeader 主机：给 GUI 用的 NDJSON 双向通道。
 *
 *   stdin  ← 命令（每行一个 JSON）
 *   stdout → 事件（每行一个 JSON）
 *
 * 命令：task / approve / abort / mode / model / config / cwd / new-session / delete-session /
 *       list-sessions / load-session / rename-session / group-session / ping
 * 事件：ready / turn-start / step / text / reasoning / assistant-end / tool-start / tool-end /
 *       approval / usage / turn-end / sessions / config / notice / error
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
import { loadSettings, maskKey, saveSettings } from './core/settings.ts'
import { MemoryStore } from './core/memory.ts'
import type { Attachment, Decision, Mode, ToolCall } from './core/types.ts'
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
  /** 验证命令：空串＝自动识别项目 */
  verify: string
  noVerify: boolean
  /** 模型能不能看图（决定图片是否作为 image part 发过去） */
  vision: boolean
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
    vision: flags.vision === true || process.env.PL_VISION === '1',
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
  // 没有 key 也要开窗口：第一次用的人是先在界面上填端点/Key 的。
  // 真正拦在 runTask 里（见下），而不是启动时直接死掉。
  if (!opts.apiKey) {
    const saved = await loadSettings(opts.dataDir)
    if (saved.apiKey) opts.apiKey = saved.apiKey
    if (saved.baseURL) opts.baseURL = saved.baseURL
    if (saved.model) opts.model = saved.model
    if (saved.verify && !opts.noVerify) opts.verify = saved.verify
    if (saved.vision) opts.vision = true
  }

  const { Audit: AuditClass } = await import('./core/audit.ts')
  const audit: Audit = await AuditClass.open(join(opts.dataDir, 'audit.sqlite'))
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
    })

  let agent = await buildAgent()

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
    events: session.events,
    // 工具调用日志目录：界面上「设置」里直接显示出来，方便按日志改
    logsDir: audit.logsDir,
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

  const runTask = async (text: string, files?: Attachment[]): Promise<void> => {
    if (running) {
      send({ type: 'error', message: '上一轮还没结束（可先点停止）' })
      return
    }
    if (!opts.apiKey) {
      send({ type: 'error', message: '还没配置模型：点右上角的设置，填端点地址和 API Key', needsSetup: true })
      return
    }
    running = true
    controller = new AbortController()
    agent.signal = controller.signal
    const t0 = Date.now()
    try {
      const r = await agent.runTurn(text, files)
      // 本轮记下的记忆：按时间戳挑出这一轮新写的，落进会话事件（历史回放要用）
      try {
        const fresh = (await memory.all()).filter((m) => m.at >= t0 - 1)
        if (fresh.length) {
          const items = fresh.map((m) => ({ id: m.id, text: m.text, at: m.at }))
          await session.append({ kind: 'memory/saved', items })
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
        const paths = Array.isArray(cmd.files) ? (cmd.files as unknown[]).filter((x): x is string => typeof x === 'string') : []
        const run = async (): Promise<void> => {
          let prompt = text
          let files: Attachment[] | undefined
          if (paths.length) {
            // 附件先入库再开轮：拷贝失败/被删就让模型知道，而不是静默少一个文件
            const ing = await ingestFiles(opts.dataDir, session.id, paths, { vision: opts.vision })
            if (ing.attachments.length) {
              prompt = `${text}\n\n${ing.text}`
              files = ing.attachments
            } else {
              prompt = `${text}\n\n[附件] 指定的 ${paths.length} 个文件都没读到（可能已被删除或没有权限）`
            }
          }
          await runTask(prompt, files)
        }
        // 关键：不能 await —— 否则执行期间读不到 stdin，approve/abort 永远进不来（死锁）
        if (text || paths.length) current = run().finally(() => { current = undefined })
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
          cmd.decision === 'allowed-once' || cmd.allowed === true ? 'allowed-once' : 'denied'
        approver.decide(String(cmd.reqId ?? ''), dec)
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
          opts.model = m
          // 界面里直接改模型名也要能留住，不然下次启动又变回去
          void saveSettings(opts.dataDir, { model: m }).catch(() => {})
          send({ type: 'model', model: m })
        }
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
        // 切 workspace：策略与工具都要重建（GUI 里换项目）
        const dir = resolve(String(cmd.dir ?? ''))
        if (running) {
          send({ type: 'error', message: '请先等当前轮结束' })
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
        if (running) {
          send({ type: 'error', message: '请先等当前轮结束' })
          break
        }
        session = await Session.create(opts.dataDir, meta())
        agent = await buildAgent()
        send(state())
        break
      }
      case 'delete-session': {
        if (running) {
          send({ type: 'error', message: '请先等当前轮结束' })
          break
        }
        const id = String(cmd.id ?? '')
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
        if (running) {
          send({ type: 'error', message: '请先等当前轮结束' })
          break
        }
        try {
          session = await Session.open(opts.dataDir, String(cmd.id ?? ''))
          agent = await buildAgent()
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
