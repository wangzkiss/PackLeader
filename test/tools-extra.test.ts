import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Policy } from '../src/core/policy.ts'
import type { Tool, ToolContext } from '../src/core/tools.ts'
import { createFsTools } from '../src/tools/fs.ts'
import { createRuntimeTools } from '../src/tools/runtime.ts'

async function ws() {
  const root = await mkdtemp(join(tmpdir(), 'pl-extra-'))
  await mkdir(join(root, 'src/tools'), { recursive: true })
  await mkdir(join(root, 'node_modules/x'), { recursive: true })
  await writeFile(
    join(root, 'src/a.ts'),
    'export function alpha() {\n  return 1\n}\n\nclass Beta {\n  run() {\n    return 2\n  }\n}\n',
    'utf8',
  )
  await writeFile(join(root, 'src/tools/b.ts'), 'export const b = 1\n', 'utf8')
  await writeFile(join(root, 'node_modules/x/index.js'), 'module.exports = 1\n', 'utf8')
  await writeFile(join(root, 'notes.md'), '# 标题\n\n## 小节\n', 'utf8')
  await writeFile(join(root, 'run.log'), Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n') + '\n', 'utf8')
  const ctx: ToolContext = {
    root,
    spillDir: join(root, '.spill'),
    maxOutputBytes: 64 * 1024,
    readFiles: new Set<string>(),
  }
  const fsTools = new Map<string, Tool>(createFsTools(root).map((t) => [t.name, t]))
  const rtTools = new Map<string, Tool>(createRuntimeTools({ root }).map((t) => [t.name, t]))
  return { root, ctx, fsTools, rtTools }
}

test('list: 目录在前、按名字排，depth 控制递归', async () => {
  const { ctx, fsTools } = await ws()
  const flat = await fsTools.get('list')!.run(ctx, {})
  assert.match(flat.content, /^d\s/m, '目录行以 d 开头')
  assert.match(flat.content, /src\//)
  assert.ok(!flat.content.includes('a.ts'), 'depth=1 不该列出孙项')

  const deep = await fsTools.get('list')!.run(ctx, { depth: 2 })
  assert.match(deep.content, /src\/a\.ts/)
  assert.match(deep.content, /src\/tools\//)

  await assert.rejects(() => fsTools.get('list')!.run(ctx, { path: 'nope' }), /路径不存在/)
})

test('find: 按名找文件与目录，默认跳 node_modules', async () => {
  const { ctx, fsTools } = await ws()
  const ts = await fsTools.get('find')!.run(ctx, { path: '.', pattern: '*.ts' })
  assert.match(ts.content, /src\/a\.ts/)
  assert.match(ts.content, /src\/tools\/b\.ts/)
  assert.ok(!ts.content.includes('node_modules'), '默认不进 node_modules')

  const all = await fsTools.get('find')!.run(ctx, { path: '.', pattern: 'index.js', all: true })
  assert.match(all.content, /node_modules\/x\/index\.js/)

  const dir = await fsTools.get('find')!.run(ctx, { path: '.', pattern: 'tools' })
  assert.match(dir.content, /src\/tools\//, '目录也参与匹配')

  const none = await fsTools.get('find')!.run(ctx, { path: '.', pattern: '*.zzz' })
  assert.match(none.content, /没有匹配/)
})

test('outline: 认出函数/类/方法与 Markdown 标题，带行号', async () => {
  const { ctx, fsTools } = await ws()
  const ts = await fsTools.get('outline')!.run(ctx, { path: 'src/a.ts' })
  assert.match(ts.content, /1\|.*function alpha/)
  assert.match(ts.content, /5\|.*class Beta/)
  assert.match(ts.content, /6\|.*run\(\)/)

  const md = await fsTools.get('outline')!.run(ctx, { path: 'notes.md' })
  assert.match(md.content, /# 标题/)
  assert.match(md.content, /## 小节/)

  const dir = await fsTools.get('outline')!.run(ctx, { path: 'src', glob: '*.ts' })
  assert.match(dir.content, /## src\/a\.ts/)
  assert.match(dir.content, /## src\/tools\/b\.ts/)
})

test('stat / hash: 元信息与 sha256', async () => {
  const { ctx, fsTools } = await ws()
  const st = await fsTools.get('stat')!.run(ctx, { path: 'src/a.ts' })
  assert.match(st.content, /type: file/)
  assert.match(st.content, /size: \d+/)
  assert.match(st.content, /readonly: (yes|no)/)

  const h = await fsTools.get('hash')!.run(ctx, { path: 'src/a.ts' })
  assert.match(h.content, /^sha256 [0-9a-f]{64}/)

  const md5 = await fsTools.get('hash')!.run(ctx, { path: 'src/a.ts', algo: 'md5' })
  assert.match(md5.content, /^md5 [0-9a-f]{32}/)

  await assert.rejects(() => fsTools.get('stat')!.run(ctx, { path: 'nope' }), /不存在/)
})

test('move: 改名后源不在、目标在；目标已存在时拒绝', async () => {
  const { ctx, fsTools, root } = await ws()
  const out = await fsTools.get('move')!.run(ctx, { from: 'src/tools/b.ts', to: 'src/tools/c.ts' })
  assert.match(out.content, /已移动/)
  await assert.rejects(() => stat(join(root, 'src/tools/b.ts')), /ENOENT/)
  assert.match(await readFile(join(root, 'src/tools/c.ts'), 'utf8'), /const b/)

  await assert.rejects(
    () => fsTools.get('move')!.run(ctx, { from: 'src/tools/c.ts', to: 'src/a.ts' }),
    /目标已存在/,
  )
})

test('remove: 删文件；目录不带 recursive 报错，带了就删整棵', async () => {
  const { ctx, fsTools, root } = await ws()
  await assert.rejects(() => fsTools.get('remove')!.run(ctx, { path: 'src' }), /recursive/)
  await fsTools.get('remove')!.run(ctx, { path: 'src/tools/b.ts' })
  await assert.rejects(() => stat(join(root, 'src/tools/b.ts')), /ENOENT/)
  await fsTools.get('remove')!.run(ctx, { path: 'src/tools', recursive: true })
  await assert.rejects(() => stat(join(root, 'src/tools')), /ENOENT/)
})

test('policy: read-only 档对 move/remove 一律 deny，guarded 档 ask', async () => {
  const { ctx, fsTools } = await ws()
  const readOnly = new Policy(ctx.root, 'read-only')
  const guarded = new Policy(ctx.root, 'guarded')
  for (const name of ['move', 'remove']) {
    const t = fsTools.get(name)!
    assert.equal(t.permission, 'write', `${name} 必须是 write 权限`)
    const target = t.targets!({ from: 'src/a.ts', to: 'x.ts', path: 'src/a.ts' })[0]!
    assert.equal(readOnly.gate(t.permission, target), 'deny', `${name} 在 read-only 档应被拒`)
    assert.equal(guarded.gate(t.permission, target), 'ask', `${name} 在 guarded 档要审批`)
  }
})

test('logtail: 只取末尾 N 行，不整份读', async () => {
  const { ctx, rtTools } = await ws()
  const out = await rtTools.get('logtail')!.run(ctx, { path: 'run.log', lines: 5 })
  assert.match(out.content, /line 296/)
  assert.match(out.content, /line 300/)
  assert.ok(!/^\s*line 10$/m.test(out.content), '不该包含前面的行')
})

test('processlist: 能列出进程', async () => {
  const { ctx, rtTools } = await ws()
  const out = await rtTools.get('processlist')!.run(ctx, { limit: 5 })
  assert.match(out.content, /进程/)
})

test('netprobe: 关着的端口快速失败，停在 tcp 阶段', async () => {
  const { ctx, rtTools } = await ws()
  const out = await rtTools.get('netprobe')!.run(ctx, { host: '127.0.0.1', port: 1, timeout_ms: 800 })
  assert.match(out.content, /tcp: .*连不上/)
  assert.ok(!out.content.includes('http:'), '连不上就不该再探 HTTP')
})

test('sysstat: 报内存与磁盘', async () => {
  const { ctx, rtTools } = await ws()
  const out = await rtTools.get('sysstat')!.run(ctx, {})
  assert.match(out.content, /内存:/)
  assert.match(out.content, /磁盘:/)
})
