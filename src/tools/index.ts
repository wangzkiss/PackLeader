/**
 * 默认工具集：read / write / edit / glob / grep / list / find / outline / stat / hash / move / remove
 * + shell + todo_write + logtail / processlist / netprobe / sysstat + remember。
 */

import { MemoryStore } from '../core/memory.ts'
import { createFsTools } from './fs.ts'
import { createMemoryTools } from './memory.ts'
import { createRuntimeTools } from './runtime.ts'
import { createShellTools } from './shell.ts'
import { createTodoTools } from './todo.ts'
import { createAskTools } from './ask.ts'
import { ToolRegistry } from '../core/tools.ts'

export function createDefaultTools(opts: {
  root: string
  /** 记忆落盘位置；给了才注册 remember */
  dataDir?: string
  /** 外部共享的 store（host 用它注入提示、做撤销）；不传就按 dataDir 新建 */
  memory?: MemoryStore
  shellTimeoutMs?: number
}): ToolRegistry {
  const registry = new ToolRegistry()
  for (const t of createFsTools(opts.root)) registry.register(t)
  for (const t of createShellTools({ cwd: opts.root, timeoutMs: opts.shellTimeoutMs })) registry.register(t)
  for (const t of createRuntimeTools({ root: opts.root })) registry.register(t)
  for (const t of createTodoTools()) registry.register(t)
  for (const t of createAskTools()) registry.register(t)
  const memory = opts.memory ?? (opts.dataDir ? new MemoryStore(opts.dataDir, opts.root) : null)
  if (memory) for (const t of createMemoryTools(memory)) registry.register(t)
  return registry
}
