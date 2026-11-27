param([int]$TargetPid = 0, [string]$Text = '')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$desktop = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)
$win = $desktop.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Output 'no uia window'; exit 1 }
$c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Text)
$all = @($win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c))
Write-Output ("text hits: " + $all.Count)
if ($all.Count -eq 0) { exit 1 }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$el = $all[0]
for ($i = 0; $i -lt 5; $i++) {
  $el = $walker.GetParent($el)
  if (-not $el) { break }
  Write-Output ("up: " + $el.Current.ControlType.ProgrammaticName + " / " + $el.Current.Name)
  if ($el.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' -or $el.Current.ControlType.ProgrammaticName -eq 'ControlType.ListItem') {
    try {
      $inv = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $inv.Invoke()
      Write-Output 'invoked'
    } catch {
      try {
        $sel = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $sel.Select()
        Write-Output 'selected'
      } catch { Write-Output ('click failed: ' + $_.Exception.Message) }
    }
    break
  }
}
