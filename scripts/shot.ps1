# 开发用：截图 / 点击（不是产品的一部分，只在验证界面时用）
#   .\scripts\shot.ps1 -Out docs/x.png            # 截 PackLeader 窗口
#   .\scripts\shot.ps1 -Out a.png -Process setup  # 截别的进程
#   .\scripts\shot.ps1 -Click 320,96              # 在窗口内坐标点一下
param(
  [string]$Out = "$env:TEMP\shot.png",
  [string]$Process = 'PackLeader',
  [string]$Click = '',
  [string]$Title = 'PackLeader',
  [int]$Wait = 0
)

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class PlShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
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

$proc = Get-Process $Process -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and ($Title -eq '' -or $_.MainWindowTitle -like "*$Title*") } |
  Select-Object -First 1
if (-not $proc) { throw "没找到带窗口的进程：$Process" }
$h = $proc.MainWindowHandle
# 窗口被最小化时 GetWindowRect 会返回 -32000，先还原再截
if ([PlShot]::IsIconic($h)) { [void][PlShot]::ShowWindow($h, 9); Start-Sleep -Milliseconds 600 }
# 临时置顶：别的窗口（比如正在跑的终端）会盖住它，导致点击打到别的窗口上
[void][PlShot]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0013)
Start-Sleep -Milliseconds 300
$r = New-Object PlShot+RECT
[void][PlShot]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top

if ($Click) {
  $parts = $Click -split ','
  $cx = [int]$parts[0]
  $cy = [int]$parts[1]
  [void][PlShot]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 350
  [void][PlShot]::SetCursorPos(($r.Left + $cx), ($r.Top + $cy))
  Start-Sleep -Milliseconds 200
  [PlShot]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [PlShot]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 500
  if ($Wait -gt 0) { Start-Sleep -Seconds $Wait }
}

$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][PlShot]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
[void][PlShot]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0013)
$bmp.Dispose()
"截图: $Out  ($w x $ht)  窗口左上角 $($r.Left),$($r.Top)"
