# PackLeader

轻量单机 Agent：**会读文件、会跑命令、会改代码，有审批、有审计、能撤销、能续跑。**

零依赖、零构建：Node ≥ 22.18 直接跑 TypeScript，不需要 `npm install`，不需要打包器。

```bash
node src/cli.ts doctor     # 先自检：node / shell / 数据目录 / 端点 / 模型
node scripts/demo.ts       # 离线 demo，不需要 API Key
```

- 设计方案：[DESIGN.md](DESIGN.md)（架构、包裁剪、体积测算、里程碑）
- 当前状态：**M0–M5 已完成**，32 个测试全绿，**已在真实模型 + 5.5 GB 真实仓库上验证**（见下节）

---

## 在真实模型上验证过

2026-11-24，接 `http://127.0.0.1:19790/v1`（`deepseek-flash`，推理型）跑了四组真实任务。

### A. 改代码（小仓库，guarded）

| 轮次 | 任务 | 结果 |
|---|---|---|
| 1 | 修一个 Node 项目的两处 bug | 8 步完成，测试由 2/5 失败变为 5/5 通过 |
| 2 | `--continue` 跨进程续聊「再确认一次」 | 从 JSONL 正确重放工具历史，独立复跑测试 |
| 3 | `pl undo` 撤销第 1 轮 | 代码退回 bug 版本，测试重新失败 3 个 |
| 4 | `--mode read-only` 让它审自己的代码 | 找出 4 处调用点，**并指出一处漏掉的审计路径**（已修） |

### B. 读懂大仓库（DSH monorepo，5.5 GB / 14.7 万文件 / 52 个 package，read-only）

问题：「一次工具调用从模型发起 `tool_call` 到结果回到模型，中间经过哪些环节？给文件:行号。」

它给出的答案覆盖 `agent-loop`（编排/并行池/屏障）→ `tools`（pre-execute → ask/审批 → guard → execute → post-execute → result）→ `session`（事件落库与 `deriveMessages`）→ `llm`（`BlockAssembler` 装配 tool-call 块），共 25 个环节、带行号。

**我抽查了 4 处引用，全部准确**：`tool-calls.ts:168` 是 `appendToolCall`、`:269` 是 `appendToolResult`、`tools/src/index.ts:1497` 是 `prepareScheduledExecution`、`surface.ts:144` 是 `case 'tool/result'`。不是编的。

代价：20 步、33 次工具调用、21 次模型请求；工具耗时合计 **4.6 秒**，模型耗时 56 秒；prompt 累计 426k（单次最大 38k），**缓存命中 82%**。

### C. 这一轮跑出来的问题（单测发现不了的那类）

| 问题 | 表现 | 修法 |
|---|---|---|
| `shell` 硬编码 `pwsh.exe` | 这台机器只有 PowerShell 5.1，工具直接 `ENOENT`，连 `echo` 都跑不了 | 按 `PL_SHELL` → PATH 的 pwsh → `Program Files\PowerShell\7` → powershell → `System32\WindowsPowerShell\v1.0` 解析；描述里提示 5.1 不支持 `&&` |
| `glob` 不支持 `{js,json}` | 模型第一反应就是大括号，之前静默返回空 | 加括号展开 |
| 一轮内改同一文件两次 → `undo` 假冲突 | 冲突检测拿的是第一次编辑后的哈希 | 改比对**最后一次**写入后的哈希 |
| `grep` 没有 `path` 参数 | 模型反复传 `path=packages/...`（ripgrep 惯例），只能退化成全库搜索 | `grep`/`glob` 补 `path`；`grep` 遇到「把路径当 pattern」还给纠正提示 |
| `grep` 在大仓库 **12.5 秒** | 扫了 3.1 万文件，其中 3.18 万是 `apps/desktop/.desktop-build`、1.75 万是 `.map` | 跳过构建目录与资源扩展名 + 并行读 + 时间预算：**12.5s → 1.0s（12×）** |
| `read` 一次吐 89 KB 又被截断 | 白读一次，模型得再分页 | 按 48 KB 预算切块，末尾给 `offset=N 继续` |
| 20 步用完却不给答案 | 穷尽步数后直接停，用户拿到 0 结果 | **到上限强制收尾**：不给工具、追加「基于现有信息作答」的指令再请求一次 |

最后一条是这次最关键的修复：没有它，B 那轮跑完只有 33 条工具日志、没有任何输出。

---

## 快速开始

```bash
# 1) 自检（先跑这个，能省掉 80% 的「为什么跑不起来」）
node src/cli.ts doctor

# 2) 指定模型端点与 key（任何 OpenAI 兼容网关都行）
export PL_API_KEY=sk-...
export PL_BASE_URL=https://api.deepseek.com/v1
export PL_MODEL=deepseek-chat

# 3) 只读模式问一句，不改任何东西
node src/cli.ts --mode read-only "这个仓库用什么构建？"

# 4) 让它改代码（每次写/执行都会问你）
node src/cli.ts --cwd D:/work/myproj "把 config.ts 里重复的校验抽成一个函数"

# 5) 查账 / 后悔
node src/cli.ts audit -n 10 --cost
node src/cli.ts undo --turn 3
```

安装成全局命令：`npm link`（之后可直接用 `pl`）。

---

## 命令一览

| 命令 | 说明 |
|---|---|
| `pl "任务"` | 单次执行，完成后退出 |
| `pl` | 交互模式（`/exit` `/undo` `/sessions` `/help`） |
| `pl --repl` | 强制交互模式（stdin 不是终端也行，便于脚本驱动） |
| `pl doctor` | 自检：node 版本 / shell 解析 / 数据目录可写 / 端点可达 / 模型存在 |
| `pl audit [-n N] [--tool X] [--cost] [--json]` | 审计账本：工具调用 / 成本 |
| `pl audit rebuild` | 从会话日志重建审计库（证明审计只是投影） |
| `pl undo [--turn N] [--force]` | 撤销某一轮的全部文件改动 |
| `pl sessions` | 列出历史会话 |

常用选项：`--cwd` `--mode` `--yes` `--deny` `--model` `--base-url` `--api-key` `--resume <id>` `--continue` `--data-dir` `--max-steps` `--json` `--repl` `--show-reasoning`

### 交互模式长什么样

行式界面（不是全屏 TUI）：横幅 → `›` 提示符 → 流式回答 → 工具行 `⚙ write hello.txt / ✓ 12ms`；
需要写权限时插入审批框，逐条问 `[y]/[n]/[d]`。

```
 PackLeader v0.1.0  ·  deepseek-flash  ·  guarded
 cwd: D:\work\proj
 session: s-mwuu35vh-3zj7

› 帮我创建 hello.txt
  ⚙ write hello.txt

┌ 需要确认 ──────────────────────────────
│ write  write 需要写权限
│ D:\work\proj\hello.txt
└────────────────────────────────────────
  [y] 允许一次   [n] 拒绝   [d] 看完整参数   (默认拒绝) y
    ✓ 1ms

已创建 hello.txt。
```

想自己看一遍：`node scripts/demo-repl.ts`（假模型，秒级，含审批 → `/undo` → `/sessions`）。

不复现全屏 TUI 是刻意的：`Renderer` 接口独立，以后想换 Ink 不用动 core。

环境变量：`PL_API_KEY` `PL_BASE_URL` `PL_MODEL` `PL_MODE` `PL_APPROVAL` `PL_SHELL` `PACKLEADER_HOME`

---

## 三档权限（默认 guarded）

| 模式 | 读 | 写文件 | 执行命令 | 越界写 |
|---|---|---|---|---|
| `read-only` | ✅ | ❌ 直接拒 | ❌ 直接拒 | ❌ |
| `guarded` **（默认）** | ✅ | 逐条询问 | 逐条询问 | ❌ 直接拒 |
| `full` | ✅ | ✅ | ✅ | ✅ |

- 审批是**一次性**的，没有「总是允许」——这是刻意的（见 DESIGN.md §6.3）。
- 没有可用审批通道时一律 **拒绝**（fail-closed）：`pl --deny` 用于 CI，非 TTY 环境下默认也是拒。
- `--yes` 只是跳过询问，**不能突破 `read-only`**，因为策略闸门在审批之前。
- 审计里 `--yes` 放行的记录会标 `auto`，与「人真的点过 y」区分开。

---

## 数据目录

默认 `~/.packleader`（`PACKLEADER_HOME` 可改）：

```
~/.packleader/
├─ sessions/<id>/session.jsonl    # 唯一真相：append-only 事件日志
├─ audit.sqlite                   # 投影：tool_calls / llm_calls / approvals / sessions
├─ ckpt/<session>/<turn>-<step>-<call>/   # 写前快照 + manifest
└─ spill/<ts>-<sha>.log           # 被截断的完整输出
```

三个特性因此成立：

- **能续跑**：`pl --resume <id>` / `--continue` 从日志重建对话，崩了最多丢最后一条
- **能重建审计**：`pl audit rebuild` 从 jsonl 重放，连工具参数和审批结论都能还原
- **能撤销**：写前快照 + 轮次级回滚，冲突时拒绝覆盖（`--force` 才强来）

---

## 已实现 / 未实现

**已实现（可跑、有测试、真模型验证过）**

- Agent 主循环：turn → step → tool batch，事件全落盘，`max-steps` 保护
- 7 个工具：`read` `write` `edit` `glob` `grep` `shell` `todo_write`
- 三档策略 + 一次性审批 + fail-closed + `auto` 审计标记
- 写前快照与轮次级撤销（含外部改动冲突检测、超大文件跳过）
- 审计投影（SQLite，`node:sqlite`）+ 成本统计 + 从日志重建
- 工具结果截断 + 溢出落盘（head 60% / tail 25% + spill 路径）
- OpenAI 兼容流式适配器（`tool_calls` 按 index 分片聚合、`reasoning_content`、缓存命中统计）
- CLI：单次 / 交互 / doctor / audit / undo / sessions / `--json` NDJSON

**未实现（下一步）**

| 项 | 说明 |
|---|---|
| **上下文压缩** | 长任务里单次 prompt 会涨到 70k+；还没有摘要/裁剪策略，这是接更大仓库前该做的 |
| 全屏 TUI（Ink） | 当前是行式输出，`Renderer` 接口不变即可替换 |
| 会话选择器 | `--resume` 要手敲 id，交互模式还没有列表选择 |
| 内置 ripgrep | 现在是遍历 + 并行读（23k 文件约 1s），仍不如 `rg` 快 |
| 并行工具调用 | 模型一次给多个调用时仍是串行执行（DSH 那边有屏障/并行池，值得抄） |
| SEA 单文件分发 | 体积测算见 DESIGN.md §12（约 33 MB） |

---

## 代码地图

```
src/
├─ cli.ts                 命令行入口（解析 / 组装 / REPL / doctor）
├─ core/
│  ├─ events.ts           会话事件词汇（唯一真相）
│  ├─ session.ts          JSONL 日志 + deriveMessages 投影
│  ├─ loop.ts             主循环 + 工具流水线（策略→审批→快照→执行→截断→审计）
│  ├─ tools.ts            Tool 契约 + 注册表
│  ├─ policy.ts           路径边界 + 三档模式
│  ├─ approval.ts         一次性审批 broker（fail-closed）
│  ├─ checkpoint.ts       写前快照 + 撤销
│  └─ audit.ts            SQLite 投影 + 重建
├─ llm/openai.ts          OpenAI 兼容流式客户端
├─ tools/                 fs / shell / todo
└─ tui/                   ANSI 渲染 + 终端审批
```

**换 DSH**：`core/types.ts` 与 `core/tools.ts` 里的词汇（`LlmMessage` / `ToolSchema` / `Permission` / `Decision`）就是 DSH 的 seam 形状。要接 `dsh-agent-loop` 时，替换的是 `core/loop.ts` 与 `llm/openai.ts` 两个文件，其余（session、audit、checkpoint、tools）原样保留。

---

## 测试

```bash
npm test     # 或 node --disable-warning=ExperimentalWarning --test "test/*.test.ts"
```

32 个测试，覆盖：

- 会话恢复（含损坏半行、截断结果的说明文本）
- 文件工具与路径越界、`{a,b}` 大括号 glob、`path` 限定范围
- 资源文件默认跳过、大文件按字节预算分页
- 快照 / 撤销 / 外部改动冲突 / 一轮内多次编辑 / 超大文件跳过
- 审批三种结局（放行、拒绝、无通道 fail-closed）、`read-only` 下 `--yes` 仍拒
- 未知工具也进审计（`unknown-tool`）
- 真实两轮工具调用、`--continue` 历史重放所需的消息形状
- **到步数上限强制收尾**（断言收尾请求不带 tools）
- shell 解析 / 执行 / 退出码 / 超时杀进程
- 删库后从 jsonl 重建审计（参数、审批结论、auto 标记）
- 真实子进程的 CLI e2e（NDJSON 事件、退出码、sessions 列表）

---

## 安全边界（请读）

- 这是**防手滑**，不是防恶意。`workspace-write` 靠路径白名单 + 审批，不是容器隔离。
- 提示注入是真实风险：模型读到的文件内容可能诱导它执行命令。缓解手段是审批闸门，**不要把模式长期开在 `full`**。
- 审计库和生产文件都在本机，别把 `~/.packleader` 提交进仓库。
