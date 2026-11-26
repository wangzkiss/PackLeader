chcp 65001 | Out-Null
$p = 'E:\Desktop\ai\PackLeader\ui\PackLeader.ps1'
$t = [System.IO.File]::ReadAllText($p)
"splitRow at: " + $t.IndexOf('function Split-TableRow')
"clipLong at: " + $t.IndexOf('function Clip-LongText')
"ruleDef at: " + $t.LastIndexOf('tableRuleRe =')
"ruleReFwd: " + $t.IndexOf('tableRuleRe =')
