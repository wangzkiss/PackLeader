import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Session } from '../src/core/session.ts'

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pl-meta-'))
}

test('session meta: 没发过消息的会话默认叫「新对话」', async () => {
  const dataDir = await fresh()
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  assert.equal(s.title(), '新对话')
  const list = await Session.list(dataDir)
  assert.equal(list.length, 1)
  assert.equal(list[0]!.title, '新对话')
  assert.equal(list[0]!.group, '')
})

test('session meta: 重命名覆盖自动标题，清空后回落到首条消息', async () => {
  const dataDir = await fresh()
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  await s.append({ kind: 'user/message', text: '  帮我看下  这个仓库  ' })

  const auto = (await Session.list(dataDir))[0]!
  assert.equal(auto.title, '帮我看下 这个仓库')

  await Session.setMeta(dataDir, s.id, { title: '  重构计划  ' })
  assert.equal((await Session.open(dataDir, s.id)).title(), '重构计划')
  assert.equal((await Session.list(dataDir))[0]!.title, '重构计划')

  // 空串 = 清掉自定义标题，回到自动
  await Session.setMeta(dataDir, s.id, { title: '' })
  assert.equal((await Session.open(dataDir, s.id)).title(), '帮我看下 这个仓库')
})

test('session meta: 分组能设能清，且不影响别的字段', async () => {
  const dataDir = await fresh()
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  await Session.setMeta(dataDir, s.id, { title: '甲', group: 'PackLeader' })
  await Session.setMeta(dataDir, s.id, { group: '别的项目' })

  const s2 = await Session.open(dataDir, s.id)
  assert.equal(s2.meta.title, '甲')
  assert.equal(s2.meta.group, '别的项目')
  assert.equal((await Session.list(dataDir))[0]!.group, '别的项目')

  await Session.setMeta(dataDir, s.id, { group: '' })
  assert.equal((await Session.list(dataDir))[0]!.group, '')
  // meta.json 真的落到会话目录里
  const raw = await readFile(join(dataDir, 'sessions', s.id, 'meta.json'), 'utf8')
  assert.equal((JSON.parse(raw) as { title?: string }).title, '甲')
})

test('session meta: 非法 id 直接拒，不碰到磁盘', async () => {
  const dataDir = await fresh()
  await assert.rejects(() => Session.setMeta(dataDir, '../../etc', { title: 'x' }), /非法会话 id/)
})

test('session meta: meta.json 坏了当成没有，不影响打开', async () => {
  const dataDir = await fresh()
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  await s.append({ kind: 'user/message', text: 'hi' })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(dataDir, 'sessions', s.id, 'meta.json'), '{ 坏掉的 json', 'utf8')
  assert.equal((await Session.open(dataDir, s.id)).title(), 'hi')
})
