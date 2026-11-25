# PackLeader 路线图

> 起点：v0.1（2026-11-24），32 测试全绿，四组真实任务已跑通，含 5.5 GB monorepo 问答。
> 排期原则：**按实测数据排序，不按"感觉重要"排序。**

---

## 0. 现状与决定性数据

在 DSH monorepo（14.7 万文件 / 52 包）上跑"工具调用链路"问答的实测：

| 指标 | 数值 | 含义 |
|---|---|---|
| 工具调用 | 33 次 | 其中约 30 次是探索（glob/grep/read） |
| 工具耗时合计 | **4.6 秒** | 占墙钟不到 8% |
| 模型耗时合计 | **56 秒** | **约 92% 的墙钟花在等模型** |
| 单次 prompt 峰值 | **79.7k tokens** | 已用掉约 60% 上下文窗口 |
| 单轮 prompt 累计 | 426k（失败那轮 853k） | 缓存命中 82% |
| 步数 | 20（打满上限） | 探索吃掉了全部预算 |

**由此得出三条结论，它们决定了下面的顺序：**

1. **继续优化工具是低回报**——工具只占 8% 墙钟。`grep` 从 12.5s 优化到 1.0s 已经够用，再上 ripgrep 只能省 10 秒左右，不值得插队。
2. **真正的瓶颈是"每步都重发越来越大的上下文"**——prompt 峰值 80k、累计 426k。压缩上下文既省钱又提速，是唯一的量级改善。
3. **最贵的是"跑满 20 步却没用"**——那轮 0 输出。已经用"强制收尾"止血，但根因是探索成本太高，需要委派。

---

## 1. 阶段规划

### P0 · 可复现基准（0.5 天）

没有基准，后面每一步都无法证明变好了。

- 新增 `scripts/bench.ts`：跑三个固定任务，输出指标表并落 `bench/results/<timestamp>.json`
  - `fix-bug`：小仓库修 bug（正确性：测试是否转绿）
  - `big-repo-qa`：DSH 链路问答（质量：引用抽查命中数；成本：prompt 峰值 / 步数 / 墙钟）
  - `long-session`：连续 5 轮追问（触发压缩路径）
- 新增 `npm run bench`，README 记一行用法

**验收**：一条命令跑完三个任务并输出对比表；能对比两次运行的指标差异。

---

### P1 · 上下文压缩（3 天）★ 最高优先

**目标**：单次 prompt 峰值从 80k 压到 **< 40k**，且答案质量不下降（引用抽查仍 ≥ 4/4）。

两级策略，先做便宜的：

1. **工具结果老化（aging）**：超过 K 步的 `tool/result`，在 `deriveMessages()` 里替换成
   `[旧结果已压缩] 首行摘要…（完整内容见 spill/xxx.log，可再 read）`。
   我们本来就把大输出落到 `spill/`，这里只是复用。
2. **滚动摘要（summary）**：整轮数超过窗口时，让模型对更早的轮次生成 ≤ 400 token 摘要，
   落 `session/summary` 事件；`deriveMessages()` 用摘要替代那几轮原始消息。

- 改动：新增 `src/core/compaction.ts`；`events.ts`（`session/summary`）；`session.ts`（投影时应用）；
  `loop.ts`（每步前调 compactor）；`cli.ts`（`--no-compact`、阈值）；`audit.ts`（记压缩次数与节省的 token）
- 测试：aging 后 `deriveMessages` 不含旧大段内容、spill 路径仍可读；摘要事件可重放；不压缩开关生效

**验收**：`npm run bench` 的 `big-repo-qa` 任务 prompt 峰值 < 40k，步数不增加，引用抽查不下降。

**风险**：压缩丢细节 → 缓解：保留 spill 指针 + 基准里专门抽查"靠旧结果才能答对的题"。

---

### P2 · 可信三件套（2 天）

小而关键，决定"敢不敢让它动真项目"。

**2.1 验证闭环（1 天）— 已完成（2026-11-25）**
- 实现方式比原计划更进一步：不是"标记未验证"，而是**收尾前自动跑一次，红了把输出回灌给模型让它自己修**
  （最多 1 轮重试，`maxVerifyRounds` 可调）
- 触发条件：本轮有 `write`/`edit` 成功落盘；纯读的轮次不跑。识别不出测试入口就跳过并说明原因
- 认项目：`package.json` 的 `scripts.test`（按 lockfile 选 npm/pnpm/yarn）、`Cargo.toml`、`go.mod`、`pytest.ini` 等
- 改动：新增 `core/verify.ts`、`loop.ts`（外层验证轮 + `verify/*` 事件）、CLI/GUI 渲染、`--verify` / `--no-verify`
- 验收（都跑过）：假模型的 e2e 断言"失败一次→回灌→通过一次"；真实模型跑 `pl-demo` 时
  `npm test` 先 `✗ 失败 exit 1`、回灌后 `✓ 通过`；没改文件的轮次不触发验证
- 踩到的坑：PowerShell 写的 `package.json` 带 BOM，`JSON.parse` 抛异常会被误判成"没有测试入口"（已修 + 有测试）

**2.2 Ctrl+C 中断（0.5 天）**
- 当前中断等于杀进程，会话最后一条可能没落盘。改为：SIGINT → `AbortController.abort()` →
  落 `turn/end reason=cancelled` → 回到提示符，会话可 `--continue`
- 验收：运行中按 Ctrl+C，进程存活、会话文件完整、能把已完成的工具结果续上

**2.3 密钥脱敏（0.5 天）**
- 落盘前对 `sk-…`、`Authorization: Bearer …`、`--password=`、`token=…` 做遮蔽
- 覆盖 `session.jsonl`、`audit.sqlite`、`spill/*.log`（Kite 的明文 `secrets.json` 是我们要避开的坑）
- 验收：跑 `shell curl -H "Authorization: Bearer sk-xxxx"` 后，三个存储点都搜不到原文

---

### P3 · 委派子 agent（3 天）

**目标**：让探索在子上下文里发生，主 agent 只拿结论——这是把 30 次探索调用压成 2 步的关键。

- 新工具 `task(description, prompt)`：起一个子 Agent（同 policy、只读继承父模式、自己的 `session.jsonl`），
  只把最终文本返回父级；深度上限 1、子步数上限 12、token 预算
- 改动：`src/core/agent.ts` 抽出可复用构造；`src/tools/task.ts`；`session.ts`（父子目录）；`cli.ts`（`pl sessions --tree`）
- 验收：`big-repo-qa` 用 1 次 `task` + 2 步完成，父级 prompt 峰值 < 25k；子会话可在 `pl sessions` 里看到；
  测试覆盖"read-only 父级下子 agent 也写不了"和"深度超限被拒"

**风险**：子 agent 陷入循环 → 步数/时间双预算；子 agent 结论不可信 → 要求它同时返回证据（文件:行号）。

---

### P4 · 日常易用（1.5 天）

- 会话选择器：`pl` 启动时 `--resume` 支持列表选择；`/resume`、`/cost`、`/model`、`/mode` 会话内命令
- 实时状态行：`思考中 12s / 正在执行 shell…`（现在 56 秒静默，体验上像卡死）
- 可选 ripgrep：检测到 `rg` 就用它做 grep，否则回退现有实现（只值 10 秒，顺手做）
- 验收：交互模式下能切换模型/模式并立即生效；状态行在流式期间每秒刷新

---

### P5 · 分发（1.5 天）

- npm 包：`files` 已就位，补 `publishConfig`、`README` 安装段；`npm i -g packleader` 后 `pl` 可用
- SEA 单文件：`node --experimental-sea-config` + 注入脚本，产出约 33 MB 的 `pl.exe`（测算见 DESIGN §12）
- 验收：干净目录 `npm i -g` 后跑 `pl doctor` 全绿；SEA 产物在无 Node 的机器上能跑

> **已提前完成（2026-11-25）**：`npm run dist` 产出 270 KB 的 `PackLeader-Setup.exe`
> （自解压 + 快捷方式 + 卸载项，支持 `/S` 静默）和 70 KB 便携 zip，
> 装完 484 KB。用 in-box 的 `csc.exe` 编译，不需要 NSIS/Inno/WiX。
> 前置条件仍是系统 Node ≥ 22.18；要真正去掉这个前置，只剩「引擎移植成 Rust」这一条路。

---

### 不做（明确划界）

- Electron / Tauri 重打包（窗口已用系统自带的 WPF 实现，体积从 150 MB 降到 35 KB）
- 云同步 / 多模型路由 / 长期记忆库
- `allow-always` 审批（安全设计上刻意不做）
- 自研模型（Kite 的 `KAM1` 那条路不在 A 档范围内）

### 已完成（原计划外，应需求新增）

- **桌面窗口（WPF）**：`ui/PackLeader.ps1`（23 KB）+ `src/host.ts`（12 KB），NDJSON over stdio。
  流式回答 / 工具行 / 审批卡片 / 三档权限 / 换模型换目录 / 停止 / 用量。
  装完 < 1 MB（不含 Node 本体）；Node SEA 打包则是 ~30 MB，移植 Rust 才能到 9–12 MB。

---

## 2. 总计与顺序

| 阶段 | 内容 | 工期 | 依赖 |
|---|---|---|---|
| P0 | 基准 | 0.5d | — |
| P1 | 上下文压缩 | 3d | P0 |
| P2 | 验证闭环 / 中断 / 脱敏 | 2d | — |
| P3 | 子 agent 委派 | 3d | P1 |
| P4 | 日常易用 | 1.5d | — |
| P5 | 分发 | 1.5d | P2 |
| | **合计** | **11.5 人日** | |

**建议执行顺序：P0 → P2 → P1 → P3 → P4 → P5。**

理由：P2 是"敢用"的前提（2 天，最便宜）；P1 是量级改善（3 天）；P3 只在 P1 之后才有意义，
否则父级压缩了、子级又炸。P4/P5 放到能力稳定之后。

---

## 3. 每个阶段都回到同一把尺子

`npm run bench` 的三行输出应该逐阶段变好：

| 指标 | v0.1 基线 | P1 后目标 | P3 后目标 |
|---|---|---|---|
| big-repo-qa prompt 峰值 | 79.7k | < 40k | < 25k |
| big-repo-qa 步数 | 20 | ≤ 20 | ≤ 6 |
| big-repo-qa 引用抽查 | 4/4 | 4/4 | 4/4 |
| long-session 是否可用 | 会撞上限 | 可跑完 5 轮 | 同左 |
| 改完是否验证 | 靠模型自觉 | 强制 + 标记 | 同左 |

> 任何阶段如果让"引用抽查"下降，就是回退，必须解决后才能继续。
