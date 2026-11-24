#!/usr/bin/env node
/**
 * PackLeader CLI
 *
 *   pl "把 README 的 TODO 补上"      单次执行
 *   pl                               交互模式
 *   pl audit [-n 20] [--tool bash] [--cost] [--json]
 *   pl undo [--turn 3] [--session s-…] [--force]
 *   pl sessions
 */

// audit 模块（node:sqlite）按需加载；顺手过滤掉它的实验性警告，否则每次启动都往 stderr 打一行
process.removeAllListeners('warning')
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return
  console.warn(w.stack ?? `${w.name}: ${w.message}`)
})

import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { ApprovalBroker } from './core/approval.ts'
import { Checkpoints } from './core/checkpoint.ts'
import { Agent } from './core/loop.ts'
import { Policy } from './core/policy.ts'
import { Session } from './core/session.ts'
import type { Mode } from './core/types.ts'
import { OpenAiClient } from './llm/openai.ts'
import { createDefaultTools } from './tools/index.ts'
import { resolveShell, runShell } from './tools/shell.ts'
import { TerminalApprover } from './tui/approval.ts'
import { CliRenderer, bold, cyan, dim, gray, green, red, yellow } from './tui/render.ts'

const VERSION = '0.1.0'
const BOOL_FLAGS = new Set([
  'yes', 'deny', 'json', 'continue', 'no-color', 'force', 'cost', 'help', 'version', 'show-reasoning', 'repl',
])

interface Parsed {
  command: 'run' | 'audit' | 'undo' | 'sessions' | 'help' | 'version' | 'doctor'
  flags: Record<string, string | boolean>
  positional: string[]
}

function parse(argv: string[]): Parsed {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
        continue
      }
      const key = a.slice(2)
      if (BOOL_FLAGS.has(key)) flags[key] = true
      else {
        const next = argv[i + 1]
        if (next && !next.startsWith('--')) {
          flags[key] = next
          i++
        } else flags[key] = true
      }
    } else positional.push(a)
  }
  const known = ['audit', 'undo', 'sessions', 'help', 'version', 'doctor']
  const head = positional[0]
  const command = (head && known.includes(head) ? positional.shift()! : 'run') as Parsed['command']
  return { command, flags, positional }
}

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

function num(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = flags[key]
  const n = typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

interface Config {
  dataDir: string
  root: string
  mode: Mode
  apiKey: string
  baseURL: string
  model: string
  approval: 'ask' | 'allow' | 'deny'
  maxSteps: number
}

function resolveConfig(flags: Record<string, string | boolean>): Config {
  const dataDir = resolve(str(flags, 'data-dir') ?? process.env.PACKLEADER_HOME ?? join(homedir(), '.packleader'))
  const mode = (str(flags, 'mode') ?? process.env.PL_MODE ?? 'guarded') as Mode
  if (!['read-only', 'guarded', 'full'].includes(mode)) throw new Error(`--mode 只能是 read-only / guarded / full，收到 ${mode}`)
  const approval = flags.deny ? 'deny' : flags.yes ? 'allow' : ((process.env.PL_APPROVAL as Config['approval']) ?? 'ask')
  return {
    dataDir,
    root: resolve(str(flags, 'cwd') ?? process.cwd()),
    mode,
    apiKey: str(flags, 'api-key') ?? process.env.PL_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    baseURL: str(flags, 'base-url') ?? process.env.PL_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    model: str(flags, 'model') ?? process.env.PL_MODEL ?? 'deepseek-chat',
    approval,
    maxSteps: num(flags, 'max-steps') ?? 40,
  }
}

function help(): void {
  process.stdout.write(`${bold('PackLeader')} v${VERSION} — 轻量单机 Agent

${bold('用法')}
  pl [选项] "任务描述"        单次执行，输出结果后退出
  pl                         交互模式（/exit 退出，/undo 撤销，/sessions 列表）
  pl audit [选项]            审计账本（工具调用 / 成本）；pl audit rebuild 从日志重建
  pl undo [--turn N]         撤销某一轮的所有文件改动
  pl sessions                列出历史会话
  pl doctor                  自检（node / shell / 数据目录 / 端点 / 模型）

${bold('选项')}
  --cwd <dir>          工作目录（默认当前目录）
  --mode <m>           read-only | guarded | full（默认 guarded）
  --yes                自动放行所有审批（仍受 read-only 约束）
  --deny               一律拒绝审批（CI 用）
  --model <name>       模型名（默认 deepseek-chat）
  --base-url <url>     OpenAI 兼容端点（默认 https://api.deepseek.com/v1）
  --api-key <key>      API Key（或用 PL_API_KEY / DEEPSEEK_API_KEY）
  --resume <id>        恢复指定会话
  --continue           恢复最近一次会话
  --data-dir <dir>     数据目录（默认 ~/.packleader）
  --max-steps <n>      单轮最多几步（默认 40）
  --json               以 NDJSON 输出事件（给脚本/CI 用）
  --repl               强制进入交互模式（stdin 不是终端时也可用，便于脚本驱动）
  --show-reasoning     打印模型的思考流

${bold('示例')}
  pl --mode read-only "这个仓库用什么构建？"
  pl "把 src/config.ts 里重复的校验抽成一个函数"
  pl --yes "跑测试并修掉失败的用例"
  pl audit -n 10 --cost
  pl undo --turn 3

${dim('环境变量：PL_API_KEY / PL_BASE_URL / PL_MODEL / PL_MODE / PL_APPROVAL / PL_SHELL / PACKLEADER_HOME')}
`)
}

async function cmdDoctor(cfg: Config, flags: Record<string, string | boolean>): Promise<void> {
  const rows: Array<{ name: string; ok: boolean | 'skip'; detail: string }> = []
  const mark = (ok: boolean | 'skip') => (ok === 'skip' ? yellow('–') : ok ? green('✓') : red('✗'))

  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number)
  rows.push({
    name: 'node',
    ok: maj > 22 || (maj === 22 && min >= 18),
    detail: `v${process.versions.node}（需要 ≥ 22.18：靠原生类型剥离直接跑 TS）`,
  })

  const shell = resolveShell()
  const probe = await runShell('echo packleader-ok', { cwd: cfg.root, timeoutMs: 15_000 })
  const shellOk = probe.stdout.includes('packleader-ok') && probe.exitCode === 0
  rows.push({
    name: 'shell',
    ok: shellOk,
    detail: shellOk
      ? `${shell.label}  ${shell.file}${shell.legacy ? '  (无 && ，用 ;)' : ''}`
      : `${shell.label}  ${shell.file} — ${probe.stderr.split('\n')[0] ?? '启动失败'}（可用 PL_SHELL 指定）`,
  })

  let dataOk = false
  let dataDetail = cfg.dataDir
  try {
    await mkdir(cfg.dataDir, { recursive: true })
    const file = join(cfg.dataDir, '.probe')
    await writeFile(file, 'ok', 'utf8')
    await rm(file, { force: true })
    dataOk = true
  } catch (e) {
    dataDetail = `${cfg.dataDir} — ${(e as Error).message}`
  }
  rows.push({ name: 'data-dir', ok: dataOk, detail: dataDetail })

  const rootOk = existsSync(cfg.root)
  rows.push({ name: 'workspace', ok: rootOk, detail: `${cfg.root}${rootOk ? '' : '（不存在）'}` })

  let modelOk: boolean | 'skip' = 'skip'
  let endpointDetail = cfg.baseURL
  try {
    const res = await fetch(`${cfg.baseURL.replace(/\/+$/, '')}/models`, {
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      modelOk = false
      endpointDetail = `${cfg.baseURL} → HTTP ${res.status}`
    } else {
      const json = (await res.json()) as { data?: Array<{ id?: string }> }
      const ids = (json.data ?? []).map((d) => d.id).filter((x): x is string => Boolean(x))
      modelOk = ids.includes(cfg.model)
      endpointDetail = ids.includes(cfg.model)
        ? `${cfg.baseURL} → ${ids.length} 个模型，包含 ${cfg.model}`
        : `${cfg.baseURL} → ${ids.length} 个模型，但没有 ${cfg.model}（有 ${ids.slice(0, 5).join(', ')}）`
    }
  } catch (e) {
    modelOk = false
    endpointDetail = `${cfg.baseURL} 不可达：${(e as Error).message}`
  }
  rows.push({ name: 'model', ok: modelOk, detail: endpointDetail })
  if (!cfg.apiKey) rows.push({ name: 'api-key', ok: false, detail: '未设置（PL_API_KEY / DEEPSEEK_API_KEY / --api-key）' })

  process.stdout.write(`${bold('PackLeader doctor')}\n`)
  for (const r of rows) {
    process.stdout.write(`  ${mark(r.ok)} ${r.name.padEnd(10)} ${dim(r.detail)}\n`)
  }
  const failed = rows.filter((r) => r.ok === false).length
  process.stdout.write(
    failed ? `\n${red(`${failed} 项没通过`)}\n` : `\n${green('全部通过')}，可以开跑\n`,
  )
  if (failed) process.exitCode = 1
  void flags
}

async function cmdSessions(cfg: Config): Promise<void> {
  const list = await Session.list(cfg.dataDir)
  if (!list.length) {
    process.stdout.write(dim('还没有任何会话\n'))
    return
  }
  process.stdout.write(`${bold('会话')}  (${cfg.dataDir})\n`)
  for (const s of list) {
    const when = new Date(s.updatedAt).toLocaleString('zh-CN')
    process.stdout.write(`  ${cyan(s.id)}  ${String(s.turns).padStart(2)} 轮  ${gray(when)}  ${s.title}\n`)
  }
}

async function cmdAudit(cfg: Config, flags: Record<string, string | boolean>, positional: string[]): Promise<void> {
  const { Audit } = await import('./core/audit.ts')
  const audit = await Audit.open(join(cfg.dataDir, 'audit.sqlite'))
  const sessionId = str(flags, 'session')
  const limit = num(flags, 'n') ?? 20

  if (positional[0] === 'rebuild') {
    const r = await audit.rebuild(join(cfg.dataDir, 'sessions'))
    process.stdout.write(
      `${green('重建完成')}  ${r.sessions} 个会话 / ${r.toolCalls} 次工具调用 / ${r.llmCalls} 次模型调用 / ${r.approvals} 次审批\n`,
    )
    audit.close()
    return
  }

  if (flags.cost) {
    const c = audit.cost()
    process.stdout.write(
      `${bold('累计')}  ${c.calls} 次模型调用  prompt ${c.prompt}  completion ${c.completion}  cache_read ${c.cacheRead}\n`,
    )
    audit.close()
    return
  }

  const rows = audit.queryToolCalls({ sessionId, tool: str(flags, 'tool'), limit })
  if (flags.json) {
    process.stdout.write(`${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
    audit.close()
    return
  }
  if (!rows.length) {
    process.stdout.write(dim('审计库里还没有工具调用（或该会话尚未产生）\n'))
    audit.close()
    return
  }
  process.stdout.write(`${bold('工具调用')}  最近 ${rows.length} 条\n`)
  for (const r of rows) {
    const ok = Number(r.ok) === 1 ? green('✓') : red('✗')
    const when = new Date(Number(r.finished_at)).toLocaleTimeString('zh-CN')
    const tool = String(r.tool).padEnd(12)
    const ms = `${String(r.ms ?? 0)}ms`.padStart(8)
    const bytes = `${r.out_bytes ?? 0}B`.padStart(7)
    const dec = r.decision && String(r.decision) !== 'allowed' ? yellow(String(r.decision)) : ''
    const auto = Number(r.auto) === 1 ? gray('auto') : ''
    process.stdout.write(`  ${ok} ${gray(when)}  ${tool}${gray(ms)}${gray(bytes)} ${dec} ${auto}\n`)
  }
  audit.close()
}

async function cmdUndo(cfg: Config, flags: Record<string, string | boolean>): Promise<void> {
  const session = str(flags, 'session') ? await Session.open(cfg.dataDir, str(flags, 'session')!) : await Session.latest(cfg.dataDir)
  if (!session) {
    process.stdout.write(dim('没有可撤销的会话\n'))
    return
  }
  const ck = new Checkpoints(join(cfg.dataDir, 'ckpt'))
  const turn = num(flags, 'turn')
  const r = await ck.undo(session.id, turn, { force: flags.force === true })
  if (!r.restored.length && !r.removed.length && !r.conflicts.length) {
    process.stdout.write(dim(`会话 ${session.id} 没有被快照过的改动\n`))
    return
  }
  for (const p of r.restored) process.stdout.write(`${green('恢复')} ${p}\n`)
  for (const p of r.removed) process.stdout.write(`${cyan('删除')} ${p}（该轮新建）\n`)
  for (const p of r.conflicts) process.stdout.write(`${yellow('冲突')} ${p}（内容已被外部改动，加 --force 覆盖）\n`)
  for (const p of r.skipped) process.stdout.write(`${gray('跳过')} ${p}（过大或二进制）\n`)
}

async function main(): Promise<void> {
  const { command, flags, positional } = parse(process.argv.slice(2))
  if (flags.help || command === 'help') return help()
  if (flags.version || command === 'version') return void process.stdout.write(`packleader ${VERSION}\n`)

  const cfg = resolveConfig(flags)
  if (command === 'sessions') return cmdSessions(cfg)
  if (command === 'audit') return cmdAudit(cfg, flags, positional)
  if (command === 'undo') return cmdUndo(cfg, flags)
  if (command === 'doctor') return cmdDoctor(cfg, flags)

  if (!cfg.apiKey) {
    process.stderr.write(
      `${red('缺少 API Key')}\n  设置 PL_API_KEY，或用 --api-key / DEEPSEEK_API_KEY 传入。\n` +
        `  端点和模型可用 PL_BASE_URL / PL_MODEL 指定（默认 ${cfg.baseURL} · ${cfg.model}）。\n`,
    )
    process.exitCode = 2
    return
  }

  const json = flags.json === true
  const renderer = new CliRenderer({
    json,
    showReasoning: flags['show-reasoning'] === true,
    onEvent: json ? (e) => process.stdout.write(`${JSON.stringify(e)}\n`) : undefined,
  })

  // `--repl` / PL_REPL=1：即使 stdin 不是 TTY 也进交互模式（便于用管道驱动、写集成测试）
  const forceRepl = flags.repl === true || process.env.PL_REPL === '1'
  const interactive = forceRepl || Boolean(process.stdin.isTTY)

  // 用「单一异步迭代器 + 自己排队」拿输入，而不是 rl.question：
  //   - rl.question 只接住提问那一刻到达的行，管道里的其它行会被丢掉
  //   - EOF 之后 rl.question 会抛 ERR_USE_AFTER_CLOSE，这里改成返回 null（正常退出）
  let rl: ReturnType<typeof createInterface> | undefined
  let lines: AsyncIterator<string> | undefined
  const ask = async (q: string): Promise<string | null> => {
    rl ??= createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
      crlfDelay: Infinity,
    })
    lines ??= rl[Symbol.asyncIterator]()
    if (process.stdin.isTTY) {
      rl.setPrompt(q)
      rl.prompt()
    } else {
      process.stdout.write(q)
    }
    const next = await lines.next()
    if (next.done) return null
    // 非 TTY 时用户输入不会被回显，补一个换行，免得提示和后续输出挤在一行
    if (!process.stdin.isTTY) process.stdout.write('\n')
    return next.value
  }

  const { Audit } = await import('./core/audit.ts')
  const audit = await Audit.open(join(cfg.dataDir, 'audit.sqlite'))
  const checkpoints = new Checkpoints(join(cfg.dataDir, 'ckpt'))
  const tools = createDefaultTools({ root: cfg.root })
  const llm = new OpenAiClient({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model })
  const policy = new Policy(cfg.root, cfg.mode)

  const wantsTty = !json && interactive
  const approver = cfg.approval === 'ask' && wantsTty ? new TerminalApprover(ask) : undefined
  const broker = new ApprovalBroker(cfg.approval, approver)

  const sessionRef = str(flags, 'resume')
  const session = sessionRef
    ? await Session.open(cfg.dataDir, sessionRef)
    : flags.continue
      ? (await Session.latest(cfg.dataDir)) ?? (await Session.create(cfg.dataDir, metaFor(cfg)))
      : await Session.create(cfg.dataDir, metaFor(cfg))

  const agent = new Agent({
    session,
    llm,
    tools,
    policy,
    broker,
    checkpoints,
    audit,
    dataDir: cfg.dataDir,
    renderer,
    maxSteps: cfg.maxSteps,
  })

  renderer.banner({ model: cfg.model, mode: cfg.mode, root: cfg.root, session: session.id, version: VERSION })

  const cleanup = () => {
    audit.close()
    rl?.close()
  }

  try {
    const task = positional.join(' ').trim()
    if (task) {
      await agent.runTurn(task)
      return
    }
    if (!interactive) {
      // 管道输入且没要求交互：整段当作一个任务
      const chunks: Buffer[] = []
      for await (const c of process.stdin) chunks.push(c as Buffer)
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        process.stderr.write(`${red('没有输入')}\n`)
        process.exitCode = 1
        return
      }
      await agent.runTurn(text)
      return
    }

    // 交互模式
    const replPrompt = process.stdin.isTTY ? `\n${cyan('›')} ` : '' // 非 TTY 下不该出现空提示符
    for (;;) {
      const raw = await ask(replPrompt)
      if (raw === null) {
        process.stdout.write(dim('\n（输入结束，退出）\n'))
        break
      }
      const line = raw.trim()
      if (!line) continue
      if (line === '/exit' || line === '/quit') break
      if (line === '/help') {
        process.stdout.write(dim('命令：/exit /undo /sessions /help\n直接输入即对话。\n'))
        continue
      }
      if (line === '/undo') {
        const r = await checkpoints.undo(session.id)
        if (!r.restored.length && !r.removed.length) process.stdout.write(dim('没有可撤销的改动\n'))
        for (const p of r.restored) process.stdout.write(`${green('恢复')} ${p}\n`)
        for (const p of r.removed) process.stdout.write(`${cyan('删除')} ${p}\n`)
        for (const p of r.conflicts) process.stdout.write(`${yellow('冲突')} ${p}\n`)
        continue
      }
      if (line === '/sessions') {
        await cmdSessions(cfg)
        continue
      }
      try {
        await agent.runTurn(line)
      } catch (e) {
        process.stderr.write(`${red('错误')} ${(e as Error).message}\n`)
      }
    }
  } finally {
    cleanup()
  }
}

function metaFor(cfg: Config) {
  return { cwd: cfg.root, model: cfg.model, baseURL: cfg.baseURL, mode: cfg.mode, version: VERSION }
}

main().catch((e) => {
  process.stderr.write(`${red('致命错误')} ${(e as Error).stack ?? String(e)}\n`)
  process.exitCode = 1
})
