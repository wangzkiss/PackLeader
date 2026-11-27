import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { dayStamp, newRunId, parsePerfLine, PerfLog, perfDir, prunePerfDir } from '../src/core/perf.ts'
import { adviceOf, analyze, renderPerfReport } from '../src/core/perfreport.ts'
import { loadSettings, saveSettings } from '../src/core/settings.ts'

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'pl-perf-'))

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

test('perf: 一行一条 JSONL，span / point / summary 都能原样读回来', async () => {
  const dir = await tmp()
  const log = new PerfLog('host', { dir, mode: 'basic', flushMs: 10_000 })
  log.span('llm-first-byte', 1234.4, { model: 'm' })
  log.point('stall', { gap_ms: 820, phase: 'render' })
  log.summary({ frames: 42 })
  await log.close()

  const lines = (await readFile(log.file, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 3, '三条记录应该是三行')
  const recs = lines.map(parsePerfLine)
  assert.deepEqual(
    recs.map((r) => r?.type),
    ['span', 'point', 'summary'],
  )
  assert.equal(recs[0]?.dur_ms, 1234, '耗时四舍五入到毫秒')
  assert.equal(recs[0]?.model, 'm')
  assert.equal(recs[1]?.gap_ms, 820)
  assert.equal(recs[2]?.frames, 42)
  assert.equal(recs[0]?.src, 'host')
  assert.equal(typeof recs[0]?.mono, 'number', '每条都该带相对启动的 mono')
})

test('perf: off 档一条都不写（连文件都不建）', async () => {
  const dir = await tmp()
  const log = new PerfLog('ui', { dir, mode: 'off' })
  log.span('x', 5)
  log.point('y')
  await log.close()
  assert.equal(log.enabled, false)
  assert.equal(await exists(log.file), false)
})

test('perf: 坏行单独跳过，不影响整份文件的其他行', () => {
  assert.equal(parsePerfLine(''), null)
  assert.equal(parsePerfLine('   '), null)
  assert.equal(parsePerfLine('{"v":1,"type":"span"'), null, '半截 JSON')
  assert.equal(parsePerfLine('[1,2,3]'), null, '数组不是一条记录')
  assert.equal(parsePerfLine('null'), null)
  // 别的工具写出来的行可能带 BOM，剥掉照样认
  assert.equal(parsePerfLine('\uFEFF{"v":1,"type":"span","name":"a"}')?.name, 'a')
})

test('perf: run / t0 从环境变量继承（同一个 run 才能把三层拼成一条时间轴）', () => {
  const oldRun = process.env.PL_PERF_RUN
  const oldT0 = process.env.PL_PERF_T0
  process.env.PL_PERF_RUN = 'r-abc-1234'
  process.env.PL_PERF_T0 = '1700000000000'
  try {
    const log = new PerfLog('node', { mode: 'off' })
    assert.equal(log.run, 'r-abc-1234')
    assert.equal(log.t0, 1_700_000_000_000)
  } finally {
    if (oldRun === undefined) delete process.env.PL_PERF_RUN
    else process.env.PL_PERF_RUN = oldRun
    if (oldT0 === undefined) delete process.env.PL_PERF_T0
    else process.env.PL_PERF_T0 = oldT0
  }
})

test('perf: prunePerfDir 删过旧文件，保留今天的和不相干的文件', async () => {
  const dir = await tmp()
  const old = join(dir, 'ui-20200101.jsonl')
  const fresh = join(dir, `host-${dayStamp()}.jsonl`)
  const other = join(dir, 'notes.txt')
  await writeFile(old, '{}\n')
  await writeFile(fresh, '{}\n')
  await writeFile(other, 'x')
  await utimes(old, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))

  const removed = await prunePerfDir(dir, Date.now())
  assert.deepEqual(removed, ['ui-20200101.jsonl'])
  assert.equal(await exists(fresh), true, '当天的不能删')
  assert.equal(await exists(other), true, '不是 perf 文件的不碰')
})

test('perf: 目录默认落在 <LOCALAPPDATA>\\PackLeader\\perf', () => {
  assert.equal(perfDir({ LOCALAPPDATA: 'C:\\L' } as NodeJS.ProcessEnv), join('C:\\L', 'PackLeader', 'perf'))
})

test('perf: run id 与日期戳的形状', () => {
  assert.match(newRunId(1_700_000_000_000), /^r-[0-9a-z]+-[0-9a-z]{4}$/)
  assert.equal(dayStamp(new Date(2026, 0, 5)), '20260105')
})

test('settings: perf 三档往返，手改坏了当没写（缺省仍是 basic）', async () => {
  const dir = await tmp()
  await saveSettings(dir, { perf: 'full' })
  assert.equal((await loadSettings(dir)).perf, 'full')

  await saveSettings(dir, { perf: 'off' })
  assert.equal((await loadSettings(dir)).perf, 'off')

  const path = join(dir, 'config.json')
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  raw.perf = 'loud'
  await writeFile(path, JSON.stringify(raw))
  assert.equal((await loadSettings(dir)).perf, undefined, '非法值应当被丢掉')
})

test('perfreport: 同一个 run 的三层记录聚成一条时间轴', () => {
  const recs = [
    { v: 1, src: 'launcher', run: 'r-a', ts: 1000, mono: 0, type: 'start', name: 'exe' },
    { v: 1, src: 'launcher', run: 'r-a', ts: 1010, mono: 10, type: 'span', name: 'launcher-total', dur_ms: 120 },
    { v: 1, src: 'node', run: 'r-a', ts: 1020, mono: 20, type: 'span', name: 'ps-spawn', dur_ms: 165 },
    { v: 1, src: 'ui', run: 'r-a', ts: 1200, mono: 900, type: 'span', name: 'first-frame', dur_ms: 170 },
    { v: 1, src: 'ui', run: 'r-a', ts: 1210, mono: 910, type: 'span', name: 'host-spawn', dur_ms: 310 },
    { v: 1, src: 'ui', run: 'r-a', ts: 1300, mono: 1000, type: 'stall', name: 'ui', dur_ms: 820, busy: true },
    { v: 1, src: 'ui', run: 'r-a', ts: 1310, mono: 1010, type: 'fps', name: 'ui', fps: 22, n: 10 },
    { v: 1, src: 'ui', run: 'r-a', ts: 1320, mono: 1020, type: 'queue', name: 'out', dur_ms: 64 },
    { v: 1, src: 'ui', run: 'r-a', ts: 1330, mono: 1030, type: 'event', name: 'tool-end', dur_ms: 85 },
    { v: 1, src: 'host', run: 'r-a', ts: 1400, mono: 1100, type: 'span', name: 'turn', dur_ms: 4000, first_ms: 6200, reason: 'done' },
    { v: 1, src: 'host', run: 'r-a', ts: 1410, mono: 1110, type: 'span', name: 'slow-tool', dur_ms: 7800, tool: 'shell' },
    { v: 1, src: 'host', run: 'r-a', ts: 1420, mono: 1120, type: 'loop-lag', name: 'host', dur_ms: 180 },
    { v: 1, src: 'host', run: 'r-a', ts: 1430, mono: 1130, type: 'res', cpu: 12.5, rss_mb: 300, heap_mb: 40 },
  ]
  const views = analyze(recs)
  assert.equal(views.length, 1)
  const v = views[0]!
  assert.equal(v.run, 'r-a')
  assert.equal(v.at, 1000)
  assert.equal(v.startup.toWindow, 900, 'toWindow 用的是 first-frame 的 mono')
  assert.equal(v.startup.launcherTotal, 120)
  assert.equal(v.startup.psSpawn, 165)
  assert.equal(v.startup.hostSpawn, 310)
  assert.equal(v.stalls, 1)
  assert.equal(v.stallWhileBusy, 1)
  assert.equal(v.stallMaxMs, 820)
  assert.equal(v.fpsMin, 22)
  assert.equal(v.fpsSamples, 10)
  assert.equal(v.queueMax, 64)
  assert.equal(v.eventCount, 1)
  assert.equal(v.turns[0]?.firstMs, 6200)
  assert.equal(v.slowTools[0]?.tool, 'shell')
  assert.equal(v.loopLagMax, 180)
  assert.equal(v.resLast?.rss_mb, 300)
})

test('perfreport: UI 首条记录里的 ps_ms 解析成「PS 启动 → 脚本首行」，超 400ms 会点名', () => {
  const views = analyze([
    { v: 1, src: 'ui', run: 'r-s', ts: 100, mono: 20, type: 'start', name: 'ui', ps_ms: 3950 },
    { v: 1, src: 'ui', run: 'r-s', ts: 200, mono: 4470, type: 'span', name: 'first-frame', dur_ms: 180 },
  ])
  assert.equal(views[0]?.startup.psToScript, 3950)
  const adv = adviceOf(views)
  assert.ok(
    adv.some((a) => a.text.includes('PowerShell 进程创建')),
    'PS 启动 3.95s 应该单独给一条建议，否则「到窗口 4.47s」拆不开',
  )
})

test('perfreport: 按时间排序，没有 run 的记录单独成一组', () => {
  const views = analyze([
    { run: 'r-b', ts: 500, type: 'point', name: 'x' },
    { run: 'r-a', ts: 100, type: 'point', name: 'x' },
    { ts: 900, type: 'point', name: 'x' },
  ])
  assert.deepEqual(
    views.map((v) => v.run),
    ['r-a', 'r-b', 'unknown'],
  )
})

test('perfreport: 超阈值的项才给建议，并且指到具体是什么慢', () => {
  const slow = analyze([
    { run: 'r-a', ts: 100, type: 'span', name: 'first-frame', dur_ms: 170, mono: 1600 },
    { run: 'r-a', ts: 200, type: 'stall', name: 'ui', dur_ms: 900, busy: true },
    { run: 'r-a', ts: 300, type: 'span', name: 'turn', dur_ms: 9000, first_ms: 7000, reason: 'done' },
  ])
  const text = adviceOf(slow)
    .map((a) => a.text)
    .join('\n')
  assert.match(text, /启动到窗口/)
  assert.match(text, /断档/)
  assert.match(text, /首字延迟/)
  assert.ok(
    adviceOf(slow).some((a) => a.level === 'warn'),
    '启动慢/首字慢应该是 warn',
  )
})

test('perfreport: 一切正常时给一句「没有超标项」，不说空话', () => {
  const ok = analyze([
    { run: 'r-a', ts: 100, type: 'span', name: 'first-frame', dur_ms: 160, mono: 620 },
    { run: 'r-a', ts: 200, type: 'fps', name: 'ui', fps: 58, n: 10 },
    { run: 'r-a', ts: 300, type: 'res', cpu: 3, rss_mb: 120, heap_mb: 20 },
  ])
  const adv = adviceOf(ok)
  assert.equal(adv.length, 1)
  assert.match(adv[0]!.text, /没有超过任何阈值/)
})

test('perfreport: 报告里打印启动、卡顿、一轮、建议几块', () => {
  const views = analyze([
    { run: 'r-a', ts: 1000, type: 'span', name: 'first-frame', dur_ms: 170, mono: 900 },
    { run: 'r-a', ts: 1100, type: 'stall', name: 'ui', dur_ms: 820, busy: true },
    { run: 'r-a', ts: 1200, type: 'span', name: 'turn', dur_ms: 4000, first_ms: 1200, reason: 'done' },
  ])
  const text = renderPerfReport(views, { dir: 'C:\\x' }).join('\n')
  assert.match(text, /双击 → 窗口 900ms/)
  assert.match(text, /卡顿 1 次/)
  assert.match(text, /一轮 1 次，首字 1\.20s/)
  assert.match(text, /^建议$/m)
})
