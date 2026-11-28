/**
 * 记忆：按工作目录分文件长期保存的「事实」。
 *
 * 布局：<数据目录>/memory/<cwd 指纹>.jsonl
 * 一行一条 { id, text, at, cwd }。撤销就是删掉对应行再重写整个文件。
 *
 * 为什么按 cwd 分：记忆几乎都跟某个仓库有关（构建命令、目录约定、踩过的坑），
 * 混在一个文件里既读不完也容易串味；cwd 变了就换文件。
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export interface MemoryItem {
  id: string
  text: string
  at: number
  cwd: string
}

/** 同一个目录写法不同（大小写、斜杠方向）要映射到同一个文件 */
export function memoryKey(cwd: string): string {
  const norm = resolve(cwd).replace(/\\/g, '/').toLowerCase()
  return createHash('sha1').update(norm).digest('hex').slice(0, 12)
}

export class MemoryStore {
  readonly cwd: string
  readonly file: string
  /** 同一实例的读写串行化：撤销是重写文件，和追加撞上就会丢行 */
  private lock: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string, cwd: string) {
    this.cwd = resolve(cwd)
    this.file = join(dataDir, 'memory', `${memoryKey(cwd)}.jsonl`)
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn)
    this.lock = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async all(): Promise<MemoryItem[]> {
    let text = ''
    try {
      text = await readFile(this.file, 'utf8')
    } catch {
      return []
    }
    const out: MemoryItem[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const v = JSON.parse(line) as MemoryItem
        if (v && typeof v.id === 'string' && typeof v.text === 'string') out.push(v)
      } catch {
        // 半个行（写到一半崩了）：跳过，不阻断
      }
    }
    return out
  }

  async add(text: string): Promise<MemoryItem> {
    return this.withLock(async () => {
      const item: MemoryItem = {
        id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        text: text.trim(),
        at: Date.now(),
        cwd: this.cwd,
      }
      await mkdir(dirname(this.file), { recursive: true })
      await appendFile(this.file, `${JSON.stringify(item)}\n`, 'utf8')
      return item
    })
  }

  /** 撤销：返回真正删掉的 id（不存在的 id 静默忽略） */
  async remove(ids: string[]): Promise<string[]> {
    const drop = new Set(ids)
    if (!drop.size) return []
    return this.withLock(async () => {
      const items = await this.all()
      const kept = items.filter((i) => !drop.has(i.id))
      const removed = items.filter((i) => drop.has(i.id)).map((i) => i.id)
      if (!removed.length) return []
      const body = kept.map((i) => JSON.stringify(i)).join('\n')
      await writeFile(this.file, kept.length ? `${body}\n` : '', 'utf8')
      return removed
    })
  }
}
