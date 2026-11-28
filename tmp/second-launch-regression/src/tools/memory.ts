/**
 * 记忆工具：让模型把值得长期记住的事写下来。
 *
 * 写的是 <数据目录>/memory/ 下的文件（不进用户仓库），所以权限按只读算——
 * 它不改用户的代码，只往 agent 自己的笔记本里添一行。
 */

import type { MemoryStore } from '../core/memory.ts'
import { needString, type Tool } from '../core/tools.ts'

export function createMemoryTools(store: MemoryStore): Tool[] {
  const remember: Tool = {
    name: 'remember',
    description:
      '把一条值得长期记住的事实写进记忆（同一工作目录下之后的会话都能看到）。' +
      '默认就该记，不要问用户要不要记：做完一轮、决定了某个做法、发现项目的坑或约定、' +
      '用户表达了偏好或禁忌，都用它记一条。一条只写一件事，写成一句陈述句。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的一句话，写成陈述句' },
      },
      required: ['text'],
    },
    permission: 'read',
    async run(_ctx, args) {
      const text = needString(args, 'text').trim()
      if (!text) return { content: '记忆内容为空，没有写入', exitCode: 1 }
      const item = await store.add(text)
      return { content: `记住了 ${item.id}：${item.text}`, meta: { memoryId: item.id } }
    },
  }
  return [remember]
}
