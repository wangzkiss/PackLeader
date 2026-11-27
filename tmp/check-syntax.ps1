$ErrorActionPreference = 'Stop'
$p = 'D:\Desktop\wzw\PackLeader\ui\PackLeader.ps1'
$bytes = [System.IO.File]::ReadAllBytes($p)[0..3]
"first bytes: " + (($bytes | ForEach-Object { $_.ToString('X2') }) -join ' ')
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$tokens, [ref]$errors) | Out-Null
"parse errors: " + $errors.Count
foreach ($e in $errors) { "  line " + $e.Extent.StartLineNumber + ": " + $e.Message }
