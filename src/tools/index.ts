/**
 * 默认工具集：read / write / edit / glob / grep / shell / todo_write。
 * A 档就这七个（见 DESIGN.md §6.2）。
 */

import { createFsTools } from './fs.ts'
import { createShellTools } from './shell.ts'
import { createTodoTools } from './todo.ts'
import { ToolRegistry } from '../core/tools.ts'

export function createDefaultTools(opts: { root: string; shellTimeoutMs?: number }): ToolRegistry {
  const registry = new ToolRegistry()
  for (const t of createFsTools(opts.root)) registry.register(t)
  for (const t of createShellTools({ cwd: opts.root, timeoutMs: opts.shellTimeoutMs })) registry.register(t)
  for (const t of createTodoTools()) registry.register(t)
  return registry
}
