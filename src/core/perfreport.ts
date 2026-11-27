/**
 * 把 perf 日志读成一份能看的报告：启动慢在哪、用着卡在哪、一轮慢在哪。
 *
 * 三层进程各写各的文件（launcher / ui / host，加上 cli 的 node 一份），
 * 都带同一个 run 与同一条 t0，所以按 run 归组就能把「双击 → 窗口 → 一轮回答」
 * 拼成一条时间轴，mono 直接就是「距离双击多少毫秒」。
 *
 * 这里只做纯计算（records 进、结构出），读盘在 loadPerfRecords，排版在
 * renderPerfReport —— 这样分析规则能单测，不用真去跑界面。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePerfLine, type PerfRecord } from './perf.ts'

const FILE_RE = /^(launcher|ui|host|node)-\d{8}\.jsonl$/

export interface PerfRes {
  cpu: number
  rss_mb: number
  heap_mb: number
}

export interface PerfRunView {
  /** 这一次启动的 run id（老数据可能为空） */
  run: string
  /** 最早一条记录的时刻，用来排序/显示 */
  at: number
  startup: {
    /** ui 的 first-frame 记录里的 mono：双击 → 窗口出现 */
    toWindow: number | null
    firstFrame: number | null
    launcherTotal: number | null
    splash: number | null
    findNode: number | null
    nodeVersion: number | null
    nodeLaunch: number | null
    scriptCopy: number | null
    psSpawn: number | null
    /** UI 第一条记录里带的 ps_ms：PowerShell 进程创建 → 脚本首行（这段以前没有任何埋点） */
    psToScript: number | null
    wpf: number | null
    xaml: number | null
    hostSpawn: number | null
    uiLifetime: number | null
  }
  /** 主线程断档次数与最长一次 */
  stalls: number
  stallMaxMs: number
  /** 断档发生时正在跑一轮的次数（跑着的时候卡，才最影响体感） */
  stallWhileBusy: number
  fpsMin: number | null
  fpsSamples: number
  queueMax: number
  eventCount: number
  /** 最慢的几条事件（同一类型只留最慢的一条） */
  slowEvents: Array<{ name: string; ms: number }>
  turns: Array<{ firstMs: number; totalMs: number; reason: string }>
  slowTools: Array<{ tool: string; ms: number; ok: boolean }>
  loopLagMax: number
  loopLagCount: number
  resFirst: PerfRes | null
  resLast: PerfRes | null
}

export interface Advice {
  level: 'warn' | 'info'
  text: string
}

/** 读目录里最近几天的 perf 文件（默认 7 天，和保留期一致） */
export async function loadPerfRecords(
  dir: string,
  opts: { days?: number; now?: number } = {},
): Promise<PerfRecord[]> {
  const days = opts.days ?? 7
  const now = opts.now ?? Date.now()
  // 多放宽一天：跨零点时「今天」那份的日期戳会比 now 小一天
  const cutoff = now - (days + 1) * 86_400_000
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: PerfRecord[] = []
  for (const n of names) {
    if (!FILE_RE.test(n)) continue
    const m = /-(\d{8})\.jsonl$/.exec(n)
    if (m) {
      const y = Number(m[1]!.slice(0, 4))
      const mo = Number(m[1]!.slice(4, 6)) - 1
      const d = Number(m[1]!.slice(6, 8))
      if (new Date(y, mo, d).getTime() < cutoff) continue
    }
    try {
      const text = await readFile(join(dir, n), 'utf8')
      for (const line of text.split('\n')) {
        const r = parsePerfLine(line)
        if (r) out.push(r)
      }
    } catch {
      /* 读不到（被杀毒锁着之类）就跳过，不让一份坏文件毁掉整份报告 */
    }
  }
  return out
}

/** 按 run 归组，每组算一份 PerfRunView，按时间从早到晚 */
export function analyze(records: PerfRecord[]): PerfRunView[] {
  const groups = new Map<string, PerfRecord[]>()
  for (const r of records) {
    const key = String(r.run ?? '') || 'unknown'
    const arr = groups.get(key)
    if (arr) arr.push(r)
    else groups.set(key, [r])
  }
  const views = [...groups.entries()].map(([run, recs]) => viewOf(run, recs))
  views.sort((a, b) => a.at - b.at)
  return views
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function resOf(r: PerfRecord): PerfRes {
  return { cpu: num(r.cpu), rss_mb: num(r.rss_mb), heap_mb: num(r.heap_mb) }
}

function viewOf(run: string, recs: PerfRecord[]): PerfRunView {
  const v: PerfRunView = {
    run,
    at: Number.MAX_SAFE_INTEGER,
    startup: {
      toWindow: null,
      firstFrame: null,
      launcherTotal: null,
      splash: null,
      findNode: null,
      nodeVersion: null,
      nodeLaunch: null,
      scriptCopy: null,
      psSpawn: null,
      psToScript: null,
      wpf: null,
      xaml: null,
      hostSpawn: null,
      uiLifetime: null,
    },
    stalls: 0,
    stallMaxMs: 0,
    stallWhileBusy: 0,
    fpsMin: null,
    fpsSamples: 0,
    queueMax: 0,
    eventCount: 0,
    slowEvents: [],
    turns: [],
    slowTools: [],
    loopLagMax: 0,
    loopLagCount: 0,
    resFirst: null,
    resLast: null,
  }
  const s = v.startup
  const slowEvt = new Map<string, number>()
  for (const r of recs) {
    const ts = num(r.ts)
    if (ts > 0 && ts < v.at) v.at = ts
    const type = String(r.type ?? '')
    const name = String(r.name ?? '')
    const dur = num(r.dur_ms)
    if (type === 'span' || type === 'start' || type === 'point') {
      if (name === 'ui' && num(r.ps_ms) > 0) {
        // ps_ms 是 UI 脚本首行时 PowerShell 进程已经跑了多久：进程创建 → 第一条脚本
        s.psToScript = num(r.ps_ms)
      } else if (name === 'first-frame') {
        s.firstFrame = dur
        s.toWindow = num(r.mono)
      } else if (name === 'launcher-total') s.launcherTotal = dur
      else if (name === 'splash') s.splash = dur
      else if (name === 'find-node') s.findNode = dur
      else if (name === 'node-version') s.nodeVersion = dur
      else if (name === 'node-launch') s.nodeLaunch = dur
      else if (name === 'script-copy') s.scriptCopy = dur
      else if (name === 'ps-spawn') s.psSpawn = dur
      else if (name === 'wpf-assemblies') s.wpf = dur
      else if (name === 'xaml-parse') s.xaml = dur
      else if (name === 'host-spawn') s.hostSpawn = dur
      else if (name === 'ui-lifetime') s.uiLifetime = dur
      else if (name === 'turn') {
        v.turns.push({ firstMs: num(r.first_ms), totalMs: dur, reason: String(r.reason ?? '') })
      } else if (name === 'slow-tool') {
        v.slowTools.push({ tool: String(r.tool ?? ''), ms: dur, ok: r.ok !== false })
      }
    }
    if (type === 'stall') {
      v.stalls++
      if (dur > v.stallMaxMs) v.stallMaxMs = dur
      if (r.busy === true) v.stallWhileBusy++
    } else if (type === 'fps') {
      const fps = num(r.fps)
      if (fps > 0) {
        v.fpsSamples += num(r.n) || 1
        if (v.fpsMin === null || fps < v.fpsMin) v.fpsMin = fps
      }
    } else if (type === 'queue') {
      if (dur > v.queueMax) v.queueMax = dur
    } else if (type === 'event') {
      v.eventCount++
      const prev = slowEvt.get(name)
      if (prev === undefined || dur > prev) slowEvt.set(name, dur)
    } else if (type === 'loop-lag') {
      v.loopLagCount++
      if (dur > v.loopLagMax) v.loopLagMax = dur
    } else if (type === 'res') {
      const res = resOf(r)
      if (!v.resFirst) v.resFirst = res
      v.resLast = res
    }
  }
  v.slowEvents = [...slowEvt.entries()]
    .map(([name, ms]) => ({ name, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3)
  return v
}

/** 千分位毫秒 / 秒：报表里看着不累 */
export function ms(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—'
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}s`
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`
  return `${Math.round(v)}ms`
}

/**
 * 规则化的建议：只报「量确实超了」的，并且把「哪个数字、超了多少」写清楚，
 * 不写「建议优化性能」这种没法定向的空话。
 */
export function adviceOf(views: PerfRunView[]): Advice[] {
  const out: Advice[] = []
  if (!views.length) return out
  const last = views[views.length - 1]!
  const s = last.startup

  if (s.toWindow !== null && s.toWindow >= 900) {
    const where: string[] = []
    if (s.psSpawn !== null) where.push(`PS 进程起来 ${ms(s.psSpawn)}`)
    if (s.wpf !== null) where.push(`载 WPF 程序集 ${ms(s.wpf)}`)
    if (s.xaml !== null) where.push(`XAML 解析 ${ms(s.xaml)}`)
    out.push({
      level: s.toWindow >= 1500 ? 'warn' : 'info',
      text: `启动到窗口 ${ms(s.toWindow)}${where.length ? `（${where.join(' · ')}）` : ''}：先看这几段里最长的那一项，>500ms 的那段才有优化余地。`,
    })
  }
  if (s.psToScript !== null && s.psToScript >= 400) {
    out.push({
      level: 'warn',
      text: `PowerShell 进程创建 → 脚本首行 ${ms(s.psToScript)}：这一段在脚本能打点之前，慢通常是进程冷启动或当时机器忙（杀软扫描、并发构建），不是界面代码的问题。`,
    })
  }
  if (s.launcherTotal !== null && s.launcherTotal >= 400) {
    out.push({ level: 'info', text: `启动器合计 ${ms(s.launcherTotal)}：node 版本检查有缓存（%LOCALAPPDATA%\\PackLeader\\node-version.txt），删掉会重测一次。` })
  }
  if (last.stalls > 0) {
    out.push({
      level: last.stallWhileBusy > 0 || last.stallMaxMs >= 500 ? 'warn' : 'info',
      text:
        `界面主线程断档 ${last.stalls} 次，最长 ${ms(last.stallMaxMs)}` +
        (last.stallWhileBusy ? `，其中 ${last.stallWhileBusy} 次发生在跑一轮期间` : '') +
        '：断档 = 一次画事件或脚本占住了 UI 线程，看同一时刻前后最慢的 event。',
    })
  }
  if (last.fpsMin !== null && last.fpsMin < 30) {
    out.push({ level: 'info', text: `帧率最低 ${last.fpsMin}fps（${last.fpsSamples} 秒采样）：连续掉帧说明一次渲染的量太大，看 event 里耗时最长的那几类。` })
  }
  const slowEvt = last.slowEvents[0]
  if (slowEvt && slowEvt.ms >= 50) {
    out.push({ level: 'info', text: `单条事件最慢是 ${slowEvt.name} ${ms(slowEvt.ms)}：这一条画得太重（大量控件一次性增删），把它拆成小批。` })
  }
  if (last.queueMax >= 50) {
    out.push({ level: 'info', text: `输出队列最长积压 ${last.queueMax} 行：host 吐得快、界面消化不掉，多半和上面的断档/慢事件是同一件事。` })
  }
  const slowTurn = last.turns.reduce<PerfRunView['turns'][number] | null>((a, b) => (!a || b.firstMs > a.firstMs ? b : a), null)
  if (slowTurn && slowTurn.firstMs >= 5000) {
    out.push({ level: 'warn', text: `首字延迟最长 ${ms(slowTurn.firstMs)}：这是模型/代理那一侧的时间，不是界面卡；先看端点延迟，再考虑换模型或减少上下文。` })
  }
  if (last.slowTools.length) {
    const t = last.slowTools.slice().sort((a, b) => b.ms - a.ms)[0]!
    out.push({ level: 'info', text: `慢工具 ${last.slowTools.length} 次，最慢 ${t.tool} ${ms(t.ms)}：卡在工具里的时候界面是能动的，别把它当成界面卡顿。` })
  }
  if (last.loopLagCount > 0) {
    out.push({ level: 'info', text: `host 主线程迟到 ${last.loopLagCount} 次（最长 ${ms(last.loopLagMax)}）：host 里有同步的重活，会让事件晚到，表现为「点了没反应」。` })
  }
  if (last.resFirst && last.resLast && last.resLast.rss_mb - last.resFirst.rss_mb >= 200) {
    out.push({
      level: 'warn',
      text: `内存 RSS 从 ${last.resFirst.rss_mb}MB 涨到 ${last.resLast.rss_mb}MB：长会话容易这样，先看是不是历史全量拼接进请求。`,
    })
  }
  if (!out.length) out.push({ level: 'info', text: '这一次没有超过任何阈值的项：启动、断档、帧率、首字、工具都在正常范围里。' })
  return out
}

/** 一次启动打印一段，最后给汇总建议 */
export function renderPerfReport(
  views: PerfRunView[],
  opts: { runs?: number; dir?: string } = {},
): string[] {
  const lines: string[] = []
  const want = Math.max(1, opts.runs ?? 3)
  const latest = views.slice(-want)
  lines.push(`性能日志${opts.dir ? `（${opts.dir}）` : ''}：共 ${views.length} 次启动，下面是最近 ${latest.length} 次`)
  lines.push('')
  for (const v of latest) {
    const s = v.startup
    lines.push(`■ ${v.run || '未命名'}  ${v.at === Number.MAX_SAFE_INTEGER ? '' : new Date(v.at).toLocaleString()}`)
    if (s.toWindow !== null) {
      lines.push(`  启动   双击 → 窗口 ${ms(s.toWindow)}`)
      const parts: string[] = []
      if (s.launcherTotal !== null) parts.push(`启动器 ${ms(s.launcherTotal)}`)
      if (s.psToScript !== null) parts.push(`PS 启动 ${ms(s.psToScript)}`)
      if (s.psSpawn !== null) parts.push(`PS 进程 ${ms(s.psSpawn)}`)
      if (s.wpf !== null) parts.push(`WPF 载入 ${ms(s.wpf)}`)
      if (s.xaml !== null) parts.push(`XAML ${ms(s.xaml)}`)
      if (s.firstFrame !== null) parts.push(`首帧 ${ms(s.firstFrame)}`)
      if (s.hostSpawn !== null) parts.push(`host 就绪 ${ms(s.hostSpawn)}`)
      if (parts.length) lines.push(`         ${parts.join(' · ')}`)
    }
    if (s.uiLifetime !== null) lines.push(`  使用   窗口存活 ${ms(s.uiLifetime)}`)
    if (v.stalls || v.fpsMin !== null) {
      lines.push(
        `        卡顿 ${v.stalls} 次（最长 ${ms(v.stallMaxMs)}，跑着一轮时 ${v.stallWhileBusy} 次）` +
          (v.fpsMin !== null ? ` · 帧率最低 ${v.fpsMin}fps` : '') +
          (v.queueMax ? ` · 队列最长 ${v.queueMax} 行` : ''),
      )
    }
    if (v.eventCount) {
      const top = v.slowEvents[0]
      lines.push(`        事件 ${v.eventCount} 条${top ? `，最慢 ${top.name} ${ms(top.ms)}` : ''}`)
    }
    if (v.turns.length) {
      const firsts = v.turns.map((t) => ms(t.firstMs)).join(' / ')
      lines.push(`        一轮 ${v.turns.length} 次，首字 ${firsts}`)
    }
    if (v.slowTools.length) {
      const t = v.slowTools.slice().sort((a, b) => b.ms - a.ms)[0]!
      lines.push(`        慢工具 ${v.slowTools.length} 次（最慢 ${t.tool} ${ms(t.ms)}）`)
    }
    if (v.loopLagCount) lines.push(`        host 主线程迟到 ${v.loopLagCount} 次（最长 ${ms(v.loopLagMax)}）`)
    if (v.resLast) {
      lines.push(
        `        内存 ${v.resFirst ? `${v.resFirst.rss_mb}MB → ` : ''}${v.resLast.rss_mb}MB · CPU ${v.resLast.cpu}%`,
      )
    }
    lines.push('')
  }
  const adv = adviceOf(views)
  lines.push('建议')
  for (const a of adv) lines.push(`  ${a.level === 'warn' ? '！' : '·'} ${a.text}`)
  return lines
}
