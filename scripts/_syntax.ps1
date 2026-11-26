chcp 65001 | Out-Null
$p = 'E:\Desktop\ai\PackLeader\ui\PackLeader.ps1'
$txt = [System.IO.File]::ReadAllText($p)
$errs = $null
[void][System.Management.Automation.PSParser]::Tokenize($txt, [ref]$errs)
"parse errors: " + $errs.Count
foreach ($e in $errs) { "  line " + $e.Token.StartLine + ": " + $e.Message }
