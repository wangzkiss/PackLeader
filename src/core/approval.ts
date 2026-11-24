/**
 * 审批：一次性、fail-closed、没有 allow-always。
 *
 * 三种来源，优先级从高到低：
 *   1. --deny / PL_APPROVAL=deny    → 一律拒（CI）
 *   2. --yes  / PL_APPROVAL=allow   → 一律放行（仍受 read-only 档约束，因为策略在前）
 *   3. ask                          → 交给 Approver；没有 Approver 则 unavailable（= 拒）
 */

import type { Decision } from './types.ts'

export interface ApprovalRequest {
  reqId: string
  tool: string
  reason: string
  detail?: string
}

export interface Approver {
  ask(req: ApprovalRequest): Promise<Decision>
}

export type ApprovalPolicy = 'ask' | 'allow' | 'deny'

export class ApprovalBroker {
  readonly policy: ApprovalPolicy
  private approver: Approver | undefined

  constructor(policy: ApprovalPolicy, approver?: Approver) {
    this.policy = policy
    this.approver = approver
  }

  async decide(req: ApprovalRequest): Promise<Decision> {
    if (this.policy === 'deny') return 'denied'
    if (this.policy === 'allow') return 'allowed-once'
    if (!this.approver) return 'unavailable'
    try {
      return await this.approver.ask(req)
    } catch {
      return 'cancelled'
    }
  }
}
