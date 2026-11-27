import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startFakeLlm } from './fake-llm.ts'

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')

function runCli(
  args: string[],
  env: Record<string, string> = {},
  stdinText?: string,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
      // PL_PERF=off：测试起的 cli 不要往用户真实的 perf 目录里写日志
      env: { ...process.env, NO_COLOR: '1', PL_PERF: 'off', ...env },
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => (out += b.toString('utf8')))
    child.stderr.on('data', (b) => (err += b.toString('utf8')))
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }))
    if (stdinText !== undefined) child.stdin.write(stdinText)
    child.stdin.end()
  })
}

test('cli: --json --yes 跑完一轮，输出 NDJSON 事件并落盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-cli-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-cli-data-'))
  const llm = await startFakeLlm([
    { toolCalls: [{ name: 'write', args: { path: 'out.txt', content: 'from cli' } }] },
    { text: '写好了' },
  ])
  try {
    const r = await runCli(
      ['--json', '--yes', '--cwd', root, '--data-dir', dataDir, '--base-url', llm.url, '--api-key', 'sk-test', '把 from cli 写到 out.txt'],
      {},
    )
    assert.equal(r.code, 0, r.err)
    const events = r.out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string })
    assert.ok(events.some((e) => e.kind === 'tool/result'))
    assert.ok(events.some((e) => e.kind === 'assistant/message'))
    assert.equal(await readFile(join(root, 'out.txt'), 'utf8'), 'from cli')
  } finally {
    await llm.close()
  }
})

test('cli: 没有 API Key 时退出码 2 并给出提示', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-cli-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-cli-data-'))
  const r = await runCli(['--cwd', root, '--data-dir', dataDir, 'hi'], {
    PL_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    OPENAI_API_KEY: '',
  })
  assert.equal(r.code, 2)
  assert.match(r.err, /缺少 API Key/)
})

test('cli: --repl 可被管道驱动（多命令按序执行，EOF 正常退出）', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-cli-data-'))
  const r = await runCli(
    ['--repl', '--cwd', dataDir, '--data-dir', dataDir, '--api-key', 'sk-x', '--base-url', 'http://127.0.0.1:1/v1'],
    {},
    '/help\n/sessions\n',
  )
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /\/exit/)
  // 启动时就建了会话，但没发过消息的空壳会话不算一条对话，所以列表是空的
  assert.match(r.out, /还没有任何会话/)
  assert.doesNotMatch(r.out, /s-\S+\s+0 轮/)
  assert.match(r.out, /输入结束，退出/)
})

test('cli: 机器上有 OPENAI_API_KEY 时仍用 config.json 里的 Key（别拿别家的 Key 打这里配的端点）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-cli-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-cli-data-'))
  const llm = await startFakeLlm([{ text: '好' }])
  await writeFile(
    join(dataDir, 'config.json'),
    JSON.stringify({
      providers: [{ id: 'p-cfg', name: '配置里那家', baseURL: llm.url, apiKey: 'sk-cfg-key-1234', model: 'm-cfg' }],
      activeProvider: 'p-cfg',
    }),
    'utf8',
  )
  try {
    const r = await runCli(['--yes', '--cwd', root, '--data-dir', dataDir, '打个招呼'], {
      PL_API_KEY: '',
      DEEPSEEK_API_KEY: '',
      OPENAI_API_KEY: 'sk-openai-env-9999',
    })
    assert.equal(r.code, 0, r.err)
    assert.equal(llm.headers[0]?.authorization, 'Bearer sk-cfg-key-1234')
    assert.equal((llm.requests[0] as Record<string, unknown>).model, 'm-cfg')
  } finally {
    await llm.close()
  }
})

test('cli: sessions 子命令能列出刚跑过的会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-cli-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-cli-data-'))
  const llm = await startFakeLlm([{ text: '你好' }])
  try {
    await runCli(['--yes', '--cwd', root, '--data-dir', dataDir, '--base-url', llm.url, '--api-key', 'sk-test', '打个招呼'], {})
    const r = await runCli(['sessions', '--data-dir', dataDir], {})
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /打个招呼/)
  } finally {
    await llm.close()
  }
})
