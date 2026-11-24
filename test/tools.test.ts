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
