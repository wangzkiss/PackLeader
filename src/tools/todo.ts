/**
 * 待办：让多步任务对用户可见（模型自己维护，不产生文件副作用）。
 */

import type { Tool } from '../core/tools.ts'

export function createTodoTools(): Tool[] {
  let items: Array<{ text: string; done: boolean }> = []

  const todo: Tool = {
    name: 'todo_write',
    description: '维护当前任务的待办清单（整体覆盖）。多步任务时用它让用户看到进度。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '完整的待办列表',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              done: { type: 'boolean' },
            },
            required: ['text'],
          },
        },
      },
      required: ['items'],
    },
    permission: 'read',
    async run(_ctx, args) {
      const raw = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>) : []
      items = raw.map((r) => ({ text: String(r.text ?? ''), done: r.done === true }))
      const body = items.map((i) => `${i.done ? '[x]' : '[ ]'} ${i.text}`).join('\n')
      return { content: `待办 ${items.filter((i) => i.done).length}/${items.length}\n${body}` }
    },
  }
  return [todo]
}
