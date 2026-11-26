chcp 65001 | Out-Null
# Offline smoke test for the pipe-table renderer in ui/PackLeader.ps1.
# ASCII-only on purpose: PowerShell 5.1 reads BOM-less files as GBK and would
# mis-decode any Chinese comment here, swallowing the following line.
$p = 'E:\Desktop\ai\PackLeader\ui\PackLeader.ps1'
$txt = [System.IO.File]::ReadAllText($p)

Add-Type -AssemblyName PresentationFramework

$start = $txt.IndexOf('function Split-TableRow')
$end = $txt.IndexOf('function Clip-LongText')
if ($start -lt 0 -or $end -le $start) { throw "fragment not found: start=$start end=$end" }
$ruleAt = $txt.LastIndexOf('tableRuleRe =', $start)
if ($ruleAt -lt 0) { throw 'tableRuleRe definition not found' }
$lineStart = $txt.LastIndexOf("`n", $ruleAt) + 1
$frag = $txt.Substring($lineStart, $end - $lineStart)

$script:brushCache = @{}
$script:fontCache = @{}
function Brush([string]$hex) {
  $b = $script:brushCache[$hex]
  if ($b) { return $b }
  $b = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($hex))
  $script:brushCache[$hex] = $b
  return $b
}
function New-Font([string]$name) {
  $f = $script:fontCache[$name]
  if ($f) { return $f }
  $f = New-Object System.Windows.Media.FontFamily($name)
  $script:fontCache[$name] = $f
  return $f
}
function New-Text {
  param([string]$text = '', [double]$size = 13.5, [string]$color = '#F9FAFB',
        [string]$weight = 'Normal', [string]$font = 'Segoe UI', [double]$mb = 0)
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Text = $text
  $tb.FontSize = $size
  $tb.Foreground = (Brush $color)
  $tb.FontFamily = (New-Font $font)
  $tb.TextWrapping = 'Wrap'
  $tb.Margin = "0,0,0,$mb"
  if ($weight -eq 'SemiBold') { $tb.FontWeight = [System.Windows.FontWeights]::SemiBold }
  return $tb
}
function New-Run([string]$t, [string]$color, [bool]$bold, [bool]$mono) {
  $r = New-Object System.Windows.Documents.Run
  $r.Text = $t
  $r.Foreground = (Brush $color)
  if ($bold) { $r.FontWeight = [System.Windows.FontWeights]::SemiBold }
  if ($mono) { $r.FontFamily = (New-Font 'Cascadia Mono, Consolas') }
  return $r
}

Invoke-Expression $frag
if (-not $script:tableRuleRe) { throw 'tableRuleRe not defined' }

"--- 1. separator detection ---"
$cases = @(
  @('| --- | --- |', $true),
  @('|---|---|', $true),
  @('| :--- | ---: |', $true),
  @('|:--|--:|', $true),
  @('--- | ---', $true),
  @('| --- |', $true),
  @('not a rule', $false),
  @('| --- | x |', $false),
  @('| a | b |', $false),
  @('plain text', $false),
  @('|--|', $true)
)
$fail = 0
foreach ($c in $cases) {
  $hit = [bool]($c[0] -match $script:tableRuleRe)
  $ok = ($hit -eq $c[1])
  if (-not $ok) { $fail++ }
  "  {0} '{1}' -> {2} (expect {3})" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $c[0], $hit, $c[1]
}

"--- 2. row splitting ---"
$rows = @(
  '| Tool | Purpose | Note |',
  '|---|---|---|',
  '| `read` | read file | with line numbers |',
  '| **write** | write file | overwrite `a|b` |',
  '| grep | search | pipe inside code `x|y` |'
)
$parsed = New-Object System.Collections.ArrayList
foreach ($r in $rows[0, 2, 3, 4]) { [void]$parsed.Add((Split-TableRow $r)) }
for ($i = 0; $i -lt $parsed.Count; $i++) {
  $cells = @()
  foreach ($c in $parsed[$i]) { $cells += "[$c]" }
  "  row{0}: {1} cells -> {2}" -f $i, $parsed[$i].Count, ($cells -join ' ')
}
if ($parsed[0].Count -ne 3) { $fail++; '  FAIL header should have 3 cells' }
if ($parsed[1].Count -ne 3) { $fail++; '  FAIL code row should have 3 cells' }
if ($parsed[2].Count -ne 3) { $fail++; '  FAIL bold row should have 3 cells (a|b kept in one cell)' }
if ($parsed[3].Count -ne 3) { $fail++; '  FAIL x|y inside backticks should not split' }

"--- 3. card build ---"
$card = New-TableCard $parsed 1
if ($null -eq $card) { throw 'New-TableCard returned null' }
$grid = $card.Child
"  card={0} child={1} cols={2} rows={3}" -f $card.GetType().Name, $grid.GetType().Name, $grid.ColumnDefinitions.Count, $grid.RowDefinitions.Count
"  widths: " + (($grid.ColumnDefinitions | ForEach-Object { [math]::Round($_.Width.Value, 1) }) -join ', ')
"  children: " + $grid.Children.Count
$cellTexts = @()
$boldCells = 0
foreach ($c in $grid.Children) {
  if ($c -is [System.Windows.Controls.TextBlock]) {
    $s = -join ($c.Inlines | ForEach-Object { $_.Text })
    $cellTexts += $s
    if ($c.FontWeight -eq [System.Windows.FontWeights]::SemiBold) { $boldCells++ }
  }
}
"  cell texts: " + ($cellTexts -join ' ~ ')
"  bold cells (header): " + $boldCells
if ($grid.ColumnDefinitions.Count -ne 3) { $fail++; '  FAIL card should have 3 columns' }
if ($grid.RowDefinitions.Count -ne 4) { $fail++; '  FAIL card should have 4 rows' }
if ($boldCells -ne 3) { $fail++; '  FAIL header row should be 3 bold cells' }
if ($cellTexts.Count -ne 12) { $fail++; '  FAIL expected 12 cell textblocks, got ' + $cellTexts.Count }
if ($cellTexts -notcontains 'read') { $fail++; '  FAIL inline code should be unwrapped from backticks' }
if ($cellTexts -notcontains 'write') { $fail++; '  FAIL bold text should be unwrapped from **' }

"--- 4. ragged rows, no crash ---"
$r2 = New-Object System.Collections.ArrayList
[void]$r2.Add((Split-TableRow '| a |'))
[void]$r2.Add((Split-TableRow '|  |'))
$r2.Add((Split-TableRow 'only | three | cells | here'))
$c2 = New-TableCard $r2 1
"  ragged card cols=" + $c2.Child.ColumnDefinitions.Count + " rows=" + $c2.Child.RowDefinitions.Count
if ($c2.Child.ColumnDefinitions.Count -ne 4) { $fail++; '  FAIL ragged card should expand to 4 columns' }

"--- 5. empty input ---"
$e = New-Object System.Collections.ArrayList
$c3 = New-TableCard $e 1
if ($null -ne $c3) { $fail++; '  FAIL empty rows should return null' } else { '  empty rows -> null (ok)' }

""
if ($fail -gt 0) { "FAILURES: $fail"; exit 1 } else { 'ALL OK' }
