import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryStore, memoryKey } from '../src/core/memory.ts'
import { createMemoryTools } from '../src/tools/memory.ts'
import type { ToolContext } from '../src/core/tools.ts'

async function fresh(): Promise<{ dataDir: string; cwd: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-mem-'))
  const cwd = join(dataDir, 'repo')
  return { dataDir, cwd }
}

const ctx = { root: process.cwd() } as unknown as ToolContext

test('memory: 记住、读回、按 cwd 分文件', async () => {
  const { dataDir, cwd } = await fresh()
  const a = new MemoryStore(dataDir, cwd)
  const other = new MemoryStore(dataDir, join(dataDir, 'another'))

  await a.add('  这个仓库用 npm test 验证  ')
  await a.add('构建产物在 dist/')
  await other.add('另一条记忆')

  const items = await a.all()
  assert.equal(items.length, 2)
  assert.equal(items[0]!.text, '这个仓库用 npm test 验证')
  assert.equal(items[0]!.cwd, cwd)

  // 大小写、斜杠方向不同也映射到同一个文件
  assert.equal(memoryKey(cwd), memoryKey(cwd.toUpperCase().replace(/\\/g, '/')))
  assert.notEqual(a.file, other.file)
  assert.equal((await other.all()).length, 1)

  const raw = await readFile(a.file, 'utf8')
  assert.equal(raw.trim().split('\n').length, 2)
})

test('memory: 撤销删掉指定 id，重写后能读回剩下的', async () => {
  const { dataDir, cwd } = await fresh()
  const store = new MemoryStore(dataDir, cwd)
  const m1 = await store.add('第一条')
  const m2 = await store.add('第二条')
  const m3 = await store.add('第三条')

  assert.deepEqual(await store.remove([m2.id]), [m2.id])
  const left = await store.all()
  assert.deepEqual(
    left.map((i) => i.id),
    [m1.id, m3.id],
  )

  // 不存在的 id 静默忽略
  assert.deepEqual(await store.remove(['m-nope']), [])
  assert.equal((await store.all()).length, 2)
  // 空参数不写文件
  assert.deepEqual(await store.remove([]), [])
})

test('memory: 并发撤销与追加不会互相丢行', async () => {
  const { dataDir, cwd } = await fresh()
  const store = new MemoryStore(dataDir, cwd)
  const first = await store.add('a')
  await Promise.all([store.remove([first.id]), store.add('b'), store.add('c')])
  const texts = (await store.all()).map((i) => i.text).sort()
  assert.deepEqual(texts, ['b', 'c'])
})

test('memory: 坏行跳过，不阻断读取', async () => {
  const { dataDir, cwd } = await fresh()
  const store = new MemoryStore(dataDir, cwd)
  await store.add('好的一条')
  const { appendFile } = await import('node:fs/promises')
  await appendFile(store.file, '{"id":"m-x","text":"半', 'utf8')
  assert.equal((await store.all()).length, 1)
})

test('memory 工具: remember 写入一条，空内容被拒', async () => {
  const { dataDir, cwd } = await fresh()
  const store = new MemoryStore(dataDir, cwd)
  const [remember] = createMemoryTools(store)
  assert.ok(remember)
  assert.equal(remember.name, 'remember')
  assert.equal(remember.permission, 'read')

  const r = await remember.run(ctx, { text: '这个仓库的测试命令是 npm test' })
  assert.equal((r as { exitCode?: number }).exitCode, undefined)
  assert.match((r as { content: string }).content, /记住了/)
  assert.equal((await store.all())[0]!.text, '这个仓库的测试命令是 npm test')

  const empty = await remember.run(ctx, { text: '   ' })
  assert.equal((empty as { exitCode?: number }).exitCode, 1)
  assert.equal((await store.all()).length, 1)
})
