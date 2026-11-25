/**
 * 读缓存：同一文件用同样的参数重复读，第二次只回一句「没变」，
 * 文件被改过（不管是用 write 工具还是外部改的）就必须重新给正文。
 */

import assert from 'node:assert/strict'
import { mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ToolContext } from '../src/core/tools.ts'
import { createDefaultTools } from '../src/tools/index.ts'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pl-cache-'))
  const tools = createDefaultTools({ root })
  const ctx: ToolContext = {
    root,
    spillDir: join(root, 'spill'),
    maxOutputBytes: 64 * 1024,
    readFiles: new Set(),
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools.get(name)
    assert.ok(t, `工具 ${name} 不存在`)
    return t.run(ctx, args)
  }
  return { root, call }
}

const body = ['CACHE-BODY-1', 'CACHE-BODY-2', 'CACHE-BODY-3'].join('\n') + '\n'

test('同参数重复读：第二次只回「没变」，不再贴全文', async () => {
  const s = await setup()
  await writeFile(join(s.root, 'a.txt'), body, 'utf8')

  const first = await s.call('read', { path: 'a.txt' })
  assert.ok(first.content.includes('CACHE-BODY-2'), '第一次要给出正文')

  const second = await s.call('read', { path: 'a.txt' })
  assert.match(second.content, /未变/, '第二次应当提示没变')
  assert.ok(!second.content.includes('CACHE-BODY-2'), '第二次不该再贴正文')
  assert.ok(second.content.length < first.content.length)
})

test('write 改过之后再读：拿到新内容', async () => {
  const s = await setup()
  await writeFile(join(s.root, 'b.txt'), body, 'utf8')
  await s.call('read', { path: 'b.txt' })

  await s.call('write', { path: 'b.txt', content: 'NEW-BODY-X\n' })
  const after = await s.call('read', { path: 'b.txt' })
  assert.ok(after.content.includes('NEW-BODY-X'), `write 之后必须重读正文：${after.content.slice(0, 200)}`)
  assert.ok(!after.content.includes('CACHE-BODY-1'))
})

test('文件在外部被改（mtime 变了）也会失效', async () => {
  const s = await setup()
  const p = join(s.root, 'c.txt')
  await writeFile(p, body, 'utf8')
  await s.call('read', { path: 'c.txt' })

  await writeFile(p, 'OUTSIDE-EDIT\n', 'utf8')
  const far = new Date(Date.now() + 2000)
  await utimes(p, far, far)

  const after = await s.call('read', { path: 'c.txt' })
  assert.ok(after.content.includes('OUTSIDE-EDIT'), `外部改动后必须重读：${after.content.slice(0, 200)}`)
})

test('参数不同不命中同一条缓存', async () => {
  const s = await setup()
  await writeFile(join(s.root, 'd.txt'), body, 'utf8')
  await s.call('read', { path: 'd.txt' })
  const part = await s.call('read', { path: 'd.txt', offset: 2, limit: 1 })
  assert.ok(part.content.includes('CACHE-BODY-2'), `换 offset 必须真的读：${part.content.slice(0, 200)}`)
  assert.ok(!part.content.includes('CACHE-BODY-1'))
})

test('限定行范围的读也各自缓存', async () => {
  const s = await setup()
  await writeFile(join(s.root, 'e.txt'), body, 'utf8')
  const a1 = await s.call('read', { path: 'e.txt', offset: 2, limit: 1 })
  assert.ok(a1.content.includes('CACHE-BODY-2'))
  const a2 = await s.call('read', { path: 'e.txt', offset: 2, limit: 1 })
  assert.match(a2.content, /未变/)
  assert.ok(!a2.content.includes('CACHE-BODY-2'))
})
