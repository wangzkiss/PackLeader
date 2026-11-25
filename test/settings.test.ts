import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Session } from '../src/core/session.ts'
import { loadSettings, loadSettingsSync, maskKey, saveSettings, settingsPath } from '../src/core/settings.ts'

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'pl-settings-'))

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

test('settings: 写入后能读回，落盘是 JSON 而不是别的格式', async () => {
  const dir = await tmp()
  const saved = await saveSettings(dir, { baseURL: 'http://127.0.0.1:19790/v1', apiKey: 'sk-test-1234', model: 'deepseek-flash' })
  assert.deepEqual(saved, { baseURL: 'http://127.0.0.1:19790/v1', apiKey: 'sk-test-1234', model: 'deepseek-flash' })

  const back = await loadSettings(dir)
  assert.equal(back.apiKey, 'sk-test-1234')
  assert.equal(back.model, 'deepseek-flash')

  const raw = JSON.parse(await readFile(settingsPath(dir), 'utf8')) as Record<string, string>
  assert.equal(raw.baseURL, 'http://127.0.0.1:19790/v1')
})

test('settings: 只改模型不动 Key，空字符串视为"保持原值"', async () => {
  const dir = await tmp()
  await saveSettings(dir, { baseURL: 'http://a/v1', apiKey: 'sk-keep', model: 'm1' })
  await saveSettings(dir, { model: 'm2' })
  await saveSettings(dir, { apiKey: '   ', baseURL: '' })

  const s = await loadSettings(dir)
  assert.equal(s.apiKey, 'sk-keep', 'Key 不该被空串覆盖掉')
  assert.equal(s.baseURL, 'http://a/v1', '空串不该覆盖端点')
  assert.equal(s.model, 'm2')
})

test('settings: 文件不存在或内容损坏都返回空对象，不抛', async () => {
  const dir = await tmp()
  assert.deepEqual(await loadSettings(dir), {})
  assert.deepEqual(loadSettingsSync(dir), {})

  await writeFile(settingsPath(dir), '{ 这不是 json', 'utf8')
  assert.deepEqual(await loadSettings(dir), {})
  assert.deepEqual(loadSettingsSync(dir), {})
})

test('settings: 非字符串字段被忽略（手改坏了也不会把 undefined 传下去）', async () => {
  const dir = await tmp()
  await writeFile(
    settingsPath(dir),
    JSON.stringify({ baseURL: 'http://a/v1', apiKey: 123, model: { x: 1 } }),
    'utf8',
  )
  const s = await loadSettings(dir)
  assert.equal(s.baseURL, 'http://a/v1')
  assert.equal(s.apiKey, undefined)
  assert.equal(s.model, undefined)
})

test('settings: 文件带 BOM 也能读（手改/脚本写都会带）', async () => {
  const dir = await tmp()
  await writeFile(settingsPath(dir), '\uFEFF{"baseURL":"http://b/v1","model":"m-bom"}', 'utf8')
  const s = await loadSettings(dir)
  assert.equal(s.baseURL, 'http://b/v1')
  assert.equal(s.model, 'm-bom')
  assert.equal(loadSettingsSync(dir).model, 'm-bom')
})

test('settings: maskKey 只露头尾', () => {
  assert.equal(maskKey(''), '')
  assert.equal(maskKey('short'), '****')
  assert.equal(maskKey('sk-1234567890abcd'), 'sk-1…abcd')
  assert.ok(!maskKey('sk-1234567890abcd').includes('2345678'))
})

test('session: 删除会话会连 checkpoint 一起删，非法 id 直接拒', async () => {
  const dataDir = await tmp()
  const s = await Session.create(dataDir, { cwd: dataDir, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  await s.append({ kind: 'user/message', text: '要被删掉的会话' })
  const ckptDir = join(dataDir, 'ckpt', s.id, '1-01-c1', 'files')
  await mkdir(ckptDir, { recursive: true })
  await writeFile(join(ckptDir, '0001'), 'x', 'utf8')

  assert.ok(await exists(join(dataDir, 'sessions', s.id)))
  await Session.remove(dataDir, s.id)
  assert.equal(await exists(join(dataDir, 'sessions', s.id)), false)
  assert.equal(await exists(join(dataDir, 'ckpt', s.id)), false)

  // 删完列表里就没有了
  assert.equal((await Session.list(dataDir)).length, 0)

  // 路径穿越必须挡住
  await assert.rejects(() => Session.remove(dataDir, '../../etc'), /非法会话 id/)
  await assert.rejects(() => Session.remove(dataDir, 's-../x'), /非法会话 id/)

  // 删不存在的（合法 id）不该抛
  await Session.remove(dataDir, 's-abc123-zzzz')
})
