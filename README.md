# PackLeader

轻量单机 Agent：**会读文件、会跑命令、会改代码，有审批、有审计、能撤销、能续跑。**

零依赖、零构建：Node ≥ 22.18 直接跑 TypeScript，不需要 `npm install`，不需要打包器。

```bash
node src/cli.ts --help
node scripts/demo.ts        # 离线 demo，不需要 API Key
```

- 设计方案：[DESIGN.md](DESIGN.md)（架构、包裁剪、体积测算、里程碑）
- 当前状态：**M0–M3 + M4–M5 已完成**，17 + 3 个测试全绿（含真实子进程的 CLI e2e）

---

## 快速开始

```bash
# 1) 指定模型端点与 key（任何 OpenAI 兼容网关都行）
export PL_API_KEY=sk-...
export PL_BASE_URL=https://api.deepseek.com/v1
export PL_MODEL=deepseek-chat

# 2) 只读模式问一句，不改任何东西
node src/cli.ts --mode read-only "这个仓库用什么构建？"

# 3) 让它改代码（每次写/执行都会问你）
node src/cli.ts --cwd D:/work/myproj "把 config.ts 里重复的校验抽成一个函数"

# 4) 查账 / 后悔
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
| `pl audit [-n N] [--tool X] [--cost] [--json]` | 审计账本：工具调用 / 成本 |
| `pl undo [--turn N] [--force]` | 撤销某一轮的全部文件改动 |
| `pl sessions` | 列出历史会话 |

常用选项：`--cwd` `--mode` `--yes` `--deny` `--model` `--base-url` `--api-key` `--resume <id>` `--continue` `--data-dir` `--max-steps` `--json` `--show-reasoning`

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

两个特性因此成立：

- **能续跑**：`pl --resume <id>` 从日志重建对话，崩了最多丢最后一条
- **能重建审计**：删掉 `audit.sqlite` 不影响任何事实，随时从 jsonl 重放

---

## 已实现 / 未实现

**已实现（可跑、有测试）**

- Agent 主循环：turn → step → tool batch，事件全落盘，`max-steps` 保护
- 7 个工具：`read` `write` `edit` `glob` `grep` `shell` `todo_write`
- 三档策略 + 一次性审批 + fail-closed
- 写前快照与轮次级撤销（含外部改动冲突检测、超大文件跳过）
- 审计投影（SQLite，`node:sqlite`）+ 成本统计
- 工具结果截断 + 溢出落盘（head 60% / tail 25% + spill 路径）
- OpenAI 兼容流式适配器（含 `tool_calls` 按 index 分片聚合）
- CLI：单次 / 交互 / audit / undo / sessions / `--json` NDJSON

**未实现（下一步）**

| 项 | 说明 |
|---|---|
| 全屏 TUI（Ink） | 当前是行式输出，`Renderer` 接口不变即可替换 |
| `--resume` 的交互体验 | 后端已支持，交互模式还没有会话选择器 |
| 内置 ripgrep | 现在用 Node 遍历，大仓库不如 `rg` 快 |
| DSH 运行时替换 | 见下节：seam 已对齐，换实现不改类型 |
| SEA 单文件分发 | 体积测算见 DESIGN.md §12（约 33 MB） |

---

## 代码地图

```
src/
├─ cli.ts                 命令行入口（解析 / 组装 / REPL）
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

覆盖：会话恢复（含损坏行）、文件工具与越界、快照/撤销/冲突、审批三种结局、`read-only` 下 `--yes` 仍拒、完整两轮工具调用、CLI 子进程 NDJSON 与退出码。

---

## 安全边界（请读）

- 这是**防手滑**，不是防恶意。`workspace-write` 靠路径白名单 + 审批，不是容器隔离。
- 提示注入是真实风险：模型读到的文件内容可能诱导它执行命令。缓解手段是审批闸门，**不要把模式长期开在 `full`**。
- 审计库和生产文件都在本机，别把 `~/.packleader` 提交进仓库。
