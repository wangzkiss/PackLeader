/**
 * 命令工具：一次性 shell（不做持久 PTY）。
 *
 * shell 解析顺序（Windows）：PL_SHELL > PATH 里的 pwsh > Program Files\PowerShell\7 >
 * PATH 里的 powershell > %SystemRoot%\System32\WindowsPowerShell\v1.0。
 * 只装了 Windows PowerShell 5.1 的机器上必须能跑——5.1 不支持 `&&`，工具描述里会说明。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Tool } from '../core/tools.ts'
import { needString, optNumber } from '../core/tools.ts'

const isWin = process.platform === 'win32'

// 控制台输出统一成 UTF-8：中文 Windows 上 PowerShell 5.1 默认按 GBK 往管道里写，
// 我们按 UTF-8 解就是一片「����」。前面拼在每条命令上，模型不用再自己 chcp。
const PS_UTF8 = 'try{[Console]::OutputEncoding=[Text.Encoding]::UTF8}catch{};'
const PS51_UTF8 = PS_UTF8 + 'try{$OutputEncoding=[Text.Encoding]::UTF8}catch{};'
const CMD_UTF8 = 'chcp 65001>nul & '

export interface ShellSpec {
  file: string
  label: string
  /** 5.1 不支持 && / ||，需要提示模型 */
  legacy: boolean
  /** 每条命令前拼的初始化片段：把输出编码定成 UTF-8 */
  prefix: string
  args: (command: string) => string[]
}

function findOnPath(name: string): string | undefined {
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function firstExisting(paths: Array<string | undefined>): string | undefined {
  return paths.filter((p): p is string => Boolean(p)).find((p) => existsSync(p))
}

function inferLegacy(file: string): boolean {
  return /powershell(\.exe)?$/i.test(basename(file)) || basename(file).toLowerCase() === 'cmd.exe'
}

function specFor(file: string): ShellSpec {
  const base = basename(file).toLowerCase()
  if (base.startsWith('cmd')) {
    return { file, label: 'cmd.exe', legacy: true, prefix: CMD_UTF8, args: (c) => ['/d', '/s', '/c', CMD_UTF8 + c] }
  }
  if (!isWin || base.includes('pwsh')) {
    if (!isWin) return { file, label: basename(file), legacy: false, prefix: '', args: (c) => ['-lc', c] }
    return {
      file,
      label: 'PowerShell 7',
      legacy: false,
      prefix: PS_UTF8,
      args: (c) => ['-NoProfile', '-NonInteractive', '-Command', PS_UTF8 + c],
    }
  }
  return {
    file,
    label: inferLegacy(file) ? 'Windows PowerShell 5.1' : basename(file),
    legacy: inferLegacy(file),
    prefix: PS51_UTF8,
    args: (c) => ['-NoProfile', '-NonInteractive', '-Command', PS51_UTF8 + c],
  }
}

let cached: ShellSpec | undefined

export function resolveShell(): ShellSpec {
  if (cached) return cached
  const override = process.env.PL_SHELL
  if (override) {
    cached = specFor(override)
    return cached
  }
  if (!isWin) {
    const bash = findOnPath('bash') ?? findOnPath('sh')
    cached = bash ? specFor(bash) : specFor('/bin/sh')
    return cached
  }
  const pwsh =
    findOnPath('pwsh') ??
    firstExisting([
      process.env.ProgramFiles ? join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe') : undefined,
      process.env.ProgramW6432 ? join(process.env.ProgramW6432, 'PowerShell', '7', 'pwsh.exe') : undefined,
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe') : undefined,
    ])
  if (pwsh) {
    cached = specFor(pwsh)
    return cached
  }
  const legacy =
    findOnPath('powershell') ??
    firstExisting([
      process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : undefined,
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]) ??
    findOnPath('cmd')
  cached = specFor(legacy ?? 'powershell.exe')
  return cached
}

export interface ShellRunResult {
  stdout: string
  stderr: string
  exitCode: number
  /** 撞了 timeoutMs 被杀 */
  timedOut: boolean
  /** 被外部 signal 取消（用户点停止 / 切会话 / 步数预算收尾），不是命令自己的毛病 */
  aborted: boolean
  ms: number
}

export function runShell(
  command: string,
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal; maxBytes?: number; shell?: ShellSpec } = { cwd: process.cwd() },
): Promise<ShellRunResult> {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? 300_000
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024
  const shell = opts.shell ?? resolveShell()

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const child = spawn(shell.file, shell.args(command), {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' },
    })

    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, exitCode, timedOut, aborted, ms: Date.now() - started })
    }

    // 中断 / 超时：Windows 上 child.kill() 只杀掉直接子进程（powershell / cmd），命令里再拉起的
    // 孙进程（node、python、构建工具）还活着并握着 stdout 管道，close 事件就一直不来——
    // runShell 的 promise 永远不 resolve，界面上就是「点了停止还在跑」。所以按整棵树杀。
    const killTree = () => {
      if (isWin && child.pid) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        } catch {
          child.kill()
        }
      } else {
        child.kill()
      }
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.()
      // 兜底：树没杀干净（或句柄还没释放）也不能让调用方无限等
      setTimeout(() => finish(-1), 4000).unref?.()
    }

    // 超时与取消要分开记：日志里出现过 992ms 就报「超时被终止」的，实际是点了停止——
    // 模型看到「超时」会去重跑并加长 timeout，同一条命令白白跑了 7 遍。
    const onTimeout = () => {
      if (settled) return
      timedOut = true
      killTree()
    }
    const onAbort = () => {
      if (settled) return
      aborted = true
      killTree()
    }

    timer = setTimeout(onTimeout, timeoutMs)
    // 已经 abort 过的 signal 不会再触发事件，这里补一次，免得工具白跑到底
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

    // 一个 UTF-8 汉字可能横跨两个 chunk，逐块 toString('utf8') 会把末尾半个字变成「�」。
    // StringDecoder 留着跨块的半个字符，下一块到了再拼——日志里满屏的「四步走一�?」就是这个。
    const outDec = new StringDecoder('utf8')
    const errDec = new StringDecoder('utf8')
    child.stdout?.on('data', (b: Buffer) => {
      if (stdout.length + b.length <= maxBytes) stdout += outDec.write(b)
    })
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length + b.length <= maxBytes) stderr += errDec.write(b)
    })
    child.on('error', (e) => {
      stderr = `[无法启动 shell] ${shell.file}\n${e.message}\n` +
        `可用 PL_SHELL 指定解释器；Windows 上也可安装 PowerShell 7。`
      finish(127)
    })
    child.on('close', (code) => {
      // 把两个解码器里可能剩的半个字吐完，再算完
      stdout += outDec.end()
      stderr += errDec.end()
      finish(code ?? -1)
    })
  })
}

export function createShellTools(opts: { cwd: string; timeoutMs?: number }): Tool[] {
  const shell: ShellSpec = resolveShell()
  const legacyHint = shell.legacy ? '注意这是 Windows PowerShell 5.1：不支持 && 和 ||，请用 ; 分隔语句。' : ''
  const tool: Tool = {
    name: 'shell',
    description: isWin
      ? `执行一条 ${shell.label} 命令（一次性，不保留状态）。工作目录是 workspace 根。${legacyHint}` +
        '复杂脚本、带中文或引号的命令，先 write 到临时文件再用 -File 执行，比在命令行里拼更稳。' +
        '要等进程/端口/窗口/文件出现，用 waitfor，别在命令里 sleep。'
      : `执行一条 ${shell.label} 命令（一次性，不保留状态）。工作目录是 workspace 根。` +
        '要等端口/文件出现，用 waitfor，别在命令里 sleep。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的完整命令' },
        timeout_ms: { type: 'integer', description: '超时毫秒，默认 300000' },
      },
      required: ['command'],
    },
    permission: 'write',
    async run(ctx, args) {
      const command = needString(args, 'command')
      const r = await runShell(command, {
        cwd: opts.cwd,
        timeoutMs: optNumber(args, 'timeout_ms') ?? opts.timeoutMs ?? 300_000,
        signal: ctx.signal,
        shell,
      })
      const parts: string[] = []
      if (r.stdout.trim()) parts.push(r.stdout.trimEnd())
      if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`)
      if (r.timedOut) parts.push(`[命令超时被终止：超过 ${timeoutMs}ms]`)
      if (r.aborted) {
        parts.push(
          '[命令被取消：不是命令本身出错——用户点了停止或切走了会话。同一命令可以直接重发，不用加长 timeout]',
        )
      }
      parts.push(`[exit code: ${r.exitCode}]`)
      // PowerShell 5.1 会把原生命令（git / curl / 进度条类）写到 stderr 的信息当 NativeCommandError，
      // 退出码跟着变非 0，命令其实已成功。这里说一句，免得模型当成失败去重跑。
      if (r.exitCode !== 0 && /NativeCommandError|RemoteException/.test(r.stderr)) {
        parts.push(
          '[提示] 这是 Windows PowerShell 把原生命令写到 stderr 的进度信息当成错误记录的常见现象，' +
            '命令很可能已经成功。先看实际效果（文件变没变、输出里的结果）再决定要不要重跑。',
        )
      }
      return { content: parts.join('\n'), exitCode: r.exitCode, meta: { ms: r.ms } }
    },
  }
  return [tool]
}
