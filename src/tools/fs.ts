/**
 * 文件工具：read / write / edit / glob / grep。
 *
 * 路径一律相对 workspace root 解析；越界不在这里判，交给 Policy（loop 里统一 gate），
 * 但 write/edit 会通过 targets() 暴露绝对路径，供策略检查与写前快照。
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { Tool } from '../core/tools.ts'
import { needString, optNumber, optString } from '../core/tools.ts'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage',
  '.venv', '__pycache__', 'target', '.packleader', '.idea', '.vscode',
  // 构建产物：DSH 仓库里 .desktop-build/targets 一个目录就有 3 万个文件
  '.desktop-build', '.dist', '.turbo', '.cache', 'release', '.pnpm-store',
])

/** 二进制/资源文件：默认不参与 grep，除非显式给了 include */
const ASSET_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.svg', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.webm', '.wav', '.ogg',
  '.zip', '.gz', '.br', '.tar', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.node', '.wasm', '.class', '.jar', '.pyc',
  '.pdf', '.db', '.sqlite', '.sqlite3', '.map', '.lockb',
])
const MAX_READ_BYTES = 2 * 1024 * 1024

function rel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/') || '.'
}

function globToRegex(glob: string): string {
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
  return out
}

/** 展开 `{js,json}` 这类大括号（模型很爱用），不支持嵌套 */
function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]*)\}/.exec(pattern)
  if (!m) return [pattern]
  const parts = m[1]!.split(',')
  return parts.flatMap((p) => expandBraces(pattern.slice(0, m.index) + p + pattern.slice(m.index + m[0].length)))
}

function toRegExp(glob: string): RegExp {
  const alts = expandBraces(glob).map(globToRegex)
  return new RegExp(`^(?:${alts.join('|')})$`)
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
      const want = Math.min(2000, optNumber(args, 'limit') ?? 2000)
      // 按字节预算切片，避免读出一个 90KB 的结果又被上层截断（白读一次）
      const budget = 48 * 1024
      const picked: string[] = []
      let bytes = 0
      for (let i = offset - 1; i < lines.length && picked.length < want; i++) {
        const line = lines[i]!
        const cost = Buffer.byteLength(line, 'utf8') + 8
        if (bytes + cost > budget) break
        picked.push(line)
        bytes += cost
      }
      if (!picked.length && offset <= lines.length) picked.push(lines[offset - 1]!.slice(0, 4000))
      const body = picked.map((l, i) => `${String(offset + i).padStart(5)}| ${l}`).join('\n')
      const nextLine = offset + picked.length
      const footer = nextLine <= lines.length ? `\n[还有 ${lines.length - nextLine + 1} 行，用 offset=${nextLine} 继续]` : ''
      return { content: `${rel(root, file)} (共 ${lines.length} 行，本次 ${offset}-${offset + picked.length - 1})\n${body}${footer}` }
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
        path: { type: 'string', description: '只在这个目录（或这个文件）下找，默认 workspace 根' },
        limit: { type: 'integer', description: '最多返回多少个，默认 200' },
      },
      required: ['pattern'],
    },
    permission: 'read',
    async run(ctx, args) {
      const pattern = needString(args, 'pattern').replace(/\\/g, '/')
      const re = toRegExp(pattern)
      const limit = Math.min(1000, optNumber(args, 'limit') ?? 200)
      const scopeArg = optString(args, 'path')
      const scope = scopeArg ? abs(scopeArg) : root
      const scopeStat = await stat(scope).catch(() => null)
      const hits: Array<{ path: string; mtime: number }> = []

      const consider = async (file: string, base: string) => {
        const relBase = rel(base, file)
        const relRoot = rel(root, file)
        if (!re.test(relBase) && !re.test(relRoot)) return
        const st = await stat(file).catch(() => null)
        hits.push({ path: relRoot, mtime: st?.mtimeMs ?? 0 })
      }

      if (scopeStat?.isFile()) {
        await consider(scope, root)
      } else {
        for await (const file of walk(scope, 0, ctx.signal)) {
          await consider(file, scope)
          if (hits.length >= limit * 4) break
        }
      }
      hits.sort((a, b) => b.mtime - a.mtime)
      const shown = hits.slice(0, limit)
      return {
        content: shown.length ? shown.map((h) => h.path).join('\n') : `没有匹配 ${pattern} 的文件`,
        meta: { matched: hits.length, partial: hits.length >= limit * 4 },
      }
    },
  }

  const grep: Tool = {
    name: 'grep',
    description:
      '在文件内容里按正则搜索，返回 路径:行号: 内容。默认跳过 node_modules/.git/构建产物/二进制/资源文件。' +
      '大仓库请尽量给 include（如 "*.ts"）缩小范围；返回里会说明是否只扫了一部分。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        include: { type: 'string', description: '只搜匹配该 glob 的文件，例如 "*.ts"；给了就不再跳过资源扩展名' },
        path: { type: 'string', description: '只在这个目录（或这个文件）里搜，默认 workspace 根' },
        max_results: { type: 'integer', description: '最多返回多少行，默认 200' },
        budget_ms: { type: 'integer', description: '时间预算（毫秒），默认 4000；超时会停下并说明' },
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
      const deadline = Date.now() + Math.max(200, optNumber(args, 'budget_ms') ?? 4000)
      const scopeArg = optString(args, 'path')
      const scope = scopeArg ? abs(scopeArg) : root

      // 模型常把路径当 pattern 传（ripgrep 习惯），给它一条明确的纠正提示，省掉一次瞎搜
      if (!includeRe && !scopeArg && /[\\/]|\.\w{1,5}$/.test(source) && !/[*?()[\]{}|+^$]/.test(source)) {
        const looksLike = await stat(abs(source)).catch(() => null)
        if (looksLike) {
          return {
            content:
              `⚠ "${source}" 看起来是路径，不是搜索模式。grep 需要 pattern（正则），可选 path 限定范围。` +
              `例如：{"pattern": "TODO", "path": "${source}", "include": "*.ts"}`,
            meta: { hint: true },
          }
        }
      }

      // 先只走目录树（不读内容），把候选文件挑出来
      const files: string[] = []
      const keep = (file: string): boolean => {
        const relPath = rel(root, file)
        if (includeRe) {
          const base = relPath.split('/').pop() ?? relPath
          return includeRe.test(relPath) || includeRe.test(base)
        }
        return !ASSET_EXT.has(extname(relPath).toLowerCase())
      }
      const scopeStat = await stat(scope).catch(() => null)
      if (scopeStat?.isFile()) {
        if (keep(scope)) files.push(scope)
      } else {
        for await (const file of walk(scope, 0, ctx.signal)) {
          if (keep(file)) files.push(file)
          if (files.length >= 50_000) break
        }
      }

      const scanOne = async (file: string): Promise<string[]> => {
        const st = await stat(file).catch(() => null)
        if (!st || st.size > 1_500_000) return []
        const buf = await readFile(file).catch(() => null)
        if (!buf || buf.includes(0)) return []
        const name = rel(root, file)
        const hits: string[] = []
        const lines = buf.toString('utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) hits.push(`${name}:${i + 1}: ${lines[i]!.trim().slice(0, 240)}`)
        }
        return hits
      }

      const out: string[] = []
      let scanned = 0
      let stopped = false
      const BATCH = 16
      for (let i = 0; i < files.length && out.length < max; i += BATCH) {
        if (Date.now() > deadline) {
          stopped = true
          break
        }
        const batch = files.slice(i, i + BATCH)
        const results = await Promise.all(batch.map(scanOne))
        for (const hits of results) {
          scanned++
          for (const line of hits) {
            out.push(line)
            if (out.length >= max) break
          }
          if (out.length >= max) break
        }
      }

      const notes: string[] = []
      if (stopped) notes.push(`⚠ 时间预算用尽，只扫了 ${scanned}/${files.length} 个候选文件，结果可能不全——请用 include 或更精确的正则`)
      if (out.length >= max) notes.push(`⚠ 已达返回上限 ${max} 条，可能有遗漏`)
      const head = out.length ? out.join('\n') : `没有匹配 ${source} 的内容（扫描 ${scanned} 个文件）`
      return {
        content: notes.length ? `${head}\n\n${notes.join('\n')}` : head,
        meta: { matched: out.length, scanned, candidates: files.length, partial: stopped || out.length >= max },
      }
    },
  }

  return [read, write, edit, glob, grep]
}
