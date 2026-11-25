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
import type { Tool } from '../core/tools.ts'
import { needString, optNumber } from '../core/tools.ts'

const isWin = process.platform === 'win32'

export interface ShellSpec {
  file: string
  label: string
  /** 5.1 不支持 && / ||，需要提示模型 */
  legacy: boolean
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
    return { file, label: 'cmd.exe', legacy: true, args: (c) => ['/d', '/s', '/c', c] }
  }
  if (!isWin || base.includes('pwsh')) {
    if (!isWin) return { file, label: basename(file), legacy: false, args: (c) => ['-lc', c] }
    return { file, label: 'PowerShell 7', legacy: false, args: (c) => ['-NoProfile', '-NonInteractive', '-Command', c] }
  }
  return {
    file,
    label: inferLegacy(file) ? 'Windows PowerShell 5.1' : basename(file),
    legacy: inferLegacy(file),
    args: (c) => ['-NoProfile', '-NonInteractive', '-Command', c],
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
  timedOut: boolean
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
    let settled = false

    const child = spawn(shell.file, shell.args(command), {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' },
    })

    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, exitCode, timedOut, ms: Date.now() - started })
    }

    const onAbort = () => {
      timedOut = true
      child.kill()
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.()
    }
    const timer = setTimeout(onAbort, timeoutMs)
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (b: Buffer) => {
      if (stdout.length < maxBytes) stdout += b.toString('utf8')
    })
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < maxBytes) stderr += b.toString('utf8')
    })
    child.on('error', (e) => {
      stderr = `[无法启动 shell] ${shell.file}\n${e.message}\n` +
        `可用 PL_SHELL 指定解释器；Windows 上也可安装 PowerShell 7。`
      finish(127)
    })
    child.on('close', (code) => finish(code ?? -1))
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
      if (r.timedOut) parts.push('[命令超时被终止]')
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
