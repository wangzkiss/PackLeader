/**
 * 运行时诊断工具：logtail / processlist / netprobe / sysstat。
 *
 * 四件都是只读的：看日志尾巴、看进程和端口、探网络、看机器余量。
 * 它们不给 agent 增加新的破坏面——真要改系统，还是走 shell（有审批）。
 */

import { open, stat, statfs } from 'node:fs/promises'
import { Socket } from 'node:net'
import { lookup } from 'node:dns/promises'
import { cpus, freemem, loadavg, totalmem } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Tool } from '../core/tools.ts'
import { needString, optNumber, optString } from '../core/tools.ts'
import { runShell } from './shell.ts'

const isWin = process.platform === 'win32'

function relPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/') || '.'
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}G`
}

/** 按 BOM / 前 64KB 猜编码：中文 Windows 上的日志十有八九是 GBK，直接按 UTF-8 读会满屏问号 */
function sniffEncoding(buf: Buffer): 'utf16le' | 'utf16be' | 'utf8' | 'gbk' {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le'
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.min(buf.length, 64 * 1024)))
    return 'utf8'
  } catch {
    return 'gbk'
  }
}

function decodeAs(buf: Buffer, enc: ReturnType<typeof sniffEncoding>): string {
  if (enc === 'utf16le') return buf.toString('utf16le')
  if (enc === 'utf16be') {
    const copy = Buffer.from(buf)
    if (copy.length % 2) return copy.toString('latin1')
    copy.swap16()
    return copy.toString('utf16le')
  }
  if (enc === 'gbk') {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('latin1')
    }
  }
  return buf.toString('utf8')
}

/**
 * 从文件尾倒着取最后 N 行。
 * 最多读 1MB 尾巴；多读的那一截从第一个换行之后开始解码，避免把多字节字符切成乱码。
 */
async function readTail(file: string, wantLines: number): Promise<{ text: string; encoding: string; truncated: boolean; bytes: number }> {
  const st = await stat(file)
  const size = st.size
  const maxBytes = 1024 * 1024
  const start = Math.max(0, size - maxBytes)
  const len = size - start
  const fh = await open(file, 'r')
  let buf: Buffer
  try {
    buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, start)
  } finally {
    await fh.close()
  }
  if (!buf.length) return { text: '', encoding: 'utf8', truncated: false, bytes: 0 }

  const enc = sniffEncoding(buf)
  let slice = buf
  if (start > 0) {
    let cut = -1
    if (enc === 'utf16le' || enc === 'utf16be') {
      for (let i = 0; i + 1 < buf.length; i += 2) {
        if (buf[i] === 0x0a && buf[i + 1] === 0x00) {
          cut = i + 2
          break
        }
      }
    } else {
      const at = buf.indexOf(0x0a)
      cut = at < 0 ? 0 : at + 1
    }
    if (cut > 0) slice = buf.subarray(cut)
  }
  const lines = decodeAs(slice, enc).split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const picked = lines.slice(Math.max(0, lines.length - wantLines))
  return { text: picked.join('\n'), encoding: enc, truncated: start > 0, bytes: size }
}

interface Proc {
  pid: number
  ppid?: number
  name: string
  rssKb: number
  cpu?: number
}

function parseTasklist(stdout: string): Proc[] {
  const out: Proc[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const t = /"([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)"/.exec(line)
    if (!t) continue
    out.push({ name: t[1] ?? '?', pid: Number(t[2] ?? 0), rssKb: Number((t[5] ?? '').replace(/[^\d]/g, '')) || 0 })
  }
  return out
}

function parsePs(stdout: string): Proc[] {
  const out: Proc[] = []
  const lines = stdout.split(/\r?\n/)
  for (const line of lines.slice(1)) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!m) continue
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rssKb: Number(m[4]), name: (m[5] ?? '').trim() })
  }
  return out
}

async function probeTcp(host: string, port: number, timeoutMs: number): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now()
  return new Promise((done) => {
    let settled = false
    const sock = new Socket()
    const finish = (ok: boolean, error?: string) => {
      if (settled) return
      settled = true
      sock.destroy()
      done({ ok, ms: Date.now() - started, error })
    }
    sock.setTimeout(timeoutMs, () => finish(false, `连接超时（${timeoutMs}ms）`))
    sock.once('connect', () => finish(true))
    sock.once('error', (e) => finish(false, (e as Error).message))
    sock.connect(port, host)
  })
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

export function createRuntimeTools(opts: { root: string }): Tool[] {
  const base = opts.root
  const abs = (p: string) => (isAbsolute(p) ? resolve(p) : resolve(opts.root, p))

  const logtail: Tool = {
    name: 'logtail',
    description:
      '读一个日志文件的最后若干行（不读全文）。自动认 UTF-8 / UTF-16 / GBK，中文日志不会变乱码。' +
      '排查「刚才出了什么错」先看尾巴，别整份读。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '日志文件路径' },
        lines: { type: 'integer', description: '从末尾取多少行，默认 200，最多 5000' },
      },
      required: ['path'],
    },
    permission: 'read',
    async run(_ctx, args) {
      const file = abs(needString(args, 'path'))
      const want = Math.min(5000, Math.max(1, optNumber(args, 'lines') ?? 200))
      const st = await stat(file).catch(() => null)
      if (!st) throw new Error(`不存在：${relPath(base, file)}`)
      if (!st.isFile()) throw new Error(`不是文件：${relPath(base, file)}（目录请用 list）`)
      const tail = await readTail(file, want)
      const head = `${relPath(base, file)}（${fmtSize(tail.bytes)}，编码 ${tail.encoding}，末 ${want} 行${tail.truncated ? '，只读了最后 1MB' : ''}）`
      return {
        content: tail.text ? `${head}\n${tail.text}` : `${head}\n（空文件）`,
        meta: { bytes: tail.bytes, encoding: tail.encoding },
      }
    },
  }

  const processlist: Tool = {
    name: 'processlist',
    description:
      '看进程，或看某个端口被谁占着。pattern 按进程名/命令行过滤；port 查端口占用（含 pid 与进程名）。只看不动。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '进程名或命令行包含这个关键词（不分大小写）' },
        port: { type: 'integer', description: '查这个 TCP 端口被哪个进程占着' },
        limit: { type: 'integer', description: '最多列多少条，默认 60' },
      },
      required: [],
    },
    permission: 'read',
    async run(_ctx, args) {
      const pattern = optString(args, 'pattern')?.toLowerCase()
      const port = optNumber(args, 'port')
      const limit = Math.min(500, Math.max(1, optNumber(args, 'limit') ?? 60))

      const procs: Proc[] = []
      if (!port) {
        const cmd = isWin ? 'tasklist /FO CSV /NH' : 'ps -eo pid,ppid,pcpu,rss,comm'
        const r = await runShell(cmd, { cwd: opts.root, timeoutMs: 20_000 })
        if (r.exitCode !== 0) return { content: `取进程列表失败（${cmd}）\n${clip(r.stderr || r.stdout, 2000)}`, exitCode: r.exitCode }
        procs.push(...(isWin ? parseTasklist(r.stdout) : parsePs(r.stdout)))
      }

      const lines: string[] = []
      if (port) {
        if (isWin) {
          const r = await runShell('netstat -ano -p TCP', { cwd: opts.root, timeoutMs: 20_000 })
          const pids = new Set<string>()
          for (const line of r.stdout.split(/\r?\n/)) {
            const cols = line.trim().split(/\s+/)
            if (cols[0] !== 'TCP' || cols.length < 4) continue
            const local = cols[1] ?? ''
            const m = /:(\d+)$/.exec(local)
            if (!m || Number(m[1]) !== port) continue
            pids.add(cols[cols.length - 1] ?? '')
          }
          if (!pids.size) return { content: `端口 ${port} 上没有正在监听的 TCP 连接（也可能是 UDP）` }
          const who = await runShell('tasklist /FO CSV /NH', { cwd: opts.root, timeoutMs: 20_000 })
          const all = parseTasklist(who.stdout)
          lines.push(`端口 ${port} 被占用：`)
          for (const pid of pids) {
            const p = all.find((x) => String(x.pid) === pid)
            lines.push(`  pid ${pid}  ${p?.name ?? '（查不到进程名）'}  ${p ? fmtSize(p.rssKb * 1024) : ''}`)
          }
        } else {
          const lsof = await runShell(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { cwd: opts.root, timeoutMs: 15_000 })
          if (lsof.exitCode === 0 && lsof.stdout.trim()) {
            lines.push(`端口 ${port} 被占用：`, clip(lsof.stdout.trimEnd(), 4000))
          } else {
            const ss = await runShell(`ss -ltnp 'sport = :${port}'`, { cwd: opts.root, timeoutMs: 15_000 })
            lines.push(
              ss.stdout.trim() ? `端口 ${port}：\n${clip(ss.stdout.trimEnd(), 4000)}` : `端口 ${port} 上没有正在监听的 TCP 连接`,
            )
          }
        }
      } else {
        const filtered = pattern
          ? procs.filter((p) => p.name.toLowerCase().includes(pattern))
          : procs
        filtered.sort((a, b) => b.rssKb - a.rssKb)
        const shown = filtered.slice(0, limit)
        const note = filtered.length > limit ? `（共 ${filtered.length} 个，只列内存最大的 ${limit} 个）` : `（共 ${filtered.length} 个）`
        lines.push(`进程${pattern ? `（名字含「${pattern}」）` : ''}${note}`)
        for (const p of shown) {
          lines.push(`  ${String(p.pid).padStart(7)}  ${fmtSize(p.rssKb * 1024).padStart(7)}${p.cpu !== undefined ? `  ${String(p.cpu).padStart(5)}% cpu` : ''}  ${p.name}`)
        }
      }
      return { content: lines.join('\n'), meta: { count: procs.length } }
    },
  }

  const netprobe: Tool = {
    name: 'netprobe',
    description:
      '从这台机器去探一个网络端点：DNS 解析 → TCP 端口 → TLS / HTTP 状态码分段报，卡在哪一层一眼看出。' +
      '给 host+port 只探到 TCP；给 url 再往下探 TLS 与 HTTP（正文只带回前 2KB）。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: '主机名或 IP（与 url 二选一）' },
        port: { type: 'integer', description: '端口（给 host 时必填）' },
        url: { type: 'string', description: 'http:// 或 https:// 地址' },
        timeout_ms: { type: 'integer', description: '每段超时，默认 5000，最多 30000' },
      },
      required: [],
    },
    permission: 'read',
    async run(_ctx, args) {
      const urlArg = optString(args, 'url')
      const hostArg = optString(args, 'host')
      const portArg = optNumber(args, 'port')
      const timeoutMs = Math.min(30_000, Math.max(500, optNumber(args, 'timeout_ms') ?? 5000))
      const lines: string[] = []

      let host = hostArg
      let port = portArg
      let parsed: URL | undefined
      if (urlArg) {
        try {
          parsed = new URL(urlArg)
        } catch (e) {
          throw new Error(`url 不合法：${urlArg}（${(e as Error).message}）`)
        }
        host = parsed.hostname
        port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
      }
      if (!host || !port) throw new Error('给 host+port，或给 url')

      // 1) DNS
      const dnsStarted = Date.now()
      const addrs: string[] = []
      const isLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
      if (isLiteral) {
        addrs.push(host)
        lines.push(`dns: 直接是 IP，跳过`)
      } else {
        try {
          const found = await lookup(host, { all: true })
          for (const a of found) addrs.push(a.address)
          lines.push(`dns: ${host} → ${addrs.join(', ')}（${Date.now() - dnsStarted}ms）`)
        } catch (e) {
          lines.push(`dns: 解析失败（${Date.now() - dnsStarted}ms）— ${(e as Error).message}`)
        }
      }
      if (!addrs.length) {
        lines.push('停在 dns 阶段：后面的 TCP / TLS / HTTP 都不用试了')
        return { content: lines.join('\n') }
      }

      // 2) TCP
      const tcpTarget = addrs[0] ?? host
      const tcp = await probeTcp(tcpTarget, port, timeoutMs)
      lines.push(
        tcp.ok ? `tcp: ${tcpTarget}:${port} 连得上（${tcp.ms}ms）` : `tcp: ${tcpTarget}:${port} 连不上（${tcp.error}，${tcp.ms}ms）`,
      )
      if (!tcp.ok || !parsed) return { content: lines.join('\n') }

      // 3+4) TLS / HTTP
      try {
        const res = await fetch(parsed.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'user-agent': 'packleader-netprobe' },
        })
        lines.push(`http: ${res.status} ${res.statusText}`)
        const interesting = ['content-type', 'content-length', 'server', 'location', 'www-authenticate']
        for (const [k, v] of res.headers) {
          if (interesting.includes(k.toLowerCase())) lines.push(`  ${k}: ${clip(v, 200)}`)
        }
        const body = await res.text().catch(() => '')
        lines.push(`body[前 2KB]: ${clip(body, 2048)}`)
      } catch (e) {
        const msg = (e as Error).message
        if (/certificate|CERT|self[- ]signed|SSL|TLS/i.test(msg)) lines.push(`tls: 证书 / 握手失败 — ${msg}`)
        else lines.push(`http: 请求失败 — ${msg}`)
      }
      return { content: lines.join('\n') }
    },
  }

  const sysstat: Tool = {
    name: 'sysstat',
    description: '看这台机器还剩多少：内存、CPU 核数与负载、各磁盘余量。“没空间了 / 内存不够”先看它。',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'read',
    async run(_ctx, _args) {
      const lines: string[] = []
      const total = totalmem()
      const free = freemem()
      lines.push(`内存: 用 ${fmtSize(total - free)} / 共 ${fmtSize(total)}（空闲 ${fmtSize(free)}，${(((total - free) / total) * 100).toFixed(0)}% 已用）`)
      const ld = loadavg()
      lines.push(
        `CPU: ${cpus().length} 核；负载 ${ld.map((n) => n.toFixed(2)).join(' ')}` +
          (isWin ? '（Windows 上 loadavg 恒为 0，看占用用 processlist）' : ''),
      )
      const drives = isWin ? 'CDEFGH'.split('').map((d) => `${d}:\\`) : ['/']
      lines.push('磁盘:')
      for (const d of drives) {
        try {
          const st = await statfs(d)
          const totalB = st.blocks * st.bsize
          const freeB = st.bfree * st.bsize
          const availB = st.bavail * st.bsize
          if (!totalB) continue
          lines.push(
            `  ${d}  总 ${fmtSize(totalB)}  可用 ${fmtSize(availB)}（已用 ${(((totalB - freeB) / totalB) * 100).toFixed(0)}%）`,
          )
        } catch {
          /* 盘不存在就跳过 */
        }
      }
      return { content: lines.join('\n') }
    },
  }

  return [logtail, processlist, netprobe, sysstat]
}
