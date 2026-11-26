// 修补 2 个冒烟测试暴露的问题：
// 1) Grid.SetVerticalAlignment 不存在（垂直对齐是元素自身属性）
// 2) 行内代码里的 | 仍被当分隔符（lookbehind 只挡住紧邻反引号的情形，跨过内容就失效）
//    -> 改成逐字符扫描，用 inCode 开关跟踪是否在反引号内
import { readFileSync, writeFileSync } from 'node:fs'

const P = 'ui/PackLeader.ps1'
const raw = readFileSync(P, 'utf8')
if (!raw.startsWith('\ufeff')) throw new Error('缺少 BOM')
let out = raw.slice(1).replace(/\r\n/g, '\n')

function rep(from, to) {
  const i = out.indexOf(from)
  if (i < 0) throw new Error('没找到：\n' + from.slice(0, 80))
  if (out.indexOf(from, i + 1) >= 0) throw new Error('不唯一：\n' + from.slice(0, 80))
  out = out.slice(0, i) + to + out.slice(i + from.length)
}

// 1) 垂直对齐
rep(
  "      [System.Windows.Controls.Grid]::SetVerticalAlignment($ln, 'Bottom')",
  "      $ln.VerticalAlignment = 'Bottom'",
)

// 2) 行切分：逐字符扫描，反引号内的 | 不切
rep(
  [
    'function Split-TableRow([string]$line) {',
    '  $s = $line.Trim()',
    "  if ($s.StartsWith('|')) { $s = $s.Substring(1) }",
    "  if ($s.EndsWith('|')) { $s = $s.Substring(0, $s.Length - 1) }",
    '  $cells = New-Object System.Collections.ArrayList',
    '  # 行内代码里的 | 不算分隔符',
    "  foreach ($c in [regex]::Split($s, '(?<!`)\\|(?!`)')) { [void]$cells.Add($c.Trim()) }",
    '  return $cells',
    '}',
  ].join('\n'),
  [
    'function Split-TableRow([string]$line) {',
    '  $s = $line.Trim()',
    "  if ($s.StartsWith('|')) { $s = $s.Substring(1) }",
    "  if ($s.EndsWith('|')) { $s = $s.Substring(0, $s.Length - 1) }",
    '  $cells = New-Object System.Collections.ArrayList',
    '  $buf = New-Object System.Text.StringBuilder',
    '  # 逐字符扫：反引号内的 | 是内容不是分隔符（`a|b` 仍算一格）',
    '  $inCode = $false',
    '  foreach ($ch in $s.ToCharArray()) {',
    "    if ($ch -eq '`') { $inCode = -not $inCode }",
    "    if (($ch -eq '|') -and (-not $inCode)) {",
    '      [void]$cells.Add($buf.ToString().Trim())',
    '      [void]$buf.Clear()',
    '      continue',
    '    }',
    '    [void]$buf.Append($ch)',
    '  }',
    '  [void]$cells.Add($buf.ToString().Trim())',
    '  return $cells',
    '}',
  ].join('\n'),
)

writeFileSync(P, '\ufeff' + out.replace(/\n/g, '\r\n'), 'utf8')
console.log('fixed, lines =', out.split('\n').length)
