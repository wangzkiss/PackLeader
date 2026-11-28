/**
 * 设置：模型端点 / API Key / 模型名。
 *
 * 落在 `<data>/config.json` —— 数据目录本来就是"这个人的 PackLeader 数据"的家，
 * 会话、审计、checkpoint 都在里面，配置没必要再找一个地方。
 *
 * 优先级（高 → 低）：命令行参数 > 环境变量 > 这个文件 > 内置默认值。
 * 见 cli.ts resolveConfig：这样 CI 里用 env 覆盖，桌面上用界面写入，两边不打架。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Mode } from './types.ts'

/** 三档权限；config.json 里写坏了就当没写 */
export const MODES = ['read-only', 'guarded', 'full'] as const

/**
 * 性能日志三档：
 *   off   全关，一条不写（自己排查兼容性时用）
 *   basic 只记启动分段、卡顿、交互响应与轮次汇总（缺省，一天几 MB 以内）
 *   full  再加逐 tick 明细与每 5s 的资源采样（查内存泄漏/CPU 尖峰时开）
 */
export const PERF_MODES = ['off', 'basic', 'full'] as const
export type PerfMode = (typeof PERF_MODES)[number]

/**
 * 一个供应商（OpenAI 兼容的一家服务）：端点 + Key + 默认模型。
 *
 * 为什么要一份列表：同一个人手上常常有好几个端点（公司网关、本地 Ollama、
 * 官方 API），来回改一个 baseURL 就得重填 Key，还容易把上一个 Key 弄丢。
 * 列表里每项自带 Key，切换只是换「当前用哪个」，互不覆盖。
 * 名字是给人认的（界面上点它），只作标识不当主键——允许重名，靠 id 区分。
 */
export interface Provider {
  /** 稳定标识：界面选中项靠它，改名字也不会丢选中 */
  id: string
  /** 显示名（空＝用端点兜底显示） */
  name: string
  baseURL: string
  apiKey: string
  model: string
  /**
   * 这家能用的模型名。对话框底部的模型菜单按它分组列出来；没拉取过就是空，
   * 由 modelsOf 用当前 model 兜底（老 config.json 没有这个字段也能用）。
   */
  models?: string[]
}

export interface Settings {
  /** 供应商列表；旧版本只有一个 baseURL/apiKey，读到时会在 providersOf 里折成一项 */
  providers?: Provider[]
  /** 当前用哪个供应商（存 id）；找不到就回落到列表第一项 */
  activeProvider?: string
  /**
   * 以下三个是「当前生效值」的快照，保留是为了两件事：
   * 1) 兼容只认识 baseURL/apiKey/model 的旧版本与手写 config.json；
   * 2) 环境变量/命令行覆盖时，界面仍要知道原本存的是什么。
   * 由 saveSettings 在写入时同步成当前供应商的值，不要让它们跟列表不一致。
   */
  baseURL?: string
  apiKey?: string
  model?: string
  /**
   * 权限档：界面上切过一次就记下来，下次启动接着用。
   * 不记的话每次开程序都退回 guarded——用户以为「完全权限」已经给过了，
   * 实际每一步写/执行仍在弹审批。
   */
  mode?: Mode
  /** 验证命令：留空＝自动识别（npm test / cargo test / go test / pytest） */
  verify?: string
  /** 模型能不能看图；开了才把图片作为 image part 发过去。缺省＝开（见 DEFAULT_VISION） */
  vision?: boolean
  /** 性能日志：见 PERF_MODES；缺省＝basic */
  perf?: PerfMode
  /**
   * 首字节超时（秒）：请求发出去多久还没等到第一个字节就算失败。
   * 长上下文（几十次工具调用之后）服务端 prefill 很慢，30 秒那种默认值会把正常请求判死，
   * 所以缺省给到 120 秒；真遇到更慢的网关就在 config.json 里写大一点。
   */
  firstByteSecs?: number
  /** 流空闲超时（秒）：两个数据块之间最多等多久，缺省 180 */
  idleSecs?: number
  /** 单次请求整体上限（秒），缺省 900 */
  requestSecs?: number
}

/** 超时类字段的取值范围（秒）：手改坏了也不会把客户端设成 0 秒或者 100 小时 */
export const TIMEOUT_RANGES = {
  firstByteSecs: [5, 3600],
  idleSecs: [5, 3600],
  requestSecs: [30, 7200],
} as const

/**
 * 看图默认开。
 *
 * 理由：现在在用的模型基本都支持视觉，而默认关掉的话，用户拖一张截图进来，
 * 模型只看到"文件名 + 大小"，答非所问还看不出为什么——这个坑比多传几 KB 图片贵得多。
 * 真遇到不支持视觉的模型（或想省 token），在设置里取消勾选即可，那个 false 会存进 config.json。
 */
export const DEFAULT_VISION = true

/** 读设置里的视觉开关：没写过这个字段就按默认算，别把 undefined 传下去 */
export const visionFrom = (s: Settings): boolean => (typeof s.vision === 'boolean' ? s.vision : DEFAULT_VISION)

export const settingsPath = (dataDir: string): string => join(dataDir, 'config.json')

/** 把设置里的秒折算成客户端的毫秒超时；没配的字段不出现，交给客户端自己的默认值 */
export function llmTimeoutsOf(s: Settings): { firstByteMs?: number; idleMs?: number; timeoutMs?: number } {
  const out: { firstByteMs?: number; idleMs?: number; timeoutMs?: number } = {}
  if (typeof s.firstByteSecs === 'number') out.firstByteMs = s.firstByteSecs * 1000
  if (typeof s.idleSecs === 'number') out.idleMs = s.idleSecs * 1000
  if (typeof s.requestSecs === 'number') out.timeoutMs = s.requestSecs * 1000
  return out
}

function coerce(raw: unknown): Settings {
  const out: Settings = {}
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  for (const k of ['baseURL', 'apiKey', 'model', 'verify'] as const) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) out[k] = v.trim()
  }
  if (Array.isArray(obj.providers)) {
    const list: Provider[] = []
    for (const raw of obj.providers) {
      const p = coerceProvider(raw)
      // 同 id 重复（手改出来的）只留第一个，否则界面上点哪一行都不确定
      if (p && !list.some((x) => x.id === p.id)) list.push(p)
    }
    if (list.length) out.providers = list
  }
  if (typeof obj.activeProvider === 'string' && obj.activeProvider.trim()) out.activeProvider = obj.activeProvider.trim()
  if (typeof obj.vision === 'boolean') out.vision = obj.vision
  if (typeof obj.perf === 'string' && (PERF_MODES as readonly string[]).includes(obj.perf)) {
    out.perf = obj.perf as PerfMode
  }
  if (typeof obj.mode === 'string' && (MODES as readonly string[]).includes(obj.mode)) {
    out.mode = obj.mode as Mode
  }
  for (const k of ['firstByteSecs', 'idleSecs', 'requestSecs'] as const) {
    const v = obj[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const [lo, hi] = TIMEOUT_RANGES[k]
    out[k] = Math.min(hi, Math.max(lo, Math.round(v)))
  }
  return out
}

/** 手改过的 JSON 常常带 BOM，剥掉再解析 */
const stripBom = (s: string): string => s.replace(/^\uFEFF/, '')

/** 单条供应商的净化：缺端点的直接丢掉（用不了还不如没有） */
function coerceProvider(raw: unknown): Provider | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const str = (k: string): string => (typeof obj[k] === 'string' ? (obj[k] as string).trim() : '')
  const baseURL = str('baseURL')
  if (!baseURL) return undefined
  const id = str('id') || `p-${Math.random().toString(36).slice(2, 10)}`
  const p: Provider = { id, name: str('name'), baseURL, apiKey: str('apiKey'), model: str('model') }
  const models = cleanModels(obj.models)
  if (models) {
    // 当前 model 必须在这家的列表里：菜单上要靠它打勾
    if (p.model && !models.includes(p.model)) models.unshift(p.model)
    p.models = models
  }
  return p
}

/**
 * 把设置折成「一份供应商列表 + 当前选中项」。
 *
 * 旧版 config.json 只有顶层 baseURL/apiKey/model，这里就把它当成唯一的一家供应商：
 * 用户不需要为了升级重填一遍 Key，切到列表形态也不会丢配置。
 * 顶层那三个字段是「当前生效值」的快照，读的时候反过来补进当前这家供应商——
 * 手改成 `{providers:[{...}], baseURL:"..."}` 这种混搭也能自洽。
 */
export function providersOf(s: Settings): { list: Provider[]; active: string } {
  const list: Provider[] = (s.providers ?? []).map((p) => ({ ...p }))
  if (!list.length) {
    if (!s.baseURL) return { list: [], active: '' }
    list.push({ id: 'p-default', name: '', baseURL: s.baseURL, apiKey: s.apiKey ?? '', model: s.model ?? '' })
    return { list, active: list[0]!.id }
  }
  const active = list.some((p) => p.id === s.activeProvider) ? s.activeProvider! : list[0]!.id
  // 顶层快照（baseURL/apiKey/model）只回填给「端点对得上的那一家」：
  // 单独的 /model、改 Key 这类只写顶层字段的调用，据此落到它该落的那家身上。
  // 反过来，切 activeProvider 时顶层快照属于旧的那家，绝不能拿去覆盖新选中的这家。
  const snap = s.baseURL ? list.find((p) => p.baseURL === s.baseURL) : undefined
  if (snap) {
    if (s.apiKey) snap.apiKey = s.apiKey
    if (s.model) snap.model = s.model
  }
  return { list, active }
}

/** 当前生效的供应商；一个都没配时返回 undefined（调用方自己兜默认端点） */
export function activeProviderOf(s: Settings): Provider | undefined {
  const { list, active } = providersOf(s)
  return list.find((p) => p.id === active) ?? list[0]
}

/** 模型名清洗：去空、去重（保序）、上限 200 条；一条都没有就当没写 */
function cleanModels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const x of raw) {
    if (typeof x !== 'string') continue
    const m = x.trim()
    if (!m || out.includes(m)) continue
    out.push(m)
    if (out.length >= 200) break
  }
  return out.length ? out : undefined
}

/**
 * 一家供应商可供选择的模型：缓存过的列表优先，没缓存就用当前 model 兜底。
 *
 * 界面底部的模型菜单按这个分组画；返回的列表里一定包含当前正在用的那个模型，
 * 否则菜单上「打勾的那一项」会找不到自己在哪一行。
 */
export function modelsOf(p: Provider): string[] {
  const list = cleanModels(p.models) ?? []
  const cur = p.model?.trim() ?? ''
  if (cur && !list.includes(cur)) list.unshift(cur)
  return list
}

/** 界面上的显示名：没起名字就用端点 */
export function providerLabel(p: Provider): string {
  return p.name || p.baseURL
}

/**
 * 保存前的清洗：去空白、丢掉没端点的项、补 id、去重。
 * 放在这里而不是界面里，是因为手写 config.json 也有可能踩到这些，读取路径要同样干净。
 */
export function normalizeProviders(list: Provider[]): Provider[] {
  const out: Provider[] = []
  for (const raw of list) {
    const baseURL = raw.baseURL?.trim() ?? ''
    if (!baseURL) continue
    const id = raw.id?.trim() || `p-${Math.random().toString(36).slice(2, 10)}`
    if (out.some((p) => p.id === id)) continue
    const p: Provider = {
      id,
      name: raw.name?.trim() ?? '',
      baseURL,
      apiKey: raw.apiKey?.trim() ?? '',
      model: raw.model?.trim() ?? '',
    }
    const models = cleanModels(raw.models)
    if (models) {
      if (p.model && !models.includes(p.model)) models.unshift(p.model)
      p.models = models
    }
    out.push(p)
  }
  return out
}

export async function loadSettings(dataDir: string): Promise<Settings> {
  try {
    return coerce(JSON.parse(stripBom(await readFile(settingsPath(dataDir), 'utf8'))))
  } catch {
    return {}
  }
}

/** 同步版：resolveConfig 在 CLI 启动路径上是同步的，不想为了读一个小 JSON 引入 async */
export function loadSettingsSync(dataDir: string): Settings {
  try {
    return coerce(JSON.parse(stripBom(readFileSync(settingsPath(dataDir), 'utf8'))))
  } catch {
    return {}
  }
}

/** 合并写入：只覆盖传进来的字段，空字符串视为"不动那个字段"（界面上留空＝保持原值） */
export async function saveSettings(dataDir: string, patch: Settings): Promise<Settings> {
  const merged: Settings = { ...(await loadSettings(dataDir)) }
  // 供应商列表是"整份替换"的语义：界面里删掉一家就得真删掉，
  // 逐项合并做不到「删除」，也会让 id 复用时的覆盖关系变得说不清。
  if (patch.providers !== undefined) merged.providers = normalizeProviders(patch.providers)
  if (patch.baseURL?.trim()) merged.baseURL = patch.baseURL.trim()
  if (patch.apiKey?.trim()) merged.apiKey = patch.apiKey.trim()
  if (patch.model?.trim()) merged.model = patch.model.trim()
  // 权限档：只接三档合法值，手改坏了不能把策略带进一个没有分支的状态
  if (patch.mode !== undefined && (MODES as readonly string[]).includes(patch.mode)) merged.mode = patch.mode
  // verify 是唯一「空串也有意义」的字段：空串＝回到自动识别，所以得真删掉
  if (patch.vision !== undefined) {
    // 默认值是 true，所以 false 必须明确写进文件——删掉字段会被当成"没设置过"，
    // 下次启动又按默认开回来，用户就永远关不掉了
    merged.vision = patch.vision
  }
  if (patch.verify !== undefined) {
    if (patch.verify.trim()) merged.verify = patch.verify.trim()
    else delete merged.verify
  }
  // 性能日志开关：三档，写坏了就当没写（不能因为一个手改错的字段把采集带进未知状态）
  if (patch.perf !== undefined && (PERF_MODES as readonly string[]).includes(patch.perf)) merged.perf = patch.perf
  // 超时是纯数字配置：界面上暂不暴露，但手写 config.json / 以后加输入框都能走这条路
  for (const k of ['firstByteSecs', 'idleSecs', 'requestSecs'] as const) {
    const v = patch[k]
    if (typeof v === 'number' && Number.isFinite(v)) merged[k] = v
  }
  // 当前供应商：只接列表里存在的 id（界面传错了不至于让下次启动没供应商可用）
  if (patch.activeProvider !== undefined) {
    const { list } = providersOf(merged)
    const want = patch.activeProvider.trim()
    if (want && list.some((p) => p.id === want)) merged.activeProvider = want
    else if (!want) delete merged.activeProvider
  }
  // 收口：顶层快照（baseURL/apiKey/model）与当前供应商必须一致。
  // 旧版本、手写 config.json 和 CLI 只认这三个字段，列表改了却不更新它们，
  // 就会出现「界面显示 A、实际请求打 B」的鬼故事；反过来 /model 这种单字段
  // 改动也会经 providersOf 落回当前供应商身上。
  {
    const { list, active } = providersOf(merged)
    if (list.length) {
      const cur = list.find((p) => p.id === active) ?? list[0]!
      merged.providers = list
      merged.activeProvider = cur.id
      merged.baseURL = cur.baseURL
      if (cur.apiKey) merged.apiKey = cur.apiKey
      else delete merged.apiKey
      if (cur.model) merged.model = cur.model
      else delete merged.model
    }
  }
  await mkdir(dataDir, { recursive: true })
  await writeFile(settingsPath(dataDir), `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return merged
}

/** 给界面看的"已设置过"提示：只露头尾，不要把 key 整个吐到屏幕上 */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}
