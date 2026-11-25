import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Audit } from '../src/core/audit.ts'
import { ApprovalBroker } from '../src/core/approval.ts'
import { Checkpoints } from '../src/core/checkpoint.ts'
import { Agent } from '../src/core/loop.ts'
import { Policy } from '../src/core/policy.ts'
import { Session } from '../src/core/session.ts'
import { clipOutput, detectVerifier } from '../src/core/verify.ts'
import { OpenAiClient } from '../src/llm/openai.ts'
import { createDefaultTools } from '../src/tools/index.ts'
import { startFakeLlm, type ScriptStep } from './fake-llm.ts'

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'pl-verify-'))

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

test('verify: 认 npm / pnpm / yarn / cargo / go / pytest，认不出就返回 null', async () => {
  const npm = await tmp()
  await writeJson(join(npm, 'package.json'), { scripts: { test: 'node --test' } })
  assert.equal(detectVerifier(npm)?.label, 'npm test')

  await writeFile(join(npm, 'pnpm-lock.yaml'), '', 'utf8')
  assert.equal(detectVerifier(npm)?.label, 'pnpm test')

  const yarn = await tmp()
  await writeJson(join(yarn, 'package.json'), { scripts: { test: 'jest' } })
  await writeFile(join(yarn, 'yarn.lock'), '', 'utf8')
  assert.equal(detectVerifier(yarn)?.label, 'yarn test')

  // 有 package.json 但没有 test script：不算（别瞎跑 npm test 然后报错）
  const noTest = await tmp()
  await writeJson(join(noTest, 'package.json'), { scripts: { dev: 'vite' } })
  assert.equal(detectVerifier(noTest), null)

  const rust = await tmp()
  await writeFile(join(rust, 'Cargo.toml'), '[package]\nname="x"\n', 'utf8')
  assert.equal(detectVerifier(rust)?.label, 'cargo test -q')

  const go = await tmp()
  await writeFile(join(go, 'go.mod'), 'module x\n', 'utf8')
  assert.equal(detectVerifier(go)?.label, 'go test ./...')

  const py = await tmp()
  await writeFile(join(py, 'pytest.ini'), '[pytest]\n', 'utf8')
  assert.equal(detectVerifier(py)?.label, 'python -m pytest -q')

  const empty = await tmp()
  assert.equal(detectVerifier(empty), null)
})

test('verify: package.json 带 BOM 也要认（PowerShell 写出来的就带）', async () => {
  const root = await tmp()
  // 真跑 demo 时踩到的坑：Set-Content -Encoding UTF8 会写 BOM，JSON.parse 直接抛，
  // 于是被误判成"没有测试入口"，验证就静默跳过了
  await writeFile(join(root, 'package.json'), '\uFEFF{"scripts":{"test":"node --test"}}', 'utf8')
  assert.equal(detectVerifier(root)?.label, 'npm test')
})

test('verify: 超长输出保留头尾（结论在尾部，不能只截头）', () => {
  const stdout = `${'head-line\n'.repeat(400)}THE-END`
  const clipped = clipOutput(stdout, '', 100, 100)
  assert.ok(clipped.startsWith('head-line'))
  assert.ok(clipped.endsWith('THE-END'), '尾部必须留着，否则看不到哪条测试挂了')
  assert.ok(clipped.length < stdout.length)
  assert.match(clipped, /中间省略/)

  // 短输出原样返回，不加任何标记
  assert.equal(clipOutput('ok', ''), 'ok')
  assert.equal(clipOutput('', 'boom'), '[stderr]\nboom')
})

test('e2e: 改完文件自动跑测试，红了把输出喂回去，改对后通过', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-loop-verify-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-data-'))

  // 一个真的会失败的测试：calc.js 里必须是加法
  await writeJson(join(root, 'package.json'), { name: 'demo', scripts: { test: 'node check.js' } })
  await writeFile(
    join(root, 'check.js'),
    [
      "const fs = require('fs')",
      "const src = fs.readFileSync('calc.js', 'utf8')",
      "if (!/return a \\+ b/.test(src)) { console.error('calc.js 的 add 不是加法'); process.exit(1) }",
      "console.log('ok')",
    ].join('\n'),
    'utf8',
  )

  const steps: ScriptStep[] = [
    // 第 1 步：写了个错的实现
    { toolCalls: [{ id: 'w1', name: 'write', args: { path: 'calc.js', content: 'export const add = (a, b) => {\n  return a - b\n}\n' } }] },
    // 第 2 步：自信收工（这一步之后自动验证会失败）
    { text: '已实现 add 函数' },
    // 第 3 步：看到失败输出后真的去改
    { toolCalls: [{ id: 'w2', name: 'write', args: { path: 'calc.js', content: 'export const add = (a, b) => {\n  return a + b\n}\n' } }] },
    // 第 4 步：再收工（这次验证该过）
    { text: '改成加法了，测试通过' },
  ]

  const llmServer = await startFakeLlm(steps)
  const audit = await Audit.open(join(dataDir, 'audit.sqlite'))
  const session = await Session.create(dataDir, {
    cwd: root,
    model: 'test-model',
    baseURL: llmServer.url,
    mode: 'guarded',
    version: '0.1.0',
  })
  const agent = new Agent({
    session,
    llm: new OpenAiClient({ baseURL: llmServer.url, apiKey: 'sk-test', model: 'test-model' }),
    tools: createDefaultTools({ root }),
    policy: new Policy(root, 'guarded'),
    broker: new ApprovalBroker('allow'),
    checkpoints: new Checkpoints(join(dataDir, 'ckpt')),
    audit,
    dataDir,
    maxVerifyRounds: 1,
  })

  try {
    const result = await agent.runTurn('给 calc.js 加一个 add 函数')

    // 1) 验证跑了两次：先红后绿
    const verifies = session.events.filter((e) => e.kind === 'verify/end')
    assert.equal(verifies.length, 2, '应该验证两次（失败一次、成功一次）')
    assert.equal((verifies[0] as { ok: boolean }).ok, false, '第一次必须失败')
    assert.equal((verifies[1] as { ok: boolean }).ok, true, '改对之后必须通过')

    // 2) 失败输出真的作为"用户消息"进了历史，模型看得到
    const fed = session.events.filter((e) => e.kind === 'user/message' && e.text.includes('[自动验证]'))
    assert.equal(fed.length, 1)
    assert.match((fed[0] as { text: string }).text, /calc\.js 的 add 不是加法/)
    const lastReq = llmServer.requests.at(-1)!
    const flat = JSON.stringify(lastReq.messages)
    assert.match(flat, /自动验证/, '最后一次请求里必须带着失败输出')

    // 3) 磁盘上的文件是修好的版本
    const calc = await readFile(join(root, 'calc.js'), 'utf8')
    assert.match(calc, /return a \+ b/)
    assert.equal(result.reason, 'done')
  } finally {
    audit.close()
    await llmServer.close()
  }
})

test('e2e: 没改文件就不跑验证（纯读的轮次不浪费时间）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-loop-noverify-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-data-'))
  await writeJson(join(root, 'package.json'), { scripts: { test: 'node -e "process.exit(1)"' } })

  const llmServer = await startFakeLlm([{ text: '这个仓库用 node --test' }])
  const audit = await Audit.open(join(dataDir, 'audit.sqlite'))
  const session = await Session.create(dataDir, {
    cwd: root,
    model: 'test-model',
    baseURL: llmServer.url,
    mode: 'guarded',
    version: '0.1.0',
  })
  const agent = new Agent({
    session,
    llm: new OpenAiClient({ baseURL: llmServer.url, apiKey: 'sk-test', model: 'test-model' }),
    tools: createDefaultTools({ root }),
    policy: new Policy(root, 'guarded'),
    broker: new ApprovalBroker('allow'),
    checkpoints: new Checkpoints(join(dataDir, 'ckpt')),
    audit,
    dataDir,
  })
  try {
    await agent.runTurn('这个仓库用什么测试框架？')
    assert.equal(session.events.filter((e) => e.kind === 'verify/start').length, 0)
  } finally {
    audit.close()
    await llmServer.close()
  }
})
