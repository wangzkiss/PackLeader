/**
 * 截图 / 看图：让模型真的"看见"界面。
 *
 * 为什么要有这两件：改完界面只读代码、只看构建退出码，等于没验——模型说"改好了"是最不可信的一句话。
 * 让它自己截一张、把图直接塞回上下文，它才有机会发现按钮压住了文字、行高不对、颜色没生效。
 *
 *  - screenshot：截窗口 / 整屏（可以先点一下某个坐标再截），落成 PNG，并把图交给模型看
 *  - view_image：把磁盘上已有的图片交给模型看（用户给的设计稿、别的工具截的图）
 *
 * 截图走 Windows 自带的 PowerShell + System.Drawing + user32 PrintWindow：零依赖，
 * 不用装 Playwright / Puppeteer，也不用起浏览器。非 Windows 上如实报不支持。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Tool } from '../core/tools.ts'
import { needString, optNumber, optString } from '../core/tools.ts'
import type { ImageRef } from '../core/types.ts'

const isWin = process.platform === 'win32'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 单张图交给模型的上限：超过这个体积网关多半会拒，也让请求变慢 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

function mimeOfImage(file: string): string | null {
  return IMAGE_MIME[extname(file).toLowerCase()] ?? null
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** PNG 头里读宽高（字节 16..24 是 IHDR 的 width/height），读不到返回 null */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** JPEG：扫 SOFn 段里的宽高；找不到就返回 null（不追求完备，只用来报个尺寸） */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]!
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = buf.readUInt16BE(i + 2)
    if (len < 2) return null
    // C0–CF 里的 SOF（排除 C4 DHT / C8 JPG / CC DAC）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return null
}

function imageSizeOf(file: string): { width: number; height: number } | null {
  try {
    const buf = readFileSync(file)
    return pngSize(buf) ?? jpegSize(buf)
  } catch {
    return null
  }
}

/** PowerShell 单引号字符串：内部单引号写两遍，路径里的中文/空格都不用再操心 */
function psStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function runPsFile(scriptPath: string, timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number; ms: number }> {
  const started = Date.now()
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolveP) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(existsSync(exe) ? exe : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true,
    })
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolveP({ stdout, stderr, code, ms: Date.now() - started })
    }
    const onAbort = (): void => {
      try {
        if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill()
      } catch {
        child.kill()
      }
      stderr += '\n[已取消]'
      finish(-1)
    }
    const timer = setTimeout(onAbort, timeoutMs)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const outDec = new StringDecoder('utf8')
    const errDec = new StringDecoder('utf8')
    child.stdout?.on('data', (b: Buffer) => {
      stdout += outDec.write(b)
    })
    child.stderr?.on('data', (b: Buffer) => {
      stderr += errDec.write(b)
    })
    child.on('error', (e) => {
      stderr += `[无法启动 PowerShell] ${e.message}`
      finish(127)
    })
    child.on('close', (code) => {
      stdout += outDec.end()
      stderr += errDec.end()
      finish(code ?? -1)
    })
  })
}

interface ShotArgs {
  target: 'window' | 'screen'
  process: string
  title: string
  click: string
  waitMs: number
  maxWidth: number
  out: string
}

/**
 * 生成截图脚本。参数直接内联（不通过命令行传参），
 * 免去 PowerShell 对中文参数、空格、引号的各种转义坑。
 */
export function buildShotScript(a: ShotArgs): string {
  return `
$ErrorActionPreference = 'Stop'
# 输出统一 UTF-8：中文 Windows 上 PowerShell 默认按 GBK 写管道，调用方按 UTF-8 解就是乱码
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class PlShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[void][PlShot]::SetProcessDPIAware()

$target = ${psStr(a.target)}
$procName = ${psStr(a.process)}
$title = ${psStr(a.title)}
$click = ${psStr(a.click)}
$waitMs = ${a.waitMs}
$maxWidth = ${a.maxWidth}
$out = ${psStr(a.out)}

$h = [IntPtr]::Zero
$r = New-Object PlShot+RECT
if ($target -eq 'screen') {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $r.Left = $vs.Left; $r.Top = $vs.Top; $r.Right = $vs.Right; $r.Bottom = $vs.Bottom
} else {
  if ($procName -eq '') {
    $h = [PlShot]::GetForegroundWindow()
  } else {
    $want = $procName -replace '\.exe$', ''
    # 带窗口的进程先筛一遍：后面两种匹配都在这个池子里找
    $pool = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.MainWindowHandle -ne 0 -and ($title -eq '' -or $_.MainWindowTitle -like "*$title*")
    })
    # 先按进程名（大小写不敏感，带不带 .exe 都行）
    $hit = $pool | Where-Object { $_.ProcessName -eq $want } | Select-Object -First 1
    # 再把它当窗口标题的片段找一次：模型经常把标题（如 PackLeader）填进 process
    # 而真实的进程是 node / powershell——日志里 3 次截图失败全踩这个
    if (-not $hit) { $hit = $pool | Where-Object { $_.MainWindowTitle -like "*$want*" } | Select-Object -First 1 }
    if (-not $hit) {
      $names = ($pool | Select-Object -First 12 | ForEach-Object { $_.ProcessName + '(' + $_.MainWindowTitle + ')' }) -join '、'
      if (-not $names) { $names = '当前没有任何带窗口的进程' }
      throw "没找到窗口：process='$procName' title='$title'。当前带窗口的：$names"
    }
    $h = $hit.MainWindowHandle
  }
  if ($h -eq [IntPtr]::Zero) { throw '没有可截的前台窗口（target=window 且没给 process）' }
  # 最小化时 GetWindowRect 返回 -32000，先还原；临时置顶，避免别的窗口把它盖住
  if ([PlShot]::IsIconic($h)) { [void][PlShot]::ShowWindow($h, 9); Start-Sleep -Milliseconds 600 }
  [void][PlShot]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0013)
  Start-Sleep -Milliseconds 300
  [void][PlShot]::GetWindowRect($h, [ref]$r)
}

$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) { throw "窗口尺寸异常：$w x $ht" }

if ($click -ne '') {
  $parts = $click -split ','
  $cx = [int]$parts[0]
  $cy = [int]$parts[1]
  if ($h -ne [IntPtr]::Zero) { [void][PlShot]::SetForegroundWindow($h) }
  Start-Sleep -Milliseconds 350
  [void][PlShot]::SetCursorPos(($r.Left + $cx), ($r.Top + $cy))
  Start-Sleep -Milliseconds 200
  [PlShot]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [PlShot]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds $waitMs
}

$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
if ($target -eq 'screen') {
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $ht))
} else {
  $hdc = $g.GetHdc()
  [void][PlShot]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc)
}
$g.Dispose()

# 太宽的图（4K 屏整屏）先等比缩下来：模型看细节够用，token 和上传体积都少一大截
$scaled = $false
if ($maxWidth -gt 0 -and $bmp.Width -gt $maxWidth) {
  $nh = [int][Math]::Round($bmp.Height * $maxWidth / $bmp.Width)
  $small = New-Object System.Drawing.Bitmap $maxWidth, $nh
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.DrawImage($bmp, 0, 0, $maxWidth, $nh)
  $sg.Dispose()
  $bmp.Dispose()
  $bmp = $small
  $scaled = $true
}

$dir = Split-Path -Parent $out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
if ($h -ne [IntPtr]::Zero) { [void][PlShot]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0013) }
$msg = "saved $out ($($bmp.Width)x$($bmp.Height)"
if ($scaled) { $msg += ", scaled from $($w)x$($ht)" }
$msg += ')'
$bmp.Dispose()
Write-Output $msg
`
}

export function createScreenshotTools(opts: { dataDir?: string }): Tool[] {
  /** 截图目录：默认放数据目录（和会话、审计一个家），没给数据目录就放系统临时目录 */
  const shotsRoot = opts.dataDir ? join(opts.dataDir, 'shots') : join(tmpdir(), 'packleader-shots')

  const screenshot: Tool = {
    name: 'screenshot',
    description:
      '截一张当前界面的图并自己看一眼（支持截某个窗口或整屏）。' +
      '改完界面/样式/布局之后必须用它验证：先让界面刷新（重启程序、刷新页面、等渲染完），再截图，' +
      '然后把你在图里看到的内容和预期逐条对照；构建成功、退出码 0 都不等于界面变对了。' +
      '参数：target=window（默认，截窗口）|screen（整屏）；process 是进程名（如 notepad、PackLeader），' +
      '不给就截前台窗口；title 可按窗口标题过滤；click 可以先在窗口内点一下（"x,y"）再截，用来展开菜单/切标签；' +
      'out 不给就落到数据目录的 shots/ 下。非 Windows 不支持。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['window', 'screen'], description: '截窗口（默认）还是整屏' },
        process: { type: 'string', description: '进程名，如 notepad / PackLeader；不给就截当前前台窗口' },
        title: { type: 'string', description: '窗口标题里包含的片段，用来在多个窗口里挑一个' },
        click: { type: 'string', description: '截图前先在窗口内点一下的坐标，格式 "x,y"（窗口左上角为原点）' },
        wait_ms: { type: 'integer', description: '点击后等多少毫秒再截，默认 400' },
        max_width: { type: 'integer', description: '图比这个宽就等比缩小，默认 1600，0 = 不缩' },
        out: { type: 'string', description: 'PNG 输出路径（相对工作目录或绝对路径）；不给就自动放在数据目录 shots/ 下' },
      },
      required: [],
    },
    permission: 'read',
    async run(ctx, args) {
      if (!isWin) return { content: '截图只支持 Windows：这台机器是 ' + process.platform + '，请用系统自带的截图工具或装了浏览器的 CDP 方案。' }
      const targetRaw = optString(args, 'target') ?? 'window'
      if (targetRaw !== 'window' && targetRaw !== 'screen') throw new Error('target 只能是 window 或 screen')
      const processName = optString(args, 'process') ?? ''
      const title = optString(args, 'title') ?? ''
      const click = optString(args, 'click') ?? ''
      if (click && !/^\s*-?\d+\s*,\s*-?\d+\s*$/.test(click)) throw new Error('click 要写成 "x,y"，例如 "320,96"')
      const waitMs = Math.max(0, optNumber(args, 'wait_ms') ?? 400)
      const maxWidth = Math.max(0, optNumber(args, 'max_width') ?? 1600)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
      const outArg = optString(args, 'out')
      const out = outArg ? (isAbsolute(outArg) ? outArg : resolve(ctx.root, outArg)) : join(shotsRoot, `shot-${stamp}.png`)

      mkdirSync(join(out, '..'), { recursive: true })
      const scriptPath = join(ctx.spillDir, `shot-${Date.now()}.ps1`)
      mkdirSync(ctx.spillDir, { recursive: true })
      // Windows PowerShell 5.1 按 BOM 认 UTF-8，不带 BOM 会把中文读成乱码
      writeFileSync(scriptPath, `\uFEFF${buildShotScript({ target: targetRaw, process: processName, title, click, waitMs, maxWidth, out })}`, 'utf8')

      const r = await runPsFile(scriptPath, 30_000, ctx.signal)
      if (r.code !== 0) {
        const msg = (r.stderr || r.stdout).trim() || `exit code ${r.code}`
        return { content: `截图失败：${msg}`, exitCode: r.code }
      }
      const st = statSync(out)
      const size = imageSizeOf(out)
      const dims = size ? `${size.width}x${size.height}` : '尺寸未知'
      const kind = targetRaw === 'screen' ? '整屏' : processName ? `${processName} 窗口` : '前台窗口'
      const content =
        `已截图（${kind}，${dims}，${humanSize(st.size)}）：${out}\n` +
        '图已经随这条工具结果发给你了。请对照预期逐条看：要改的东西真的出现了吗？布局、文字、颜色、状态对不对？' +
        '只看代码或构建日志不算验证过。'
      return { content, images: [{ path: out, mime: 'image/png', bytes: st.size }] as ImageRef[] }
    },
  }

  const viewImage: Tool = {
    name: 'view_image',
    description:
      '把磁盘上的一张图交给模型看（png / jpg / webp / gif）。' +
      '用户给了设计稿、截图、导出图，或者别的工具生成了图片时用它；' +
      '不要用 read 读图片文件（二进制读出来是乱码）。图片太大（>8MB）会拒，先用 shell 缩一下。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片路径（相对工作目录或绝对路径）' },
      },
      required: ['path'],
    },
    permission: 'read',
    async run(ctx, args) {
      const p = needString(args, 'path')
      const abs = isAbsolute(p) ? p : resolve(ctx.root, p)
      const mime = mimeOfImage(abs)
      if (!mime) throw new Error(`不支持的图片格式：${extname(abs) || '(无扩展名)'}；支持 png / jpg / jpeg / webp / gif`)
      let st
      try {
        st = statSync(abs)
      } catch {
        throw new Error(`文件不存在或读不到：${abs}`)
      }
      if (st.size > MAX_IMAGE_BYTES) {
        throw new Error(`图片 ${humanSize(st.size)} 超过 ${humanSize(MAX_IMAGE_BYTES)}，请先用 shell 缩一张再看`)
      }
      const size = imageSizeOf(abs)
      const dims = size ? `${size.width}x${size.height}` : '尺寸未知'
      const content = `已把图片交给模型查看：${abs}（${dims}，${humanSize(st.size)}）`
      return { content, images: [{ path: abs, mime, bytes: st.size }] as ImageRef[] }
    },
  }

  return [screenshot, viewImage]
}
