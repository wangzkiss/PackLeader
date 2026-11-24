/**
 * 命令工具：一次性 shell（不做持久 PTY）。
 *
 * 平台：Windows 用 pwsh（缺失则 powershell）；POSIX 用 bash -lc。
 * 超时会 SIGTERM，2 秒后 SIGKILL，并把 timedOut 标出来。
 */

import { spawn } from 'node:child_process'
import type { Tool } from '../core/tools.ts'
import { needString, optNumber } from '../core/tools.ts'

const isWin = process.platform === 'win32'

export interface ShellRunResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  ms: number
}

export function runShell(
  command: string,
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal; maxBytes?: number } = { cwd: process.cwd() },
): Promise<ShellRunResult> {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? 300_000
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024

  const [file, args] = isWin
    ? ['pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command]]
    : ['/bin/bash', ['-lc', command]]

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(file, args as string[], {
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
      stderr += `\n[进程启动失败] ${e.message}\n（Windows 需要 pwsh 或 powershell 在 PATH 中）`
      finish(127)
    })
    child.on('close', (code) => finish(code ?? -1))
  })
}

export function createShellTools(opts: { cwd: string; timeoutMs?: number }): Tool[] {
  const shell: Tool = {
    name: 'shell',
    description: isWin
      ? '执行一条 PowerShell 命令（一次性，不保留状态）。工作目录是 workspace 根。'
      : '执行一条 bash 命令（一次性，不保留状态）。工作目录是 workspace 根。',
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
      })
      const parts: string[] = []
      if (r.stdout.trim()) parts.push(r.stdout.trimEnd())
      if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`)
      if (r.timedOut) parts.push('[命令超时被终止]')
      parts.push(`[exit code: ${r.exitCode}]`)
      return { content: parts.join('\n'), exitCode: r.exitCode, meta: { ms: r.ms } }
    },
  }
  return [shell]
}
