param([int]$TargetPid = 0, [string]$Name = '', [string]$Id = '', [int]$Index = 0)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Output 'no uia window'; exit 1 }
if ($Id) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Id)
} else {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
}
$all = @($win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c))
Write-Output ("hits: " + $all.Count)
foreach ($a in $all) { Write-Output ("- [" + $a.Current.ControlType.ProgrammaticName + "] " + $a.Current.Name) }
if ($all.Count -le $Index) { Write-Output 'no such element'; exit 1 }
$el = $all[$Index]
try {
  $inv = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $inv.Invoke()
  Write-Output 'invoked'
} catch { Write-Output ('invoke failed: ' + $_.Exception.Message) }
