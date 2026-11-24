/**
 * 检查点：写之前的快照 + 轮次级撤销。
 *
 * 布局：
 *   <data>/ckpt/<session>/<turn>-<step>-<callId>/
 *       manifest.json
 *       files/0000 , files/0001 ...
 *
 * 撤销语义：回到「该轮开始」——同一轮内同一文件只保留最早那份快照。
 * 冲突检测：finalize 记录写后的 sha256；撤销时若当前内容已被外部改动，
 *           报冲突而不是静默覆盖。
 */

import { copyFile, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export interface CheckpointEntry {
  path: string
  existed: boolean
  beforeSha: string
  afterSha?: string
  bytes: number
  skipped: boolean
  snapshot?: string
}

export interface Manifest {
  turn: number
  step: number
  callId: string
  cwd: string
  at: number
  files: CheckpointEntry[]
}

export async function sha256File(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash('sha256').update(buf).digest('hex')
}

export class Checkpoints {
  readonly root: string
  readonly maxFileMB: number

  constructor(root: string, maxFileMB = 2) {
    this.root = root
    this.maxFileMB = maxFileMB
  }

  private dirOf(sessionId: string, m: { turn: number; step: number; callId: string }): string {
    return join(this.root, sessionId, `${m.turn}-${String(m.step).padStart(2, '0')}-${m.callId}`)
  }

  /** 在工具执行之前调用 */
  async snapshot(
    sessionId: string,
    meta: { turn: number; step: number; callId: string; cwd: string },
    paths: string[],
  ): Promise<Manifest> {
    const dir = this.dirOf(sessionId, meta)
    await mkdir(join(dir, 'files'), { recursive: true })
    const manifest: Manifest = { ...meta, at: Date.now(), files: [] }
    let n = 0
    for (const path of paths) {
      const entry: CheckpointEntry = { path, existed: false, beforeSha: '', bytes: 0, skipped: false }
      try {
        const st = await stat(path)
        if (!st.isFile()) {
          entry.skipped = true
        } else if (st.size > this.maxFileMB * 1024 * 1024) {
          entry.skipped = true
          entry.bytes = st.size
        } else {
          const dest = join(dir, 'files', String(n++).padStart(4, '0'))
          await copyFile(path, dest)
          entry.existed = true
          entry.bytes = st.size
          entry.beforeSha = await sha256File(dest)
          entry.snapshot = dest
        }
      } catch {
        entry.existed = false // 文件不存在 = 新建，撤销时删除即可
      }
      manifest.files.push(entry)
    }
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    return manifest
  }

  /** 工具执行之后调用：记录写后 sha，供冲突检测 */
  async finalize(sessionId: string, manifest: Manifest): Promise<void> {
    for (const f of manifest.files) {
      if (f.skipped && !f.existed) continue
      try {
        f.afterSha = await sha256File(f.path)
      } catch {
        f.afterSha = undefined // 执行后被删除
      }
    }
    await writeFile(join(this.dirOf(sessionId, manifest), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  async list(sessionId: string): Promise<Manifest[]> {
    const dir = join(this.root, sessionId)
    const names = await readdir(dir).catch(() => [] as string[])
    const out: Manifest[] = []
    for (const name of names) {
      try {
        out.push(JSON.parse(await readFile(join(dir, name, 'manifest.json'), 'utf8')) as Manifest)
      } catch {
        /* 忽略 */
      }
    }
    return out.sort((a, b) => a.turn - b.turn || a.step - b.step || a.callId.localeCompare(b.callId))
  }

  /** 撤销某一轮（缺省：最后一个有快照的轮） */
  async undo(
    sessionId: string,
    turn?: number,
    opts: { force?: boolean } = {},
  ): Promise<{ restored: string[]; removed: string[]; conflicts: string[]; skipped: string[] }> {
    const all = await this.list(sessionId)
    if (!all.length) return { restored: [], removed: [], conflicts: [], skipped: [] }
    const target = turn ?? Math.max(...all.map((m) => m.turn))
    const inTurn = all.filter((m) => m.turn === target)

    // 同一路径只保留最早那份（= 轮次开始时的内容）；同时记住这一轮**最后**一次写后的哈希，
    // 否则一轮里连续改两次会被误判成「被外部改动」。
    const earliest = new Map<string, CheckpointEntry>()
    const latestAfter = new Map<string, string>()
    for (const m of inTurn) {
      for (const f of m.files) {
        if (!earliest.has(f.path)) earliest.set(f.path, f)
        if (f.afterSha) latestAfter.set(f.path, f.afterSha)
      }
    }

    const restored: string[] = []
    const removed: string[] = []
    const conflicts: string[] = []
    const skipped: string[] = []

    for (const [path, entry] of earliest) {
      if (entry.skipped) {
        skipped.push(path)
        continue
      }
      if (/[\\/]node_modules[\\/]/.test(path)) {
        skipped.push(path)
        continue
      }
      const expectAfter = latestAfter.get(path) ?? entry.afterSha
      if (!opts.force && expectAfter) {
        const current = await sha256File(path).catch(() => '')
        // 当前内容既不是「最后一次写完的状态」，也不是原本状态 → 真的被人改过
        if (current && current !== expectAfter && current !== entry.beforeSha) {
          conflicts.push(path)
          continue
        }
      }
      if (entry.existed && entry.snapshot) {
        await mkdir(join(path, '..'), { recursive: true })
        await copyFile(entry.snapshot, path)
        restored.push(path)
      } else {
        await unlink(path).catch(() => undefined)
        removed.push(path)
      }
    }

    // 还有冲突时保留快照，允许用户确认后用 --force 重试
    if (!conflicts.length) {
      for (const m of inTurn) await rm(this.dirOf(sessionId, m), { recursive: true, force: true })
    }
    return { restored, removed, conflicts, skipped }
  }
}
