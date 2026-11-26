/**
 * 一轮的 Agent 时间线：思考 → 工具调用 → 阶段性正文 → 待办 → 底部实时状态。
 *
 * 界面（ui/PackLeader.ps1）画的那条卡片，字段就照这里来：
 *   顶部状态行    → phase + latestAction + elapsed（「● 执行 shell  27:38」）
 *   思考摘要条    → thoughts（「思考了片刻」+ 最新一段，点开看全文）
 *   工具聚合条    → tools + stats()（「61 次工具调用 · 共 9.5s」/「运行中... · grep ×8 · shell ×27」）
 *   阶段性正文    → turnMessages（每条带 model 标识，按时间顺序往下追加）
 *   执行方案卡    → todoPlan（「执行方案  3/4」，完成的置灰、未完成的正常）
 *   底部状态胶囊  → activeBottomStatus（「执行 shell · 用时 27分37秒…」）
 *
 * 多轮就是多条这样的时间线往下排。统计只在这里算一处：界面自己实时算的是
 * 同一套口径，host 在 turn-end 里报一份 stats，审计和 CLI 用的数字才对得上。
 * 会话事件也能直接折出来（foldEvents，历史回放与离线分析用）。
 */

import type { SessionEvent } from './events.ts'
import type { ToolCall } from './types.ts'

export type ToolState = 'running' | 'done' | 'failed'
export type TurnPhase = 'thinking' | 'tools' | 'answering' | 'done'

export interface ToolItem {
  id: string
  /** 工具名，等宽显示（read / grep / shell…） */
  name: string
  /** 一句话目标：路径 / 搜索词 / 命令行开头 */
  summary: string
  args?: Record<string, unknown>
  state: ToolState
  ms: number
  /** 结果开头一段：展开这一行看到的就是它 */
  preview: string
  error?: string
  /** 这几次调用各自开始 / 结束的时刻（底部胶囊算「这个任务跑了多久」） */
  startedAt: number
  endedAt: number
}

export interface ThoughtBlock {
  text: string
  /** 这一段思考花的时间（毫秒）；正在想的时候是 0 */
  ms: number
}

/** 阶段性正文：每一步想完/做完给用户看的那一段，按时间顺序累计 */
export interface TurnMessage {
  /** 第几步出的（从 1 起） */
  step: number
  /** 谁写的，界面左上角那行小字 */
  model: string
  text: string
  at: number
}

export interface TodoItem {
  text: string
  done: boolean
}

export interface TodoPlan {
  items: TodoItem[]
  done: number
  total: number
}

/** 底部那颗胶囊：现在在跑的是哪件事、从什么时候开始 */
export interface ActiveBottomStatus {
  label: string
  since: number
  running: boolean
}

export interface TurnStats {
  tools: number
  failed: number
  /** 还挂着的（界面右侧「运行中...」） */
  running: number
  steps: number
  /** 工具耗时合计（毫秒） */
  ms: number
  /** 按调用次数从多到少；同数按名字 */
  byName: Array<{ name: string; count: number }>
}

/** 给界面 / CLI 的一整份快照：界面其实自己按事件实时画，这份用于审计与测试 */
export interface TimelineSnapshot {
  phase: TurnPhase
  latestAction: string
  elapsedMs: number
  thinking: { text: string; ms: number; done: boolean }
  toolSummary: TurnStats
  turnMessages: TurnMessage[]
  todoPlan: TodoPlan | null
  activeBottomStatus: ActiveBottomStatus | null
}

/** 结果预览截多长：够看出改了什么/查到了什么，又不至于把界面撑爆 */
export const PREVIEW_CHARS = 2000

/** 毫秒 → 「1:30」（状态行那颗计时器用，超过一小时是「1:02:03」） */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** 工具耗时合计：不足 1 秒报毫秒，一分钟内报一位小数秒（和界面组头的「共 8.4s」一致） */
export function formatToolSecs(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return formatClock(ms)
}

/** 底部胶囊的中文时长：「27分37秒」（和界面的 Format-Elapsed 同一写法） */
export function formatElapsedCn(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return `${m}分${String(rest).padStart(2, '0')}秒`
  const h = Math.floor(m / 60)
  return `${h}小时${String(m % 60).padStart(2, '0')}分`
}

export class TurnTimeline {
  phase: TurnPhase = 'thinking'
  thoughts: ThoughtBlock[] = []
  tools: ToolItem[] = []
  messages: TurnMessage[] = []
  todos: TodoItem[] | null = null
  steps = 1
  readonly startedAt: number
  endedAt = 0
  /** 谁在写（界面上每段正文左上角那行小字） */
  model: string

  private open: ThoughtBlock | null = null
  private byId = new Map<string, ToolItem>()
  private counts = new Map<string, number>()

  constructor(at: number = Date.now(), model = '') {
    this.startedAt = at
    this.model = model
  }

  /** 思考流式增量：接着当前这一段往下写；没有段落就开一段 */
  reason(text: string): ThoughtBlock {
    if (!this.open) {
      this.open = { text: '', ms: 0 }
      this.thoughts.push(this.open)
    }
    this.open.text += text
    return this.open
  }

  /** 一段思考结束：记下这段花了多久，下一段思考重新开一块 */
  closeThought(ms: number): void {
    if (!this.open) return
    this.open.ms = Math.max(0, Math.round(ms))
    this.open = null
  }

  /** 还在想的时候那一段（界面用它显示「思考中…」的当前文本） */
  get openThought(): ThoughtBlock | null {
    return this.open
  }

  step(n: number): void {
    const v = Number(n) || 0
    if (v > this.steps) this.steps = v
  }

  toolStart(call: Pick<ToolCall, 'id' | 'name' | 'args'>, summary: string, at: number = Date.now()): ToolItem {
    const item: ToolItem = {
      id: String(call.id),
      name: String(call.name),
      summary,
      args: call.args,
      state: 'running',
      ms: 0,
      preview: '',
      startedAt: at,
      endedAt: 0,
    }
    this.tools.push(item)
    this.byId.set(item.id, item)
    this.counts.set(item.name, (this.counts.get(item.name) ?? 0) + 1)
    this.phase = 'tools'
    return item
  }

  toolEnd(
    id: string,
    r: { ok: boolean; ms: number; content?: string; preview?: string; error?: string; at?: number },
  ): ToolItem | null {
    const item = this.byId.get(id)
    if (!item) return null
    item.state = r.ok ? 'done' : 'failed'
    item.ms = Math.max(0, Math.round(r.ms))
    item.endedAt = r.at ?? item.startedAt + item.ms
    item.preview = String(r.preview ?? r.content ?? '').slice(0, PREVIEW_CHARS)
    if (!r.ok) item.error = String(r.error ?? item.preview).slice(0, PREVIEW_CHARS)
    // 状态回退到思考：下一步模型还要接着想（真正的 phase 由 answer/end 改）
    this.phase = 'thinking'
    return item
  }

  /** 一段阶段性正文（每步的结论 / 下一步计划） */
  message(text: string, at: number = Date.now(), model?: string): TurnMessage {
    const m: TurnMessage = { step: this.steps, model: model ?? this.model, text, at }
    this.messages.push(m)
    return m
  }

  /** todo_write 的结构化结果（整份覆盖） */
  setTodos(items: TodoItem[]): TodoPlan {
    this.todos = items.map((i) => ({ text: String(i.text ?? ''), done: i.done === true }))
    return this.todoPlan
  }

  get todoPlan(): TodoPlan {
    const items = this.todos ?? []
    return { items, done: items.filter((i) => i.done).length, total: items.length }
  }

  answer(): void {
    this.phase = 'answering'
  }

  end(at: number = Date.now()): void {
    this.phase = 'done'
    this.endedAt = at
    if (this.open) this.closeThought(this.elapsed)
    // 收尾时还挂着的调用按「被中断」算，不然界面会永远显示运行中
    for (const t of this.tools) {
      if (t.state === 'running') {
        t.state = 'failed'
        t.endedAt = at
        if (!t.error) t.error = '被中断，没有拿到结果'
      }
    }
  }

  /** 从这一轮开始到「现在」（已结束就定格）：状态行那颗计时器读它 */
  get elapsed(): number {
    const end = this.endedAt > 0 ? this.endedAt : Date.now()
    return Math.max(0, end - this.startedAt)
  }

  /** 还在跑的调用（按开始先后） */
  get runningTools(): ToolItem[] {
    return this.tools.filter((t) => t.state === 'running')
  }

  /** 状态行左边那个词：「执行 shell」/「回答中」/「思考中」/「已完成」 */
  get latestAction(): string {
    if (this.phase === 'done') return '已完成'
    const running = this.runningTools
    if (running.length > 0) return `执行 ${running[running.length - 1].name}`
    if (this.phase === 'answering') return '回答中'
    return '思考中'
  }

  /** 底部胶囊：现在跑最久的那个调用 */
  get activeBottomStatus(): ActiveBottomStatus | null {
    const running = this.runningTools
    if (running.length === 0) return null
    let oldest = running[0]
    for (const t of running) if (t.startedAt < oldest.startedAt) oldest = t
    return { label: `执行 ${oldest.name}`, since: oldest.startedAt, running: true }
  }

  stats(at: number = Date.now()): TurnStats {
    let ms = 0
    let failed = 0
    let running = 0
    for (const t of this.tools) {
      // 合计只算已经回来的调用：界面上那串数字不该每 100ms 自己跳。
      // 还在跑的那件由 activeBottomStatus 单独报「用时 27分37秒…」。
      if (t.state === 'running') running++
      else ms += t.ms
      if (t.state === 'failed') failed++
    }
    const byName = [...this.counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    return { tools: this.tools.length, failed, running, steps: this.steps, ms, byName }
  }

  /** 一整份快照：审计、CLI 的 --json、以及「把这条时间线存下来再看」都读它 */
  snapshot(at: number = Date.now()): TimelineSnapshot {
    const cur = this.open
    const last = this.thoughts[this.thoughts.length - 1]
    return {
      phase: this.phase,
      latestAction: this.latestAction,
      elapsedMs: this.elapsed,
      thinking: cur
        ? { text: cur.text, ms: 0, done: false }
        : { text: last?.text ?? '', ms: last?.ms ?? 0, done: true },
      toolSummary: this.stats(at),
      turnMessages: [...this.messages],
      todoPlan: this.todos ? this.todoPlan : null,
      activeBottomStatus: this.activeBottomStatus,
    }
  }
}

/** 「待办 3/4\n[x] a\n[ ] b」→ 清单（tool/result 里只有这段文本，没有结构化字段） */
export function parseTodoContent(content: string): TodoItem[] {
  const items: TodoItem[] = []
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*\[( |x|X)\]\s*(.+)$/)
    if (m) items.push({ text: m[2].trim(), done: m[1].toLowerCase() === 'x' })
  }
  return items
}

/**
 * 从会话事件折出一轮的时间线（历史回放、离线分析）。
 * 一轮的边界由调用方切好（一般是两条 user/message 之间）。
 */
export function foldEvents(events: SessionEvent[]): TurnTimeline {
  const tx = new TurnTimeline(events[0]?.at ?? Date.now())
  let lastAt = tx.startedAt
  for (const e of events) {
    if (typeof e.at === 'number' && e.at > lastAt) lastAt = e.at
    if (e.kind === 'step/start') {
      tx.step(e.step)
    } else if (e.kind === 'assistant/message') {
      if (e.reasoning) {
        tx.reason(e.reasoning)
        tx.closeThought(e.ms)
      }
      if (e.text && e.text.trim()) tx.message(e.text, e.at)
      for (const c of e.toolCalls) {
        tx.toolStart(c, typeof c.args?.path === 'string' ? c.args.path : '', e.at)
      }
    } else if (e.kind === 'tool/result') {
      tx.toolEnd(e.callId, { ok: e.ok, ms: e.ms, content: e.content, at: e.at })
      if (e.name === 'todo_write') {
        const items = parseTodoContent(e.content)
        if (items.length > 0) tx.setTodos(items)
      }
    } else if (e.kind === 'turn/end') {
      lastAt = e.at
    }
  }
  tx.end(lastAt)
  return tx
}

// ---------------------------------------------------------------- 演示数据
// 三轮连续的「排查并发掉帧并修掉」：每轮都会出阶段性正文、跑工具、更新执行方案，
// 最后一轮在收尾时还挂着一个长 shell（底部胶囊那种），把界面的各种状态都过一遍。
// 用 host → 界面那套 turn-event 的字段，界面上能直接回放（scripts/gen-timeline-demo.mjs）。

export type TimelineDemoEvent =
  | { type: 'user'; text: string }
  | { type: 'turn-start' }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool-start'; id: string; name: string; summary: string; args?: Record<string, unknown> }
  | { type: 'tool-end'; id: string; name: string; ok: boolean; ms: number; preview?: string; error?: string; data?: unknown }
  | { type: 'text'; delta: string }
  | { type: 'assistant-end'; text: string }
  | { type: 'turn-end'; reason: 'done' | 'error' | 'cancelled' }

interface DemoCall {
  name: string
  summary: string
  ms: number
  preview: string
  ok?: boolean
  args?: Record<string, unknown>
  data?: unknown
}

const DEMO_TOOL_TEXT: Record<string, string> = {
  read: '(读到了文件内容)',
  grep: 'src/ui/view.ts:41:  scheduleRender()\nsrc/ui/view.ts:88:  flushQueue()\nsrc/ui/view.ts:120:  requestAnimationFrame',
  list: 'src/ui/\n  view.ts  12.4 KB\n  queue.ts  3.1 KB',
  shell: 'added 0 packages, 143 passed (3.2s)',
  edit: '已替换 1 处（view.ts:88）',
  glob: 'src/ui/*.ts (3 files)',
}

/** 三轮演示：返回一串「host 会发给界面」的事件，按顺序喂进去就是那段效果 */
export function mockBugHuntEvents(): TimelineDemoEvent[] {
  const ev: TimelineDemoEvent[] = []
  const calls: Array<{ turn: DemoCall[][]; text: string[]; todo: Array<{ text: string; done: boolean }> | null }> = [
    {
      text: [
        '先摸清渲染链路：`scheduleRender` 在滚动时被反复调用，先确认它有没有做合并。',
        '找到问题了：`flushQueue` 每帧都在跑，但队列没有去重，滚动事件一多就堆积。',
      ],
      todo: [
        { text: '定位掉帧来源（滚动时的渲染队列）', done: true },
        { text: '给 flushQueue 加去重与合并', done: false },
        { text: '补一条回归测试', done: false },
      ],
      turn: [
        [
          { name: 'read', summary: 'src/ui/view.ts', ms: 4, preview: DEMO_TOOL_TEXT.read },
          { name: 'grep', summary: 'scheduleRender', ms: 11, preview: DEMO_TOOL_TEXT.grep },
        ],
        [
          { name: 'list', summary: 'src/ui', ms: 3, preview: DEMO_TOOL_TEXT.list },
          { name: 'read', summary: 'src/ui/queue.ts', ms: 2, preview: DEMO_TOOL_TEXT.read },
        ],
      ],
    },
    {
      text: [
        '动手前先把执行方案更新一下，再去改 `flushQueue`。',
        '改完了，跑一遍测试确认没有把别的用例带崩。',
      ],
      todo: [
        { text: '定位掉帧来源（滚动时的渲染队列）', done: true },
        { text: '给 flushQueue 加去重与合并', done: true },
        { text: '补一条回归测试', done: true },
      ],
      turn: [
        [
          { name: 'edit', summary: 'src/ui/view.ts:88', ms: 6, preview: DEMO_TOOL_TEXT.edit, args: { path: 'src/ui/view.ts', line: 88 } },
          { name: 'shell', summary: 'npm test', ms: 3240, preview: DEMO_TOOL_TEXT.shell },
        ],
      ],
    },
    {
      text: ['顺手把剩下的边界情况收掉：队列为空时少一次 `requestAnimationFrame`。'],
      todo: [
        { text: '定位掉帧来源（滚动时的渲染队列）', done: true },
        { text: '给 flushQueue 加去重与合并', done: true },
        { text: '补一条回归测试', done: true },
        { text: '清理空队列的多余调度', done: true },
      ],
      turn: [
        [
          { name: 'glob', summary: 'src/ui/*.ts', ms: 5, preview: DEMO_TOOL_TEXT.glob },
          { name: 'edit', summary: 'src/ui/queue.ts:12', ms: 4, preview: DEMO_TOOL_TEXT.edit },
          { name: 'shell', summary: 'npm test', ms: 9800, preview: DEMO_TOOL_TEXT.shell, ok: false, error: '1 个用例失败：queue.test.ts › 空队列时不调度' },
        ],
      ],
    },
  ]

  let n = 0
  calls.forEach((turn, ti) => {
    ev.push({ type: 'turn-start' })
    ev.push({ type: 'reasoning', delta: `第 ${ti + 1} 轮：先把范围收窄到 ${ti === 0 ? '渲染队列' : ti === 1 ? '改动的调用点' : '边界情况'}，再决定下一步。` })
    if (turn.todo) {
      // 第一轮 0/3 起步，第二轮推到 3/3，最后一轮 3/4（末一步没做完，卡片上还留一条高亮的）
      const doneCount = ti === 0 ? 0 : ti === 1 ? 3 : 3
      const items = turn.todo.map((t, i) => ({ text: t.text, done: i < doneCount }))
      ev.push({ type: 'tool-start', id: `t${ti}-todo`, name: 'todo_write', summary: '维护执行方案', args: { items } })
      ev.push({
        type: 'tool-end',
        id: `t${ti}-todo`,
        name: 'todo_write',
        ok: true,
        ms: 1,
        preview: `待办 ${items.filter((i) => i.done).length}/${items.length}`,
        data: { items },
      })
    }
    turn.turn.forEach((group) => {
      group.forEach((c) => {
        const id = `t${ti}-c${n++}`
        ev.push({ type: 'tool-start', id, name: c.name, summary: c.summary, args: c.args })
        ev.push({
          type: 'tool-end',
          id,
          name: c.name,
          ok: c.ok !== false,
          ms: c.ms,
          preview: c.preview,
          error: c.ok === false ? c.error : undefined,
        })
      })
    })
    turn.text.forEach((t) => {
      ev.push({ type: 'text', delta: t })
      ev.push({ type: 'assistant-end', text: t })
    })
    ev.push({ type: 'turn-end', reason: 'done' })
  })
  return ev
}

/** 把演示事件折成三条时间线（测试和离线看效果都用它） */
export function mockBugHuntTimelines(at: number = Date.now()): TurnTimeline[] {
  const out: TurnTimeline[] = []
  let tx: TurnTimeline | null = null
  let clock = at
  let step = 0
  for (const e of mockBugHuntEvents()) {
    if (e.type === 'turn-start') {
      tx = new TurnTimeline(clock, 'deepseek-flash')
      step = 0
      out.push(tx)
      continue
    }
    if (!tx) continue
    if (e.type === 'reasoning') {
      tx.reason(e.delta)
      tx.closeThought(1200)
      clock += 1200
    } else if (e.type === 'tool-start') {
      step++
      tx.step(step)
      tx.toolStart({ id: e.id, name: e.name, args: e.args }, e.summary, clock)
    } else if (e.type === 'tool-end') {
      clock += Math.max(1, e.ms)
      tx.toolEnd(e.id, { ok: e.ok, ms: e.ms, preview: e.preview, error: e.error, at: clock })
      if (e.name === 'todo_write') {
        const d = e.data as { items?: TodoItem[] } | undefined
        if (d?.items) tx.setTodos(d.items)
      }
    } else if (e.type === 'assistant-end') {
      tx.message(e.text, clock)
      clock += 800
    } else if (e.type === 'turn-end') {
      tx.end(clock)
      clock += 500
    }
  }
  return out
}
