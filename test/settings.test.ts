import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Session } from '../src/core/session.ts'
import { DEFAULT_VISION, activeProviderOf, llmTimeoutsOf, loadSettings, loadSettingsSync, maskKey, providersOf, saveSettings, settingsPath, TIMEOUT_RANGES, visionFrom } from '../src/core/settings.ts'

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
  // 保存时会顺手把单端点折成一家供应商（providers 里一项，activeProvider 指向它），
  // 这样 config.json 从第一次保存起就是自描述的新形态，老字段依然同步着当前生效值。
  assert.equal(saved.baseURL, 'http://127.0.0.1:19790/v1')
  assert.equal(saved.apiKey, 'sk-test-1234')
  assert.equal(saved.model, 'deepseek-flash')
  assert.equal(saved.providers?.length, 1)
  assert.equal(saved.providers?.[0]?.baseURL, 'http://127.0.0.1:19790/v1')
  assert.equal(saved.activeProvider, saved.providers?.[0]?.id)

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

test('settings: 看图默认开（没写过这个字段时），显式 false 也要能存下来', async () => {
  const dir = await tmp()
  // 从没配置过：读出来没有 vision 字段，但按默认算开
  assert.equal(visionFrom(await loadSettings(dir)), true)
  assert.equal(visionFrom(loadSettingsSync(dir)), true)
  assert.equal(DEFAULT_VISION, true)

  // 用户取消勾选：必须真的把 false 写进文件，否则下次启动又被默认开回来
  const saved = await saveSettings(dir, { vision: false })
  assert.equal(saved.vision, false)
  const raw = JSON.parse(await readFile(settingsPath(dir), 'utf8')) as Record<string, unknown>
  assert.equal(raw.vision, false, 'false 要落盘，不能被当成"没设置过"删掉')
  assert.equal(visionFrom(await loadSettings(dir)), false)

  // 再勾回来
  await saveSettings(dir, { vision: true })
  assert.equal(visionFrom(await loadSettings(dir)), true)
})

test('settings: 手写成 "vision": false 也能读出来（别被 coerce 丢掉）', async () => {
  const dir = await tmp()
  await writeFile(settingsPath(dir), JSON.stringify({ baseURL: 'http://a/v1', vision: false }), 'utf8')
  const s = await loadSettings(dir)
  assert.equal(s.vision, false)
  assert.equal(visionFrom(s), false)
})

test('settings: 多个供应商各存各的 Key，切换只换当前项不动别人的', async () => {
  const dir = await tmp()
  await saveSettings(dir, {
    providers: [
      { id: 'a', name: '公司网关', baseURL: 'https://gw.example/v1', apiKey: 'sk-aaa', model: 'gpt-4o' },
      { id: 'b', name: '本地', baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'sk-bbb', model: 'qwen' },
    ],
    activeProvider: 'b',
    vision: true,
  })
  let s = await loadSettings(dir)
  assert.equal(s.providers?.length, 2)
  assert.equal(s.activeProvider, 'b')
  // 顶层快照跟着当前项走：旧版本/手写配置只认这三个字段
  assert.equal(s.baseURL, 'http://127.0.0.1:11434/v1')
  assert.equal(s.apiKey, 'sk-bbb')
  assert.equal(s.model, 'qwen')

  // 切回第一家：两家的 Key 都还在，没有被覆盖
  await saveSettings(dir, { activeProvider: 'a' })
  s = await loadSettings(dir)
  assert.equal(s.activeProvider, 'a')
  assert.equal(s.apiKey, 'sk-aaa')
  assert.equal(s.providers?.find((p) => p.id === 'b')?.apiKey, 'sk-bbb')

  // 删掉一家：整份替换语义，文件里就真没了
  await saveSettings(dir, { providers: [s.providers!.find((p) => p.id === 'b')!] })
  s = await loadSettings(dir)
  assert.equal(s.providers?.length, 1)
  assert.equal(s.providers?.[0]?.id, 'b')
  assert.equal(s.activeProvider, 'b', '当前项被删了要回落到列表里存在的那个')
})

test('settings: 旧版单端点配置会被折成一家供应商（升级不用重填 Key）', async () => {
  const dir = await tmp()
  await writeFile(
    settingsPath(dir),
    JSON.stringify({ baseURL: 'http://old/v1', apiKey: 'sk-old', model: 'm-old' }),
    'utf8',
  )
  const s = await loadSettings(dir)
  const { list, active } = providersOf(s)
  assert.equal(list.length, 1)
  assert.equal(active, list[0]!.id)
  assert.equal(list[0]!.baseURL, 'http://old/v1')
  assert.equal(list[0]!.apiKey, 'sk-old')
  assert.deepEqual(activeProviderOf(s), list[0])

  // 一家都没配：没有当前供应商，调用方自己兜默认端点
  const empty = await tmp()
  assert.equal(activeProviderOf(await loadSettings(empty)), undefined)
})

test('settings: 供应商列表里有坏项（没端点/重复 id）时不带病保存', async () => {
  const dir = await tmp()
  const saved = await saveSettings(dir, {
    providers: [
      { id: 'x', name: '好的', baseURL: ' http://ok/v1 ', apiKey: ' sk-x ' },
      { id: 'x', name: '重复 id', baseURL: 'http://dup/v1', apiKey: 'sk-dup' },
      { id: 'y', name: '', baseURL: '   ', apiKey: 'sk-none' },
    ] as never,
    activeProvider: 'x',
  })
  assert.equal(saved.providers?.length, 1, '空端点的项丢掉，重复 id 只留第一个')
  assert.equal(saved.providers?.[0]?.baseURL, 'http://ok/v1')
  assert.equal(saved.providers?.[0]?.apiKey, 'sk-x')
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

test('settings: 超时字段能存能读，没写的就不出现在设置里（交给客户端默认值）', async () => {
  const dir = await tmp()
  // 手改 config.json：只写了首字节和空闲两个
  await writeFile(settingsPath(dir), JSON.stringify({ firstByteSecs: 240, idleSecs: 120 }), 'utf8')
  const s = await loadSettings(dir)
  assert.equal(s.firstByteSecs, 240)
  assert.equal(s.idleSecs, 120)
  assert.equal(s.requestSecs, undefined)
  assert.deepEqual(llmTimeoutsOf(s), { firstByteMs: 240_000, idleMs: 120_000 })

  // 界面/脚本再存一项：不能把已有的两项洗掉
  await saveSettings(dir, { requestSecs: 1200 })
  const back = await loadSettings(dir)
  assert.equal(back.requestSecs, 1200)
  assert.equal(back.firstByteSecs, 240)
  assert.equal(back.idleSecs, 120)
  assert.deepEqual(llmTimeoutsOf(back), { firstByteMs: 240_000, idleMs: 120_000, timeoutMs: 1_200_000 })
})

test('settings: 超时数值写坏了被裁到合法范围，不会变成 0 秒或几十小时', async () => {
  const dir = await tmp()
  await writeFile(
    settingsPath(dir),
    JSON.stringify({ firstByteSecs: 0, idleSecs: 999_999, requestSecs: '600' }),
    'utf8',
  )
  const s = await loadSettings(dir)
  assert.equal(s.firstByteSecs, TIMEOUT_RANGES.firstByteSecs[0], '太小抬到下限')
  assert.equal(s.idleSecs, TIMEOUT_RANGES.idleSecs[1], '太大压到上限')
  assert.equal(s.requestSecs, undefined, '字符串不认（当没写过）')

  // 非数字（手改成 null / 布尔）一律忽略，不能给客户端传个 NaN 上去
  await writeFile(settingsPath(dir), JSON.stringify({ firstByteSecs: null, idleSecs: true }), 'utf8')
  assert.deepEqual(llmTimeoutsOf(await loadSettings(dir)), {})
})

test('settings: 从没配过超时：llmTimeoutsOf 返回空对象，客户端用内置默认', async () => {
  const dir = await tmp()
  assert.deepEqual(llmTimeoutsOf(await loadSettings(dir)), {})
})

test('settings: 权限档存进 config.json，下次启动接着用；写坏的档当没写过', async () => {
  const dir = await tmp()
  await saveSettings(dir, { mode: 'full' })
  assert.equal((await loadSettings(dir)).mode, 'full', '界面切过的档要留住')

  // 手改成不存在的档：当没写过，不能让策略落进一个没有分支的状态
  await writeFile(settingsPath(dir), JSON.stringify({ mode: 'banana' }), 'utf8')
  assert.equal((await loadSettings(dir)).mode, undefined)

  // 再存一项：不能把档位洗掉，也不能把已有字段带跑
  await saveSettings(dir, { mode: 'read-only', model: 'm1' })
  const back = await loadSettings(dir)
  assert.equal(back.mode, 'read-only')
  assert.equal(back.model, 'm1')
})
