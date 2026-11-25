import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { truncateOutput } from '../src/core/loop.ts'
import type { ToolContext } from '../src/core/tools.ts'
import { createFsTools } from '../src/tools/fs.ts'
import { createRuntimeTools } from '../src/tools/runtime.ts'

async function ws(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const ctx: ToolContext = {
    root,
    spillDir: join(root, '.spill'),
    maxOutputBytes: 64 * 1024,
    readFiles: new Set<string>(),
  }
  return { root, ctx }
}

// ---------- truncateOutput ----------

test('truncateOutput: 超长输出按字节预算裁，裁完不超上限', () => {
  const big = 'x'.repeat(700 * 1024)
  const r = truncateOutput(big, 64 * 1024)
  assert.equal(r.truncated, true)
  const bytes = Buffer.byteLength(r.content, 'utf8')
  assert.ok(bytes < 64 * 1024 * 1.2, `裁完 ${bytes} 字节，应回到 64KB 量级而不是原来的 85%`)
  assert.match(r.content, /省略 \d+ 字符/)
  assert.ok(r.omittedChars > 0)
})

test('truncateOutput: 中文和 emoji 不会被切碎', () => {
  const big = '中文内容😀'.repeat(120_000)
  const r = truncateOutput(big, 64 * 1024)
  assert.equal(r.truncated, true)
  assert.ok(!r.content.includes('\uFFFD'), '不能出现替换符')
  // 头尾都不该有孤立代理项
  for (const chunk of [r.content.slice(0, 40), r.content.slice(-40)]) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i)
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = chunk.charCodeAt(i + 1)
        assert.ok(next >= 0xdc00 && next <= 0xdfff, '高位代理后面必须紧跟低位代理')
      }
      if (c >= 0xdc00 && c <= 0xdfff) {
        const prev = chunk.charCodeAt(i - 1)
        assert.ok(prev >= 0xd800 && prev <= 0xdbff, '低位代理前面必须有高位代理')
      }
    }
  }
})

test('truncateOutput: 没超上限就原样返回', () => {
  const r = truncateOutput('hello', 100)
  assert.equal(r.content, 'hello')
  assert.equal(r.truncated, false)
  assert.equal(r.omittedChars, 0)
})

test('truncateOutput: 省略提示里带上 spill 路径', () => {
  const r = truncateOutput('y'.repeat(200 * 1024), 16 * 1024, 'C:/tmp/spill/1.log')
  assert.match(r.content, /C:\/tmp\/spill\/1\.log/)
})

// ---------- read ranges ----------

test('read: ranges 一次读多段，行号对得上', async () => {
  const { root, ctx } = await ws('pl-range-')
  const body = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
  await writeFile(join(root, 'f.txt'), body, 'utf8')
  const read = createFsTools(root).find((t) => t.name === 'read')!

  const out = await read.run(ctx, { path: 'f.txt', ranges: [{ offset: 3, limit: 2 }, { offset: 50, limit: 2 }] })
  assert.match(out.content, /\b3\| line 3/)
  assert.match(out.content, /\b4\| line 4/)
  assert.match(out.content, /\b50\| line 50/)
  assert.match(out.content, /\b51\| line 51/)
  assert.ok(!out.content.includes('line 20'), '没要求的段不该出现')
  assert.ok(!out.content.includes('还有'), '多段模式不报剩余行数')
})

test('read: 单段行为不变（offset/limit + 剩余提示）', async () => {
  const { root, ctx } = await ws('pl-range-')
  const body = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n')
  await writeFile(join(root, 'f.txt'), body, 'utf8')
  const read = createFsTools(root).find((t) => t.name === 'read')!
  const out = await read.run(ctx, { path: 'f.txt', offset: 2, limit: 3 })
  assert.match(out.content, /本次 2-4/)
  assert.match(out.content, /还有 6 行/)
})

test('read: 超出末尾的区间如实说明', async () => {
  const { root, ctx } = await ws('pl-range-')
  await writeFile(join(root, 'f.txt'), 'a\nb', 'utf8')
  const read = createFsTools(root).find((t) => t.name === 'read')!
  const out = await read.run(ctx, { path: 'f.txt', ranges: [{ offset: 99, limit: 5 }] })
  assert.match(out.content, /超出文件末尾/)
})

// ---------- waitfor ----------

test('waitfor: 文件已存在就立刻返回', async () => {
  const { root, ctx } = await ws('pl-wait-')
  await writeFile(join(root, 'done.txt'), 'ok', 'utf8')
  const waitfor = createRuntimeTools({ root }).find((t) => t.name === 'waitfor')!
  const t0 = Date.now()
  const out = await waitfor.run(ctx, { target: 'file', path: 'done.txt' })
  assert.match(out.content, /已存在/)
  assert.ok(Date.now() - t0 < 2000)
})

test('waitfor: 等不到就超时返回现状，不无限等', async () => {
  const { root, ctx } = await ws('pl-wait-')
  const waitfor = createRuntimeTools({ root }).find((t) => t.name === 'waitfor')!
  const t0 = Date.now()
  const out = await waitfor.run(ctx, { target: 'file', path: 'nope.txt', timeout_ms: 400, interval_ms: 100 })
  const spent = Date.now() - t0
  assert.match(out.content, /还没有成立/)
  assert.match(out.content, /nope\.txt 还没有/)
  assert.ok(spent >= 350 && spent < 5000, `实际等了 ${spent}ms`)
})

test('waitfor: 端口连不上就等到超时', async () => {
  const { root, ctx } = await ws('pl-wait-')
  const waitfor = createRuntimeTools({ root }).find((t) => t.name === 'waitfor')!
  const out = await waitfor.run(ctx, { target: 'port', port: 1, timeout_ms: 300, interval_ms: 100 })
  assert.match(out.content, /还没有成立/)
})

test('waitfor: 参数不对就说清楚', async () => {
  const { root, ctx } = await ws('pl-wait-')
  const waitfor = createRuntimeTools({ root }).find((t) => t.name === 'waitfor')!
  await assert.rejects(() => waitfor.run(ctx, { target: 'nonsense' }), /target 只能是/)
  await assert.rejects(() => waitfor.run(ctx, { target: 'port' }), /需要 port/)
})
