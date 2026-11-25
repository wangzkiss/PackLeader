/**
 * 验证闭环：这一轮真的改过文件，就在收尾前替你把项目测试跑一遍。
 *
 * 为什么值得做：模型说"改好了"是最不可信的一句话。让它自己看到红的测试输出，
 * 修起来比让人去看、再回来描述，成本低一个数量级。
 *
 * 三条自我约束：
 *  - 只有 write/edit 成功落盘才算"改过"，纯读的轮次不跑（省时间）
 *  - 最多重试 maxVerifyRounds 轮，避免"测试永远红 → 无限修"烧钱
 *  - 超时/输出都截断，测试挂住不能把 agent 一起挂住
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runShell } from '../tools/shell.ts'

export interface Verifier {
  /** 人类可读的命令，直接拿去 shell 跑 */
  label: string
  /** 从哪认出来的（写进日志，方便解释为什么跑了这个） */
  reason: string
}

/**
 * 认项目：node 优先看 package.json 的 test script（这是最普遍、最不容易误判的信号），
 * 然后 Rust / Go / Python 的常见标记文件。
 * 认不出来就返回 null —— 宁可不验证，也不要瞎跑一条错的命令。
 */
export function detectVerifier(root: string): Verifier | null {
  const pkgPath = join(root, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      // Windows 上的 package.json 常带 BOM（PowerShell 的 Set-Content 默认就写），
      // 不剥掉 JSON.parse 会直接抛，然后就会误判成"没有测试入口"
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '')) as { scripts?: Record<string, string> }
      if (pkg.scripts?.test?.trim()) {
        const pm = existsSync(join(root, 'pnpm-lock.yaml'))
          ? 'pnpm'
          : existsSync(join(root, 'yarn.lock'))
            ? 'yarn'
            : 'npm'
        return { label: `${pm} test`, reason: 'package.json 的 test script' }
      }
    } catch {
      // package.json 坏了就当没有；真坏了模型自己会发现
    }
  }
  if (existsSync(join(root, 'Cargo.toml'))) return { label: 'cargo test -q', reason: 'Cargo.toml' }
  if (existsSync(join(root, 'go.mod'))) return { label: 'go test ./...', reason: 'go.mod' }
  for (const f of ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']) {
    if (existsSync(join(root, f))) return { label: 'python -m pytest -q', reason: f }
  }
  return null
}

export interface VerifyResult {
  ok: boolean
  label: string
  exitCode: number
  ms: number
  output: string
  timedOut: boolean
}

/** 只留头 2KB + 尾 6KB：测试结论在尾部，头部留着能看出跑了什么 */
export function clipOutput(stdout: string, stderr: string, headBytes = 2048, tailBytes = 6144): string {
  const text = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim()
  if (Buffer.byteLength(text, 'utf8') <= headBytes + tailBytes) return text
  const head = text.slice(0, headBytes)
  const tail = text.slice(-tailBytes)
  return `${head}\n\n… [中间省略 ${text.length - headBytes - tailBytes} 字] …\n\n${tail}`
}

export async function runVerifier(
  v: Verifier,
  opts: { root: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<VerifyResult> {
  const r = await runShell(v.label, {
    cwd: opts.root,
    timeoutMs: opts.timeoutMs ?? 180_000,
    signal: opts.signal,
  })
  const output = clipOutput(r.stdout, r.stderr)
  return {
    ok: r.exitCode === 0 && !r.timedOut,
    label: v.label,
    exitCode: r.exitCode,
    ms: r.ms,
    output: output || '(没有输出)',
    timedOut: r.timedOut,
  }
}
