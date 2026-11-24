# PackLeader：轻量单机 Agent 设计方案

> 目标形态：**A 档（单机 Agent）** —— 会读文件、会跑命令、会改代码，有审批、有审计、能撤销、能续跑。
> 设计底座参考：`E:\Desktop\ai\deepseek-harness-master`（DeepSeek Harness `0.2.1-rc.2`，Cordis「一切皆插件」架构，MIT）。
> 设计原则：**不自己发明 agent 语义**——session / tool pipeline / approval seam 的形状直接对齐 DSH，能换实现，不换契约。

---

## 0. 实现状态（v0.1，2026-11-24）

已落地为本目录的 **PackLeader v0.1**：2129 行源码 + 523 行测试，**20 个测试全绿**（含真实子进程的 CLI e2e）；`node scripts/demo.ts` 可离线跑通「读 → 改 → 审计 → 撤销」。

**一处重要偏离**：运行时**没有直接依赖 DSH 的包**，而是按本文定义的 seam 形状自实现。原因：

1. DSH 所有包用 `workspace:*` 互相引用，link 到外部工程解析不出来
2. npm 上只发布到 `0.1.0-rc.6`，与本地源码 `0.2.1-rc.2` 的 seam 不兼容
3. 仓库里有 7 个包（`compaction/basic`、`fs/local`、`sandbox/*`、`session/persistence-jsonl`、`session/projection`、`subprocess/local`）尚未构建

**代价与收益**：多写约 400 行主循环，换来「零依赖、零构建、改一行立刻生效」——验证阶段这比复用更划算。**替换路径保留**：`src/core/types.ts` 与 `src/core/tools.ts` 的词汇就是 DSH 的 seam 形状，将来接 `dsh-agent-loop` 时只需替换 `src/core/loop.ts` 与 `src/llm/openai.ts`，session / audit / checkpoint / tools 原样保留。

其余设计（三档权限、一次性审批、事件溯源、审计投影、写前快照、截断落盘）与下文一致；实现与设计的逐条对应见 [README.md](README.md)。

---

## 1. 目标与非目标

### 1.1 量化目标

| 指标 | 目标 | 说明 |
|---|---|---|
| 冷启动 | < 1.5 s | Node 22 + Cordis 19 个插件行 |
| 常驻内存 | < 250 MB RSS | 不挂 Web/Host/浏览器层 |
| 单轮工具→结果 | < 1.5 s（不含模型） | 本地文件/命令 |
| 代码量 | 新增 ≈ 3.5–4.5k 行 TS | 5 个新包，其余全复用 |
| 依赖 | ≤ 20 个 Cordis 行、≤ 12 个 npm 直接依赖 | 对比 sdk-minimal 的 33 个包 |
| 分发 | `npm i -g dsh-lite`（~15 MB）或 SEA 单文件 exe（~90 MB） | 二选一 |

### 1.2 明确不做（边界即轻量）

- ❌ 云端账号 / 设备注册 / 遥测 / 计费
- ❌ 多机远程、P2P、中继、提权服务
- ❌ 插件市场与安装器（插件仍可用 profile patch 手动加，但不做市场）
- ❌ 浏览器 Web UI / Electron 桌面壳 / HTTP 服务
- ❌ 沙箱虚拟化（用「目录白名单 + 审批」代替容器级隔离）
- ❌ MCP、LSP、子代理、工作流、技能库、定时任务、Goal（可后续按需加回）

> 一句话：**一个进程、一个窗口、一个 `.dsh-lite` 目录，除此之外什么都不连。**

### 1.3 为什么「结合 DSH」是正确路径

| 这类产品的真正难点 | DSH 是否已有 | 复用方式 |
|---|---|---|
| 会话事件日志（可回放、可续跑、可 fork） | ✅ `dsh-session` + `session-persistence-jsonl` | 直接用 |
| 模型可见即已记录的强约束 | ✅ `deriveMessages()` 从日志投影 | 直接用 |
| 工具流水线（pre/guards/approval/execute/post/finalize） | ✅ `dsh-tools` | 直接用 |
| 审批 seam（ask/never、fail-closed、审计事件） | ✅ `dsh-user-approval` | 直接用，补一个 CLI 应答者 |
| 权限预设（沙箱 + 审批捆绑） | ✅ `dsh-permission-presets` | 直接用，改预设表 |
| 上下文压缩与计量 | ✅ `compaction-basic` + `token-meter` | 直接用，调阈值 |
| 文件/命令工具 | ✅ `tool-fs` / `tool-fs-search` / `tool-{bash,pwsh}-persistent` | 直接用 |
| 单进程一次性运行器 | ✅ `dsh-headless`（参考，不直接依赖） | 抄它的启动方式 |
| **审计视图 / 撤销 / 终端界面 / OpenAI 兼容适配器** | ❌ | **这就是我们要写的 5 个包** |

结论：**工作量从「写一个 agent（2–3 个月）」降到「写一个发行版（3–4 周）」。**

---

## 2. 总体架构

```
┌───────────────────────── dsh lite (单个 Node 进程) ─────────────────────────┐
│                                                                             │
│  lite-app        CLI 解析 / 组装 / --resume --yes --mode                     │
│      │                                                                      │
│  lite-tui  ◄──── Ink(React) 渲染 ──── 审批弹窗 / diff / 工具卡片             │
│      │                                                                      │
│  ── Cordis 插件树（19 行）────────────────────────────────────────────────  │
│    llm(openai-compat) → agent → agent-loop                                  │
│                          │                                                  │
│                          ├─ session（JSONL，append-only）                    │
│                          ├─ tools ──► tool-fs / tool-fs-search / bash|pwsh   │
│                          │        └─► sandbox-policy + user-approval        │
│                          ├─ system-prompt / token-meter / compaction-basic   │
│                          └─ fs-local / subprocess-local                      │
│                                                                             │
│  lite-audit  ── 旁路订阅 session/event ──► audit.sqlite（只读视图，可重建）    │
│  lite-checkpoint ── 订阅 fs/*-intent ──► .dsh-lite/ckpt/<session>/<turn>/     │
└─────────────────────────────────────────────────────────────────────────────┘
            │                                        │
     ~/.dsh-lite/sessions/*.jsonl            ~/.dsh-lite/audit.sqlite
     ~/.dsh-lite/ckpt/**                     ~/.dsh-lite/config.yml
```

**关键取舍**：TUI 与 agent 同进程（不走 HTTP/WS）。这样省掉 Host、鉴权、序列化、端口管理四层，代价是无法远程接管——而 A 档本来就不需要。

---

## 3. 包裁剪：从 sdk-minimal 到 lite

`sdk-minimal`（33 个依赖）是 DSH 官方最轻的模板，正好当起点。裁剪表：

| # | 包 | 决策 | 理由 |
|---|---|---|---|
| 1 | `dsh-agent` | ✅ 留 | Agent 接口与注册表 |
| 2 | `dsh-agent-loop` | ✅ 留 | **核心，绝不重写** |
| 3 | `dsh-llm` | ✅ 留 | 流式词汇表与 seam |
| 4 | `dsh-llm-retry` | ✅ 留 | 重试/退避，省得自己写 |
| 5 | `dsh-session` | ✅ 留 | 事件日志 |
| 6 | `dsh-session-persistence-jsonl` | ✅ 留 | 落盘 |
| 7 | `dsh-session-projection` | ✅ 留 | 被 permission-presets 硬依赖 |
| 8 | `dsh-system-prompt` | ✅ 留 | 提示词组装 |
| 9 | `dsh-tools` | ✅ 留 | 工具流水线 |
| 10 | `dsh-token-meter` | ✅ 留 | 预算与计量 |
| 11 | `dsh-compaction-basic` | ✅ 留 | 上下文压缩 |
| 12 | `dsh-fs-local` | ✅ 留 | 文件系统 seam 的本机实现 |
| 13 | `dsh-tool-fs` | ✅ 留 | read/write/edit |
| 14 | `dsh-tool-fs-search` | ✅ 留 | glob/grep（内置 ripgrep） |
| 15 | `dsh-subprocess-local` | ✅ 留 | 起进程 |
| 16 | `dsh-tool-pwsh-persistent` / `dsh-tool-bash-persistent` | ✅ 留（按平台） | 执行命令 |
| 17 | `dsh-sandbox-local` + `dsh-sandbox-policy` | ✅ 留 | 权限模型的执行侧 |
| 18 | `dsh-user-approval` | ✅ 留 | 审批 seam |
| 19 | `dsh-permission-presets` | ✅ 留 | read-only/guarded/full 三档 |
| 20 | `cordis-plugin-timer` | ✅ 留 | 超时/重试依赖 |
| 21 | `dsh-deepseek-llm-api-extensions` | ❌ 删 | 只服务 DeepSeek 官方 wire |
| 22 | `dsh-llm-deepseek-api-key` | 🔁 换 | 换成本项目的 `llm-openai` 适配器 |
| 23 | `dsh-sdk-app` + `sdk-jsonrpc-server` | ❌ 删 | 不做 SDK/JSON-RPC |
| 24 | `dsh-mcp-resources` | ❌ 删 | 不做 MCP |
| 25 | `dsh-jobs-local` | ❌ 删 | 不做后台任务 |
| 26 | `dsh-attachment-local` | ❌ 删 | 不做附件 |
| 27 | `dsh-compaction-image-offload` | ❌ 删 | 不做图片卸载 |
| 28 | `dsh-terminal` + `terminal-bash` | ❌ 删 | 不做持久终端，先用一次性 pwsh/bash |
| 29 | `dsh-session-title` | ❌ 删（可选留） | 标题让模型自己起，省一次调用 |
| 30 | `dsh-session-log-deepseek` | ❌ 删 | 云端日志 |
| 31 | `dsh-plugin-package-inventory-deepseek` | ❌ 删 | 只服务官方 API |
| 32 | `dsh-working-directory` + `tool-working-directory` | ⚠️ 建议留 | 多目录会话很实用，成本极低 |
| 33 | `dsh-session-persistence-jsonl` 的 zstd | 配 `compression: none` | 启动更快，便于人工排查 |

**新增（本项目代码）**：

| 包 | 行数估算 | 职责 |
|---|---|---|
| `@dsh-lite/llm-openai` | ~450 | `ctx.llm` 适配器：`/v1/chat/completions` + SSE + tool_calls + usage |
| `@dsh-lite/approval-cli` | ~250 | `approval/request` 应答者：TUI 弹窗 / `--yes` / `--deny` |
| `@dsh-lite/audit` | ~600 | 事件 → `audit.sqlite`；`lite audit` 子命令；可重建 |
| `@dsh-lite/checkpoint` | ~500 | 写前快照；`/undo`；`lite undo` |
| `@dsh-lite/tui` | ~1,500 | Ink 界面：会话流、工具卡片、diff、审批、输入框、状态栏 |
| `@dsh-lite/app` | ~300 | CLI + 组装 + 启动 |
| **合计** | **≈ 3,600** | 不含测试 |

---

## 4. 插件树（`cordis.patch.yml`，可直接抄）

```yaml
# packages/bundle/lite/cordis.patch.yml
# 本文件即完整的 Cordis 树：不叠 dsh-base，逐行声明所需服务。
- insert:
    - id: lite-app
      name: '@dsh-lite/app'
      config:
        home: !!js process.env.DSH_LITE_HOME ?? dshHomePath('.')
        defaultPreset: guarded

    # ── 模型通路（本项目自写，OpenAI 兼容）────────────────────────────
    - id: llm-openai
      name: '@dsh-lite/llm-openai'
      config:
        baseURL: !!js process.env.DSH_LITE_BASE_URL ?? 'https://api.deepseek.com/v1'
        apiKeyEnv: DSH_LITE_API_KEY
        model: !!js process.env.DSH_LITE_MODEL ?? 'deepseek-chat'
        contextWindow: 131072
        streamIdleTimeoutMs: 300000

    # ── 内核：会话 / 提示词 / 工具 / 循环 ─────────────────────────────
    - id: session
      name: '@deepseek-ai/dsh-session'
    - id: session-projection
      name: '@deepseek-ai/dsh-session-projection'
    - id: system-prompt
      name: '@deepseek-ai/dsh-system-prompt'
      config:
        includeHarnessIdentity: false
        includeRuntimeContext: true
        personaPrefix: |-
          你是一个在本机工作的软件工程助手。先读再改；改之前说清要改什么；
          命令输出很长时自行截断；不确定就问。
    - id: tools
      name: '@deepseek-ai/dsh-tools'
    - id: agent
      name: '@deepseek-ai/dsh-agent'
    - id: agent-loop
      name: '@deepseek-ai/dsh-agent-loop'
      config:
        agents: []
    - id: llm-retry
      name: '@deepseek-ai/dsh-llm-retry'
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'
    - id: token-meter
      name: '@deepseek-ai/dsh-token-meter'
    - id: compaction
      name: '@deepseek-ai/dsh-compaction-basic'
      config:
        # 触发线压到 70%，留出工具结果的余量
        thresholdRatio: 0.7
        keepRecentTokens: 20000

    # ── 能力：文件 / 搜索 / 命令 ──────────────────────────────────────
    - id: filesystem
      name: '@deepseek-ai/dsh-fs-local'
    - id: sandbox
      name: '@deepseek-ai/dsh-sandbox-local'
    - id: sandbox-policy
      name: '@deepseek-ai/dsh-sandbox-policy'
      config:
        mode: workspace-write
        workspaceRoot: !!js process.cwd()
    - id: subprocess
      name: '@deepseek-ai/dsh-subprocess-local'
    - id: working-directory
      name: '@deepseek-ai/dsh-working-directory'
    - id: tool-working-directory
      name: '@deepseek-ai/dsh-tool-working-directory'
    - id: tool-fs
      name: '@deepseek-ai/dsh-tool-fs'
      config: { read: true, readImage: false, write: true, edit: true }
    - id: tool-fs-search
      name: '@deepseek-ai/dsh-tool-fs-search'
    - id: shell-pwsh
      name: '@deepseek-ai/dsh-tool-pwsh-persistent'
      disabled: !!js process.platform !== 'win32'
      config: { timeoutMs: 300000 }
    - id: shell-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
      disabled: !!js process.platform === 'win32'
      config: { timeoutMs: 300000 }
    - id: todo
      name: '@deepseek-ai/dsh-tool-todo'          # 可选，多步任务很有用

    # ── 权限：三档预设 + 逐条审批 ────────────────────────────────────
    - id: user-approval
      name: '@deepseek-ai/dsh-user-approval'
      config:
        policy: ask                               # 默认询问；never 供 CI
    - id: permission-presets
      name: '@deepseek-ai/dsh-permission-presets'
      config:
        defaultPreset: guarded
        presets:
          read-only:   { sandbox: read-only,           approval: never }
          guarded:     { sandbox: workspace-write,     approval: ask   }
          full:        { sandbox: danger-full-access,  approval: never }
    - id: approval-cli
      name: '@dsh-lite/approval-cli'
    - id: timeout-policy
      name: '@deepseek-ai/dsh-timeout-policy'      # 可选
    - id: repeat-reminder
      name: '@deepseek-ai/dsh-repeat-tool-reminder' # 可选：模型反复调同一工具时提醒

    # ── 本项目增值：审计 + 撤销 + 界面 ───────────────────────────────
    - id: audit
      name: '@dsh-lite/audit'
      config: { db: !!js dshHomePath('audit.sqlite'), flushMs: 500 }
    - id: checkpoint
      name: '@dsh-lite/checkpoint'
      config: { dir: !!js dshHomePath('ckpt'), maxFileMB: 2, keepTurns: 30 }
    - id: tui
      name: '@dsh-lite/tui'

    - id: sessions
      name: '@deepseek-ai/dsh-session-persistence-jsonl'
      config:
        root: !!js dshHomePath('sessions')
        compression: none
```

**注册一个新 profile**：在 `packages/boot/app-boot/src/profile.ts` 的 shipped 模板表里加一项（现有 `sdk-minimal` 就在第 192 行）：

```ts
'lite': { bundles: ['@dsh-lite/dsh-lite-bundle'] },
```

之后 `dsh lite` 即可启动；`dsh plugin --profile lite add <pkg>` 仍可用（但我们不宣传）。

---

## 5. 五个新包的设计

### 5.1 `@dsh-lite/llm-openai`（模型适配器）

**为什么必须写**：DSH 只随发行版提供 DeepSeek 的 *Messages* wire（`dsh-llm-deepseek`，baseURL 可改但协议不可改，源码里明确 `protocol is not configurable`）。而现场几乎所有网关（one-api、vLLM、LM Studio、Ollama、Kite 用的 `127.0.0.1:19790`）都是 **OpenAI `/v1/chat/completions`**。

**做法**：以 `packages/llm/llm-deepseek/src/adapter.ts` 为模板（同一个 seam、同一套 `assistant-stream` / `tool_calls` 词汇），只换 wire：

| 关注点 | 实现要点 |
|---|---|
| 请求 | `POST {baseURL}/chat/completions`，`stream: true`，`tools: [{type:'function', function:{name,description,parameters}}]` |
| 流式 | 逐行 `data: {...}`；`choices[0].delta.{content, reasoning_content, tool_calls}`；`[DONE]` 收尾 |
| 工具调用 | `delta.tool_calls[i].function.arguments` **分片拼接**，按 `index` 聚合后再解析 JSON（这是最容易写错的地方） |
| 用量 | `usage` 常在最后一帧（需 `stream_options:{include_usage:true}`）；缺失时回退 token-meter 估算 |
| 错误 | 429/5xx 抛可重试错误交给 `llm-retry`；4xx 抛终止错误 |
| 能力声明 | `contextWindow`、`supportsTools`、`supportsVision:false`（A 档不需要图片） |
| 兼容开关 | `extraBody`（透传 `temperature/top_p/thinking` 等厂商字段）、`reasoningField`（`reasoning_content` vs `reasoning`） |

### 5.2 `@dsh-lite/approval-cli`（审批应答者）

DSH 的审批是**一次性、fail-closed、无 allow-always**（官方文档明确「仅存在一次性授权」）。这正好符合 A 档「逐条确认」的定位。

```ts
// 形状示意，签名以 ctx.approval / approval-request 类型为准
export const name = 'approval-cli'
export function apply(ctx: Context, config: { mode: 'ask' | 'yes' | 'no' }) {
  // 作为 approval/request waterfall 的最终应答者
  ctx.on('approval/request', async (req, next) => {
    if (config.mode === 'no')  return { kind: 'denied',   reason: '--deny' }
    if (config.mode === 'yes') return { kind: 'allowed-once', reason: '--yes' }
    return { kind: await ctx.tui.ask(req.tool, req.reason), reason: 'user' }
  })
}
```

展示给用户的三要素（固定格式，别让人读长文）：**要做什么 / 影响哪些文件或路径 / 一条可复制的命令**。

- 无人值守：`--yes` 仍需 `--mode full` 才放行写操作；`--mode read-only` 下 `--yes` 也写不进去（策略在 waterfall 之前生效）。
- CI：`DSH_LITE_APPROVAL=no`，等价 Kite 的 `policy = never`。

### 5.3 `@dsh-lite/audit`（审计账本）

**唯一真相仍是 session 事件日志**；SQLite 只是投影，随时可 `rebuild`。

```sql
CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, turn INTEGER, step INTEGER,
  req_id TEXT NOT NULL UNIQUE, tool TEXT NOT NULL, args_json TEXT NOT NULL,
  caller TEXT NOT NULL,                 -- local
  decision TEXT,                        -- allowed-once | denied | cancelled
  status TEXT NOT NULL,                 -- running|done|failed|denied
  ok INTEGER, exit_code INTEGER, error TEXT,
  ms INTEGER, out_bytes INTEGER, truncated INTEGER DEFAULT 0,
  started_at INTEGER, finished_at INTEGER);
CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, turn INTEGER, step INTEGER,
  model TEXT NOT NULL, msgs INTEGER, tools_n INTEGER,
  prompt INTEGER, completion INTEGER, cache_read INTEGER,
  ms INTEGER, finish TEXT, http_status INTEGER, error TEXT, at INTEGER NOT NULL);
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, req_id TEXT NOT NULL,
  tool TEXT NOT NULL, reason TEXT, decision TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, title TEXT, cwd TEXT, model TEXT, preset TEXT,
  created_at INTEGER, updated_at INTEGER, events_n INTEGER);
```

写入策略：**订阅内存中的 `session/event`，攒批 500 ms 落库，写失败降级为 JSONL 追加**——审计绝不能阻断主链路。

命令：
```
dsh lite audit                 # 最近 20 次工具调用
dsh lite audit --tool bash -n 100
dsh lite audit --session <id> --json
dsh lite audit rebuild         # 从 sessions/*.jsonl 全量重建
```

### 5.4 `@dsh-lite/checkpoint`（写前快照 + 撤销）

监听 `fs/write-intent`、`fs/edit-intent`（`tool-fs` 的变更都从这两个事件走），在**真正落盘前**保存旧内容：

```
~/.dsh-lite/ckpt/<session-id>/<turn>-<step>-<callid>/
    manifest.json
    files/0000
    files/0001
```

```json
{
  "turn": 7, "step": 2, "call": "call_a1b2", "tool": "edit",
  "at": 1795429166805, "cwd": "E:\\work\\proj",
  "files": [
    {"path":"src/app.ts","existed":true,"before_sha256":"…","bytes":12914,"skipped":false},
    {"path":"src/new.ts","existed":false,"skipped":false}
  ]
}
```

规则：
- 单文件 > `maxFileMB`（默认 2 MB）或二进制 → `skipped: true`，撤销时跳过并明确提示
- 同一轮内同一文件多次修改只留**最早**那份（撤销 = 回到轮次开始）
- 撤销前校验当前 sha256：不一致要求 `--force`，并打印 diff 让人确认
- 保留最近 `keepTurns`（默认 30）个轮次，超出按 LRU 删

命令：`/undo`（TUI 内，撤销上一轮）、`dsh lite undo <session> --turn 7`。

### 5.5 `@dsh-lite/tui`（界面）

用 **Ink（React for CLI）**，与 agent 同进程，直接读 `session/event` 流渲染。

```
┌ dsh-lite ─────────────────────────────────────────────────────────────┐
│ E:\work\proj   deepseek-chat   guarded   12.4k/131k tok   turn 7      │
├───────────────────────────────────────────────────────────────────────┤
│ › 把 parseConfig 里重复的校验抽成一个函数，然后跑测试                    │
│                                                                       │
│ ⚙ read  src/config.ts                                       12 ms ✓  │
│ ⚙ read  src/parse.ts                                         9 ms ✓  │
│ ⚙ edit  src/config.ts          +18 −26   [d] 查看 diff        31 ms ✓  │
│ ⚙ bash  pnpm test --silent                                  8.2 s ✗  │
│   ✗ 1 failed: parse.test.ts:44  expected 3, got undefined             │
│                                                                       │
│ 测试挂了。失败原因是 parse() 在空输入时返回 undefined 而不是默认配置。   │
├───────────────────────────────────────────────────────────────────────┤
│ › ▊                                        @ 引用文件 · / 命令 · ⇥ 补全 │
└───────────────────────────────────────────────────────────────────────┘
```

审批弹窗（覆盖输入区，单键决策）：

```
┌ 需要确认 ──────────────────────────────────────────┐
│ bash  在 E:\work\proj 执行:                        │
│   pnpm test --silent                               │
│ 影响：只读运行测试，可能写入 node_modules/.cache     │
│ [y] 允许一次   [n] 拒绝   [d] 看完整参数   [Esc] 取消 │
└────────────────────────────────────────────────────┘
```

必备交互：`Ctrl-C` 中断当前轮（不是退进程）、`Esc` 取消审批、`↑` 历史、`@` 文件补全（用 `fs/list`）、`/undo` `/mode` `/resume` `/audit` `/clear`。

> **复用提醒**：别自己维护消息状态。渲染源是 `session/event`，重启后能原样恢复；这也是 DSH 的「模型可见即已记录」带来的白送好处。

---

## 6. 关键机制

### 6.1 会话与续跑

```
~/.dsh-lite/sessions/<session-id>/session.v1.jsonl
```

- 一个会话一个目录，append-only；崩溃最多丢最后一条
- `--resume <id>` / `--continue`（最近一个）
- fork：`/fork` 从当前轮次复制（`session/fork` 已内置）
- 不需要数据库；SQLite 只服务审计查询

### 6.2 工具集（A 档就这 7 个）

| 工具 | 来源 | 关键约束 |
|---|---|---|
| `read` | tool-fs | 行号返回；> 2k 行提示分段 |
| `write` | tool-fs | 全量覆盖；先读后写（`fs/observed` 守卫） |
| `edit` | tool-fs | 精确串替换；失败要回显「找到了几处」 |
| `glob` | tool-fs-search | 内置 ripgrep 的 glob |
| `grep` | tool-fs-search | 输出上限 250 行，超出报「完整结果已保存到…」 |
| `bash` / `pwsh` | tool-{bash,pwsh}-persistent | 超时 300 s；输出截断并标记 `truncated` |
| `todo_write` | tool-todo（可选） | 多步任务可见化 |

**截断策略**（Kite 的经验，务必照做）：工具结果超过 `max_output_bytes`（默认 64 KB 文本 / 128 KB 命令输出）时只留头尾，中间写「省略 N 字节，完整内容在 `~/.dsh-lite/spill/<id>.log`」。这是上下文炸掉的头号原因。

### 6.3 三层权限（照 Kite，但语义更明确）

```
第 1 层 预设（会话级，可 /mode 切）
        read-only   → 写/执行一律拒，不问
        guarded     → 写/执行逐条问（默认）
        full        → 不问，但仍有目录白名单
第 2 层 沙箱策略（sandbox-policy）
        workspaceRoot 内的写放行；外出写 = 越界 → 触发审批或拒绝
第 3 层 逐条审批（user-approval）
        一次一授权，不记忆、不可批量，无应答者 = 拒
```

**刻意不加**「总是允许」：Kite 的 `approval_remember` 是它最危险的设计之一；A 档不需要，加了迟早出事。

### 6.4 上下文预算

- `token-meter` 计量 → `compaction-basic` 在 70% 时压缩
- 压缩前把「已读文件清单 + 当前计划」写进摘要，避免压缩后重复读同一文件
- 每轮结束记录 `prompt/completion/cache_read` 到 `llm_calls`，`dsh lite audit --cost` 看趋势

### 6.5 配置

`~/.dsh-lite/config.yml`（优先级低于环境变量，高于默认值）：

```yaml
model: deepseek-chat
baseURL: https://api.deepseek.com/v1
mode: guarded            # read-only | guarded | full
approval: ask            # ask | yes | no
limits:
  maxOutputBytes: 65536
  commandTimeoutSec: 300
  maxStepsPerTurn: 40
compaction: { thresholdRatio: 0.7, keepRecentTokens: 20000 }
```

环境变量：`DSH_LITE_HOME`、`DSH_LITE_API_KEY`、`DSH_LITE_MODEL`、`DSH_LITE_BASE_URL`、`DSH_LITE_MODE`、`DSH_LITE_APPROVAL`。

---

## 7. 目录结构

**方案一（推荐）：在 monorepo 内加包，跟随上游升级**

```
deepseek-harness-master/
├─ packages/bundle/lite/            # 新：bundle（patch + package.json + profile 注册）
├─ packages/lite/                   # 新：5 个包的目录
│  ├─ llm-openai/
│  ├─ approval-cli/
│  ├─ audit/
│  ├─ checkpoint/
│  ├─ tui/
│  └─ app/
└─ (其余不动)
```

**方案二：独立仓库**，只依赖 npm 上 `@deepseek-ai/dsh-*` 的已发布版本，自己写 Cordis 树。
优点：仓库干净、发版独立；缺点：`0.2.1-rc.2` 是 dev preview，peer 依赖与版本窗口会持续咬人。

> 建议先用方案一（改起来最快、能直接跑上游测试），稳定后再抽成独立仓库。

---

## 8. 里程碑

| # | 里程碑 | 交付 | 验收 | 人日 |
|---|---|---|---|---|
| M0 | 骨架 | 复制 sdk-minimal → lite bundle，注册 profile，`dsh lite "hi"` 有输出 | 能跑通一次只读问答 | 1 |
| M1 | 模型通路 | `llm-openai` 适配器（流式 + tool_calls + usage） | 对着 vLLM/DeepSeek 网关跑通工具调用 | 3 |
| M2 | 工具 + 权限 | 7 个工具、三档预设、`approval-cli`（y/n/--yes） | 改文件必弹一次；read-only 下写不进去 | 3 |
| M3 | TUI | Ink 界面：流、工具卡片、审批弹窗、输入、中断 | 全程不退出终端完成一次改代码任务 | 5 |
| M4 | 审计 | `audit` 包 + 4 张表 + `lite audit` 命令 + rebuild | 每次工具调用可查 args/退出码/耗时 | 3 |
| M5 | 撤销 | `checkpoint` 包 + `/undo` + `lite undo` | 撤销后 `git diff` 为空；冲突能拦住 | 3 |
| M6 | 打磨 | 截断/溢出落盘、`--resume`、配置、SEA 打包、8 条 e2e | 冷启动 < 1.5 s，RSS < 250 MB | 4 |
| | | | **合计** | **22 人日** |

**最小可用（M0–M3）= 12 人日**，单人 2.5 周；完整 A 档 = 4.5 周。比从零写（8–10 周）省 60%。

---

## 9. 验收用例（8 条 e2e）

1. `dsh lite "读 README 并总结"` → 只调 `read`，无写操作，退出码 0
2. 「把 X 改成 Y」→ 恰好弹一次审批；选 `n` 时文件字节不变
3. `--mode read-only --yes` → 写操作仍被拒，且模型收到明确的拒绝结果
4. 执行中 `Ctrl-C` → 当前轮取消、会话可继续、无半条 `tool/result`
5. 杀进程后 `--resume` → 历史完整、能接着上次继续
6. `dsh lite audit` → 每次调用都有 `args/exit_code/ms/out_bytes`
7. `/undo` → 恢复上一轮所有被改文件，`git status` 干净
8. 连续 10 轮工具调用 → 触发压缩、不重复读同一文件、能跑完

---

## 10. 风险与取舍

| 风险 | 影响 | 对策 |
|---|---|---|
| 上游 dev preview 破坏性变更 | 中高 | 锁 `0.2.1-rc.2`；只依赖公开 seam（`ctx.tools`/`ctx.session`/`ctx.approval`）+ 4 个 `fs/*` `tools/*` 事件；每两周做一次升级回归 |
| Cordis 学习曲线 | 中 | 只写 5 个插件、不做动态加载；抄 `sdk-minimal` 与 `headless` 两棵树 |
| Node 分发体积 | 低 | 优先 `npm i -g`；要单文件再上 Node SEA（~90 MB） |
| Windows ConPTY 坑 | 中 | A 档先不做持久终端，一次性 pwsh 足够；真需要再上 `dsh-terminal` |
| 审批阻塞事件循环 | 中 | 审批走异步 Promise + Ink 渲染，session append 不等 UI |
| 审计写库拖慢主链路 | 中 | 批量 500 ms + 失败降级 JSONL；`audit` 包整体可 disable |
| 沙箱不是真隔离 | 中 | 文档写清「这是防手滑，不是防恶意」；需要强隔离时换容器后端（`ctx.sandbox` 可替换） |

---

## 11. 附：与 Kite A 档逐项对照

| Kite A 档能力 | 本方案实现 | 差异 |
|---|---|---|
| 会话式 Agent + 工具循环 | DSH `agent-loop` | 更严格（事件溯源、请求可重建） |
| 6 个核心工具 | `tool-fs` / `tool-fs-search` / `tool-{bash,pwsh}` | 命名不同（read/edit/glob/grep），能力等价 |
| 三层权限 + 逐条审批 | `permission-presets` + `sandbox-policy` + `user-approval` | 多一个「沙箱模式」维度；无 allow-always（更安全） |
| exec_log 审计 | `audit` 包 → `tool_calls` 表 | 字段对齐，且可从事件重建 |
| checkpoint + fs.undo | `checkpoint` 包 | 轮次级撤销（Kite 是调用级） |
| 结果截断 + 落盘 | `maxOutputBytes` + spill 文件 | 一致 |
| 上下文压缩 | `compaction-basic` + `token-meter` | 一致，可调阈值 |
| 桌面 UI | Ink TUI | 轻；需要 GUI 时再上 `dsh web` |
| 多机 / 云端 / 插件市场 | 不做 | 边界即轻量 |

---

## 12. 发行体积测算（实测）

### 12.1 构成（Windows x64）

| 组成 | 未压缩 | 压缩后（LZMA 2.9:1，与 Kite 实测同口径） | 说明 |
|---|---|---|---|
| `node.exe`（Node 24 随附版） | **89.2 MB** | ≈ 30.8 MB | 硬地板，V8 + ICU + libuv |
| DSH 核心包 JS（15 个已构建包实测 3.78 MB） | ≈ 5 MB | ≈ 1.3 MB | 纯 JS + `.d.ts`，可再剥类型 |
| 第三方依赖（cordis / ink / react / commander） | ≈ 6 MB | ≈ 1.8 MB | Ink 只用到子集 |
| `rg.exe`（@vscode/ripgrep） | ≈ 5 MB | ≈ 1.5 MB | 可省，但 grep 慢 5–10× |
| 本项目 5 个新包 | ≈ 0.3 MB | ≈ 0.1 MB | |
| **合计** | **≈ 105 MB** | **≈ 35 MB** | NSIS 安装包 |

### 12.2 三种发行形态

| 形态 | 下载 | 安装后磁盘 | 前置依赖 | 额外工期 |
|---|---|---|---|---|
| npm 全局包（不自带 Node） | **4–7 MB** | 25–30 MB | 用户已有 Node ≥ 22.5 | 0 |
| SEA 单文件 exe / NSIS | **32–36 MB** | 95–105 MB | 无 | +3 人日 |
| 7z SFX（LZMA2 替代 NSIS） | **29–32 MB** | 95–105 MB | 无 | +1 人日 |
| Rust 重写（Kite 路线） | **6–10 MB** | 15–25 MB | 无 | +40–55 人日 |

### 12.3 Kite 为什么能做到 9 MB

三个前提，缺一不可：

1. **Rust 静态二进制**：`kite.exe` 17.75 MB + `kite-desk.exe` 9.25 MB，无运行时（V8/CLR/JVM 一个都没有）
2. **Tauri 用系统 WebView2**：不打包 Chromium（Electron 是 150 MB 起步）
3. **NSIS LZMA solid**：27.45 MB payload → 9.16 MB，压缩比 2.9:1

Node 路线只能满足第 3 条。`node.exe` 一个文件 89 MB，压缩后 30 MB —— 这是不可逾越的地板，**Node 永远做不到 9 MB**。

> 反向提醒：Kite 的 9 MB 依赖目标机已装 WebView2。Windows 10 1803+ 通常自带，但干净的 Server / LTSC 镜像上缺 WebView2 时，实际安装体积要再加 40–100 MB。所以「9 MB」并不完全等于「轻」。

### 12.4 如果 9 MB 是硬指标

只有一条路：**把 DSH 从「运行时依赖」降级为「设计参考」，用 Rust 重写**。

- 参考 Kite 的规模：核心 17.75 MB + TUI（无 WebView）≈ 3–5 MB → 安装包 8–10 MB
- 代价：agent loop / 事件日志 / 审批流水线 / 压缩全部自己写，40–55 人日
- 折中：先按本方案用 Node 出 MVP（2.5 周验证产品价值），确认值得再做 Rust 重写；届时 Cordis 树的形状可以直接映射成 Rust 的 trait 装配

---

*本方案基于仓库内 `docs/architecture.zh.md`、`docs/tool-execution-pipeline.zh.md`、`packages/bundle/sdk-minimal/cordis.patch.yml`、`packages/interaction/{user-approval,permission-presets}`、`packages/fs/*`、`packages/llm/*` 的实际源码与文档；包名、配置字段、事件名均取自仓库，未执行任何构建。*
