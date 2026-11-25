/**
 * 策略：路径边界 + 三档模式。
 *
 * 这是「防手滑」不是「防恶意」——真正的隔离要换沙箱后端（见 DESIGN.md §10）。
 */

import { isAbsolute, relative, resolve } from 'node:path'
import type { Mode, Permission } from './types.ts'

export type Gate = 'allow' | 'ask' | 'deny'

/** 命中的危险操作（进审批卡，让用户一眼看懂风险） */
export interface DangerHit {
  why: string
  match: string
}

/**
 * 危险命令清单：命中就一律问一次（full 档也不自动放行）。
 * 这不是沙箱，只是让「npm test」和「rm -rf /」在审批卡上长得不一样。
 */
const DANGERS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, why: '递归强制删除（rm -rf）' },
  { re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*\s+)+(?:\/|~|\*|\.\.?)/, why: '递归删除关键路径' },
  { re: /\bgit\s+(?:reset\s+--hard|push\s+(?:-f|--force)\b|clean\s+-[a-zA-Z]*[fd])/, why: '不可逆的 git 操作（丢本地改动或覆写远端）' },
  { re: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i, why: '删表 / 删库' },
  { re: /\bDELETE\s+FROM\s+\w+\s*(?:;|$)/i, why: '无条件 DELETE（没有 WHERE）' },
  { re: /\b(?:mkfs|diskpart|bcdedit|format\s+[a-zA-Z]:)/i, why: '改磁盘 / 引导' },
  { re: /\bdd\s+if=/i, why: 'dd 写裸设备' },
  { re: /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(?:sh|bash|zsh|iex|powershell)\b/i, why: '下载内容直接执行' },
  { re: /\b(?:shutdown|Stop-Computer|Restart-Computer)\b/i, why: '关机 / 重启' },
  { re: /\btaskkill\b[^\n]*\/f\b/i, why: '强杀进程' },
  { re: /\b(?:chmod\s+-R\s+777|icacls\b[^\n]*\/grant\b)/i, why: '放宽权限' },
]

/** 文本里是否命中危险操作；没命中返回 null */
export function dangerOf(text: string): DangerHit | null {
  if (!text) return null
  for (const d of DANGERS) {
    const m = d.re.exec(text)
    if (m) return { why: d.why, match: m[0].slice(0, 80) }
  }
  return null
}

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
   * 越界的第一个路径；都在域内则返回 undefined。
   *
   * 一次调用可能碰多个路径（move 的 from/to、批量 target），必须逐个查。
   * 早先 gate 只看 targets[0]，`move from=<域内> to=<域外>` 就整条溜过去了。
   */
  outsideOf(paths: string | string[] | undefined): string | undefined {
    const list = paths === undefined ? [] : typeof paths === 'string' ? [paths] : paths
    return list.find((p) => typeof p === 'string' && p !== '' && !this.inside(p))
  }

  /**
   * 工具是否放行：
   *  - read   → allow（读不限域，见下方注释；这是刻意的取舍，不是漏了）
   *  - write  → read-only 档一律 deny；任一 target 出界即 deny（full 档除外）；guarded 档 ask；full 档 allow
   *  - detail（命令文本 / 改动摘要）命中危险清单 → 一律 ask，full 档也不例外
   *
   * 读为什么不限域：这是「防手滑」不是「防恶意」。把读也锁在 workspace 内，
   * 模型就查不了全局配置（~/.gitconfig）、依赖源码、系统日志——而这些正是它排查问题要看的。
   * 写、执行、删除才是会留下痕迹的操作，边界只管它们。
   */
  gate(permission: Permission, absPath?: string | string[], detail?: string): Gate {
    if (permission === 'read') return 'allow'
    if (this.mode === 'read-only') return 'deny'
    if (this.mode !== 'full' && this.outsideOf(absPath)) return 'deny'
    if (detail && dangerOf(detail)) return 'ask'
    if (this.mode === 'full') return 'allow'
    return 'ask'
  }

  describe(): string {
    return `${this.mode} @ ${this.root}`
  }
}
