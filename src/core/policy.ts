/**
 * 策略：路径边界 + 三档模式。
 *
 * 这是「防手滑」不是「防恶意」——真正的隔离要换沙箱后端（见 DESIGN.md §10）。
 */

import { isAbsolute, relative, resolve } from 'node:path'
import type { Mode, Permission } from './types.ts'

export type Gate = 'allow' | 'ask' | 'deny'

export class Policy {
  /** 可运行期切换（GUI 里换 workspace / 改权限档位） */
  root: string
  mode: Mode

  constructor(root: string, mode: Mode) {
    this.root = resolve(root)
    this.mode = mode
  }

  setMode(mode: Mode): void {
    this.mode = mode
  }

  setRoot(root: string): void {
    this.root = resolve(root)
  }

  /** 相对路径按 workspace root 解析 */
  absolute(p: string): string {
    return isAbsolute(p) ? resolve(p) : resolve(this.root, p)
  }

  /** 是否在 workspace 内（含等于） */
  inside(abs: string): boolean {
    const rel = relative(this.root, abs)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }

  /**
   * 工具是否放行：
   *  - read   → allow
   *  - write  → read-only 档一律 deny；越界 deny（full 档除外）；guarded 档 ask；full 档 allow
   */
  gate(permission: Permission, absPath?: string): Gate {
    if (permission === 'read') return 'allow'
    if (this.mode === 'read-only') return 'deny'
    if (absPath && !this.inside(absPath) && this.mode !== 'full') return 'deny'
    if (this.mode === 'full') return 'allow'
    return 'ask'
  }

  describe(): string {
    return `${this.mode} @ ${this.root}`
  }
}
