/**
 * 文件工具：read / write / edit / glob / grep。
 *
 * 路径一律相对 workspace root 解析；越界不在这里判，交给 Policy（loop 里统一 gate），
 * 但 write/edit 会通过 targets() 暴露绝对路径，供策略检查与写前快照。
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Tool } from '../core/tools.ts'
import { needString, optNumber, optString } from '../core/tools.ts'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage',
  '.venv', '__pycache__', 'target', '.packleader', '.idea', '.vscode',
])
const MAX_READ_BYTES = 2 * 1024 * 1024

function rel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/') || '.'
}

function toRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if ('\\^$.|+()[]{}'.includes(c)) out += `\\${c}`
    else out += c
  }
  return new RegExp(`^${out}$`)
}

async function* walk(root: string, depth = 0, signal?: AbortSignal): AsyncGenerator<string> {
  if (depth > 12 || signal?.aborted) return
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (signal?.aborted) return
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      yield* walk(join(root, e.name), depth + 1, signal)
    } else if (e.isFile()) {
      yield join(root, e.name)
    }
  }
}

export function createFsTools(root: string): Tool[] {
  const abs = (p: string) => (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) ? resolve(p) : resolve(root, p))

  const read: Tool = {
    name: 'read',
    description: '读取一个文本文件并带行号返回。可指定 offset/limit 分段读大文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对或相对 workspace）' },
        offset: { type: 'integer', description: '从第几行开始（1 起），默认 1' },
        limit: { type: 'integer', description: '最多读多少行，默认全部（最多 2000）' },
      },
      required: ['path'],
    },
    permission: 'read',
    async run(ctx, args) {
      const file = abs(needString(args, 'path'))
      const st = await stat(file)
      if (!st.isFile()) throw new Error(`不是文件：${rel(root, file)}`)
      if (st.size > MAX_READ_BYTES) throw new Error(`文件过大（${(st.size / 1024 / 1024).toFixed(1)} MB），请用 offset/limit 或 grep`)
      const text = await readFile(file, 'utf8')
      ctx.readFiles.add(file)
      const lines = text.split('\n')
      const offset = Math.max(1, optNumber(args, 'offset') ?? 1)
      const limit = Math.min(2000, optNumber(args, 'limit') ?? lines.length)
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const body = slice.map((l, i) => `${String(offset + i).padStart(5)}| ${l}`).join('\n')
      return { content: `${rel(root, file)} (${lines.length} 行)\n${body}` }
    },
  }

  const write: Tool = {
    name: 'write',
    description: '整体写入一个文件（会覆盖），必要时自动创建父目录。要小改动用 edit。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '完整内容' },
      },
      required: ['path', 'content'],
    },
    permission: 'write',
    targets: (args) => [abs(String(args.path ?? ''))],
    async run(_ctx, args) {
      const file = abs(needString(args, 'path'))
      const content = typeof args.content === 'string' ? args.content : String(args.content ?? '')
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content, 'utf8')
      const n = content.split('\n').length
      return { content: `已写入 ${rel(root, file)}（${content.length} 字节，${n} 行）` }
    },
  }

  const edit: Tool = {
    name: 'edit',
    description:
      '把文件里的一段文本精确替换。old 必须唯一命中（除非 replace_all=true）。失败会告诉你命中了几处。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old: { type: 'string', description: '要被替换的原文（含缩进，逐字匹配）' },
        new: { type: 'string', description: '替换成的新文本，空字符串表示删除' },
        replace_all: { type: 'boolean', description: '是否替换所有命中，默认 false' },
      },
      required: ['path', 'old', 'new'],
    },
    permission: 'write',
    targets: (args) => [abs(String(args.path ?? ''))],
    async run(_ctx, args) {
      const file = abs(needString(args, 'path'))
      const oldText = needString(args, 'old')
      const newText = typeof args.new === 'string' ? args.new : ''
      const all = args.replace_all === true
      const text = await readFile(file, 'utf8')
      const count = text.split(oldText).length - 1
      if (count === 0) throw new Error(`没找到要替换的原文（前 80 字符：${JSON.stringify(oldText.slice(0, 80))}）`)
      if (count > 1 && !all) throw new Error(`原文命中 ${count} 处，不唯一；请补充上下文或设 replace_all=true`)
      const next = all ? text.split(oldText).join(newText) : text.replace(oldText, newText)
      await writeFile(file, next, 'utf8')
      return { content: `已修改 ${rel(root, file)}（替换 ${all ? count : 1} 处）` }
    },
  }

  const glob: Tool = {
    name: 'glob',
    description: '按 glob 查找文件，例如 "src/**/*.ts"。返回相对路径，最近修改的在前。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式' },
        limit: { type: 'integer', description: '最多返回多少个，默认 200' },
      },
      required: ['pattern'],
    },
    permission: 'read',
    async run(ctx, args) {
      const pattern = needString(args, 'pattern').replace(/\\/g, '/')
      const re = toRegExp(pattern)
      const limit = Math.min(1000, optNumber(args, 'limit') ?? 200)
      const hits: Array<{ path: string; mtime: number }> = []
      for await (const file of walk(root, 0, ctx.signal)) {
        const r = rel(root, file)
        if (!re.test(r)) continue
        const st = await stat(file).catch(() => null)
        hits.push({ path: r, mtime: st?.mtimeMs ?? 0 })
        if (hits.length >= limit * 4) break
      }
      hits.sort((a, b) => b.mtime - a.mtime)
      const shown = hits.slice(0, limit)
      return {
        content: shown.length ? shown.map((h) => h.path).join('\n') : `没有匹配 ${pattern} 的文件`,
        meta: { matched: hits.length },
      }
    },
  }

  const grep: Tool = {
    name: 'grep',
    description: '在文件内容里按正则搜索，返回 路径:行号: 内容。默认跳过 node_modules/.git 等目录。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        include: { type: 'string', description: '只搜匹配该 glob 的文件，例如 "*.ts"' },
        max_results: { type: 'integer', description: '最多返回多少行，默认 200' },
      },
      required: ['pattern'],
    },
    permission: 'read',
    async run(ctx, args) {
      const source = needString(args, 'pattern')
      let re: RegExp
      try {
        re = new RegExp(source, 'i')
      } catch (e) {
        throw new Error(`正则不合法：${(e as Error).message}`)
      }
      const include = optString(args, 'include')
      const includeRe = include ? toRegExp(include.replace(/\\/g, '/')) : undefined
      const max = Math.min(1000, optNumber(args, 'max_results') ?? 200)
      const out: string[] = []
      let scanned = 0
      for await (const file of walk(root, 0, ctx.signal)) {
        const relPath = rel(root, file)
        if (includeRe) {
          const base = relPath.split('/').pop() ?? relPath
          if (!includeRe.test(relPath) && !includeRe.test(base)) continue
        }
        const st = await stat(file).catch(() => null)
        if (!st || st.size > 1_500_000) continue
        const buf = await readFile(file).catch(() => null)
        if (!buf || buf.includes(0)) continue // 跳过二进制
        scanned++
        const lines = buf.toString('utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            out.push(`${rel(root, file)}:${i + 1}: ${lines[i]!.trim().slice(0, 240)}`)
            if (out.length >= max) break
          }
        }
        if (out.length >= max) break
      }
      return {
        content: out.length ? out.join('\n') : `没有匹配 ${source} 的内容（扫描 ${scanned} 个文件）`,
        meta: { matched: out.length, scanned },
      }
    },
  }

  return [read, write, edit, glob, grep]
}
