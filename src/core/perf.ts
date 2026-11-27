/**
 * 性能日志（perf log）：一行一条 JSONL。
 *
 * 为什么要它：用户说「启动卡」「用着卡」「这次怎么没反应」，光靠界面日志
 * （%TEMP%\packleader-ui.log，每次启动清空、只有启动打点和异常）没法复盘。
 * 这里记的是可以对齐时间轴的数字：启动每一段多久、主线程哪一次被占住了、
 * 一次操作从点击到看得见用了多久。
 *
 * 三层进程各写各的文件（launcher / ui / host），否则三个进程同时持有句柄、
 * Windows 上 append 不是原子的，会出现难查的丢行。分析时按 ts 合并即可：
 *   - run / t0 由启动器生成，经 PL_PERF_RUN / PL_PERF_T0 环境变量往下传
 *   - 每条记录同时带 ts（epoch 毫秒）与 mono（相对 t0 的毫秒），
 *     跨进程比 mono 就是「距离这次双击多少毫秒」
 *
 * 开销纪律：写盘绝不发生在等它的调用里——内存里攒够或每 500ms 批量 append 一次，
 * 磁盘满/没权限一律吞掉，日志不能拖垮程序本身。
 */

import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PerfMode } from './settings.ts'

export type PerfSrc = 'launcher' | 'ui' | 'host' | 'node'

/** 一条 perf 记录；type 是 span / point / summary / start 之类，其余是各自带的字段 */
export interface PerfRecord {
  v?: number
  src?: string
  run?: string
  ts?: number
  mono?: number
  type?: string
  name?: string
  dur_ms?: number
  [key: string]: unknown
}

/** 单文件封顶 20MB、保留 7 天；超了删整个文件（一天的明细，删掉比写爆磁盘好） */
export const PERF_MAX_BYTES = 20 * 1024 * 1024
export const PERF_KEEP_DAYS = 7

const FILE_RE = /^(launcher|ui|host|node)-\d{8}\.jsonl$/

/** 20261127 这种按天分文件用的日期戳（本机时区） */
export function dayStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** %LOCALAPPDATA%\PackLeader\perf —— 与数据目录无关，装在哪台机器都能找到 */
export function perfDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA ?? (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : join(homedir(), 'AppData', 'Local'))
  return join(base, 'PackLeader', 'perf')
}

/** 一次启动一个 run id：`r-<36 进制时间戳>-<4 位随机>` */
export function newRunId(now: number = Date.now()): string {
  return `r-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 解析一行；坏行（半截、被截断、手改坏）返回 null —— 分析时跳过即可，不能因此整份报表读不出来 */
export function parsePerfLine(line: string): PerfRecord | null {
  // 开头的 BOM 得剥：别的工具写出来的一行若带 BOM，首字符就不是 '{' 了
  const s = line.trim().replace(/^\uFEFF/, '')
  if (!s || s.charCodeAt(0) !== 0x7b /* { */) return null
  try {
    const o = JSON.parse(s) as unknown
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as PerfRecord) : null
  } catch {
    return null
  }
}

/** 清理过期/超大的 perf 文件，返回删掉的文件名（给测试和 `pl perf` 用） */
export async function prunePerfDir(dir: string, now: number = Date.now()): Promise<string[]> {
  const removed: string[] = []
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return removed
  }
  for (const n of names) {
    if (!FILE_RE.test(n)) continue
    const full = join(dir, n)
    let old = false
    let big = false
    try {
      const st = await stat(full)
      old = now - st.mtimeMs > PERF_KEEP_DAYS * 86_400_000
      big = st.size > PERF_MAX_BYTES
    } catch {
      continue
    }
    if (!old && !big) continue
    try {
      await unlink(full)
      removed.push(n)
    } catch {
      /* 别的进程正占着，下次启动再删 */
    }
  }
  return removed
}

export interface PerfLogOptions {
  /** off 时一条不写；缺省按 basic（也认环境变量 PL_PERF） */
  mode?: PerfMode | string
  /** 改写到别的目录（测试用） */
  dir?: string
  /** 批量落盘间隔，缺省 500ms */
  flushMs?: number
  /** 时钟注入（测试用） */
  now?: () => number
}

/**
 * 进程内的 perf 记录器。用法：
 *   const perf = new PerfLog('host', { mode })
 *   perf.span('llm-first-byte', 1234, { model: 'deepseek-flash' })
 *   perf.point('stall', { gap_ms: 820, phase: 'render' })
 *   await perf.close()
 */
export class PerfLog {
  readonly enabled: boolean
  readonly run: string
  readonly t0: number
  readonly file: string
  private readonly dir: string
  private readonly src: PerfSrc
  private readonly now: () => number
  private buf: string[] = []
  private timer: NodeJS.Timeout | null = null
  private closed = false

  constructor(src: PerfSrc, opts: PerfLogOptions = {}) {
    this.src = src
    this.now = opts.now ?? Date.now
    const mode = String(opts.mode ?? process.env.PL_PERF ?? 'basic')
    this.enabled = mode !== 'off'
    this.run = process.env.PL_PERF_RUN ?? ''
    const t0 = Number(process.env.PL_PERF_T0 ?? 0)
    this.t0 = Number.isFinite(t0) && t0 > 0 ? t0 : this.now()
    this.dir = opts.dir ?? perfDir()
    this.file = join(this.dir, `${src}-${dayStamp()}.jsonl`)
    if (!this.enabled) return
    void this.warm()
    this.timer = setInterval(() => void this.flush(), opts.flushMs ?? 500)
    this.timer.unref?.()
  }

  /** 有区间的一次动作（工具、渲染、请求……） */
  span(name: string, durMs: number, meta: Record<string, unknown> = {}): void {
    this.record('span', name, { dur_ms: Math.round(durMs), ...meta })
  }

  /** 瞬时事件（卡顿、交互动作、状态变化） */
  point(name: string, meta: Record<string, unknown> = {}): void {
    this.record('point', name, meta)
  }

  /** 退出前的汇总：一辈子一条，报表直接读它最省事 */
  summary(data: Record<string, unknown>): void {
    this.record('summary', 'exit', data)
  }

  /** 立刻把缓冲写下去（关窗前、进程要退时调） */
  async flush(): Promise<void> {
    if (!this.buf.length) return
    const batch = this.buf
    this.buf = []
    try {
      await appendFile(this.file, `${batch.join('\n')}\n`, 'utf8')
    } catch {
      /* 磁盘满 / 没权限：宁可丢日志也不能影响程序本身 */
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.flush()
  }

  private record(type: string, name: string, extra: Record<string, unknown>): void {
    if (!this.enabled || this.closed) return
    const now = this.now()
    this.buf.push(JSON.stringify({ v: 1, src: this.src, run: this.run, ts: now, mono: now - this.t0, type, name, ...extra }))
    if (this.buf.length >= 2000) void this.flush()
  }

  private async warm(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      await prunePerfDir(this.dir, this.now())
    } catch {
      /* 建不了目录就一路静默降级，不影响界面 */
    }
  }
}
