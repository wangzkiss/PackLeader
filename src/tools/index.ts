/**
 * 默认工具集：read / write / edit / glob / grep / list / find / outline / stat / hash / move / remove
 * + shell + todo_write + logtail / processlist / netprobe / sysstat。
 */

import { createFsTools } from './fs.ts'
import { createRuntimeTools } from './runtime.ts'
import { createShellTools } from './shell.ts'
import { createTodoTools } from './todo.ts'
import { ToolRegistry } from '../core/tools.ts'

export function createDefaultTools(opts: { root: string; shellTimeoutMs?: number }): ToolRegistry {
  const registry = new ToolRegistry()
  for (const t of createFsTools(opts.root)) registry.register(t)
  for (const t of createShellTools({ cwd: opts.root, timeoutMs: opts.shellTimeoutMs })) registry.register(t)
  for (const t of createRuntimeTools({ root: opts.root })) registry.register(t)
  for (const t of createTodoTools()) registry.register(t)
  return registry
}
