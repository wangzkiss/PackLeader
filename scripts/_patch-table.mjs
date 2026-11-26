// 一次性补丁脚本：给 ui/PackLeader.ps1 加 Markdown 表格渲染。
// 用 Node 做替换是因为该文件是纯 CRLF + BOM，edit 工具在 CRLF 上会把行串起来。
import { readFileSync, writeFileSync } from 'node:fs'

const P = 'ui/PackLeader.ps1'
const raw = readFileSync(P, 'utf8')
if (!raw.startsWith('\ufeff')) throw new Error('缺少 BOM，先确认编码')
let out = raw.slice(1).replace(/\r\n/g, '\n')

/** 唯一替换：from 必须恰好命中一次 */
function rep(from, to) {
  const i = out.indexOf(from)
  if (i < 0) throw new Error('没找到片段：\n' + from.slice(0, 80))
  if (out.indexOf(from, i + 1) >= 0) throw new Error('片段不唯一：\n' + from.slice(0, 80))
  out = out.slice(0, i) + to + out.slice(i + from.length)
}

// ---- 1. 修 $Matches 被后续正则覆盖（标题 / 列表标记没被剥掉）----
rep(
  [
    "    if ($line -match '^(#{1,6})\\s+(.*)$') {",
    "      $tb.Inlines.Add((New-Run $Matches[2] '#F9FAFB' $true $false)) | Out-Null",
    '      continue',
    '    }',
    "    if ($line -match '^(\\s*)[-*]\\s+(.*)$') { $line = \"$($Matches[1])• $($Matches[2])\" }",
  ].join('\n'),
  [
    "    if ($line -match '^(#{1,6})\\s+(.*)$') {",
    '      # 先把捕获组取出来：下面还要跑别的正则，$Matches 会被覆盖',
    '      $htext = [string]$Matches[2]',
    "      $tb.Inlines.Add((New-Run $htext '#F9FAFB' $true $false)) | Out-Null",
    '      continue',
    '    }',
    "    if ($line -match '^(\\s*)[-*]\\s+(.*)$') {",
    '      $lind = [string]$Matches[1]',
    '      $lbody = [string]$Matches[2]',
    '      $line = "$lind• $lbody"',
    '    }',
  ].join('\n'),
)

// ---- 2. 表格解析 + 网格卡片，插在 Clip-LongText 之前 ----
const tableCode = [
  '# ---------------- 管道表格：| a | b | 加 | --- | 分隔行 → 网格卡片 ----------------',
  '# 表格是模型「给结论」时最常用的格式，原样输出成一堆竖线很难读。',
  '# 不追求完整 Markdown 语义，只做三件事：按列估宽度、表头给底色、行间画细线。',
  "$script:tableRuleRe = '^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$'",
  '',
  'function Split-TableRow([string]$line) {',
  '  $s = $line.Trim()',
  "  if ($s.StartsWith('|')) { $s = $s.Substring(1) }",
  "  if ($s.EndsWith('|')) { $s = $s.Substring(0, $s.Length - 1) }",
  '  $cells = New-Object System.Collections.ArrayList',
  '  # 行内代码里的 | 不算分隔符',
  "  foreach ($c in [regex]::Split($s, '(?<!`)\\|(?!`)')) { [void]$cells.Add($c.Trim()) }",
  '  return $cells',
  '}',
  '',
  '# 单元格里的粗体 / 行内代码走和正文一样的切分逻辑',
  'function Add-TableInlines($tb, [string]$cell) {',
  '  if (-not $cell) { return }',
  "  $s = $cell -replace '<br\\s*/?>', ' / '",
  "  $parts = [regex]::Split($s, '(\\*\\*[^*]+\\*\\*|`[^`]+`)')",
  '  foreach ($p in $parts) {',
  '    if (-not $p) { continue }',
  "    if ($p -match '^\\*\\*(.+)\\*\\*$') { $tb.Inlines.Add((New-Run ([string]$Matches[1]) '#F9FAFB' $true $false)) | Out-Null }",
  "    elseif ($p -match '^`(.+)`$') { $tb.Inlines.Add((New-Run ([string]$Matches[1]) '#9FC7FF' $false $true)) | Out-Null }",
  "    else { $tb.Inlines.Add((New-Run $p '#D4D9E0' $false $false)) | Out-Null }",
  '  }',
  '}',
  '',
  '# 列宽按「该列各行最长显示宽度」估星号比例；中文按 1.7 个字符宽算，单列上限 40',
  'function New-TableCard($rows, [int]$headerRows) {',
  '  $cols = 0',
  '  foreach ($r in $rows) { if ($r.Count -gt $cols) { $cols = $r.Count } }',
  '  if ($cols -eq 0) { return $null }',
  '  $w = [double[]]::new($cols)',
  '  for ($c = 0; $c -lt $cols; $c++) {',
  '    $max = 4.0',
  '    foreach ($r in $rows) {',
  '      if ($c -ge $r.Count) { continue }',
  '      $len = 0.0',
  '      foreach ($ch in ([string]$r[$c]).ToCharArray()) {',
  '        if ([int]$ch -gt 0x2E7F) { $len += 1.7 } else { $len += 1.0 }',
  '      }',
  '      if ($len -gt $max) { $max = $len }',
  '    }',
  '    if ($max -gt 40) { $max = 40 }',
  '    $w[$c] = $max',
  '  }',
  '',
  '  $outer = New-Object System.Windows.Controls.Border',
  "  $outer.Background = (Brush '#12141A')",
  "  $outer.CornerRadius = '8'",
  "  $outer.BorderThickness = '1'",
  "  $outer.BorderBrush = (Brush '#1FFFFFFF')",
  "  $outer.Padding = '8,6,8,8'",
  "  $outer.Margin = '0,4,0,10'",
  '',
  '  $grid = New-Object System.Windows.Controls.Grid',
  '  for ($c = 0; $c -lt $cols; $c++) {',
  '    $cd = New-Object System.Windows.Controls.ColumnDefinition',
  '    $cd.Width = [System.Windows.GridLength]::new($w[$c], [System.Windows.GridUnitType]::Star)',
  '    $grid.ColumnDefinitions.Add($cd) | Out-Null',
  '  }',
  '  for ($r = 0; $r -lt $rows.Count; $r++) {',
  '    $rd = New-Object System.Windows.Controls.RowDefinition',
  '    $rd.Height = [System.Windows.GridLength]::Auto',
  '    $grid.RowDefinitions.Add($rd) | Out-Null',
  '  }',
  '',
  '  for ($r = 0; $r -lt $rows.Count; $r++) {',
  '    $row = $rows[$r]',
  '    $isHead = ($r -lt $headerRows)',
  '    if ($isHead) {',
  '      # 表头底色铺一整条横跨所有列的 Border，比逐格画省元素',
  '      $hb = New-Object System.Windows.Controls.Border',
  "      $hb.Background = (Brush '#1A1E27')",
  "      $hb.CornerRadius = '5'",
  "      $hb.Margin = '0,0,0,2'",
  '      [System.Windows.Controls.Grid]::SetRow($hb, $r)',
  '      [System.Windows.Controls.Grid]::SetColumn($hb, 0)',
  '      [System.Windows.Controls.Grid]::SetColumnSpan($hb, $cols)',
  '      $grid.Children.Add($hb) | Out-Null',
  '    }',
  '    for ($c = 0; $c -lt $cols; $c++) {',
  "      $cellTxt = ''",
  '      if ($c -lt $row.Count) { $cellTxt = [string]$row[$c] }',
  "      $tb = New-Text '' 12.5 '#D4D9E0' 'Normal' 'Segoe UI' 0",
  "      $tb.TextWrapping = 'Wrap'",
  "      $tb.Margin = '10,5,10,5'",
  "      $tb.VerticalAlignment = 'Center'",
  '      if ($isHead) { $tb.FontWeight = [System.Windows.FontWeights]::SemiBold }',
  '      Add-TableInlines $tb $cellTxt',
  '      [System.Windows.Controls.Grid]::SetRow($tb, $r)',
  '      [System.Windows.Controls.Grid]::SetColumn($tb, $c)',
  '      $grid.Children.Add($tb) | Out-Null',
  '    }',
  '    if (-not $isHead -and $r -lt ($rows.Count - 1)) {',
  '      # 行分隔线：一条只留底边的 Border，跨满整行',
  '      $ln = New-Object System.Windows.Controls.Border',
  "      $ln.BorderBrush = (Brush '#14FFFFFF')",
  "      $ln.BorderThickness = '0,0,0,1'",
  "      $ln.Margin = '6,0,6,0'",
  '      [System.Windows.Controls.Grid]::SetRow($ln, $r)',
  '      [System.Windows.Controls.Grid]::SetColumn($ln, 0)',
  '      [System.Windows.Controls.Grid]::SetColumnSpan($ln, $cols)',
  "      [System.Windows.Controls.Grid]::SetVerticalAlignment($ln, 'Bottom')",
  '      $grid.Children.Add($ln) | Out-Null',
  '    }',
  '  }',
  '',
  '  $outer.Child = $grid',
  '  return $outer',
  '}',
  '',
  '# 超长文本先截一段看，剩下的用一行提示带过（思考过程回放用）',
].join('\n')
rep('# 超长文本先截一段看，剩下的用一行提示带过（思考过程回放用）', tableCode)

// ---- 3. Render-Markdown 里加表格分支（整段替换 while 开头，保证唯一）----
rep(
  [
    '  while ($i -lt $n) {',
    "    if ($lines[$i] -match '^\\s*```\\s*([^`]*)$') {",
    '      $lang = $Matches[1].Trim()',
    '      $buf = New-Object System.Text.StringBuilder',
  ].join('\n'),
  [
    '  while ($i -lt $n) {',
    '    # 表格：本行含 |，且下一行是 | --- | 分隔行',
    "    if ($lines[$i] -match '\\|' -and ($i + 1) -lt $n -and ([string]$lines[$i + 1]) -match $script:tableRuleRe) {",
    '      $rows = New-Object System.Collections.ArrayList',
    '      [void]$rows.Add((Split-TableRow ([string]$lines[$i])))',
    '      $i += 2',
    "      while (($i -lt $n) -and (([string]$lines[$i]) -match '\\|') -and (([string]$lines[$i]).Trim())) {",
    '        [void]$rows.Add((Split-TableRow ([string]$lines[$i])))',
    '        $i++',
    '      }',
    '      $card = New-TableCard $rows 1',
    '      if ($null -ne $card) { $hostPanel.Children.Add($card) | Out-Null }',
    '      continue',
    '    }',
    "    if ($lines[$i] -match '^\\s*```\\s*([^`]*)$') {",
    '      $lang = $Matches[1].Trim()',
    '      $buf = New-Object System.Text.StringBuilder',
  ].join('\n'),
)

// ---- 4. 注释里补一句表格 ----
rep(
  '# 把整段回答重绘成「段落 + 代码块卡片」。流式阶段仍然是纯文本，结束时再格式化。',
  '# 把整段回答重绘成「段落 + 代码块卡片 + 表格卡片」。流式阶段仍然是纯文本，结束时再格式化。',
)

writeFileSync(P, '\ufeff' + out.replace(/\n/g, '\r\n'), 'utf8')
console.log('patched, lines =', out.split('\n').length)
