/**
 * 截图 / 看图：脚本生成、工具产出、以及「截图怎么回到模型上下文」。
 *
 * 真截图依赖桌面（要有窗口、要有会话），不进单测；
 * 这里锁住的是不靠桌面的那部分：参数内联和转义、view_image 的产出、
 * tool/result.images 被投影成一条 user 消息（vision 开 / 关两种）。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Session } from '../src/core/session.ts'
import { createDefaultTools } from '../src/tools/index.ts'
import { buildShotScript, createScreenshotTools } from '../src/tools/screenshot.ts'

/** 1x1 PNG：够验证尺寸解析和 base64 往返 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('screenshot: 默认工具集里有 screenshot / view_image', () => {
  const names = createDefaultTools({ root: tmpdir() }).all().map((t) => t.name)
  assert.ok(names.includes('screenshot'))
  assert.ok(names.includes('view_image'))
})

test('screenshot: 生成脚本时参数内联，单引号双写转义', () => {
  const s = buildShotScript({
    target: 'window',
    process: 'PackLeader',
    title: '',
    click: '320,96',
    waitMs: 400,
    maxWidth: 1600,
    out: "C:\\tmp\\a'b.png",
  })
  assert.match(s, /PrintWindow/)
  assert.match(s, /SetCursorPos/)
  assert.match(s, /\$procName = 'PackLeader'/)
  assert.match(s, /\$click = '320,96'/)
  // 路径里的单引号在 PowerShell 里要写成两个
  assert.match(s, /\$out = 'C:\\tmp\\a''b\.png'/)
  // 太宽的图要缩放，不然 4K 整屏直接把请求撑爆
  assert.match(s, /InterpolationMode/)
  // 输出编码定成 UTF-8，否则 PS 报错中文按 GBK 出来就是一片乱码
  assert.match(s, /Console\]::OutputEncoding = \[Text\.Encoding\]::UTF8/)
})

// 日志里 3 次截图失败：process 填的是窗口标题（PackLeader），或者机器上根本没有的 pwsh。
test('screenshot: process 按名找不到时退回拿它当标题找，并把候选列给模型', () => {
  const s = buildShotScript({
    target: 'window',
    process: 'PackLeader',
    title: '',
    click: '',
    waitMs: 0,
    maxWidth: 1600,
    out: 'a.png',
  })
  assert.match(s, /\$want = \$procName -replace/) // 容忍带不带 .exe
  assert.match(s, /ProcessName -eq \$want/) // 先按进程名
  assert.match(s, /MainWindowTitle -like "\*\$want\*"/) // 再当标题片段
  assert.match(s, /当前带窗口的/) // 找不到时把候选给出来
})

test('screenshot: view_image 把图片交给模型（带 mime 和尺寸）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-shot-'))
  const p = join(root, 'a.png')
  await writeFile(p, PNG)
  const view = createScreenshotTools({ dataDir: root }).find((t) => t.name === 'view_image')!
  const out = await view.run(
    { root, spillDir: join(root, 'spill'), maxOutputBytes: 4096, readFiles: new Set() },
    { path: 'a.png' },
  )
  assert.equal(out.images?.length, 1)
  assert.equal(out.images?.[0]!.mime, 'image/png')
  assert.match(out.content, /1x1/)
})

test('screenshot: view_image 拒绝非图片，不拿 read 凑', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-shot-'))
  const p = join(root, 'a.txt')
  await writeFile(p, 'x')
  const view = createScreenshotTools({ dataDir: root }).find((t) => t.name === 'view_image')!
  await assert.rejects(
    view.run({ root, spillDir: join(root, 'spill'), maxOutputBytes: 4096, readFiles: new Set() }, { path: 'a.txt' }),
    /不支持的图片格式/,
  )
})

test('session: 工具结果里的截图投影成一条 user 消息，日志里不存二进制', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-shot-s-'))
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'x', mode: 'full', version: 't' })
  const png = join(dataDir, 'shot.png')
  await writeFile(png, PNG)

  await s.append({
    kind: 'assistant/message',
    text: '',
    reasoning: '',
    toolCalls: [{ id: 'c1', name: 'screenshot', args: {} }],
    ms: 1,
    finish: 'tool_calls',
  })
  await s.append({
    kind: 'tool/result',
    callId: 'c1',
    name: 'screenshot',
    ok: true,
    content: '已截图',
    ms: 5,
    images: [{ path: png, mime: 'image/png' }],
  })

  const msgs = s.deriveMessages()
  // tool 消息后面紧跟一条 user 消息：tool 本身只能放文本
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['assistant', 'tool', 'user'],
  )
  assert.equal(msgs[2]!.images?.length, 1)
  assert.equal(msgs[2]!.images?.[0]!.dataBase64, PNG.toString('base64'))

  const raw = await readFile(s.file, 'utf8')
  assert.ok(!raw.includes(PNG.toString('base64')))

  // 关掉看图：只给路径，不把图塞进去
  const noVision = s.deriveMessages({ vision: false })
  assert.equal(noVision[2]!.images, undefined)
  assert.match(noVision[2]!.content, /图片没有发给模型/)
})

test('session: 同一批多个 tool 结果之后才补截图（不打断 tool_calls 配对）', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-shot-p-'))
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'x', mode: 'full', version: 't' })
  const png = join(dataDir, 'shot.png')
  await writeFile(png, PNG)

  await s.append({
    kind: 'assistant/message',
    text: '',
    reasoning: '',
    toolCalls: [
      { id: 'c1', name: 'screenshot', args: {} },
      { id: 'c2', name: 'read', args: { path: 'a.txt' } },
    ],
    ms: 1,
    finish: 'tool_calls',
  })
  await s.append({ kind: 'tool/result', callId: 'c1', name: 'screenshot', ok: true, content: '已截图', ms: 5, images: [{ path: png, mime: 'image/png' }] })
  await s.append({ kind: 'tool/result', callId: 'c2', name: 'read', ok: true, content: 'aaa', ms: 2 })

  assert.deepEqual(
    s.deriveMessages().map((m) => m.role),
    ['assistant', 'tool', 'tool', 'user'],
  )
})
