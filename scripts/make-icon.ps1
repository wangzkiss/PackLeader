# 画 PackLeader 的图标：蓝色圆角方块 + 白色 P，按 Windows 真实用到的每个尺寸各出一帧，
# 拼成一个多帧 .ico（16/20/24/32/40/48/64/128/256）。
# 只出一个尺寸的话，系统会拿 256 去缩到 16px，糊成一团白点——任务栏和标题栏就是这么糊掉的。
# 字形用几何图形拼（竖笔 + 圆环），不用字体渲染：几 px 的文字会被 GDI+ hint 得歪七扭八，
# 几何笔画在 16px 上也还是清楚的一个 P。
# 全部用 System.Drawing（.NET Framework 自带），不依赖任何外部工具。
param(
  [string]$Out = (Join-Path (Split-Path -Parent $PSScriptRoot) 'build\packleader.ico')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# 小的在前：Explorer 会挑最接近请求尺寸的那一帧
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)

function New-Frame([int]$n) {
  $bmp = New-Object System.Drawing.Bitmap $n, $n, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # ---------- 蓝色圆角块 ----------
    $pad = [math]::Max(1, [int][math]::Round($n * 0.03))
    $rad = [math]::Max(2, [int][math]::Round($n * 0.22))
    $d = $rad * 2
    $x0 = $pad; $y0 = $pad; $x1 = $n - $pad; $y1 = $n - $pad
    $box = New-Object System.Drawing.Drawing2D.GraphicsPath
    try {
      $box.AddArc($x0, $y0, $d, $d, 180, 90)
      $box.AddArc(($x1 - $d), $y0, $d, $d, 270, 90)
      $box.AddArc(($x1 - $d), ($y1 - $d), $d, $d, 0, 90)
      $box.AddArc($x0, ($y1 - $d), $d, $d, 90, 90)
      $box.CloseFigure()
      $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush `
        (New-Object System.Drawing.Rectangle $x0, $y0, ($x1 - $x0), ($y1 - $y0)), `
        ([System.Drawing.Color]::FromArgb(255, 43, 92, 255)), `
        ([System.Drawing.Color]::FromArgb(255, 22, 48, 170)), 90
      try { $g.FillPath($grad, $box) } finally { $grad.Dispose() }
    } finally { $box.Dispose() }

    # ---------- 白色 P：竖笔 + 右侧圆环 ----------
    # 比例是量出来的：字形横向 0.28n..0.74n（居中），纵向 0.20n..0.80n；笔画约 1/7 高。
    $stroke = [math]::Max(2, [int][math]::Round($n * 0.135))
    $stemX = [int][math]::Round($n * 0.28)
    $top = [int][math]::Round($n * 0.20)
    $bottom = [int][math]::Round($n * 0.80)
    $bowl = [math]::Max(6, [int][math]::Round($n * 0.46))
    $iBowl = $bowl - 2 * $stroke                 # 内圆直径，太小就没有孔了，留着也算数
    $white = [System.Drawing.Brushes]::White
    $g.FillRectangle($white, $stemX, $top, $stroke, ($bottom - $top))
    if ($iBowl -ge 2) {
      # FillMode 默认 Alternate：外圆 + 内圆同向相加，结果就是一个带抗锯齿的圆环
      $ring = New-Object System.Drawing.Drawing2D.GraphicsPath
      try {
        $ring.AddEllipse($stemX, $top, $bowl, $bowl)
        $ring.AddEllipse(($stemX + $stroke), ($top + $stroke), $iBowl, $iBowl)
        $g.FillPath($white, $ring)
      } finally { $ring.Dispose() }
    } else {
      $g.FillEllipse($white, $stemX, $top, $bowl, $bowl)
    }
  } finally { $g.Dispose() }
  return $bmp
}

$frames = @()
foreach ($s in $sizes) {
  $bmp = New-Frame $s
  try {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $frames += , @{ Size = $s; Data = $ms.ToArray() }
    $ms.Dispose()
  } finally { $bmp.Dispose() }
}

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$fs = [System.IO.File]::Create($Out)
try {
  $bw = New-Object System.IO.BinaryWriter $fs
  try {
    $bw.Write([UInt16]0)                        # reserved
    $bw.Write([UInt16]1)                        # type = icon
    $bw.Write([UInt16]$frames.Count)
    $offset = 6 + 16 * $frames.Count            # 头部 + 每帧 16 字节目录项
    foreach ($f in $frames) {
      $len = $f.Data.Length
      $dim = 0
      if ($f.Size -lt 256) { $dim = $f.Size }   # 256 在目录里记作 0
      $bw.Write([byte]$dim)          # width
      $bw.Write([byte]$dim)          # height
      $bw.Write([byte]0)             # 调色板颜色数
      $bw.Write([byte]0)             # reserved
      $bw.Write([UInt16]1)           # color planes
      $bw.Write([UInt16]32)          # 每像素位深
      $bw.Write([UInt32]$len)
      $bw.Write([UInt32]$offset)
      $offset += $len
    }
    foreach ($f in $frames) { $bw.Write($f.Data) }
    $bw.Flush()
  } finally { $bw.Dispose() }
} finally { $fs.Dispose() }

Write-Host ('已生成 {0}（{1} 帧：{2}）' -f $Out, $frames.Count, (($sizes | ForEach-Object { "$_ " }) -join '').Trim())
