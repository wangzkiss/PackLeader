# PackLeader

轻量单机 Agent：读文件、跑命令、改代码，带审批、审计、撤销、续跑。

零依赖、零构建：Node ≥ 22.18 直接跑 TypeScript，不需要 `npm install`，不需要打包器。

```bash
node src/cli.ts doctor     # 先自检：node / shell / 数据目录 / 端点 / 模型
node scripts/demo.ts       # 离线 demo，不需要 API Key
```

- 命令行：单次执行 / 交互模式 / 审计 / 撤销 / 会话列表
- 桌面窗口：`pl gui`，原生 WPF 窗口（.NET Framework 4.8，系统自带），不是 Electron、没有 web 服务和端口
- 安装包：270 KB 自解压 exe + 70 KB 便携版，不含 Node 运行时

---

## 一、功能

### Agent 主循环
turn → step → tool batch，事件全量落盘，`--max-steps` 保护；步数用尽时强制收尾作答，不会只留一堆工具日志没有结论。

### 19 个工具

| 类别 | 工具 |
|---|---|
| 文件 | `read` `write` `edit` `glob` `grep` `list` `find` `outline` `stat` `hash` `move` `remove` |
| 运行时 | `shell` `logtail` `processlist` `netprobe` `sysstat` |
| 便签 | `todo_write` |
| 交互 | `ask`（向用户提一个选择题，界面画成选项卡） |

工具结果超长会截断（head 60% / tail 25%），完整输出落到 `spill/` 并给出路径。

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

### 可续跑 / 可撤销 / 可审账 / 可重建

- **续跑**：`--resume <id>` / `--continue`，从 JSONL 事件日志重建对话，崩了最多丢最后一条。
- **撤销**：写前快照 + 轮次级回滚（`pl undo --turn N`），检测外部改动冲突，冲突时拒绝覆盖（`--force` 才强来），超大文件跳过。
- **审计**：SQLite 投影记录工具调用 / 模型调用 / 审批结论 / 成本，`pl audit [-n N] [--cost] [--json]`。
- **重建**：`pl audit rebuild` 从会话日志重放，连工具参数和审批结论都能还原。

### 自动验证闭环
本轮只要有 `write` / `edit` 成功落盘，收尾前自动跑一遍项目测试：认 `package.json` 的 `scripts.test`（按 lockfile 选 npm / pnpm / yarn）、`Cargo.toml`、`go.mod`、`pytest.ini`；认不出就跳过并说明。失败输出回灌给模型让它自己修，默认只重试 1 轮（`maxVerifyRounds`），超时 180s。关掉用 `--no-verify`，指定命令用 `--verify "node --test"`。

### 桌面窗口（`pl gui`）
- 左侧会话列表（切换、悬停 `×` 删除、当前会话删掉会自动新建一个）
- 消息流 + Markdown 渲染、代码块卡片、工具行 `⚙ read src/host.ts ✓ 1ms`
- 思考链折叠显示（`▸ 思考 · 316 字 · 6.4s`），历史会话重放同样可见
- 审批卡片（允许一次 / 拒绝 / 看参数）+ 权限三档切换
- 设置面板：端点地址、API Key、模型名（可点「拉取」走 `GET {baseURL}/models`），保存即生效
- 附件：`+ 附件` 按钮 / `Ctrl+V` 粘贴 / 拖拽入窗；图片可点开看大图。文本（≤120 KB）内联进上下文，图片走 `image_url`，其它只给路径和大小；所有附件先拷进 `<数据目录>/files/<会话id>/`
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
| `firstByteSecs` | 请求发出到收到第一个字节 | 120 秒 |
| `idleSecs` | 流式输出中两段数据之间最长间隔 | 180 秒 |
| `requestSecs` | 单次请求整体上限 | 900 秒 |

长上下文一轮下来上下文十几万 token 时，服务端 prefill 就可能一两分钟才吐第一个字，所以默认放宽到 120 秒；网关更慢就写 300 / 600。界面上 Key 输入框永远留空，只显示 `sk-p…3456` 这类掩码。

### 数据目录
默认 `~/.packleader`（`PACKLEADER_HOME` 可改）：

```
~/.packleader/
├─ sessions/<id>/session.jsonl    # 唯一真相：append-only 事件日志
├─ audit.sqlite                   # 投影：tool_calls / llm_calls / approvals / sessions
├─ ckpt/<session>/<turn>-<step>-<call>/   # 写前快照 + manifest
├─ files/<会话id>/                 # 附件副本
├─ spill/<ts>-<sha>.log           # 被截断的完整输出
└─ config.json                    # 模型配置（含 API Key）
```

### 已知没做
diff 预览、窗口无边框自绘标题栏、代码块横向滚动与复制按钮、上下文压缩、全屏 TUI、会话选择器、内置 ripgrep、并行工具调用、SEA 单文件分发。

---

## 二、启动方式

### 前提
- **Node ≥ 22.18**（直接用 Node 跑 `.ts`，不需要装依赖、不需要编译）
- Windows 上桌面窗口还要 .NET Framework 4.8（系统自带）
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
```

也可以不配环境变量，直接在窗口的设置面板里填端点 / Key / 模型（第一次启动没 Key 会自动弹出设置面板）。

装成全局命令：`npm link`，之后用 `pl` 代替 `node src/cli.ts`。

### 从安装包启动
装到 `%LOCALAPPDATA%\Programs\PackLeader` 后，开始菜单 / 桌面点 `PackLeader.exe` 开窗口。
启动链路：`PackLeader.exe`（48 KB 原生启动器，C#）→ 找系统 Node（版本低于 22.18 给中文提示）→ `node src/cli.ts gui` → WPF 窗口；没给 `--cwd` 时用上次的工作目录。

### 环境变量
`PL_API_KEY` `PL_BASE_URL` `PL_MODEL` `PL_MODE` `PL_APPROVAL` `PL_SHELL` `PACKLEADER_HOME`

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
| `dist/PackLeader-Setup-0.1.0.exe` | 270 KB | 安装包：自解压 + 开始菜单 / 桌面快捷方式 + 注册卸载项，带安装界面，支持 `/S` 静默 |
| `dist/PackLeader-0.1.0-portable.zip` | 70 KB | 便携版：解压即用，双击 `PackLeader.exe` 开窗口 |

装完占 484 KB（23 个文件），**不含 Node 运行时**，复用系统 Node。

- 构建脚本：`scripts/build-dist.ps1`，只用系统自带的东西——`csc.exe`（.NET Framework 4.8）编译启动器和安装包，图标脚本现画，负载用自定义容器嵌进安装包，**不需要 NSIS / Inno / WiX**。
- 安装包的行为：先关掉正在运行的旧实例（否则覆盖安装 `IOException`）、文件被占用时改名再写、写 `HKCU` 卸载项、建开始菜单 / 桌面快捷方式。
- 卸载：应用和功能、开始菜单右键、或双击安装目录里的 `Uninstall.exe`（按「文件名 + 参数」识别，弹出的是卸载界面）。默认保留会话记录和 `config.json`，勾选「同时删除会话记录和配置」才清 `%USERPROFILE%\.packleader` + `%LOCALAPPDATA%\PackLeader`。

体积取舍（想免装 Node 就得换方案）：

| 方案 | 安装包 | 前提 |
|---|---|---|
| 启动器 + 系统 Node（当前） | 270 KB | 需 Node ≥ 22.18 |
| Node SEA 单文件 | 30–33 MB | 无 |
| Rust / Tauri 重写引擎 | 9–12 MB | 无 |

---

## 四、使用方式

### 命令一览

| 命令 | 说明 |
|---|---|
| `pl "任务"` | 单次执行，完成后退出 |
| `pl` | 交互模式（`/exit` `/undo` `/sessions` `/help`） |
| `pl --repl` | 强制交互模式（stdin 不是终端也行，便于脚本驱动） |
| `pl gui` | 打开桌面窗口 |
| `pl doctor` | 自检：node 版本 / shell 解析 / 数据目录可写 / 端点可达 / 模型存在 |
| `pl audit [-n N] [--tool X] [--cost] [--json]` | 审计账本：工具调用 / 成本 |
| `pl audit rebuild` | 从会话日志重建审计库 |
| `pl undo [--turn N] [--force]` | 撤销某一轮的全部文件改动 |
| `pl sessions` | 列出历史会话 |

常用选项：`--cwd` `--mode` `--yes` `--deny` `--model` `--base-url` `--api-key` `--resume <id>` `--continue` `--data-dir` `--max-steps` `--json` `--repl` `--show-reasoning` `--no-verify` `--verify "<cmd>"`

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
1. 右上角「设置」填端点 / Key / 模型，点「拉取」可列出端点真实存在的模型；保存立刻生效，不用重启。
2. 输入区左边 `+ 附件` 与目录按钮（点一下换工作目录），右边依次是模型、权限（只读 / 询问 / 完全）、发送。
3. 需要动文件时会弹审批卡片：允许一次 / 拒绝 / 看参数。
4. 本会话用量与缓存命中率显示在窗口里；停止、新对话随时可用。

### 安全边界（请读）
- 这是**防手滑**，不是防恶意：`workspace-write` 靠路径白名单 + 审批，不是容器隔离。
- 提示注入是真实风险，模型读到的文件内容可能诱导它执行命令；缓解手段就是审批闸门，**不要把模式长期开在 `full`**。
- `~/.packleader` 里有会话记录和 API Key，别把它提交进仓库。
