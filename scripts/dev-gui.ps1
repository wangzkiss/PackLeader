param([string]$Cwd = "$env:TEMP", [string]$Data = "$env:TEMP\pl-gui-dev")
$env:PL_API_KEY = 'sk-any'
$env:PL_BASE_URL = 'http://127.0.0.1:19790/v1'
cd E:\Desktop\ai\PackLeader
node --disable-warning=ExperimentalWarning src/cli.ts gui --cwd $Cwd --data-dir $Data --mode full --model deepseek-flash