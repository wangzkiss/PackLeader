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
      const left = items.filter((i) => !i.done).length
      // 用户界面上这张卡是全轮唯一会变的进度条：模型常写一次就忘了勾，
      // 所以把「继续回写」的要求挂在结果里（每看一次结果就被提醒一次）
      const hint =
        left > 0
          ? `\n（还剩 ${left} 项。做完一项就再调一次 todo_write 把它勾上，别攒到最后；收尾给结论前必须把清单更新到最终状态。）`
          : '\n（清单已全部完成。若后面还有新步骤，记得同步更新这张卡。）'
      return {
        content: `待办 ${items.filter((i) => i.done).length}/${items.length}\n${body}${hint}`,
        // 界面拿这个画计划卡（勾选样式），不当普通工具输出渲染
        data: { items },
      }
    },
  }
  return [todo]
}
