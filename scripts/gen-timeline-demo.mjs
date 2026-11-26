/**
 * 把 src/core/timeline.ts 里那三轮「排查 + 修复」的演示事件落成 scripts/timeline-demo.json。
 * 界面 `powershell -File ui/PackLeader.ps1 -Demo` 读它，按 200ms 一条喂进渲染流程，
 * 不用连 host、不用真跑工具，就能看到完整的多轮执行流（正文流 / 执行方案 / 底部胶囊）。
 *
 *   node scripts/gen-timeline-demo.mjs
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mockBugHuntEvents } from '../src/core/timeline.ts'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'timeline-demo.json')
const events = mockBugHuntEvents()
// 一行一条（NDJSON）：界面按行读进来当事件流，不用先解析整份数组
writeFileSync(out, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
console.log(`已写出 ${events.length} 条事件 → ${out}`)
