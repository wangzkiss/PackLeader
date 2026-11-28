# 构建发包：原生启动器 exe + 自解压安装包 + 便携 zip。
# 全部用 in-box 的 csc.exe（.NET Framework 4.8），不依赖 Node 工具链之外的东西。
# 产物刻意不含 Node 运行时：几百 KB vs 30 MB，见 README 的体积测算。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
Push-Location $root
try {
  $csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path $csc)) { throw "找不到 in-box 的 csc.exe：$csc" }

  $version = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $dist = Join-Path $root 'dist'
  $stage = Join-Path $dist 'stage'
  Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $stage | Out-Null

  # ---------- 1. 图标：蓝色圆角块 + 白色 P ----------
  $icon = Join-Path $root 'build\packleader.ico'
  Add-Type -AssemblyName System.Drawing
  $n = 256
  $bmp = New-Object System.Drawing.Bitmap $n, $n
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 58
  $d = $r * 2
  $path.AddArc(8, 8, $d, $d, 180, 90)
  $path.AddArc($n - 8 - $d, 8, $d, $d, 270, 90)
  $path.AddArc($n - 8 - $d, $n - 8 - $d, $d, $d, 0, 90)
  $path.AddArc(8, $n - 8 - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $rect = New-Object System.Drawing.Rectangle 8, 8, ($n - 16), ($n - 16)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 43, 92, 255)), ([System.Drawing.Color]::FromArgb(255, 22, 48, 170)), 90
  $g.FillPath($grad, $path)
  $font = New-Object System.Drawing.Font 'Segoe UI', 150, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString('P', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 6, $n, $n), $fmt)
  $g.Dispose()
  $hicon = $bmp.GetHicon()
  $iconObj = [System.Drawing.Icon]::FromHandle($hicon)
  $fsIcon = [System.IO.File]::Create($icon)
  $iconObj.Save($fsIcon)
  $fsIcon.Close()
  $iconObj.Dispose()
  $bmp.Dispose()

  # ---------- 2. 负载：只带运行时需要的东西 ----------
  Copy-Item (Join-Path $root 'package.json') $stage
  Copy-Item (Join-Path $root 'README.md') $stage
  Copy-Item (Join-Path $root 'src') $stage -Recurse
  Copy-Item (Join-Path $root 'ui') $stage -Recurse
  # 清掉不该进包的东西：编辑器/调参留下的备份、map、隐藏文件
  Get-ChildItem $stage -Recurse -File -Force -Include '*.bak', '*.orig', '*.rej', '*.map', '*.log', '.DS_Store', 'Thumbs.db' |
    ForEach-Object { Write-Host ('  跳过 {0}' -f $_.FullName.Substring($stage.Length + 1)); Remove-Item $_.FullName -Force }

  # ---------- 3. 启动器 ----------
  & $csc /nologo /target:winexe /codepage:65001 /optimize+ /platform:anycpu "/win32icon:$icon" "/out:$stage\PackLeader.exe" (Join-Path $root 'build\launcher.cs')
  if ($LASTEXITCODE -ne 0) { throw '启动器编译失败' }

  # ---------- 4. 负载打包（自定义容器，无压缩，省一个 Compression 引用） ----------
  $payload = Join-Path $dist 'payload.bin'
  $fsPayload = [System.IO.File]::Create($payload)
  $bw = New-Object System.IO.BinaryWriter($fsPayload)
  $files = Get-ChildItem $stage -Recurse -File | Sort-Object FullName
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($stage.Length + 1)
    $nameBytes = [System.Text.Encoding]::UTF8.GetBytes($rel)
    $data = [System.IO.File]::ReadAllBytes($f.FullName)
    $bw.Write([int]$nameBytes.Length)
    $bw.Write($nameBytes)
    $bw.Write([int]$data.Length)
    $bw.Write($data)
  }
  $bw.Write([int]0)
  $bw.Flush()
  $bw.Close()
  $fsPayload.Close()

  # ---------- 5. 安装包 ----------
  # 逻辑（installer.cs）+ 界面（installer-ui.cs，和主窗口一套配色与自绘控件）分开写，
  # 免得一个文件六百多行又长又难改；编译时一起交给 csc。
  $setup = Join-Path $dist "PackLeader-Setup-$version.exe"
  & $csc /nologo /target:winexe /codepage:65001 /optimize+ "/win32icon:$icon" "/resource:$payload,payload.bin" "/out:$setup" `
    (Join-Path $root 'build\installer.cs') (Join-Path $root 'build\installer-ui.cs')
  if ($LASTEXITCODE -ne 0) { throw '安装包编译失败' }

  # ---------- 6. 便携 zip ----------
  $zip = Join-Path $dist "PackLeader-$version-portable.zip"
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force

  # ---------- 7. 报告 ----------
  Write-Host ''
  Write-Host '产物：'
  Get-ChildItem $dist -File | Sort-Object Length | ForEach-Object {
    Write-Host ('  {0,-32} {1,8:N1} KB' -f $_.Name, ($_.Length / 1KB))
  }
  $stageSize = (Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum
  Write-Host ('  {0,-32} {1,8:N1} KB  ({2} 个文件)' -f 'stage/（装完占用的源码）', ($stageSize / 1KB), $files.Count)
}
finally {
  Pop-Location
}
