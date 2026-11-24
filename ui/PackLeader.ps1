#
# PackLeader 桌面窗口（WPF / Windows PowerShell 5.1）
#
# 只做两件事：画界面、跟 node 主机进程说 NDJSON。agent 逻辑全在 src/host.ts。
# 不依赖 Electron、不需要编译、不额外占体积（.NET Framework 4.8 是系统自带的）。
#
# 启动：pl gui   （或 node src/cli.ts gui）
# 直接跑：powershell -NoProfile -STA -ExecutionPolicy Bypass -File ui\PackLeader.ps1
#

param(
  [string]$Cwd = $env:PL_GUI_CWD,
  [string]$Mode = $env:PL_GUI_MODE,
  [string]$DataDir = $env:PL_GUI_DATA,
  [string]$BaseUrl = $env:PL_GUI_BASE_URL,
  [string]$ApiKey = $env:PL_GUI_API_KEY,
  [string]$Model = $env:PL_GUI_MODEL
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# 排查用：GUI 出错时没有控制台可看，写一份日志到 %TEMP%
$script:guiLog = Join-Path $env:TEMP 'packleader-ui.log'
"{0:o} start" -f (Get-Date) | Set-Content -Path $script:guiLog -Encoding UTF8
function Log([string]$m) { Add-Content -Path $script:guiLog -Value ("{0:HH:mm:ss} {1}" -f (Get-Date), $m) -Encoding UTF8 }
trap { Log ("异常: " + ($_ | Out-String)); throw }

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml

# 为什么需要这个东西：PowerShell 的脚本事件处理器（Add_OutputDataReceived）在
# ShowDialog() 阻塞期间不会被调度（runspace 被占着），子进程的输出永远读不到。
# 所以用一段 C# 起后台线程读行，UI 线程只从队列里取。
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

public class LinePump
{
    private readonly Queue<string> q = new Queue<string>();
    private readonly object gate = new object();
    private readonly StreamReader reader;
    private volatile bool done;

    public LinePump(StreamReader r) { reader = r; }

    public void Start()
    {
        var t = new Thread(Pump) { IsBackground = true };
        t.Start();
    }

    private void Pump()
    {
        try
        {
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                lock (gate) { q.Enqueue(line); }
            }
        }
        catch { }
        done = true;
    }

    /// <summary>没有新行时返回 null；流结束且取空后也返回 null</summary>
    public string Take()
    {
        lock (gate) { return q.Count > 0 ? q.Dequeue() : null; }
    }

    public bool Finished { get { lock (gate) { return done && q.Count == 0; } } }
}
'@ -Language CSharp

if (-not $Mode) { $Mode = 'guarded' }
if (-not $DataDir) { $DataDir = Join-Path $env:USERPROFILE '.packleader' }
if (-not $Cwd) { $Cwd = (Get-Location).Path }
if (-not $BaseUrl) { $BaseUrl = 'http://127.0.0.1:19790/v1' }
if (-not $Model) { $Model = 'deepseek-flash' }
if (-not $ApiKey) { $ApiKey = $env:PL_API_KEY }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = $env:PL_GUI_ROOT
if (-not $root) { $root = Split-Path -Parent $here }
$hostTs = Join-Path $root 'src\host.ts'

# ---------------- 界面 ----------------

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="PackLeader" Height="700" Width="1060" MinHeight="520" MinWidth="760"
        Background="#16171A" Foreground="#E6E6E6"
        WindowStartupLocation="CenterScreen" FontFamily="Microsoft YaHei UI" FontSize="13">
  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <!-- 顶栏 -->
    <Border Grid.Row="0" Background="#1F2024" BorderBrush="#2E3036" BorderThickness="0,0,0,1" Padding="14,10">
      <DockPanel>
        <StackPanel Orientation="Horizontal" DockPanel.Dock="Left" VerticalAlignment="Center">
          <TextBlock Text="PackLeader" FontSize="15" FontWeight="SemiBold" Foreground="#EDEDED" VerticalAlignment="Center"/>
          <Border Background="#26282D" CornerRadius="4" Padding="7,3" Margin="10,0,0,0">
            <TextBlock x:Name="WorkspaceLabel" Text="…" Foreground="#9AA0A6" FontSize="12"/>
          </Border>
          <Button x:Name="PickFolderBtn" Content="换目录" Margin="8,0,0,0" Padding="10,4"
                  Background="#2A2C31" Foreground="#D6D6D6" BorderBrush="#3A3D44" BorderThickness="1" Cursor="Hand"/>
        </StackPanel>

        <StackPanel Orientation="Horizontal" DockPanel.Dock="Right" VerticalAlignment="Center">
          <TextBlock Text="权限" Foreground="#8B9096" VerticalAlignment="Center" Margin="0,0,8,0"/>
          <Border Background="#26282D" CornerRadius="6" Padding="2" VerticalAlignment="Center">
            <StackPanel Orientation="Horizontal">
              <Button x:Name="ModeRead" Content="只读" Padding="10,3" FontSize="12"
                      Background="Transparent" Foreground="#9AA0A6" BorderThickness="0" Cursor="Hand"/>
              <Button x:Name="ModeGuard" Content="询问" Padding="10,3" FontSize="12" Margin="2,0"
                      Background="Transparent" Foreground="#9AA0A6" BorderThickness="0" Cursor="Hand"/>
              <Button x:Name="ModeFull" Content="完全" Padding="10,3" FontSize="12"
                      Background="Transparent" Foreground="#9AA0A6" BorderThickness="0" Cursor="Hand"/>
            </StackPanel>
          </Border>
          <TextBlock Text="模型" Foreground="#8B9096" VerticalAlignment="Center" Margin="14,0,6,0"/>
          <Border Background="#26282D" CornerRadius="6" Padding="8,3" VerticalAlignment="Center">
            <TextBox x:Name="ModelBox" Width="140" Background="Transparent" Foreground="#E6E6E6"
                     BorderThickness="0" FontSize="12" VerticalContentAlignment="Center"/>
          </Border>
          <Button x:Name="NewChatBtn" Content="新对话" Margin="14,0,0,0" Padding="10,4"
                  Background="#2A2C31" Foreground="#D6D6D6" BorderBrush="#3A3D44" BorderThickness="1" Cursor="Hand"/>
        </StackPanel>
      </DockPanel>
    </Border>

    <!-- 对话区 -->
    <ScrollViewer Grid.Row="1" x:Name="Scroller" VerticalScrollBarVisibility="Auto" Padding="18,14,10,14">
      <StackPanel x:Name="Transcript"/>
    </ScrollViewer>

    <!-- 输入区（输入框 + 提示 + 状态行都在这一块，避免 Auto 行把状态栏挤出窗口） -->
    <Border Grid.Row="2" Background="#1B1C20" BorderBrush="#2E3036" BorderThickness="0,1,0,0" Padding="14,12,14,6">
      <StackPanel>
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <Border Grid.Column="0" Background="#26282D" CornerRadius="8" Padding="10,8">
            <TextBox x:Name="Input" AcceptsReturn="True" TextWrapping="Wrap" MinHeight="44" MaxHeight="150"
                     Background="Transparent" Foreground="#EDEDED" BorderThickness="0"
                     VerticalScrollBarVisibility="Auto" FontSize="13"
                     CaretBrush="#EDEDED" SelectionBrush="#3D5AFE"/>
          </Border>
          <StackPanel Grid.Column="1" Orientation="Vertical" Margin="12,0,0,0" VerticalAlignment="Bottom">
            <Button x:Name="SendBtn" Content="发送" Width="78" Height="32"
                    Background="#3D5AFE" Foreground="White" BorderThickness="0" Cursor="Hand" FontWeight="SemiBold"/>
            <Button x:Name="StopBtn" Content="停止" Width="78" Height="28" Margin="0,8,0,0" IsEnabled="False"
                    Background="#3A2A2C" Foreground="#E8A0A6" BorderBrush="#5A3A3E" BorderThickness="1" Cursor="Hand"/>
          </StackPanel>
        </Grid>
        <DockPanel Margin="4,6,0,0">
          <TextBlock x:Name="Hint" DockPanel.Dock="Left" Text="Enter 发送 · Shift+Enter 换行"
                     Foreground="#6E7378" FontSize="11" VerticalAlignment="Center"/>
          <TextBlock x:Name="UsageText" DockPanel.Dock="Right" Text="" Foreground="#6E7378" FontSize="11"
                     HorizontalAlignment="Right" VerticalAlignment="Center"/>
          <TextBlock x:Name="StatusText" Text="正在连接…" Foreground="#8B9096" FontSize="11"
                     Margin="16,0,16,0" VerticalAlignment="Center"/>
        </DockPanel>
      </StackPanel>
    </Border>

    <!-- 底部空行，保证最下方不被窗口边框切到 -->
    <Border Grid.Row="3" Background="#1B1C20" Height="4"/>
  </Grid>
</Window>
'@

$window = [Windows.Markup.XamlReader]::Parse($xaml)
Log 'XAML 解析成功'
$window.Dispatcher.add_UnhandledException({
  param($s, $e)
  Log ("Dispatcher 未处理异常: " + $e.Exception.ToString())
})
$Transcript = $window.FindName('Transcript')
$Scroller = $window.FindName('Scroller')
$InputBox = $window.FindName('Input')
$SendBtn = $window.FindName('SendBtn')
$StopBtn = $window.FindName('StopBtn')
$StatusText = $window.FindName('StatusText')
$UsageText = $window.FindName('UsageText')
$WorkspaceLabel = $window.FindName('WorkspaceLabel')
$PickFolderBtn = $window.FindName('PickFolderBtn')
$ModeRead = $window.FindName('ModeRead')
$ModeGuard = $window.FindName('ModeGuard')
$ModeFull = $window.FindName('ModeFull')
$ModelBox = $window.FindName('ModelBox')
$NewChatBtn = $window.FindName('NewChatBtn')
$Hint = $window.FindName('Hint')

$WorkspaceLabel.Text = $Cwd
$ModelBox.Text = $Model

# 权限用三个按钮而不是下拉：深色主题下 WPF 默认 ComboBox 模板读不到前景色，会渲染成空白
$script:modeButtons = @{ 'read-only' = $ModeRead; 'guarded' = $ModeGuard; 'full' = $ModeFull }
function Set-ModeVisual([string]$m) {
  foreach ($k in $script:modeButtons.Keys) {
    $b = $script:modeButtons[$k]
    if ($k -eq $m) {
      $b.Background = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#3D5AFE')))
      $b.Foreground = [System.Windows.Media.Brushes]::White
    } else {
      $b.Background = [System.Windows.Media.Brushes]::Transparent
      $b.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#9AA0A6')))
    }
  }
}
Set-ModeVisual $Mode

# ---------------- 样式小工具 ----------------

function New-Text([string]$text, [double]$size, [string]$color, [string]$weight = 'Normal', [string]$family = $null) {
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Text = $text
  $tb.FontSize = $size
  $tb.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($color)))
  $tb.FontWeight = $weight
  if ($family) { $tb.FontFamily = $family }
  $tb.TextWrapping = 'Wrap'
  return $tb
}

function New-Card([string]$bg, [string]$border, [double]$radius = 8) {
  $b = New-Object System.Windows.Controls.Border
  $b.Background = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($bg)))
  $b.BorderBrush = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($border)))
  $b.BorderThickness = '1'
  $b.CornerRadius = $radius
  $b.Padding = '12,10'
  $b.Margin = '0,0,0,12'
  return $b
}

function Scroll-Bottom {
  $Scroller.ScrollToEnd()
}

# 用户气泡（右对齐）
function Add-UserMessage([string]$text) {
  $wrap = New-Object System.Windows.Controls.StackPanel
  $wrap.HorizontalAlignment = 'Right'
  $wrap.Margin = '0,0,0,10'
  $wrap.MaxWidth = 720
  $card = New-Card '#2B3A67' '#33477D' 10
  $card.Margin = '0'
  $card.Padding = '12,9'
  $card.Child = (New-Text $text 13 '#EDF0FF')
  $wrap.Children.Add($card) | Out-Null
  $Transcript.Children.Add($wrap) | Out-Null
  Scroll-Bottom
}

# 助手正文（返回 TextBlock，流式时往里追加）
function Add-AssistantMessage {
  $wrap = New-Object System.Windows.Controls.StackPanel
  $wrap.Margin = '0,0,0,12'
  $tb = New-Text '' 13 '#E6E6E6'
  $wrap.Children.Add($tb) | Out-Null
  $Transcript.Children.Add($wrap) | Out-Null
  return $tb
}

# 工具行
function Add-ToolRow([string]$name, [string]$summary) {
  $wrap = New-Object System.Windows.Controls.StackPanel
  $wrap.Orientation = 'Horizontal'
  $wrap.Margin = '2,0,0,4'
  $lab = New-Text ("⚙ " + $name) 11.5 '#7F94B8' 'Normal' 'Consolas'
  $lab.Margin = '0,0,8,0'
  $txt = New-Text $summary 11.5 '#8B9096' 'Normal' 'Consolas'
  $wrap.Children.Add($lab) | Out-Null
  $wrap.Children.Add($txt) | Out-Null
  $Transcript.Children.Add($wrap) | Out-Null
  Scroll-Bottom
  return @($wrap, $txt)
}

function Add-SystemLine([string]$text, [string]$color = '#8B9096') {
  $tb = New-Text $text 11.5 $color
  $tb.Margin = '2,0,0,8'
  $Transcript.Children.Add($tb) | Out-Null
  Scroll-Bottom
}

# ---------------- 跟主机进程通信 ----------------

$psi = New-Object System.Diagnostics.ProcessStartInfo
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'node.exe' }
$psi.FileName = $node
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$psi.WorkingDirectory = $root
$hostArgs = @('--disable-warning=ExperimentalWarning', $hostTs, '--cwd', $Cwd, '--mode', $Mode, '--data-dir', $DataDir,
              '--base-url', $BaseUrl, '--model', $Model)
if ($ApiKey) { $hostArgs += @('--api-key', $ApiKey) }
# .NET Framework 4.8 没有 ArgumentList（那是 .NET Core 的），只能自己拼带引号的字符串
$psi.Arguments = ($hostArgs | ForEach-Object {
  if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
}) -join ' '

$proc = [System.Diagnostics.Process]::Start($psi)
Log "host 已启动 pid=$($proc.Id) args=$($psi.Arguments)"

$pumpOut = New-Object LinePump -ArgumentList $proc.StandardOutput
$pumpOut.Start()
$pumpErr = New-Object LinePump -ArgumentList $proc.StandardError
$pumpErr.Start()
Log '输出泵已启动'

function Send-Host([hashtable]$payload) {
  if ($proc.HasExited) { return }
  $json = $payload | ConvertTo-Json -Compress
  $proc.StandardInput.WriteLine($json)
  $proc.StandardInput.Flush()
}

# ---------------- UI 状态 ----------------

$script:busy = $false
$script:currentAssistant = $null
$script:pendingText = New-Object System.Text.StringBuilder
$script:pendingReasoning = $false
$script:pendingTools = @{}
$script:toolRows = @{}

function Set-Busy([bool]$value) {
  $script:busy = $value
  $SendBtn.IsEnabled = -not $value
  $StopBtn.IsEnabled = $value
  $StatusText.Text = if ($value) { '运行中…' } else { '就绪' }
}

function Start-Turn([string]$text) {
  if ($script:busy -or -not $text.Trim()) { return }
  Add-UserMessage $text
  $InputBox.Text = ''
  $script:currentAssistant = $null
  $script:pendingText.Clear() | Out-Null
  Set-Busy $true
  Send-Host @{ cmd = 'task'; text = $text }
  $Scroller.ScrollToEnd()
}

# ---------------- 事件处理 ----------------

function Handle-Event([string]$line) {
  try { $e = $line | ConvertFrom-Json } catch { return }
  switch ($e.type) {
    'ready' {
      $WorkspaceLabel.Text = $Cwd
      $StatusText.Text = "会话 $($e.session) · 就绪"
      # 重放历史
      foreach ($ev in $e.events) {
        if ($ev.kind -eq 'user/message') { Add-UserMessage $ev.text }
        elseif ($ev.kind -eq 'assistant/message' -and $ev.text) { (Add-AssistantMessage).Text = $ev.text }
        elseif ($ev.kind -eq 'tool/call') { Add-ToolRow $ev.name (Summarize-Args $ev.name $ev.args) | Out-Null }
      }
      # 不能在这里清空 currentAssistant —— tick 可能晚于 Loaded 里的 Start-Turn 到达，
      # 会把刚建好的回答框清掉（回答就永远不显示）
      if (-not $script:busy) { $script:currentAssistant = $null }
      Scroll-Bottom
    }
    'turn-start' { }
    'step' { $StatusText.Text = "第 $($e.step) 步…" }
    'text' {
      # 懒创建：第一个文本增量到来时才加块，这样工具行在上、回答在下，顺序跟真实时间线一致
      if (-not $script:currentAssistant) { $script:currentAssistant = Add-AssistantMessage }
      $script:pendingText.Append($e.delta) | Out-Null
    }
    'assistant-end' {
      if (-not $script:currentAssistant) { $script:currentAssistant = Add-AssistantMessage }
      $script:currentAssistant.Text = $e.text
      $script:pendingText.Clear() | Out-Null
    }
    'tool-start' {
      $rows = Add-ToolRow $e.name $e.summary
      $script:toolRows[$e.id] = $rows[1]
    }
    'tool-end' {
      $tb = $script:toolRows[$e.id]
      if ($tb) {
        if ($e.ok) {
          $tb.Text = "$($tb.Text)  ✓ $($e.ms)ms"
          $tb.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#6FA86F')))
        } else {
          $tb.Text = "$($tb.Text)  ✗ $($e.error)"
          $tb.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#D98A8A')))
        }
      }
      Scroll-Bottom
    }
    'approval' { Add-ApprovalCard $e }
    'notice' { Add-SystemLine $e.text '#A99456' }
    'error' {
      Add-SystemLine ("错误：" + $e.message) '#D98A8A'
      if ($e.fatal) { Set-Busy $false }
    }
    'usage' {
      $p = [int]$e.prompt; $c = [int]$e.completion; $cr = [int]$e.cacheRead
      $pct = if ($p -gt 0) { [math]::Round($cr * 100 / $p) } else { 0 }
      $UsageText.Text = "用量 $($e.calls) 次 · prompt $p · completion $c · 缓存 $pct%"
    }
    'turn-end' {
      if ($script:pendingText.Length -gt 0 -and $script:currentAssistant) {
        $script:currentAssistant.Text += $script:pendingText.ToString()
        $script:pendingText.Clear() | Out-Null
      }
      Set-Busy $false
      $script:currentAssistant = $null
      if ($e.reason -eq 'max-steps') { Add-SystemLine '已达步数上限（已让模型收尾）' '#A99456' }
      if ($e.reason -eq 'cancelled') { Add-SystemLine '已中断' '#A99456' }
      $StatusText.Text = "就绪 · 本轮 $([math]::Round([double]$e.ms / 1000, 1))s"
    }
    'mode' { $StatusText.Text = "权限已切到 $($e.mode)" }
    'model' { $StatusText.Text = "模型已切到 $($e.model)" }
    'cwd' { $Cwd = $e.cwd; $WorkspaceLabel.Text = $Cwd }
    'sessions' { }
    'stderr' { Add-SystemLine ("host: " + $e.message) '#7A5A5A' }
  }
}

function Summarize-Args([string]$name, $args) {
  if ($null -eq $args) { return '' }
  foreach ($k in @('path', 'pattern', 'command')) {
    if ($args.$k) { return [string]$args.$k }
  }
  return ''
}

function Add-ApprovalCard($e) {
  $wrap = New-Card '#2A2418' '#8A7440' 8
  $stack = New-Object System.Windows.Controls.StackPanel
  $head = New-Text ("需要确认：" + $e.tool + " · " + $e.reason) 12.5 '#E8CFA0' 'SemiBold'
  $stack.Children.Add($head) | Out-Null
  if ($e.detail) {
    $d = New-Text $e.detail 11.5 '#B8A98A' 'Normal' 'Consolas'
    $d.Margin = '0,6,0,0'
    $stack.Children.Add($d) | Out-Null
  }
  $row = New-Object System.Windows.Controls.StackPanel
  $row.Orientation = 'Horizontal'
  $row.Margin = '0,10,0,0'

  $yes = New-Object System.Windows.Controls.Button
  $yes.Content = '允许一次'
  $yes.Padding = '12,5'
  $yes.Background = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#3D6B4A')))
  $yes.Foreground = [System.Windows.Media.Brushes]::White
  $yes.BorderThickness = '0'
  $yes.Cursor = 'Hand'
  $reqId = $e.reqId
  $yes.Add_Click({
    Send-Host @{ cmd = 'approve'; reqId = $reqId; decision = 'allowed-once' }
    $wrap.Opacity = 0.55
    $yes.IsEnabled = $false
    $no.IsEnabled = $false
  }.GetNewClosure())

  $no = New-Object System.Windows.Controls.Button
  $no.Content = '拒绝'
  $no.Padding = '12,5'
  $no.Margin = '8,0,0,0'
  $no.Background = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#3A2A2C')))
  $no.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#E8A0A6')))
  $no.BorderThickness = '0'
  $no.Cursor = 'Hand'
  $no.Add_Click({
    Send-Host @{ cmd = 'approve'; reqId = $reqId; decision = 'denied' }
    $wrap.Opacity = 0.55
    $yes.IsEnabled = $false
    $no.IsEnabled = $false
  }.GetNewClosure())

  $row.Children.Add($yes) | Out-Null
  $row.Children.Add($no) | Out-Null
  $stack.Children.Add($row) | Out-Null
  $wrap.Child = $stack
  $Transcript.Children.Add($wrap) | Out-Null
  Scroll-Bottom
}

# ---------------- 定时器：把缓存的文本刷进 UI ----------------

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(50)
$timer.Add_Tick({
  try {
    if (-not $script:tickSeen) { $script:tickSeen = $true; Log 'Tick 首次触发' }
    # 1) 抽包子进程输出（stdout 是 NDJSON 事件，stderr 只记日志）
    for ($i = 0; $i -lt 300; $i++) {
      $l = $pumpOut.Take()
      if ($null -eq $l) { break }
      if ($l.Trim()) { Handle-Event $l }
    }
    for ($i = 0; $i -lt 50; $i++) {
      $l = $pumpErr.Take()
      if ($null -eq $l) { break }
      if ($l.Trim()) { Log ("stderr: " + $l) }
    }
    if ($pumpOut.Finished -and -not $script:hostGone) {
      $script:hostGone = $true
      Add-SystemLine 'host 进程已退出（窗口可关闭后重开）' '#D98A8A'
      Set-Busy $false
    }
    # 2) 流式文本
    if ($script:pendingText.Length -gt 0 -and $script:currentAssistant) {
      $script:currentAssistant.Text += $script:pendingText.ToString()
      $script:pendingText.Clear() | Out-Null
      $Scroller.ScrollToEnd()
    }
  } catch {
    Log ("Tick 异常: " + ($_ | Out-String))
  }
})

# ---------------- 交互 ----------------

$SendBtn.Add_Click({ Start-Turn $InputBox.Text })

$InputBox.Add_KeyDown({
  param($s, $e)
  if ($e.Key -eq 'Return' -and -not [System.Windows.Input.Keyboard]::IsKeyDown([System.Windows.Input.Key]::LeftShift) -and
      -not [System.Windows.Input.Keyboard]::IsKeyDown([System.Windows.Input.Key]::RightShift)) {
    $e.Handled = $true
    Start-Turn $InputBox.Text
  }
})

$StopBtn.Add_Click({
  Send-Host @{ cmd = 'abort' }
  $StatusText.Text = '已请求中断…'
})

foreach ($pair in @(@('read-only', $ModeRead), @('guarded', $ModeGuard), @('full', $ModeFull))) {
  $m = $pair[0]
  $pair[1].Add_Click({
    Set-ModeVisual $m
    Send-Host @{ cmd = 'mode'; mode = $m }
  }.GetNewClosure())
}

$ModelBox.Add_LostFocus({
  $m = $ModelBox.Text.Trim()
  if ($m) { Send-Host @{ cmd = 'model'; model = $m } }
})

$NewChatBtn.Add_Click({
  Send-Host @{ cmd = 'new-session' }
  $Transcript.Children.Clear()
  $script:toolRows = @{}
  Add-SystemLine '新对话已开始' '#5E6B7E'
})

$PickFolderBtn.Add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  if ($dlg.ShowDialog() -eq 'OK') {
    Send-Host @{ cmd = 'cwd'; dir = $dlg.SelectedPath }
    $Cwd = $dlg.SelectedPath
    $WorkspaceLabel.Text = $Cwd
  }
})

$window.Add_Loaded({
  Log '窗口 Loaded'
  $timer.Start()
  $InputBox.Focus() | Out-Null
  # 自测入口：设置 PL_GUI_TASK 会自动发第一条任务（也方便截图验证）
  if ($env:PL_GUI_TASK) {
    Start-Turn $env:PL_GUI_TASK
  }
})

$window.Add_Closing({
  Log '窗口 Closing'
  $timer.Stop()
  try { $proc.StandardInput.Close() } catch { }
  Start-Sleep -Milliseconds 150
  try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
})

Log '准备 ShowDialog'
$window.ShowDialog() | Out-Null
Log '窗口已关闭'
