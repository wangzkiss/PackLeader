param([int]$TargetPid = 0, [string]$Out = 'shot.png', [switch]$NoInvoke)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class PlShot2 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[void][PlShot2]::SetProcessDPIAware()

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Output 'no uia window'; exit 1 }

if (-not $NoInvoke) {
  $btn = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'SettingsBtn')))
  if ($btn) {
    $inv = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $inv.Invoke()
    Start-Sleep -Milliseconds 1500
  } else { Write-Output 'SettingsBtn not found' }
}

$h = [IntPtr]$win.Current.NativeWindowHandle
if ([PlShot2]::IsIconic($h)) { [void][PlShot2]::ShowWindow($h, 9); Start-Sleep -Milliseconds 600 }
[void][PlShot2]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0013)
Start-Sleep -Milliseconds 400
$r = New-Object PlShot2+RECT
[void][PlShot2]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][PlShot2]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
[void][PlShot2]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0013)
$bmp.Dispose()
Write-Output "shot: $Out ($w x $ht)"
