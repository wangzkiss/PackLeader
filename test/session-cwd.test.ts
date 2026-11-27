/**
 * 每个会话记住自己的工作目录：切会话时工具根跟着它走。
 * 没记过的（老会话）落到启动时的默认目录，并写进 meta.json 固定下来。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { startFakeLlm } from './fake-llm.ts'
import { Session } from '../src/core/session.ts'

const HOST = join(import.meta.dirname, '..', 'src', 'host.ts')

interface Line {
  type: string
  [k: string]: unknown
}

class HostProc {
  readonly child: ChildProcessWithoutNullStreams
  private buf = ''
  private queue: Line[] = []
  readonly seen: Line[] = []
  stderr = ''

  constructor(args: string[]) {
    this.child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOST, ...args], {
      // PL_PERF=off：测试起的 host 不要往用户真实的 perf 目录里写日志
      env: { ...process.env, NO_COLOR: '1', PL_PERF: 'off' },
      windowsHide: true,
    })
    this.child.stdout.on('data', (b: Buffer) => {
      this.buf += b.toString('utf8')
      let i: number
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        if (!line.trim()) continue
        const evt = JSON.parse(line) as Line
        this.seen.push(evt)
        this.queue.push(evt)
      }
    })
    this.child.stderr.on('data', (b: Buffer) => {
      this.stderr += b.toString('utf8')
    })
  }

  send(cmd: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(cmd)}\n`)
  }

  async next(type: string, timeoutMs = 20_000): Promise<Line> {
    const t0 = Date.now()
    for (;;) {
      const i = this.queue.findIndex((e) => e.type === type)
      if (i !== -1) return this.queue.splice(i, 1)[0]!
      if (this.stderr) throw new Error(`host 写了 stderr：${this.stderr}`)
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`等 ${type} 超时；已收到：${this.seen.map((e) => e.type).join(',')}`)
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  errors(): string[] {
    return this.seen.filter((e) => e.type === 'error').map((e) => String(e.message))
  }

  async close(): Promise<void> {
    this.child.stdin.end()
    await new Promise((r) => this.child.on('close', r))
  }
}

const readMeta = async (dataDir: string, id: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dataDir, 'sessions', id, 'meta.json'), 'utf8')) as Record<string, unknown>

test('会话记住工作目录：换过目录再切回来，还是那个目录', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'pl-cwd-a-'))
  const rootB = await mkdtemp(join(tmpdir(), 'pl-cwd-b-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-cwd-data-'))
  const llm = await startFakeLlm([{ text: '嗯' }])
  const host = new HostProc([
    '--cwd',
    rootA,
    '--data-dir',
    dataDir,
    '--base-url',
    llm.url,
    '--api-key',
    'sk-x',
    '--model',
    'demo-model',
  ])

  try {
    const readyA = await host.next('ready')
    const aId = String(readyA.session)
    assert.equal(String(readyA.cwd), rootA, '启动时用 --cwd 的目录')
    assert.equal(String((await readMeta(dataDir, aId)).cwd), rootA, '新会话把工作目录写进 meta.json')

    // 新会话 B 继承当前目录，再把它切到 rootB
    host.send({ cmd: 'new-session' })
    const bId = String((await host.next('ready')).session)
    assert.notEqual(bId, aId)
    host.send({ cmd: 'cwd', dir: rootB })
    assert.equal(String((await host.next('cwd')).cwd), rootB)
    assert.equal(String((await readMeta(dataDir, bId)).cwd), rootB, '切目录记在当前会话上')

    // 切回 A：目录回到 A 的
    host.send({ cmd: 'load-session', id: aId })
    const backA = await host.next('ready')
    assert.equal(String(backA.session), aId)
    assert.equal(String(backA.cwd), rootA, 'A 还记得自己的工作目录')

    // 再切 B：回到 B 的
    host.send({ cmd: 'load-session', id: bId })
    const backB = await host.next('ready')
    assert.equal(String(backB.cwd), rootB, 'B 记得它被切到的目录')
    assert.deepEqual(host.errors(), [])
  } finally {
    await host.close()
    await llm.close()
  }
})

test('老会话没记工作目录：落到启动目录并写回 meta.json', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'pl-cwd-old-a-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-cwd-old-data-'))
  // 造一个「老会话」：meta.json 里没有 cwd
  const s = await Session.create(dataDir, { cwd: rootA, model: 'm', baseURL: 'u', mode: 'guarded', version: '0' })
  const metaPath = join(dataDir, 'sessions', s.id, 'meta.json')
  const m = await readMeta(dataDir, s.id)
  delete m.cwd
  await writeFile(metaPath, `${JSON.stringify(m, null, 2)}\n`, 'utf8')

  const llm = await startFakeLlm([{ text: '嗯' }])
  const host = new HostProc([
    '--cwd',
    rootA,
    '--data-dir',
    dataDir,
    '--base-url',
    llm.url,
    '--api-key',
    'sk-x',
    '--model',
    'demo-model',
    '--resume',
    s.id,
  ])

  try {
    const ready = await host.next('ready')
    assert.equal(String(ready.session), s.id)
    assert.equal(String(ready.cwd), rootA, '老会话落到启动目录')
    assert.equal(String((await readMeta(dataDir, s.id)).cwd), rootA, '并写回 meta.json，下次打开就不用再猜')
  } finally {
    await host.close()
    await llm.close()
  }
})
