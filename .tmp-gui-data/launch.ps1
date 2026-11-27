$dir = 'D:\Desktop\wzw\PackLeader\.tmp-gui-data'
Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-STA','-ExecutionPolicy','Bypass','-File','D:\Desktop\wzw\PackLeader\ui\PackLeader.ps1','-DataDir',$dir -WorkingDirectory 'D:\Desktop\wzw\PackLeader'
Write-Output 'started'
