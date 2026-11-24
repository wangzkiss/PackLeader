/**
 * 离线 demo：不需要 API Key，也不需要联网。
 *
 * 起一个假的 OpenAI 端点，按脚本让 agent 走一遍真实流水线：
 *   read → edit（触发审批 + 写前快照）→ 收尾
 * 然后展示审计账本，并撤销这一轮改动。
 *
 * 运行：node --disable-warning=ExperimentalWarning scripts/demo.ts
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Audit } from '../src/core/audit.ts'
import { ApprovalBroker } from '../src/core/approval.ts'
import { Checkpoints } from '../src/core/checkpoint.ts'
import { Agent } from '../src/core/loop.ts'
import { Policy } from '../src/core/policy.ts'
import { Session } from '../src/core/session.ts'
import { OpenAiClient } from '../src/llm/openai.ts'
import { createDefaultTools } from '../src/tools/index.ts'
import { CliRenderer, bold, cyan, dim, gray, green, yellow } from '../src/tui/render.ts'
import { startFakeLlm } from '../test/fake-llm.ts'

const line = (s = '') => process.stdout.write(`${s}\n`)

const readme = `# demo-project

一个用来演示 PackLeader 的小仓库。

## 构建
（还缺构建命令）
`

const steps = [
  {
    reasoning: '先看看仓库里有什么，找到 README。',
    toolCalls: [{ id: 'call_glob', name: 'glob', args: { pattern: '**/*.md' } }],
  },
  {
    reasoning: '读一下 README，确认要补在哪。',
    toolCalls: [{ id: 'call_read', name: 'read', args: { path: 'README.md' } }],
  },
  {
    reasoning: '在「## 构建」下面补一行命令。',
    toolCalls: [
      {
        id: 'call_edit',
        name: 'edit',
        args: { path: 'README.md', old: '（还缺构建命令）', new: '```bash\nnpm run build\n```' },
      },
    ],
  },
  { text: '已在 README 的「构建」一节补上 `npm run build`。' },
]

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'packleader-demo-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'packleader-data-'))
  await writeFile(join(root, 'README.md'), readme, 'utf8')
  await writeFile(join(root, 'package.json'), '{"name":"demo-project"}\n', 'utf8')

  const llm = await startFakeLlm(steps)
  const audit = await Audit.open(join(dataDir, 'audit.sqlite'))
  const renderer = new CliRenderer()
  const session = await Session.create(dataDir, {
    cwd: root,
    model: 'demo-model',
    baseURL: llm.url,
    mode: 'guarded',
    version: '0.1.0',
  })
  const checkpoints = new Checkpoints(join(dataDir, 'ckpt'))
  const agent = new Agent({
    session,
    llm: new OpenAiClient({ baseURL: llm.url, apiKey: 'sk-demo', model: 'demo-model' }),
    tools: createDefaultTools({ root }),
    policy: new Policy(root, 'guarded'),
    broker: new ApprovalBroker('allow'), // 等价于 pl --yes；真实使用时是终端逐条确认
    checkpoints,
    audit,
    dataDir,
    renderer,
  })

  line(bold('\n=== 1. 让 agent 完成一个任务（guarded 模式，审批自动放行）==='))
  line(dim(`workspace: ${root}`))
  renderer.banner({ model: 'demo-model', mode: 'guarded', root, session: session.id, version: '0.1.0' })

  const result = await agent.runTurn('README 的构建一节缺命令，帮我补上')
  line(dim(`\n结果：${result.steps} 步 / ${result.toolCalls} 次工具调用 / 结束原因 ${result.reason}`))

  line(bold('\n=== 2. 文件确实变了 ==='))
  const after = await readFile(join(root, 'README.md'), 'utf8')
  line(after.split('\n').map((l) => `  ${l}`).join('\n'))

  line(bold('\n=== 3. 审计账本（来自 SQLite，可随时由会话日志重建）==='))
  for (const r of audit.queryToolCalls({ limit: 10 }).reverse()) {
    const ok = Number(r.ok) === 1 ? green('✓') : yellow('✗')
    line(`  ${ok} ${String(r.tool).padEnd(8)} ${gray(String(r.ms) + 'ms')}  ${gray(JSON.stringify(r.args_json).slice(0, 70))}`)
  }
  const cost = audit.cost()
  line(dim(`  模型调用 ${cost.calls} 次，prompt ${cost.prompt}，completion ${cost.completion}`))

  line(bold('\n=== 4. 撤销这一轮 ==='))
  const undo = await checkpoints.undo(session.id, 1)
  for (const p of undo.restored) line(`  ${green('恢复')} ${p}`)
  const restored = await readFile(join(root, 'README.md'), 'utf8')
  line(dim(`  构建一节已回到：${restored.split('\n').find((l) => l.includes('构建命令'))?.trim()}`))

  line(bold('\n=== 5. 会话事件序列（append-only 日志）==='))
  line(
    '  ' +
      session.events
        .map((e) => e.kind)
        .join(` ${gray('→')} `),
  )

  line(cyan(`\n全部产物在临时目录，进程退出即散。真实使用时数据在 ~/.packleader。\n`))

  audit.close()
  await llm.close()
}

main().catch((e) => {
  process.stderr.write(`demo 失败：${(e as Error).stack}\n`)
  process.exitCode = 1
})
