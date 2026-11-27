# PackLeader

轻量单机 Agent：读文件、跑命令、改代码，带审批、审计、撤销、续跑。

零依赖、零构建：Node ≥ 22.18 直接跑 TypeScript，不需要 `npm install`，不需要打包器。

```bash
node src/cli.ts doctor     # 先自检：node / shell / 数据目录 / 端点 / 模型
npm run demo               # 离线 demo，不需要 API Key
```

- 命令行：单次执行 / 交互模式 / 审计 / 撤销 / 会话列表
- 桌面窗口：`pl gui`，原生 WPF 窗口（.NET Framework 4.8 + Windows PowerShell 5.1，系统自带），不是 Electron、没有 web 服务和端口
- 23 个工具，含跨会话记忆（`remember`，按工作目录分文件，界面上可撤销）和截图验证（`screenshot` / `view_image`）
- 安装包：684 KB 自解压 exe + 216 KB 便携版，不含 Node 运行时

---

## 一、功能

### Agent 主循环
turn → step → tool batch，事件全量落盘，`--max-steps` 保护；步数用尽时强制收尾作答，不会只留一堆工具日志没有结论。

### 23 个工具

| 类别 | 工具 |
|---|---|
| 文件 | `read` `write` `edit` `glob` `grep` `list` `find` `outline` `stat` `hash` `move` `remove` |
| 运行时 | `shell` `logtail` `processlist` `netprobe` `sysstat` `waitfor` |
| 界面 | `screenshot`（截窗口/整屏，可选先点一下再截）`view_image`（把图片交回给模型看） |
| 便签 | `todo_write`（界面画成「执行方案」清单，反复写就原地更新进度） |
| 交互 | `ask`（向用户提一个选择题，界面画成选项卡） |
| 记忆 | `remember`（写进 `<数据目录>/memory/<cwd 指纹>.jsonl`，下一轮起进系统提示；界面上带「撤销」） |

工具结果超长会截断（head 60% / tail 25%），完整输出落到 `spill/` 并给出路径。

**截图验证界面**：`screenshot` 用 Windows 自带的 PowerShell + System.Drawing + `PrintWindow` 截窗口（也可以 `target=screen` 截整屏），PNG 落在 `<数据目录>/shots/`，太宽的图会先等比缩到 1600 宽（`max_width` 可调）；`click:"x,y"` 可以先在窗口内点一下（展开菜单、切标签）再截。图片不进 `session.jsonl`（日志里只有路径，二进制请求前才读成 base64），下一轮请求时作为一条 `user` 消息跟在 `tool` 结果后面交回给模型——tool 消息正文只能放文本，图得单给，但又不能插在 `tool_calls` 与 `tool` 中间。关掉「模型支持看图」时只保留路径、不塞 base64。`view_image` 用来把设计稿、已有的截图交给模型看（`read` 读图片是二进制乱码，别用它）。

只读工具（`permission: 'read'`）在同一批里并行跑，写类工具独占执行；落盘顺序仍按模型给的顺序，保证 `tool` 消息和 `tool_calls` 对齐。

### 三档权限 + 一次性审批

| 模式 | 读 | 写文件 | 执行命令 | 越界写 |
|---|---|---|---|---|
| `read-only` | ✅ | ❌ 直接拒 | ❌ 直接拒 | ❌ |
| `guarded`（默认） | ✅ | 逐条询问 | 逐条询问 | ❌ 直接拒 |
| `full` | ✅ | ✅ | ✅ | ✅ |

- 审批是一次性的，没有「总是允许」。
- 没有可用审批通道时一律拒绝（fail-closed；非 TTY 默认拒，CI 用 `--deny`）。
- `--yes` 只跳过询问，突破不了 `read-only`。
- 被 `--yes` 放行的记录在审计里标 `auto`，与人手动批准区分。
- 命中危险清单的命令（`rm -rf`、`git reset --hard` / `push -f`、`DROP TABLE`、无 `WHERE` 的 `DELETE FROM`、`mkfs` / `diskpart` / `format`、`dd if=`、下载内容管道进 shell、关机重启、`taskkill /f`、`chmod -R 777` / `icacls /grant`）**`full` 档也要问一次**。这不是沙箱，只是让「跑测试」和「删库」在审批卡上长得不一样。

### 可续跑 / 可撤销 / 可审账 / 可重建

- **续跑**：`--resume <id>` / `--continue`，从 JSONL 事件日志重建对话，崩了最多丢最后一条。
- **撤销**：写前快照 + 轮次级回滚（`pl undo --turn N`），检测外部改动冲突，冲突时拒绝覆盖（`--force` 才强来）；超过 2 MB 的文件不拍快照（`maxFileMB` 可调），撤销时列进 skipped 并说明。
- **审计**：SQLite 投影记录工具调用 / 模型调用 / 审批结论 / 成本，`pl audit [-n N] [--cost] [--json]`。
- **重建**：`pl audit rebuild` 从会话日志重放，连工具参数和审批结论都能还原。

### 长上下文处理
每轮请求前估算历史字符数，超过 `maxContextChars`（默认 240 000）就从最早的消息开始压缩：工具结果压到 600 字（还不够再压到 200 字）、助手长文 1200 字、用户输入 1500 字，压成「首行 + 已压缩 N 字符」，最近 6 条一律不动。只丢细节、不额外发一次模型调用去总结。

### 自动验证闭环
本轮只要有 `write` / `edit` 成功落盘，收尾前自动跑一遍项目测试：认 `package.json` 的 `scripts.test`（按 lockfile 选 npm / pnpm / yarn）、`Cargo.toml`、`go.mod`、`pytest.ini`；认不出就跳过并说明。失败输出回灌给模型让它自己修，默认只重试 1 轮（`maxVerifyRounds`），超时 180s。关掉用 `--no-verify`，指定命令用 `--verify "node --test"`。

### 性能日志与卡顿定位

启动慢、用着卡、一轮没反应——光靠 `%TEMP%\packleader-ui.log`（每次启动清空、只有启动打点和异常）没法复盘。所以另有一套结构化的 perf 日志：

- **在哪**：`%LOCALAPPDATA%\PackLeader\perf\`，按天分文件、一行一条 JSONL（`launcher-` / `ui-` / `host-` / `node-` 各写各的），保留 7 天、单文件封顶 20 MB。几个进程写同一个 `run` 与同一个 t0，所以按 `mono`（距离双击多少毫秒）能把「双击 → 窗口 → 一轮回答」拼成一条时间轴。
- **档位**：`config.json` 的 `perf` 字段（`off` / `basic`（默认）/ `full`），也可以 `--perf full`。`basic` 记启动分段、卡顿、帧率（10 秒一条）、事件、首字、慢工具；`full` 连每条事件、每秒帧率、队列深度都记。
- **记了什么**：启动各段（启动器 / PS 进程 / WPF 载入 / XAML / 首帧 / host 就绪）、界面主线程断档（一次断档一条，带当时是否在跑）、帧率、输出队列积压、每条事件画了多久、交互动作、从点发送到第一段可见输出、每轮的 delta 数与首字延迟、慢工具（≥5 s）、host 的 event loop 迟到、每 5 秒一次的 CPU / 内存。
- **三种「卡」分开记**：主线程心跳断档＝脚本占住了 UI 线程；帧率掉＝画得慢但主线程活着；队列变长＝ host 吐得快、界面消化不掉。只记其中一种会把原因误指到别处。
- **怎么看**：`pl perf`（默认最近 3 次启动）打印启动分解、卡顿/帧率/队列、每轮首字、慢工具和规则化建议；`--runs N` 看更多次，`--dir` 换目录。建议只报「量确实超了」的项，并指向具体那一段（比如「启动到窗口 1.24s（PS 进程 165ms · WPF 载入 230ms）」），不写「建议优化性能」这种空话。

### 桌面窗口（`pl gui`）
- 左侧会话列表：分组（右键重命名 / 移到分组 / 取消分组 / 删除）、悬停露出垃圾桶图标删除（深色界面上 `×` 太像关窗口，所以换掉了）、当前会话删掉会自动新建一个
- 消息流 + Markdown 渲染、代码块卡片（右键复制 / 复制整段对话）、工具行 `⚙ read src/host.ts ✓ 1ms`
- 一轮的「思考 + 工具」画成时间线：顶部状态行、可折叠的思考摘要卡、按工具名聚合的折叠组，点某一行看这次的入参和结果
- 打开历史会话时，每一轮的过程默认收起，只留轮头（状态 + 工具汇总）和最后的结论，点轮头再展开；正在跑的那一轮照旧实时展开；收起的思考条只留一行摘要，正文要等点开那一条时才渲染
- `todo_write` 的结果画成「执行方案」清单卡片，带 `n/m` 进度
- 记忆卡片：本轮记下的事实直接显示，带「撤销」按钮，不用去翻 `memory/*.jsonl`
- 审批卡片（允许一次 / 拒绝 / 看参数）+ 权限三档切换
- 设置面板：端点地址、API Key（端点不校验鉴权时可以留空）、模型名（可点「拉取」走 `GET {baseURL}/models`）、验证命令、模型是否支持看图；保存即生效
- 附件：`+ 附件` 按钮 / `Ctrl+V` 粘贴 / 拖拽入窗；图片可点开看大图。文本（≤120 KB）内联进上下文，图片走 `image_url`，其它只给路径和大小；所有附件先拷进 `<数据目录>/files/<会话id>/`
- 会话进行中可以「插话」：这句话直接落进当前上下文，模型下一步就能看到，不中断正在跑的工具
- 长会话按需分页加载历史（滚到顶部继续拉）、提问缩略索引可直接跳转；单条正文 / 思考超长时先画一段，点「展开」再画剩下的
- 本会话用量与缓存命中率、停止、换目录、新对话、↑↓ 翻输入历史

### 模型与超时配置
OpenAI 兼容流式适配器：`tool_calls` 按 index 分片聚合、`reasoning_content`、缓存命中统计。

配置写在 `<数据目录>/config.json`（默认 `~/.packleader/config.json`），优先级 **命令行 > 环境变量 > config.json > 内置默认**：

```json
{
  "baseURL": "http://127.0.0.1:19790/v1",
  "apiKey": "sk-...",
  "model": "deepseek-flash",
  "vision": true,
  "firstByteSecs": 120,
  "idleSecs": 180,
  "requestSecs": 900
}
```

| 字段 | 含义 | 默认 |
|---|---|---|
| `verify` | 验证命令；留空＝自动识别 | 空 |
| `vision` | 模型能不能看图（开了才把图片作为 image part 发过去） | `true` |
| `firstByteSecs` | 请求发出到收到第一个字节（取值 5–3600） | 120 秒 |
| `idleSecs` | 流式输出中两段数据之间最长间隔（取值 5–3600） | 180 秒 |
| `requestSecs` | 单次请求整体上限（取值 30–7200） | 900 秒 |
| `perf` | 性能日志档：`off` / `basic` / `full` | `basic` |
| `providers` | 多个模型供应商（每项 `id` / `name` / `baseURL` / `apiKey` / `model` / `models`） | 无（单家时折算成 `p-default`） |
| `activeProvider` | 当前用哪一家 | 最后用的那家 |
| `models` | （每家供应商里）拉取过的模型列表，菜单直接用它，不必每次等网络 | 自动缓存 |

超时项在界面上暂不暴露，手改 `config.json` 即可；别的字段在设置面板里都能改。长上下文一轮下来上下文十几万 token 时，服务端 prefill 就可能一两分钟才吐第一个字，所以默认放宽到 120 秒；网关更慢就写 300 / 600。界面上 Key 输入框永远留空，只显示 `sk-p…3456` 这类掩码。端点不校验鉴权（本地 llama.cpp、内网中转之类）时 `apiKey` 可以不填——请求里干脆不带 `authorization` 头，省得发一个空的 `Bearer `。

### 多个供应商：在对话框里换模型

`config.json` 可以写好几家（OpenAI 兼容就行），`activeProvider` 指当前这家；顶层 `baseURL` / `apiKey` / `model` 只是当前生效值的快照，换一家会跟着变：

```json
{
  "providers": [
    { "id": "p-default", "name": "DeepSeek 账号", "baseURL": "https://api.deepseek.com/v1", "apiKey": "sk-...", "model": "deepseek-chat" },
    { "id": "p-gw",      "name": "公司网关",     "baseURL": "http://127.0.0.1:19790/v1", "apiKey": "sk-...", "model": "deepseek-flash" }
  ],
  "activeProvider": "p-gw"
}
```

对话框右下角的模型按钮点开就是一个菜单：顶上搜索框按名字过滤，下面按供应商分组，当前在用的那一行打 ✓，点任一行就切到「那家的那个模型」——立刻生效并写回 `config.json`，下一句就打到那家，不用重启。

每家拉过一次模型列表（菜单里一个模型都没有时点一下按钮就会去这家端点的 `/models` 拉，一家连不上不影响别家）后，结果记进这家的 `models`，下次打开菜单直接显示、不再等网络；菜单里列的是端点报的模型名，外加这家自己的当前 `model`。设置面板里拖「拉取模型」也走同一套缓存。

### 数据目录
默认 `~/.packleader`（`PACKLEADER_HOME` 可改）：

```
~/.packleader/
├─ sessions/<id>/session.jsonl    # 唯一真相：append-only 事件日志
├─ sessions/<id>/meta.json        # 会话元信息（标题 / 分组），不进模型历史投影
├─ audit.sqlite (+ -wal/-shm)     # 投影：tool_calls / llm_calls / approvals / sessions
├─ logs/tool-calls-YYYY-MM-DD.jsonl  # 工具调用的逐行流水（SQLite 不可用时也能查）
├─ ckpt/<session>/<turn>-<step>-<call>/   # 写前快照 + manifest
├─ files/<会话id>/                 # 附件副本
├─ memory/<cwd 指纹>.jsonl         # 长期记忆，按工作目录分文件
├─ spill/<ts>-<sha>.log           # 被截断的完整输出
├─ ui-layout.json                  # 窗口尺寸 / 分栏宽度
└─ config.json                    # 模型配置（含 API Key）
```

### 已知没做
diff 预览、窗口无边框自绘标题栏、全屏 TUI、内置 ripgrep、SEA 单文件分发。

---

## 二、启动方式

### 前提
- **Node ≥ 22.18**（直接用 Node 跑 `.ts`，不需要装依赖、不需要编译）
- Windows 上桌面窗口还要 .NET Framework 4.8 + Windows PowerShell 5.1（都是系统自带）
- 用一个 OpenAI 兼容的模型端点

### 从源码启动
```bash
node src/cli.ts doctor          # 1) 自检：node 版本 / shell 解析 / 数据目录可写 / 端点可达 / 模型存在

export PL_API_KEY=sk-...        # 2) 配置模型（Windows cmd 用 set PL_API_KEY=...）
export PL_BASE_URL=https://api.deepseek.com/v1
export PL_MODEL=deepseek-chat

node src/cli.ts --mode read-only "这个仓库用什么构建？"   # 3) 只读试一下
node src/cli.ts --cwd D:/work/myproj "把 config.ts 里重复的校验抽成一个函数"   # 4) 让它改代码
node src/cli.ts gui             # 5) 打开桌面窗口
node src/cli.ts                 # 6) 交互模式

npm test                        # 跑测试（node --test，零依赖）
```

也可以不配环境变量，直接在窗口的设置面板里填端点 / Key / 模型（第一次启动没 Key 会自动弹出设置面板）。

装成全局命令：`npm link`（`bin` 里同时挂了 `pl` 和 `packleader`），之后用 `pl` 代替 `node src/cli.ts`。

### 从安装包启动
装到 `%LOCALAPPDATA%\Programs\PackLeader` 后，开始菜单 / 桌面点 `PackLeader.exe` 开窗口。
启动链路：`PackLeader.exe`（49 KB 原生启动器，C#）→ 找系统 Node（版本低于 22.18 给中文提示）→ `node src/cli.ts gui` → WPF 窗口；没给 `--cwd` 时用上次的工作目录。

### 环境变量
`PL_API_KEY` `PL_BASE_URL` `PL_MODEL` `PL_MODE` `PL_APPROVAL` `PL_SHELL` `PACKLEADER_HOME` `PL_REPL` `PL_VISION`

也认这几个通用别名：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `OPENAI_API_KEY`（命令行与 config.json 的优先级都高于它们）。

---

## 三、打包方式

```powershell
npm run dist                                   # 构建，产物在 dist/
dist\PackLeader-Setup-0.1.0.exe                # 图形安装
dist\PackLeader-Setup-0.1.0.exe /S             # 静默安装
dist\PackLeader-Setup-0.1.0.exe --uninstall /S # 静默卸载
```

| 产物 | 大小 | 说明 |
|---|---|---|
| `dist/PackLeader-Setup-0.1.0.exe` | 684 KB | 安装包：自解压 + 开始菜单 / 桌面快捷方式 + 注册卸载项，带安装界面，支持 `/S` 静默 |
| `dist/PackLeader-0.1.0-portable.zip` | 216 KB | 便携版：解压即用，双击 `PackLeader.exe` 开窗口 |

装完占约 1.28 MB（35 个文件 = 负载 623 KB + `Uninstall.exe` 684 KB），**不含 Node 运行时**，复用系统 Node。

- 构建脚本：`scripts/build-dist.ps1`，只用系统自带的东西——`csc.exe`（.NET Framework 4.8）编译启动器和安装包，图标脚本现画，负载用自定义容器（`payload.bin`，不压缩，省一个 Compression 引用）嵌进安装包，**不需要 NSIS / Inno / WiX**。
- 负载只带运行时需要的东西：`package.json` `README.md` `src/` `ui/` + 编译出来的 `PackLeader.exe`；`*.bak` / `*.orig` / `*.map` / `*.log` 这类备份与调试残留会被跳过，不进包。
- 安装包的行为：先关掉正在运行的旧实例（否则覆盖安装 `IOException`）、文件被占用时改名再写、写 `HKCU` 卸载项、建开始菜单 / 桌面快捷方式。
- 卸载：应用和功能、开始菜单右键、或双击安装目录里的 `Uninstall.exe`（按「文件名 + 参数」识别，弹出的是卸载界面）。默认保留会话记录和 `config.json`，勾选「同时删除会话记录和配置」才清 `%USERPROFILE%\.packleader` + `%LOCALAPPDATA%\PackLeader`。

体积取舍（想免装 Node 就得换方案）：

| 方案 | 安装包 | 前提 |
|---|---|---|
| 启动器 + 系统 Node（当前） | 684 KB | 需 Node ≥ 22.18 |
| Node SEA 单文件 | 30–33 MB | 无 |
| Rust / Tauri 重写引擎 | 9–12 MB | 无 |

---

## 四、使用方式

### 命令一览

| 命令 | 说明 |
|---|---|
| `pl "任务"` | 单次执行，完成后退出 |
| `pl` | 交互模式（`/exit`（也可 `/quit`） `/undo` `/sessions` `/help`） |
| `pl --repl` | 强制交互模式（stdin 不是终端也行，便于脚本驱动） |
| `pl gui` | 打开桌面窗口 |
| `pl perf [--runs N] [--dir <d>]` | 性能报告：启动分解 / 卡顿 / 帧率 / 首字 / 慢工具 + 规则化建议 |
| `pl doctor` | 自检：node 版本 / shell 解析 / 数据目录可写 / 端点可达 / 模型存在 |
| `pl audit [-n N] [--tool X] [--session <id>] [--cost] [--json]` | 审计账本：工具调用 / 成本 |
| `pl audit rebuild` | 从会话日志重建审计库 |
| `pl undo [--turn N] [--session <id>] [--force]` | 撤销某一轮的全部文件改动；不给 `--session` 就撤最近一次会话 |
| `pl sessions` | 列出历史会话 |

常用选项：`--cwd` `--mode` `--yes` `--deny` `--model` `--base-url` `--api-key` `--resume <id>` `--continue` `--data-dir` `--max-steps` `--json` `--repl` `--show-reasoning` `--no-verify` `--verify "<cmd>"`

输出颜色：非 TTY（管道 / CI）自动关色；交互终端里想关掉就设环境变量 `NO_COLOR=1`（`--no-color` 目前只是被解析，没有真正接进渲染）。

常用 npm 脚本：`npm start`（等价 `node src/cli.ts`）、`npm test`（`node --test test/*.test.ts`）、`npm run demo`、`npm run dist`。`npm run typecheck` 需要 `tsc`，零依赖环境下不可用。

### 典型流程
```bash
pl doctor                                  # 先自检
pl --mode read-only "这个仓库用什么构建？"    # 只读问问，不改任何东西
pl --cwd D:/work/myproj "把 X 抽成函数"      # 改代码，每次写 / 执行都会问你
pl audit -n 10 --cost                      # 查账
pl undo --turn 3                           # 后悔
pl --continue "再确认一次"                  # 接着上次聊
```

### 交互模式的审批
行式界面（不是全屏 TUI）：横幅 → `›` 提示符 → 流式回答 → 工具行 `⚙ write hello.txt / ✓ 12ms`，需要写权限时插入审批框，逐条问 `[y]/[n]/[d]`：

```
┌ 需要确认 ──────────────────────────────
│ write  write 需要写权限
│ D:\work\proj\hello.txt
└────────────────────────────────────────
  [y] 允许一次   [n] 拒绝   [d] 看完整参数   (默认拒绝) y
```

想自己走一遍：`node scripts/demo-repl.ts`（假模型，秒级，含审批 → `/undo` → `/sessions`）。

### 桌面窗口的日常用法
1. 右上角「设置」填端点 / Key / 模型，点「拉取」可列出端点真实存在的模型；顺手可以填验证命令、勾掉「模型支持看图」。保存立刻生效，不用重启。
2. 输入区左边 `+ 附件` 与目录按钮（点一下换工作目录），右边依次是模型、权限（只读 / 询问 / 完全）、发送。
3. 需要动文件时会弹审批卡片：允许一次 / 拒绝 / 看参数。
4. 一轮跑着的时候再发消息就是「插话」：直接进当前上下文，不打断正在跑的工具；想彻底停下点「停止」。
5. 会话行右键可以重命名 / 移到分组；模型这轮写下的记忆会以卡片形式出现，带「撤销」。
6. 本会话用量与缓存命中率显示在窗口里；新对话随时可用。

### 安全边界（请读）
- 这是**防手滑**，不是防恶意：越界保护靠路径白名单 + 审批，不是容器隔离。
- 提示注入是真实风险，模型读到的文件内容可能诱导它执行命令；缓解手段就是审批闸门，**不要把模式长期开在 `full`**。
- `~/.packleader` 里有会话记录、记忆和 API Key，别把它提交进仓库。
