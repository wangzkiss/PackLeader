/**
 * 附件入库：把用户拖进来/选中的文件拷进数据目录，并决定它怎么进上下文。
 *
 * 三种处理方式，按"模型到底能不能用上"排序：
 *  1. 文本类且不大 → 直接内联进消息正文。模型不用再花一步去 read，快且省 token 抖动
 *  2. 图片 → 只记路径，真正读成 base64 是在 deriveMessages 里（模型要视觉才发）
 *  3. 其余（pdf/docx/zip/大文件）→ 只给路径和大小，让模型自己决定要不要动工具
 *
 * 为什么都拷一份：用户随手从桌面拖进来的文件可能下一秒就被删/被改，
 * 而会话是可以几天后重新打开继续聊的。
 */

import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Attachment } from './types.ts'

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift',
  '.css', '.scss', '.html', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.sql', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.log', '.csv', '.tsv', '.gitignore', '.dockerfile',
])

const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 内联文本的上限：再大就该让模型用 read + offset 去翻了 */
const INLINE_MAX = 120 * 1024

export function mimeOf(name: string): string {
  const ext = extname(name).toLowerCase()
  if (IMAGE_EXT[ext]) return IMAGE_EXT[ext]!
  if (TEXT_EXT.has(ext) || ext === '') return 'text/plain'
  if (ext === '.pdf') return 'application/pdf'
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (ext === '.zip') return 'application/zip'
  return 'application/octet-stream'
}

export const humanSize = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

export interface IngestResult {
  /** 拼进用户消息的那段文字（没有文件时是空串） */
  text: string
  attachments: Attachment[]
}

export async function ingestFiles(
  dataDir: string,
  sessionId: string,
  paths: string[],
  opts: { vision?: boolean } = {},
): Promise<IngestResult> {
  if (!paths.length) return { text: '', attachments: [] }
  const destDir = join(dataDir, 'files', sessionId)
  await mkdir(destDir, { recursive: true })

  const attachments: Attachment[] = []
  const inlinedBlocks: string[] = []
  const lines: string[] = []

  let i = 0
  for (const src of paths) {
    i++
    const name = basename(src) || `file-${i}`
    const st = await stat(src).catch(() => null)
    if (!st || !st.isFile()) continue
    // 同名文件不覆盖：加序号，保证同一轮里两个 a.txt 都还在
    const dest = join(destDir, `${String(i).padStart(2, '0')}-${name}`)
    await copyFile(src, dest).catch(() => undefined)
    const mime = mimeOf(name)
    const att: Attachment = { name, path: dest, bytes: st.size, mime }

    if (mime.startsWith('image/')) {
      // 路径必须给真的落盘路径（dest 带序号前缀，跟 name 不一样）：只报名字时模型会自己拼
      // destDir/name 去 view_image，日志里 3 次全是这么失败的
      lines.push(`- ${name} — ${humanSize(st.size)}, ${mime}${opts.vision ? `（已作为图片附上，可以直接看；要再看一遍就用 view_image，path 填 ${dest}）` : `（当前模型没开视觉，看不到内容，只能按文件名/大小判断；路径 ${dest}）`}`)
    } else if (mime.startsWith('text/') && st.size <= INLINE_MAX) {
      const raw = await readFile(dest, 'utf8').catch(() => '')
      // PowerShell 的 Set-Content/Out-File 会写 BOM。它会作为不可见字符进上下文，
      // 模型有时把它当成正文首字符（"﻿薄荷绿"），所以内联前统一去掉
      const body = raw.replace(/^\uFEFF/, '')
      att.inlined = true
      lines.push(`- ${name} — ${humanSize(st.size)}, ${mime}（内容已贴在下面，不用再 read）`)
      const ext = extname(name).replace(/^\./, '') || 'text'
      inlinedBlocks.push(`<file name="${name}" path="${dest}">\n\`\`\`${ext}\n${body.replace(/\s+$/, '')}\n\`\`\`\n</file>`)
    } else {
      lines.push(`- ${name} — ${humanSize(st.size)}, ${mime}（太大或非文本，需要时用工具自己看：${dest}）`)
    }
    attachments.push(att)
  }

  if (!attachments.length) return { text: '', attachments: [] }

  const text = [
    `[附件] ${attachments.length} 个文件，已保存到 ${destDir}：`,
    ...lines,
    '',
    ...inlinedBlocks,
  ].join('\n')
  return { text, attachments }
}
