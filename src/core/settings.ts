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

export interface Settings {
  baseURL?: string
  apiKey?: string
  model?: string
  /** 验证命令：留空＝自动识别（npm test / cargo test / go test / pytest） */
  verify?: string
}

export const settingsPath = (dataDir: string): string => join(dataDir, 'config.json')

function coerce(raw: unknown): Settings {
  const out: Settings = {}
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  for (const k of ['baseURL', 'apiKey', 'model', 'verify'] as const) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) out[k] = v.trim()
  }
  return out
}

/** 手改过的 JSON 常常带 BOM，剥掉再解析 */
const stripBom = (s: string): string => s.replace(/^\uFEFF/, '')

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
  if (patch.baseURL?.trim()) merged.baseURL = patch.baseURL.trim()
  if (patch.apiKey?.trim()) merged.apiKey = patch.apiKey.trim()
  if (patch.model?.trim()) merged.model = patch.model.trim()
  // verify 是唯一「空串也有意义」的字段：空串＝回到自动识别，所以得真删掉
  if (patch.verify !== undefined) {
    if (patch.verify.trim()) merged.verify = patch.verify.trim()
    else delete merged.verify
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
