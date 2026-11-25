/**
 * 文件工具：read / write / edit / glob / grep / list / find / outline / stat / hash / move / remove。
 *
 * 路径一律相对 workspace root 解析；越界不在这里判，交给 Policy（loop 里统一 gate），
 * 但 write/edit 会通过 targets() 暴露绝对路径，供策略检查与写前快照。
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
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

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}G`
}

/** 本地时区的 YYYY-MM-DD HH:mm —— 比 ISO 好读 */
function fmtTime(ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
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

type OutlineRule = [RegExp, string]

/** 定义行的认法：按语言分表。逐行正则，不是语法分析——多行签名只认第一行，宏生成的会漏。 */
const OUTLINE_RULES: Record<string, OutlineRule[]> = {
  ts: [
    [/^\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
    [/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, 'type'],
    [/^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'fn'],
    [/^\s{2,}(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, 'method'],
  ],
  py: [
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'def'],
    [/^\s*class\s+([A-Za-z_]\w*)/, 'class'],
  ],
  go: [
    [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'func'],
    [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, 'type'],
  ],
  jvm: [
    [/^\s*(?:(?:public|private|protected|static|final|abstract|sealed|open|data|inner|enum)\s+)*(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)/, 'type'],
    [/^\s{2,}(?:(?:public|private|protected|static|final|abstract|synchronized|override|suspend|inline|open|default)\s+)+[\w<>\[\],.? ]*?\b([A-Za-z_]\w*)\s*\(/, 'method'],
  ],
  cs: [
    [/^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*(?:class|interface|enum|struct|record)\s+([A-Za-z_]\w*)/, 'type'],
    [/^\s{2,}(?:(?:public|private|protected|internal|static|final|abstract|async|override|virtual|sealed|extern|unsafe|partial)\s+)+[\w<>\[\],.? ]*?\b([A-Za-z_]\w*)\s*\(/, 'method'],
  ],
  rs: [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/, 'fn'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/, 'type'],
    [/^\s*impl\b\s*(.*)$/, 'impl'],
  ],
  md: [[/^(#{1,6})\s+(.+?)\s*$/, 'heading']],
  sql: [
    [/^\s*create\s+(?:or\s+replace\s+)?(?:table|view|index|function|procedure)\s+(?:if\s+not\s+exists\s+)?([\w."`\[\]]+)/i, 'create'],
    [/^\s*alter\s+table\s+([\w."`\[\]]+)/i, 'alter'],
  ],
  sh: [
    [/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{?/, 'function'],
    [/^\s*function\s+([A-Za-z_][\w-]*)/, 'function'],
    [/^\s*filter\s+([A-Za-z_][\w-]*)/i, 'filter'],
  ],
  php: [
    [/^\s*(?:(?:abstract|final)\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, 'type'],
    [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+([A-Za-z_]\w*)/, 'function'],
  ],
  lua: [[/^\s*(?:local\s+)?function\s+([\w.:]+)/, 'function']],
}

const OUTLINE_EXT: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.cjs': 'ts',
  '.py': 'py', '.go': 'go',
  '.java': 'jvm', '.kt': 'jvm', '.kts': 'jvm',
  '.cs': 'cs', '.rs': 'rs',
  '.md': 'md', '.markdown': 'md',
  '.sql': 'sql',
  '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh', '.ps1': 'sh',
  '.php': 'php', '.lua': 'lua',
}

/** 这两类名字后面跟括号时不该当成方法（if (x) { … }） */
const NOT_METHOD = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'new',
  'typeof', 'else', 'do', 'try', 'case', 'with', 'yield', 'super', 'this', 'delete',
])

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

  // 精确匹配多处时，把每一处的行号列出来
  function hitLines(text: string, oldText: string): number[] {
    const out: number[] = []
    let idx = text.indexOf(oldText)
    while (idx >= 0) {
      out.push(text.slice(0, idx).split('\n').length)
      idx = text.indexOf(oldText, idx + 1)
    }
    return out
  }

  const edit: Tool = {
    name: 'edit',
    description:
      '把文件里的一段文本精确替换。old 必须唯一命中（除非 replace_all=true）。换行风格（CRLF/LF）和行尾空白不同会自动对齐；失败会告诉你命中了几处、在第几行。',
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

      if (count > 1 && !all) {
        throw new Error(
          `原文命中 ${count} 处（第 ${hitLines(text, oldText).join('、')} 行），不唯一；请补充上下文或设 replace_all=true`,
        )
      }
      if (count >= 1) {
        const hit = all ? text.split(oldText).join(newText) : text.replace(oldText, newText)
        await writeFile(file, hit, 'utf8')
        return { content: `已修改 ${rel(root, file)}（替换 ${all ? count : 1} 处）` }
      }

      // 精确匹配没命中：模型抄 old 时差几个行尾空格、或者文件是 CRLF 而它给的是 LF，
      // 这两类差异按行比对一下就绕过去了（缩进内容本身的差异不放过）。
      const lines = text.split('\n')
      const tail = (s: string) => s.replace(/[ \t\r]+$/, '')
      const want = oldText.replace(/\r\n/g, '\n').split('\n').map(tail)
      const hits: number[] = []
      for (let i = 0; i + want.length <= lines.length; i++) {
        let ok = true
        for (let j = 0; j < want.length; j++) {
          if (tail(lines[i + j] ?? '') !== (want[j] ?? '')) {
            ok = false
            break
          }
        }
        if (ok) hits.push(i)
      }
      if (hits.length === 0) {
        // 把 old 第一行在文件里的位置告诉模型，它照着那一行的原文重发就能一次改对
        const at = lines.findIndex((l) => tail(l) === (want[0] ?? ''))
        const hint =
          at >= 0 ? `；第 ${at + 1} 行开头一样：${JSON.stringify((lines[at] ?? '').slice(0, 120))}` : ''
        throw new Error(
          `没找到要替换的原文（前 80 字符：${JSON.stringify(oldText.slice(0, 80))}）${hint}`,
        )
      }
      if (hits.length > 1 && !all) {
        throw new Error(
          `原文命中 ${hits.length} 处（第 ${hits.map((i) => i + 1).join('、')} 行），不唯一；请补充上下文或设 replace_all=true`,
        )
      }

      const crlf = text.includes('\r\n')
      // 换行风格跟文件走：CRLF 文件里，插入的行除“正好顶到文件末尾的那一行”外都要带 \r
      const buildInsert = (at: number) => {
        const ins = newText.replace(/\r\n/g, '\n').split('\n')
        if (crlf) {
          const endsAtEof = at + want.length >= lines.length
          for (let k = 0; k < ins.length; k++) {
            if (k === ins.length - 1 && endsAtEof) continue
            ins[k] = `${ins[k] ?? ''}\r`
          }
        }
        return ins
      }
      let next: string
      if (all) {
        const out = lines.slice()
        for (let h = hits.length - 1; h >= 0; h--) {
          const at = hits[h] ?? 0
          out.splice(at, want.length, ...buildInsert(at))
        }
        next = out.join('\n')
      } else {
        const at = hits[0] ?? 0
        next = [...lines.slice(0, at), ...buildInsert(at), ...lines.slice(at + want.length)].join('\n')
      }
      await writeFile(file, next, 'utf8')
      return {
        content: `已修改 ${rel(root, file)}（替换 ${all ? hits.length : 1} 处；行尾/换行差异已自动对齐）`,
      }
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

  const list: Tool = {
    name: 'list',
    description:
      '列目录内容（类型 / 大小 / 修改时间）。depth>1 时递归展开；默认不列隐藏项、不进 node_modules 等依赖与构建目录。' +
      'sort=mtime 适合看「最近改过什么」。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，默认 workspace 根' },
        depth: { type: 'integer', description: '递归层数，默认 1，最大 8' },
        sort: {
          type: 'string',
          enum: ['name', 'mtime', 'size'],
          description: 'name（目录在前，按名字）/ mtime（最近改的在前）/ size（最大的在前），默认 name',
        },
        limit: { type: 'integer', description: '最多返回多少条，默认 200' },
        all: { type: 'boolean', description: '含以 . 开头的隐藏条目' },
      },
      required: [],
    },
    permission: 'read',
    async run(ctx, args) {
      const target = abs(optString(args, 'path') ?? '.')
      const depth = Math.min(8, Math.max(1, optNumber(args, 'depth') ?? 1))
      const limit = Math.min(2000, Math.max(1, optNumber(args, 'limit') ?? 200))
      const showAll = args.all === true
      const sortArg = optString(args, 'sort') ?? 'name'
      const sortBy = sortArg === 'mtime' || sortArg === 'size' ? sortArg : 'name'

      const st0 = await stat(target).catch(() => null)
      if (!st0) throw new Error(`路径不存在：${rel(root, target)}`)
      if (st0.isFile()) {
        return { content: `${rel(root, target)} 是文件：${fmtSize(st0.size)}，改于 ${fmtTime(st0.mtimeMs)}。要读内容用 read。` }
      }

      type Row = { path: string; dir: boolean; size: number; mtime: number }
      const rows: Row[] = []
      let overflow = false

      const visit = async (dir: string, level: number): Promise<void> => {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch (e) {
          if (level === 1) throw new Error(`读不了目录 ${rel(root, dir)}：${(e as Error).message}`)
          return
        }
        for (const e of entries) {
          if (ctx.signal?.aborted || overflow) return
          if (!showAll && e.name.startsWith('.')) continue
          const full = join(dir, e.name)
          const isDir = e.isDirectory()
          const st = await stat(full).catch(() => null)
          rows.push({
            path: `${rel(root, full)}${isDir ? '/' : ''}`,
            dir: isDir,
            size: st?.size ?? 0,
            mtime: st?.mtimeMs ?? 0,
          })
          if (rows.length >= limit * 4) {
            overflow = true
            return
          }
          // 依赖/构建目录只列名字，不进去（否则一次 list 就把上下文撑满）
          if (isDir && level < depth && !SKIP_DIRS.has(e.name)) await visit(full, level + 1)
        }
      }
      await visit(target, 1)

      const cmp = (a: Row, b: Row): number => {
        if (sortBy === 'mtime') return b.mtime - a.mtime
        if (sortBy === 'size') return b.size - a.size
        if (a.dir !== b.dir) return a.dir ? -1 : 1
        return a.path.localeCompare(b.path)
      }
      rows.sort(cmp)
      const shown = rows.slice(0, limit)
      const head = `${rel(root, target)}/（${rows.length} 项，depth=${depth}${overflow ? '，已截断' : ''}）`
      const body = shown
        .map((r) => `${r.dir ? 'd' : '-'} ${(r.dir ? '-' : fmtSize(r.size)).padStart(6)} ${fmtTime(r.mtime)} ${r.path}`)
        .join('\n')
      const note = rows.length > limit ? `\n… 还有 ${rows.length - limit} 项没显示，用 limit 或收窄 path` : ''
      return { content: shown.length ? `${head}\n${body}${note}` : `${head}\n（空目录）`, meta: { count: rows.length } }
    },
  }

  const find: Tool = {
    name: 'find',
    description:
      '按文件名 glob 递归查找文件和目录（如 *.log、*.{ts,tsx}、nginx.conf）。模式不含 / 时只匹配名字本身，含 / 时匹配相对路径；' +
      '默认按名字排，sort=mtime 时最近改的在前。目录也参与匹配。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '从哪个目录开始找，默认 workspace 根' },
        pattern: { type: 'string', description: '文件名 glob，如 *.log、nginx.conf、src/**/*.ts' },
        max_depth: { type: 'integer', description: '最大递归深度，默认 20' },
        max_results: { type: 'integer', description: '最多返回多少条，默认 200' },
        skip: { type: 'integer', description: '跳过前 N 条（翻页用，填回上一页末尾给的那个数）' },
        sort: { type: 'string', enum: ['name', 'mtime'], description: '默认 name；mtime 按修改时间从新到旧' },
        all: { type: 'boolean', description: '含隐藏条目、也进 node_modules 等默认跳过的目录' },
      },
      required: ['path', 'pattern'],
    },
    permission: 'read',
    async run(ctx, args) {
      const pattern = needString(args, 'pattern').replace(/\\/g, '/')
      // 文件名查找不分大小写（*.LOG 和 *.log 是同一件事）
      const re = new RegExp(toRegExp(pattern).source, 'i')
      const byName = !pattern.includes('/')
      const scope = abs(optString(args, 'path') ?? '.')
      const maxDepth = Math.min(40, Math.max(1, optNumber(args, 'max_depth') ?? 20))
      const max = Math.min(2000, Math.max(1, optNumber(args, 'max_results') ?? 200))
      const skip = Math.max(0, optNumber(args, 'skip') ?? 0)
      const byMtime = optString(args, 'sort') === 'mtime'
      const showAll = args.all === true
      const hits: Array<{ path: string; mtime: number }> = []
      const cap = (skip + max) * 4

      const visit = async (dir: string, level: number): Promise<void> => {
        if (level > maxDepth || ctx.signal?.aborted || hits.length >= cap) return
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (ctx.signal?.aborted || hits.length >= cap) return
          if (!showAll && e.name.startsWith('.')) continue
          const full = join(dir, e.name)
          const isDir = e.isDirectory()
          const relRoot = rel(root, full).split(sep).join('/')
          const relScope = rel(scope, full).split(sep).join('/')
          if (byName ? re.test(e.name) : re.test(relRoot) || re.test(relScope)) {
            const st = await stat(full).catch(() => null)
            hits.push({ path: `${relRoot}${isDir ? '/' : ''}`, mtime: st?.mtimeMs ?? 0 })
          }
          // all=true 时才进 node_modules 这类默认跳过的目录
          if (isDir && (showAll || !SKIP_DIRS.has(e.name))) await visit(full, level + 1)
        }
      }

      const st0 = await stat(scope).catch(() => null)
      if (!st0) throw new Error(`路径不存在：${rel(root, scope)}`)
      if (st0.isFile()) {
        const name = rel(root, scope).split(sep).join('/')
        const hit = re.test(name.split('/').pop() ?? '') || re.test(name)
        return { content: hit ? name : `没有匹配 ${pattern} 的条目` }
      }
      await visit(scope, 1)

      hits.sort((a, b) => (byMtime ? b.mtime - a.mtime : a.path.localeCompare(b.path)))
      const page = hits.slice(skip, skip + max)
      const notes: string[] = []
      if (!hits.length) notes.push(`没有匹配 ${pattern} 的条目`)
      else if (hits.length > skip + max) notes.push(`[还有更多：用 skip=${skip + max} 继续]`)
      return {
        content: [page.map((h) => h.path).join('\n'), ...notes].filter(Boolean).join('\n'),
        meta: { matched: hits.length, shown: page.length, skip },
      }
    },
  }

  const outline: Tool = {
    name: 'outline',
    description:
      '列出一个源码文件（或一个目录下多个文件）里的定义：函数、类、方法、类型、Markdown 标题、SQL 建表，带行号。' +
      '不读正文——先看结构，再用 read 定点读那几段。识别 ts/js/py/go/java/kt/cs/rs/md/sql/sh/php/lua，其他语言给 lang 指定。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或目录' },
        glob: { type: 'string', description: 'path 是目录时，只列文件名匹配此 glob 的，如 *.ts' },
        max_files: { type: 'integer', description: '目录模式最多列几个文件，默认 40' },
        skip: { type: 'integer', description: '目录模式跳过前 N 个文件（翻页）' },
        lang: { type: 'string', description: '强制按某种语言识别（ts/py/go/jvm/cs/rs/md/sql/sh/php/lua），缺省按扩展名' },
      },
      required: ['path'],
    },
    permission: 'read',
    async run(ctx, args) {
      const target = abs(needString(args, 'path'))
      const langArg = optString(args, 'lang')?.toLowerCase()
      const globArg = optString(args, 'glob')
      const maxFiles = Math.min(200, Math.max(1, optNumber(args, 'max_files') ?? 40))
      const skip = Math.max(0, optNumber(args, 'skip') ?? 0)

      const st0 = await stat(target).catch(() => null)
      if (!st0) throw new Error(`路径不存在：${rel(root, target)}`)
      const files: string[] = []
      if (st0.isFile()) {
        files.push(target)
      } else {
        const re = globArg ? toRegExp(globArg.replace(/\\/g, '/')) : undefined
        for await (const file of walk(target, 0, ctx.signal)) {
          const relPath = rel(target, file).split(sep).join('/')
          const name = relPath.split('/').pop() ?? relPath
          if (re) {
            if (!re.test(relPath) && !re.test(name)) continue
          } else if (ASSET_EXT.has(extname(name).toLowerCase())) continue
          files.push(file)
          if (files.length >= 5000) break
        }
        files.sort((a, b) => rel(root, a).localeCompare(rel(root, b)))
      }

      const sections: string[] = []
      let listed = 0
      for (const file of files) {
        if (listed >= skip + maxFiles) break
        listed++
        if (listed <= skip) continue
        const name = rel(root, file).split(sep).join('/')
        const ext = extname(file).toLowerCase()
        const lang = langArg ?? OUTLINE_EXT[ext]
        const rules = lang ? OUTLINE_RULES[lang] : undefined
        if (!rules) {
          sections.push(`## ${name}\n（没认出语言：${ext || '无扩展名'}，可用 lang 指定）`)
          continue
        }
        const st = await stat(file).catch(() => null)
        if (!st || !st.isFile()) continue
        if (st.size > 1_500_000) {
          sections.push(`## ${name}\n（${fmtSize(st.size)}，太大，跳过；直接对该文件给 path 也一样）`)
          continue
        }
        const text = await readFile(file, 'utf8').catch(() => '')
        const lines = text.split('\n')
        const hits: string[] = []
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          for (const [rule, label] of rules) {
            const m = rule.exec(line)
            if (!m) continue
            const ident = m[1] ?? ''
            if ((label === 'method' || label === 'function') && NOT_METHOD.has(ident)) break
            const shown = (label === 'heading' ? `${'#'.repeat(ident.length)} ${m[2] ?? ''}` : line.trim()).slice(0, 160)
            hits.push(`${String(i + 1).padStart(5)}| ${shown}`)
            break
          }
        }
        sections.push(hits.length ? `## ${name}\n${hits.join('\n')}` : `## ${name}\n（没认出定义）`)
      }

      const notes: string[] = []
      if (files.length > skip + maxFiles) notes.push(`[还有 ${files.length - skip - maxFiles} 个文件没列，用 skip=${skip + maxFiles} 继续]`)
      if (!files.length) notes.push(`没有可列的文件`)
      const content = [sections.join('\n\n'), ...notes].filter(Boolean).join('\n\n')
      return { content, meta: { files: files.length, listed: Math.max(0, listed - skip), skip } }
    },
  }

  const statTool: Tool = {
    name: 'stat',
    description: '查一个文件或目录的元信息：类型、大小、修改时间、是否只读。读内容用 read，列子项用 list。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件或目录路径' } },
      required: ['path'],
    },
    permission: 'read',
    async run(_ctx, args) {
      const file = abs(needString(args, 'path'))
      const st = await stat(file).catch(() => null)
      if (!st) throw new Error(`不存在：${rel(root, file)}`)
      const kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other'
      const writable = (st.mode & 0o200) !== 0
      return {
        content: [
          rel(root, file),
          `type: ${kind}`,
          `size: ${st.size} (${fmtSize(st.size)})`,
          `mtime: ${fmtTime(st.mtimeMs)}  (${new Date(st.mtimeMs).toISOString()})`,
          `readonly: ${writable ? 'no' : 'yes'}`,
        ].join('\n'),
      }
    },
  }

  const hashTool: Tool = {
    name: 'hash',
    description: '算文件的 sha256（可指定 md5/sha1）。比对两份文件是否逐字节相同、确认下载没坏时用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        algo: { type: 'string', enum: ['sha256', 'sha1', 'md5'], description: '缺省 sha256' },
      },
      required: ['path'],
    },
    permission: 'read',
    async run(_ctx, args) {
      const file = abs(needString(args, 'path'))
      const algo = optString(args, 'algo') ?? 'sha256'
      if (!['sha256', 'sha1', 'md5'].includes(algo)) throw new Error(`不支持的算法：${algo}（sha256 / sha1 / md5）`)
      const st = await stat(file).catch(() => null)
      if (!st?.isFile()) throw new Error(`不是文件：${rel(root, file)}`)
      if (st.size > 512 * 1024 * 1024) throw new Error(`文件过大（${fmtSize(st.size)}），hash 不适合在这里算`)
      const digest = createHash(algo).update(await readFile(file)).digest('hex')
      return { content: `${algo} ${digest}  ${rel(root, file)}` }
    },
  }

  const move: Tool = {
    name: 'move',
    description:
      '移动或改名文件/目录（相当于 mv），父目录不存在会自动建。目标已存在时拒绝，不静默覆盖。' +
      '注意：快照只备份文件，目录移动撤销不回来——移目录前先确认。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源路径' },
        to: { type: 'string', description: '目标路径（含新名字）' },
      },
      required: ['from', 'to'],
    },
    permission: 'write',
    targets: (args) => [abs(String(args.from ?? '')), abs(String(args.to ?? ''))],
    async run(_ctx, args) {
      const src = abs(needString(args, 'from'))
      const dst = abs(needString(args, 'to'))
      if (src === dst) throw new Error('源和目标是同一个路径')
      const st = await stat(src).catch(() => null)
      if (!st) throw new Error(`源不存在：${rel(root, src)}`)
      const occupied = await stat(dst).catch(() => null)
      if (occupied) throw new Error(`目标已存在：${rel(root, dst)}（不覆盖，请先确认）`)
      await mkdir(dirname(dst), { recursive: true })
      let how = 'rename'
      try {
        await rename(src, dst)
      } catch (e) {
        // 跨盘 rename 会 EXDEV，退化成「复制 + 删源」
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
        how = 'copy+remove'
        await copyFile(src, dst)
        await rm(src, { recursive: st.isDirectory(), force: true })
      }
      return { content: `已移动 ${rel(root, src)} → ${rel(root, dst)}（${how}）` }
    },
  }

  const remove: Tool = {
    name: 'remove',
    description:
      '删除文件或目录（目录必须 recursive=true）。快照只备份文件，删目录撤销不回来——删前先看清里面是什么。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要删的文件或目录' },
        recursive: { type: 'boolean', description: '删整棵目录（含里面所有东西），默认 false' },
      },
      required: ['path'],
    },
    permission: 'write',
    targets: (args) => [abs(String(args.path ?? ''))],
    async run(_ctx, args) {
      const file = abs(needString(args, 'path'))
      const st = await stat(file).catch(() => null)
      if (!st) throw new Error(`不存在：${rel(root, file)}`)
      const recursive = args.recursive === true
      if (st.isDirectory() && !recursive) throw new Error(`${rel(root, file)} 是目录，删目录要 recursive=true`)
      await rm(file, { recursive: recursive && st.isDirectory(), force: true })
      return { content: `已删除 ${rel(root, file)}${st.isDirectory() ? '/' : ''}` }
    },
  }

  return [read, write, edit, glob, grep, list, find, outline, statTool, hashTool, move, remove]
}
