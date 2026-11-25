import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Policy } from '../src/core/policy.ts'
import type { Tool, ToolContext } from '../src/core/tools.ts'
import { createFsTools } from '../src/tools/fs.ts'

async function ws() {
  const root = await mkdtemp(join(tmpdir(), 'pl-fs-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1\n// TODO: fix\n', 'utf8')
  const ctx: ToolContext = {
    root,
    spillDir: join(root, '.spill'),
    maxOutputBytes: 64 * 1024,
    readFiles: new Set<string>(),
  }
  const tools = new Map<string, Tool>(createFsTools(root).map((t) => [t.name, t]))
  return { root, ctx, tools }
}

test('fs.read 带行号，且支持 offset/limit', async () => {
  const { ctx, tools } = await ws()
  const out = await tools.get('read')!.run(ctx, { path: 'src/a.ts' })
  assert.match(out.content, /^\s*1\| export const a = 1/m)
  assert.match(out.content, /3 行/)

  const sliced = await tools.get('read')!.run(ctx, { path: 'src/a.ts', offset: 2, limit: 1 })
  assert.match(sliced.content, /^\s*2\| \/\/ TODO: fix/m)
  assert.ok(!sliced.content.includes('export const'))
  assert.ok(ctx.readFiles.size > 0, '读过的文件要记进 readFiles')
})

test('fs.write 自动建父目录', async () => {
  const { root, ctx, tools } = await ws()
  await tools.get('write')!.run(ctx, { path: 'deep/nested/b.txt', content: 'hi' })
  assert.equal(await readFile(join(root, 'deep/nested/b.txt'), 'utf8'), 'hi')
})

test('fs.edit 要求唯一命中，多处时报错并给出数量', async () => {
  const { ctx, tools } = await ws()
  const edit = tools.get('edit')!
  await assert.rejects(() => edit.run(ctx, { path: 'src/a.ts', old: '不存在的文本', new: 'x' }), /没找到/)

  await writeFile(join(ctx.root, 'dup.txt'), 'aa\naa\n', 'utf8')
  await assert.rejects(() => edit.run(ctx, { path: 'dup.txt', old: 'aa', new: 'bb' }), /命中 2 处/)

  const ok = await edit.run(ctx, { path: 'dup.txt', old: 'aa', new: 'bb', replace_all: true })
  assert.match(ok.content, /替换 2 处/)
  assert.equal(await readFile(join(ctx.root, 'dup.txt'), 'utf8'), 'bb\nbb\n')
})

test('fs.glob / fs.grep 能按模式定位', async () => {
  const { ctx, tools } = await ws()
  const globbed = await tools.get('glob')!.run(ctx, { pattern: 'src/**/*.ts' })
  assert.match(globbed.content, /src\/a\.ts/)

  const grepped = await tools.get('grep')!.run(ctx, { pattern: 'TODO', include: '*.ts' })
  assert.match(grepped.content, /src\/a\.ts:2:/)
})

test('fs.glob 支持 {a,b} 大括号（模型常用写法）', async () => {
  const { ctx, tools } = await ws()
  await writeFile(join(ctx.root, 'package.json'), '{}', 'utf8')
  const out = await tools.get('glob')!.run(ctx, { pattern: '**/*.{ts,json}' })
  assert.match(out.content, /src\/a\.ts/)
  assert.match(out.content, /package\.json/)
})

test('fs.grep 默认跳过资源文件，给 include 才搜', async () => {
  const { ctx, tools } = await ws()
  await writeFile(join(ctx.root, 'a.js.map'), '{"sources":["needs_review"]}', 'utf8')
  await writeFile(join(ctx.root, 'logo.svg'), '<svg>needs_review</svg>', 'utf8')

  const skipped = await tools.get('grep')!.run(ctx, { pattern: 'needs_review' })
  assert.match(skipped.content, /没有匹配/)

  const included = await tools.get('grep')!.run(ctx, { pattern: 'needs_review', include: '*.map' })
  assert.match(included.content, /a\.js\.map:1:/)
})

test('grep/glob 支持 path 限定范围（模型默认写法）', async () => {
  const { ctx, tools } = await ws()
  await mkdir(join(ctx.root, 'src/sub'), { recursive: true })
  await writeFile(join(ctx.root, 'src/sub/x.ts'), '// needle\n', 'utf8')
  await writeFile(join(ctx.root, 'other.ts'), '// needle\n', 'utf8')

  const grepped = await tools.get('grep')!.run(ctx, { pattern: 'needle', path: 'src' })
  assert.match(grepped.content, /src\/sub\/x\.ts:1:/)
  assert.ok(!grepped.content.includes('other.ts'), '不该搜到范围外的文件')

  const globbed = await tools.get('glob')!.run(ctx, { pattern: '**/*.ts', path: 'src' })
  assert.match(globbed.content, /src\/sub\/x\.ts/)
  assert.ok(!globbed.content.includes('other.ts'))
})

test('read: 大文件按字节预算切块，并给出续读 offset', async () => {
  const { ctx, tools } = await ws()
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`).join('\n')
  await writeFile(join(ctx.root, 'big.txt'), big, 'utf8')

  const out = await tools.get('read')!.run(ctx, { path: 'big.txt' })
  assert.match(out.content, /还有 \d+ 行，用 offset=\d+ 继续/)
  assert.ok(Buffer.byteLength(out.content, 'utf8') < 50 * 1024, '单次输出不应超过预算')

  const next = Number(/offset=(\d+)/.exec(out.content)![1])
  const more = await tools.get('read')!.run(ctx, { path: 'big.txt', offset: next })
  assert.match(more.content, new RegExp(`^\\s*${next}\\|`, 'm'))
})

test('policy: 越界写被拒，read-only 一律拒写', async () => {
  const { root } = await ws()
  const guarded = new Policy(root, 'guarded')
  const outside = join(root, '..', 'evil.txt')
  assert.equal(guarded.gate('write', outside), 'deny')
  assert.equal(guarded.gate('write', join(root, 'src/a.ts')), 'ask')
  assert.equal(guarded.gate('read', outside), 'allow')

  const ro = new Policy(root, 'read-only')
  assert.equal(ro.gate('write', join(root, 'src/a.ts')), 'deny')

  const full = new Policy(root, 'full')
  assert.equal(full.gate('write', outside), 'allow')
})

test('fs.edit 容忍 CRLF/LF 与行尾空白差异', async () => {
  const { root, ctx, tools } = await ws()
  const edit = tools.get('edit')!
  const p = join(root, 'crlf.ts')
  await writeFile(p, 'const a = 1\r\nconst b = 2\r\nconst c = 3\r\n', 'utf8')
  const r = await edit.run(ctx, {
    path: 'crlf.ts',
    old: 'const b = 2  \nconst c = 3',
    new: 'const b = 20\nconst c = 30',
  })
  assert.match(r.content, /已修改/)
  assert.equal(await readFile(p, 'utf8'), 'const a = 1\r\nconst b = 20\r\nconst c = 30\r\n')
})

test('fs.edit 不命中时指出最接近的行号', async () => {
  const { ctx, tools } = await ws()
  const edit = tools.get('edit')!
  await assert.rejects(
    () => edit.run(ctx, { path: 'src/a.ts', old: '// TODO: fix\nconst zzz = 9', new: 'x' }),
    /第 2 行/,
  )
})

test('fs.edit 多命中时列出每个命中的行号', async () => {
  const { ctx, tools } = await ws()
  const edit = tools.get('edit')!
  await writeFile(join(ctx.root, 'dup2.txt'), 'aa\nbb\naa\n', 'utf8')
  await assert.rejects(() => edit.run(ctx, { path: 'dup2.txt', old: 'aa\n', new: 'xx\n' }), /第 1、3 行/)
})
