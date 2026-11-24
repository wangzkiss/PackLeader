/**
 * 交互模式（REPL）演示：把几行输入喂给 `pl --repl`，看真实界面输出。
 *
 * 用假模型，所以秒级完成、结果确定；演示的是界面与权限交互，不是模型能力。
 *
 * 运行：node --disable-warning=ExperimentalWarning scripts/demo-repl.ts
 */

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeLlm } from '../test/fake-llm.ts'

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')

const header = (s: string) => process.stdout.write(`\n\x1b[1m${s}\x1b[0m\n`)
const line = (s = '') => process.stdout.write(`${s}\n`)

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'pl-repl-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'pl-repl-data-'))
  await writeFile(join(root, 'README.md'), '# demo\n', 'utf8')

  const llm = await startFakeLlm([
    // 第 1 轮：写文件（会触发审批）→ 收尾
    { toolCalls: [{ id: 'c1', name: 'write', args: { path: 'hello.txt', content: 'hello packleader\n' } }] },
    { text: '已创建 hello.txt。' },
    // 第 2 轮：读回来 → 收尾
    { toolCalls: [{ id: 'c2', name: 'read', args: { path: 'hello.txt' } }] },
    { text: '文件内容是 hello packleader。' },
  ])

  header('=== 把这几行喂给 `pl --repl`（模拟用户逐步输入）===')
  line('  帮我创建 hello.txt，内容是 hello packleader')
  line('  y            ← 审批：允许一次')
  line('  再读回来确认一下')
  line('  /undo        ← 撤销这一轮的写')
  line('  /sessions    ← 看历史')
  line('  /exit')

  header('=== 下面是 pl --repl 的真实输出 ===')

  const child = spawn(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      CLI,
      '--repl',
      '--cwd',
      root,
      '--data-dir',
      dataDir,
      '--base-url',
      llm.url,
      '--api-key',
      'sk-demo',
      '--model',
      'demo-model',
    ],
    { stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, NO_COLOR: '1' } },
  )

  child.stdin.write('帮我创建 hello.txt，内容是 hello packleader\n')
  child.stdin.write('y\n')
  child.stdin.write('再读回来确认一下\n')
  child.stdin.write('/undo\n')
  child.stdin.write('/sessions\n')
  child.stdin.write('/exit\n')
  child.stdin.end()

  await new Promise((resolve) => child.on('close', resolve))

  header('=== 进程退出后 ===')
  const exists = await readFile(join(root, 'hello.txt'), 'utf8').catch(() => null)
  line(exists === null ? '  hello.txt 已被 /undo 删除 ✓' : `  hello.txt 仍在：${JSON.stringify(exists)}`)
  line(`  数据目录：${dataDir}`)
  line()

  await llm.close()
}

main().catch((e) => {
  process.stderr.write(`demo-repl 失败：${(e as Error).stack}\n`)
  process.exitCode = 1
})
