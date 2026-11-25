# 临时实验：验证「设置进程 AUMID 后，任务栏按钮是否改用窗口图标」。
# 用法：powershell -NoProfile -STA -File scripts/icon-selftest.ps1 [-Aumid none]
param([string]$Aumid = 'PackLeader.IconTest')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Drawing
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

Add-Type -Namespace IconTest -Name Shell -MemberDefinition @'
[DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string id);
'@

if ($Aumid -ne 'none') {
  $hr = [IconTest.Shell]::SetCurrentProcessExplicitAppUserModelID($Aumid)
  Write-Host ("SetCurrentProcessExplicitAppUserModelID('{0}') -> 0x{1:X8}" -f $Aumid, $hr)
} else {
  Write-Host 'AUMID: 不设置（对照组）'
}

# 复用 ui/PackLeader.ps1 里的图标代码（保证测的就是产品代码）
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:PL_GUI_ROOT = $repoRoot
$src = [System.IO.File]::ReadAllText((Join-Path $repoRoot 'ui\PackLeader.ps1'))
$i = $src.IndexOf('$script:iconHandles = @()')
$j = $src.IndexOf('Log "窗口图标用')
if ($i -lt 0 -or $j -lt 0) { throw "提取标记没找到 i=$i j=$j" }
$j = $src.IndexOf("`n", $j)
# 图标块结尾是 Log 那行；try 的 catch 自己补，便于看到真实异常
$block = $src.Substring($i, $j - $i) + "`n} catch { Write-Host ('图标代码异常: ' + `$_.Exception.Message) }`n"

$window = New-Object System.Windows.Window
$window.Title = 'PLIconAumidTest'
$window.Width = 360
$window.Height = 240
$window.WindowStartupLocation = 'CenterScreen'
function Log([string]$m) { Write-Host ('LOG: ' + $m) }

Invoke-Expression $block

# 等任务栏把按钮建出来，再看它显示什么
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(2200)
$timer.add_Tick({
  $timer.Stop()
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ClassNameProperty), 'Shell_TrayWnd'
    $tb = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    $btnCond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Button)
    $btns = $tb.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    $hit = $null
    foreach ($b in $btns) {
      if ($b.Current.Name -like '*PLIconAumidTest*') { $hit = $b; break }
    }
    if (-not $hit) {
      # 按钮名还是 powershell.exe 的分组名（说明 AUMID 没改变分组）——
      # 那就把所有 PowerShell 分组按钮都截下来，看图标是不是我们的 P
      $psBtns = @()
      foreach ($b in $btns) { if ($b.Current.Name -like '*PowerShell*') { $psBtns += $b } }
      Write-Host ("没找到自家按钮；PowerShell 分组按钮 {0} 个" -f $psBtns.Count)
      $idx = 0
      foreach ($b in $psBtns) {
        $idx++
        $r = $b.Current.BoundingRectangle
        if ($r.Width -le 0) { continue }
        Write-Host ("-- 按钮 {0}: '{1}' x={2} w={3}" -f $idx, $b.Current.Name, [int]$r.X, [int]$r.Width)
        $bmp = New-Object System.Drawing.Bitmap ([int]$r.Width), ([int]$r.Height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bmp.Size)
        $g.Dispose()
        $step = [math]::Max(1, [int]($bmp.Width / 34))
        for ($y = 0; $y -lt $bmp.Height; $y += $step) {
          $line = ''
          for ($x = 0; $x -lt $bmp.Width; $x += $step) {
            $c = $bmp.GetPixel($x, $y)
            $line += if ($c.R -gt 170 -and $c.G -gt 170 -and $c.B -gt 170) { '#' }
                     elseif ($c.B -gt $c.R + 40) { 'b' }
                     else { '.' }
          }
          Write-Host $line
        }
        $bmp.Dispose()
      }
    } else {
      $r = $hit.Current.BoundingRectangle
      Write-Host ("按钮名: " + $hit.Current.Name)
      Write-Host ("按钮区域: x={0} y={1} w={2} h={3}" -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
      $bmp = New-Object System.Drawing.Bitmap ([int]$r.Width), ([int]$r.Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bmp.Size)
      $g.Dispose()
      $step = [math]::Max(1, [int]($bmp.Width / 30))
      for ($y = 0; $y -lt $bmp.Height; $y += $step) {
        $line = ''
        for ($x = 0; $x -lt $bmp.Width; $x += $step) {
          $c = $bmp.GetPixel($x, $y)
          $line += if ($c.R -gt 170 -and $c.G -gt 170 -and $c.B -gt 170) { '#' }
                   elseif ($c.B -gt $c.R + 40) { 'b' }
                   else { '.' }
        }
        Write-Host $line
      }
      $out = Join-Path $env:TEMP 'pl-aumid-test.png'
      $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Host ('截图: ' + $out)
      $bmp.Dispose()
    }
  } catch {
    Write-Host ('检查任务栏失败: ' + $_.Exception.Message)
  }
  $window.Close()
})
$timer.Start()
[void]$window.ShowDialog()
Write-Host 'DONE'
