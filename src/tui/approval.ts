/**
 * 审批应答者：终端交互。
 *
 * 一次一授权；默认拒绝（空回车 = 拒），避免「手快回车」放行危险操作。
 * `d` 展开完整参数，`a` 不提供——刻意没有 allow-always。
 */

import type { ApprovalRequest, Approver } from '../core/approval.ts'
import type { Decision } from '../core/types.ts'
import { bold, dim, gray, red, yellow } from './render.ts'

export interface PromptFn {
  /** 返回 null 表示输入已结束（EOF），按拒绝处理 */
  (question: string): Promise<string | null>
}

export class TerminalApprover implements Approver {
  private ask_: PromptFn
  private forceDeny: boolean

  constructor(ask: PromptFn, opts: { forceDeny?: boolean } = {}) {
    this.ask_ = ask
    this.forceDeny = opts.forceDeny ?? false
  }

  async ask(req: ApprovalRequest): Promise<Decision> {
    if (this.forceDeny) return 'denied'
    const lines = [
      '',
      yellow('┌ 需要确认 ' + '─'.repeat(46)),
      `│ ${bold(req.tool)}  ${dim(req.reason)}`,
    ]
    if (req.detail) {
      const d = req.detail.replace(/\s+/g, ' ').slice(0, 200)
      lines.push(`│ ${gray(d)}`)
    }
    lines.push(yellow('└' + '─'.repeat(54)))
    process.stdout.write(`${lines.join('\n')}\n`)

    for (;;) {
      const raw = await this.ask_(`  [y] 允许一次   [n] 拒绝   [d] 看完整参数   ${gray('(默认拒绝)')} `)
      if (raw === null) return 'denied' // 输入结束，按拒绝处理
      const a = raw.trim().toLowerCase()
      if (a === 'y' || a === 'yes') return 'allowed-once'
      if (a === 'd') {
        process.stdout.write(`${gray(req.detail ?? '(无额外参数)')}\n`)
        continue
      }
      if (a === 'n' || a === 'no' || a === '') return 'denied'
      process.stdout.write(`${red('  ?')} 请输入 y / n / d\n`)
    }
  }
}
