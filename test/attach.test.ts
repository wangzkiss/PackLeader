import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ingestFiles, mimeOf } from '../src/core/attach.ts'
import { Session } from '../src/core/session.ts'
import { OpenAiClient } from '../src/llm/openai.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function sandbox(): Promise<{ data: string; src: string }> {
  const data = await mkdtemp(join(tmpdir(), 'pl-attach-data-'))
  const src = await mkdtemp(join(tmpdir(), 'pl-attach-src-'))
  return { data, src }
}

test('attach: 文本文件内联进正文，同时拷进数据目录', async () => {
  const { data, src } = await sandbox()
  const f = join(src, 'notes.md')
  await writeFile(f, '# 标题\n内容\n')

  const r = await ingestFiles(data, 's-abc-1', [f])
  assert.equal(r.attachments.length, 1)
  const att = r.attachments[0]!
  assert.equal(att.name, 'notes.md')
  assert.equal(att.inlined, true)
  assert.equal(att.mime, 'text/plain')
  // 拷贝过的是副本：源文件删了也不影响会话
  assert.ok(existsSync(att.path))
  assert.notEqual(att.path, f)
  assert.equal(await readFile(att.path, 'utf8'), '# 标题\n内容\n')
  // 内容已内联，模型不用再 read 一次
  assert.match(r.text, /内容已贴在下面/)
  assert.match(r.text, /# 标题/)
  assert.ok(!r.text.includes('\uFEFF'))
  assert.match(r.text, /<file name="notes\.md"/)
})

test('attach: 图片不内联，按视觉开关给不同说法', async () => {
  const { data, src } = await sandbox()
  const f = join(src, 'shot.png')
  await writeFile(f, PNG)

  const off = await ingestFiles(data, 's-abc-2', [f], { vision: false })
  assert.equal(off.attachments[0]!.mime, 'image/png')
  assert.equal(off.attachments[0]!.inlined, undefined)
  assert.match(off.text, /没开视觉/)

  const on = await ingestFiles(data, 's-abc-3', [f], { vision: true })
  assert.match(on.text, /已作为图片附上/)
})

test('attach: 同名文件不互相覆盖，序号前缀保证都在', async () => {
  const { data, src } = await sandbox()
  const a = join(src, 'a.txt')
  await writeFile(a, 'AAA')
  const dir2 = await mkdtemp(join(tmpdir(), 'pl-attach-src2-'))
  const b = join(dir2, 'a.txt')
  await writeFile(b, 'BBB')

  const r = await ingestFiles(data, 's-abc-4', [a, b])
  assert.equal(r.attachments.length, 2)
  const paths = r.attachments.map((x) => x.path)
  assert.equal(new Set(paths).size, 2)
  assert.equal(await readFile(paths[0]!, 'utf8'), 'AAA')
  assert.equal(await readFile(paths[1]!, 'utf8'), 'BBB')
})

test('attach: 不存在的路径被跳过，不是静默少一个而是明确提示', async () => {
  const { data, src } = await sandbox()
  const real = join(src, 'ok.txt')
  await writeFile(real, 'x')

  const onlyMissing = await ingestFiles(data, 's-abc-5', [join(src, 'nope.txt')])
  assert.deepEqual(onlyMissing.attachments, [])
  assert.equal(onlyMissing.text, '')

  const mixed = await ingestFiles(data, 's-abc-6', [join(src, 'nope.txt'), real])
  assert.equal(mixed.attachments.length, 1)
  assert.equal(mixed.attachments[0]!.name, 'ok.txt')
})

test('attach: 二进制/大文件只给路径，不塞进上下文', async () => {
  const { data, src } = await sandbox()
  const f = join(src, 'pkg.zip')
  await writeFile(f, Buffer.alloc(1024, 7))

  const r = await ingestFiles(data, 's-abc-7', [f])
  assert.equal(r.attachments[0]!.mime, 'application/zip')
  assert.equal(r.attachments[0]!.inlined, undefined)
  assert.match(r.text, /需要时用工具自己看/)
  assert.ok(!r.text.includes('<file name'))
})

test('attach: mimeOf 覆盖常见类型', () => {
  assert.equal(mimeOf('a.png'), 'image/png')
  assert.equal(mimeOf('a.JPG'), 'image/jpeg')
  assert.equal(mimeOf('a.ts'), 'text/plain')
  assert.equal(mimeOf('a.unknown-ext'), 'application/octet-stream')
})

test('attach: 图片在 deriveMessages 时读成 base64（日志里不存二进制）', async () => {
  const { data, src } = await sandbox()
  const f = join(src, 'p.png')
  await writeFile(f, PNG)

  const s = await Session.create(data, { cwd: data, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  const ing = await ingestFiles(data, s.id, [f])
  await s.append({ kind: 'turn/start', turn: 1 })
  await s.append({ kind: 'user/message', text: '这张图里是什么？', files: ing.attachments })

  // 事件日志里只有路径和大小，没有 base64
  const raw = await readFile(s.file, 'utf8')
  assert.ok(!raw.includes(PNG.toString('base64')))

  const msgs = s.deriveMessages()
  const user = msgs.find((m) => m.role === 'user')!
  assert.equal(user.images?.length, 1)
  assert.equal(user.images?.[0].mime, 'image/png')
  assert.equal(user.images?.[0].dataBase64, PNG.toString('base64'))
})

test('attach: 带图消息走 OpenAI 多模态 parts，纯文本消息保持字符串', () => {
  const client = new OpenAiClient({ baseURL: 'http://x/v1', apiKey: 'k', model: 'm' })
  const toWire = (client as unknown as { toWire: (m: unknown[]) => Array<Record<string, unknown>> }).toWire.bind(client)

  const plain = toWire([{ role: 'user', content: 'hi' }])
  assert.equal(typeof plain[0]!.content, 'string')

  const withImage = toWire([
    { role: 'user', content: '看图', images: [{ mime: 'image/png', dataBase64: 'AAA' }] },
  ])
  const parts = withImage[0]!.content as Array<Record<string, unknown>>
  assert.equal(Array.isArray(parts), true)
  assert.deepEqual(parts[0], { type: 'text', text: '看图' })
  assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } })
})

test('attach: 同一会话的附件落在自己的目录里，互不干扰', async () => {
  const { data, src } = await sandbox()
  const f = join(src, 'x.txt')
  await writeFile(f, 'x')

  const one = await ingestFiles(data, 's-aaa-1', [f])
  const two = await ingestFiles(data, 's-bbb-1', [f])
  assert.ok(one.attachments[0]!.path.includes(join('files', 's-aaa-1')))
  assert.ok(two.attachments[0]!.path.includes(join('files', 's-bbb-1')))
  assert.notEqual(one.attachments[0]!.path, two.attachments[0]!.path)
})

test('attach: 删会话时附件目录一起删（不留孤儿文件）', async () => {
  const { data, src } = await sandbox()
  const f = join(src, 'x.txt')
  await writeFile(f, 'x')

  const s = await Session.create(data, { cwd: data, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  const ing = await ingestFiles(data, s.id, [f])
  assert.ok(existsSync(ing.attachments[0]!.path))

  await Session.remove(data, s.id)
  assert.equal(existsSync(join(data, 'files', s.id)), false)
  assert.equal(existsSync(join(data, 'sessions', s.id)), false)
})