/**
 * 提问：让模型在需求不清楚时向用户要一个选择，而不是自己猜。
 *
 * 通道由外层提供（GUI 弹选项卡；CLI 没有通道时会返回说明，不会挂住）。
 */

import type { Tool } from '../core/tools.ts'

export function createAskTools(): Tool[] {
  const ask: Tool = {
    name: 'ask',
    description:
      '向用户提一个问题，并给出 2-4 个选项让用户点选。需求有歧义、或在几个做法之间要用户拍板时用它，比猜着做强。' +
      '不要用它问开放式问题（要用户自由输入的话，直接把问题写在回复里）。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '一句话问题，最多 300 字' },
        options: {
          type: 'array',
          description: '2-4 个选项，每项是一句完整的话（选它意味着什么），不要写「其他 / 自定义」这类兜底项',
          items: { type: 'string' },
        },
      },
      required: ['question', 'options'],
    },
    permission: 'read',
    async run(ctx, args) {
      const question = String(args.question ?? '').trim()
      const raw = Array.isArray(args.options) ? args.options : []
      const options = raw
        .map((o) => String(o ?? '').trim())
        .filter(Boolean)
        .slice(0, 4)
      if (!question) return { content: 'ask 需要 question（一句话问题）', exitCode: 1 }
      if (options.length < 2) return { content: 'ask 至少要给 2 个选项', exitCode: 1 }
      if (!ctx.ask) return { content: '当前运行环境没有提问通道（GUI 里才有），请直接把问题写在回复里让用户回答', exitCode: 1 }
      const picked = await ctx.ask({ question, options })
      return { content: picked ? `用户选择：${picked}` : '用户没有作答' }
    },
  }
  return [ask]
}
