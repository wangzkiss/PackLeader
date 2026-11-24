import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Checkpoints } from '../src/core/checkpoint.ts'

test('checkpoint: 快照 → 改动 → 撤销回到轮次开始', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-ckpt-'))
  const file = join(root, 'a.txt')
  await writeFile(file, 'v1', 'utf8')
  const ck = new Checkpoints(join(root, '.ckpt'))

  const m = await ck.snapshot('s-1', { turn: 1, step: 1, callId: 'c1', cwd: root }, [file])
  await writeFile(file, 'v2', 'utf8')
  await ck.finalize('s-1', m)

  const r = await ck.undo('s-1', 1)
  assert.deepEqual(r.restored, [file])
  assert.equal(await readFile(file, 'utf8'), 'v1')
})

test('checkpoint: 该轮新建的文件，撤销时删除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-ckpt-'))
  const fresh = join(root, 'new.txt')
  const ck = new Checkpoints(join(root, '.ckpt'))

  const m = await ck.snapshot('s-2', { turn: 2, step: 1, callId: 'c2', cwd: root }, [fresh])
  await writeFile(fresh, 'created', 'utf8')
  await ck.finalize('s-2', m)

  const r = await ck.undo('s-2', 2)
  assert.deepEqual(r.removed, [fresh])
  await assert.rejects(() => readFile(fresh, 'utf8'), /ENOENT/)
})

test('checkpoint: 外部改动过的文件报冲突，--force 才覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-ckpt-'))
  const file = join(root, 'b.txt')
  await writeFile(file, 'orig', 'utf8')
  const ck = new Checkpoints(join(root, '.ckpt'))

  const m = await ck.snapshot('s-3', { turn: 1, step: 1, callId: 'c3', cwd: root }, [file])
  await writeFile(file, 'agent', 'utf8')
  await ck.finalize('s-3', m)
  await writeFile(file, 'human-edited', 'utf8')

  const refused = await ck.undo('s-3', 1)
  assert.deepEqual(refused.conflicts, [file])
  assert.equal(await readFile(file, 'utf8'), 'human-edited')

  const forced = await ck.undo('s-3', 1, { force: true })
  assert.deepEqual(forced.restored, [file])
  assert.equal(await readFile(file, 'utf8'), 'orig')
})

test('checkpoint: 同一轮连续改两次不算外部改动（假冲突回归）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-ckpt-'))
  const file = join(root, 'c.txt')
  await writeFile(file, 'v0', 'utf8')
  const ck = new Checkpoints(join(root, '.ckpt'))

  const m1 = await ck.snapshot('s-5', { turn: 1, step: 1, callId: 'c1', cwd: root }, [file])
  await writeFile(file, 'v1', 'utf8')
  await ck.finalize('s-5', m1)

  const m2 = await ck.snapshot('s-5', { turn: 1, step: 2, callId: 'c2', cwd: root }, [file])
  await writeFile(file, 'v2', 'utf8')
  await ck.finalize('s-5', m2)

  const r = await ck.undo('s-5', 1)
  assert.deepEqual(r.conflicts, [])
  assert.deepEqual(r.restored, [file])
  assert.equal(await readFile(file, 'utf8'), 'v0')
})

test('checkpoint: 超大文件被跳过而不是拖垮撤销', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-ckpt-'))
  const big = join(root, 'big.bin')
  await writeFile(big, 'x'.repeat(4096), 'utf8')
  const ck = new Checkpoints(join(root, '.ckpt'), 0.001) // 1 KB 上限

  const m = await ck.snapshot('s-4', { turn: 1, step: 1, callId: 'c4', cwd: root }, [big])
  assert.equal(m.files[0]!.skipped, true)
  const r = await ck.undo('s-4', 1)
  assert.deepEqual(r.skipped, [big])
})
