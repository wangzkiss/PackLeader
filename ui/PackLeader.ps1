#Requires -Version 5.1
<#
  PackLeader 桌面窗口（WPF / PowerShell 5.1 / .NET Framework 4.8，都是 Windows 自带）

  设计参考 DeepSeek Harness 的界面：深色中性底、左侧会话栏、无气泡消息流、
  细描边（12% 白）卡片、等宽字体显示工具调用。配色取自 DSH 自己的 CSS 变量：
    #0f1115 底色 / #f9fafb 主文字 / #cfd3d6 次文字 / #adb2b8 三级文字 / rgba(255,255,255,.12) 描边
  字号取自它的主题插件：正文 14px，代码小 1px，行高 1.6。

  往外只做一件事：把用户输入变成 NDJSON 写给 src/host.ts，把 host 的事件画出来。

  启动：pl gui   （或 node src/cli.ts gui）
  直接跑：powershell -NoProfile -STA -ExecutionPolicy Bypass -File ui\PackLeader.ps1
#>

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

$script:guiLog = Join-Path $env:TEMP 'packleader-ui.log'
"{0:o} start" -f (Get-Date) | Set-Content -Path $script:guiLog -Encoding UTF8
function Log([string]$m) { Add-Content -Path $script:guiLog -Value ("{0:HH:mm:ss} {1}" -f (Get-Date), $m) -Encoding UTF8 }
trap { Log ("异常: " + ($_ | Out-String)); throw }

if (-not $Cwd) { $Cwd = (Get-Location).Path }
if (-not $Mode) { $Mode = 'guarded' }
if (-not $DataDir) { $DataDir = Join-Path (Split-Path -Parent $PSScriptRoot) '.pl-data' }
if (-not $BaseUrl) { $BaseUrl = 'http://127.0.0.1:19790/v1' }
if (-not $Model) { $Model = 'deepseek-flash' }
if (-not $ApiKey) { $ApiKey = $env:PL_API_KEY }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = $env:PL_GUI_ROOT
if (-not $root) { $root = Split-Path -Parent $here }
$hostTs = Join-Path $root 'src\host.ts'

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml, System.Windows.Forms

# ---------------------------------------------------------------- 界面
$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="PackLeader" Height="720" Width="1120" MinHeight="520" MinWidth="860"
        WindowStartupLocation="CenterScreen"
        Background="#0F1115" FontFamily="Segoe UI" FontSize="13"
        UseLayoutRounding="True" SnapsToDevicePixels="True"
        TextOptions.TextFormattingMode="Ideal">
  <Window.Resources>
    <!-- 默认焦点虚线框在深色底上很跳，去掉 -->
    <Style TargetType="Button">
      <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
    </Style>
    <Style TargetType="TextBox">
      <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
    </Style>
  </Window.Resources>
  <Grid>
    <Grid.ColumnDefinitions>
      <ColumnDefinition Width="252"/>
      <ColumnDefinition Width="*"/>
    </Grid.ColumnDefinitions>

    <!-- ================= 左侧栏 ================= -->
    <Border Grid.Column="0" Background="#0B0D11" BorderBrush="#12FFFFFF" BorderThickness="0,0,1,0">
      <Grid>
        <Grid.RowDefinitions>
          <RowDefinition Height="Auto"/>
          <RowDefinition Height="Auto"/>
          <RowDefinition Height="*"/>
          <RowDefinition Height="Auto"/>
        </Grid.RowDefinitions>

        <!-- 品牌 -->
        <StackPanel Grid.Row="0" Orientation="Horizontal" Margin="16,16,16,12">
          <Border Width="18" Height="18" CornerRadius="5" Background="#2B5CFF" VerticalAlignment="Center">
            <TextBlock Text="P" Foreground="White" FontSize="11" FontWeight="Bold"
                       HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <TextBlock Text="PackLeader" Foreground="#F9FAFB" FontSize="13.5" FontWeight="SemiBold"
                     Margin="9,0,0,0" VerticalAlignment="Center"/>
          <TextBlock Text="单机" Foreground="#6B7280" FontSize="10.5" Margin="8,2,0,0" VerticalAlignment="Center"/>
        </StackPanel>

        <!-- 新对话 -->
        <Button Grid.Row="1" x:Name="NewChatBtn" Margin="12,0,12,8" Height="32" Cursor="Hand"
                HorizontalContentAlignment="Left" Padding="10,0"
                Background="#16181D" Foreground="#E6E8EE" BorderBrush="#1FFFFFFF" BorderThickness="1">
          <Button.Template>
            <ControlTemplate TargetType="Button">
              <Border x:Name="bd" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                      BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="8">
                <ContentPresenter Margin="{TemplateBinding Padding}" VerticalAlignment="Center"/>
              </Border>
              <ControlTemplate.Triggers>
                <Trigger Property="IsMouseOver" Value="True">
                  <Setter TargetName="bd" Property="Background" Value="#1B1F27"/>
                  <Setter TargetName="bd" Property="BorderBrush" Value="#33FFFFFF"/>
                </Trigger>
              </ControlTemplate.Triggers>
            </ControlTemplate>
          </Button.Template>
          <StackPanel Orientation="Horizontal">
            <TextBlock Text="＋" FontSize="13" Foreground="#ADB2B8" VerticalAlignment="Center"/>
            <TextBlock Text="新对话" Margin="6,0,0,0" FontSize="12.5" VerticalAlignment="Center"/>
          </StackPanel>
        </Button>

        <!-- 会话列表 -->
        <ScrollViewer Grid.Row="2" VerticalScrollBarVisibility="Auto" Padding="8,4,8,8">
          <StackPanel>
            <TextBlock Text="最近" Foreground="#6B7280" FontSize="10.5" Margin="8,6,0,6"/>
            <StackPanel x:Name="SessionList"/>
          </StackPanel>
        </ScrollViewer>

        <!-- 底部：工作目录 + 权限 -->
        <Border Grid.Row="3" BorderBrush="#12FFFFFF" BorderThickness="0,1,0,0" Padding="12,10">
          <StackPanel>
            <DockPanel>
              <TextBlock Text="工作目录" Foreground="#6B7280" FontSize="10.5" DockPanel.Dock="Left" VerticalAlignment="Center"/>
              <Button x:Name="PickFolderBtn" Content="换" DockPanel.Dock="Right" Cursor="Hand" FontSize="10.5"
                      Padding="6,1" Height="20" Background="Transparent" Foreground="#ADB2B8"
                      BorderBrush="#1FFFFFFF" BorderThickness="1"/>
              <TextBlock x:Name="WorkspaceLabel" Text="" Foreground="#ADB2B8" FontSize="11"
                         Margin="8,0,6,0" VerticalAlignment="Center" TextTrimming="CharacterEllipsis"
                         TextWrapping="NoWrap"/>
            </DockPanel>
            <DockPanel Margin="0,8,0,0">
              <TextBlock Text="权限" Foreground="#6B7280" FontSize="10.5" DockPanel.Dock="Left" VerticalAlignment="Center"/>
              <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
                <Button x:Name="ModeRead" Content="只读" Cursor="Hand" FontSize="10.5" Padding="7,1" Height="20"
                        Background="Transparent" Foreground="#ADB2B8" BorderThickness="0"/>
                <Button x:Name="ModeGuard" Content="询问" Cursor="Hand" FontSize="10.5" Padding="7,1" Height="20" Margin="2,0"
                        Background="Transparent" Foreground="#ADB2B8" BorderThickness="0"/>
                <Button x:Name="ModeFull" Content="完全" Cursor="Hand" FontSize="10.5" Padding="7,1" Height="20"
                        Background="Transparent" Foreground="#ADB2B8" BorderThickness="0"/>
              </StackPanel>
            </DockPanel>
          </StackPanel>
        </Border>
      </Grid>
    </Border>

    <!-- ================= 右侧 ================= -->
    <Grid Grid.Column="1">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>

      <!-- 顶栏 -->
      <Border Grid.Row="0" BorderBrush="#12FFFFFF" BorderThickness="0,0,0,1" Padding="24,0" Height="48">
        <DockPanel VerticalAlignment="Center">
          <StackPanel Orientation="Horizontal" DockPanel.Dock="Left" VerticalAlignment="Center">
            <TextBlock x:Name="TitleText" Text="新对话" Foreground="#F9FAFB" FontSize="13" FontWeight="SemiBold"
                       VerticalAlignment="Center" TextTrimming="CharacterEllipsis" MaxWidth="420"/>
            <TextBlock x:Name="SubTitle" Text="" Foreground="#6B7280" FontSize="11" Margin="10,1,0,0"
                       VerticalAlignment="Center"/>
          </StackPanel>
          <StackPanel Orientation="Horizontal" DockPanel.Dock="Right" HorizontalAlignment="Right" VerticalAlignment="Center">
            <TextBlock Text="模型" Foreground="#6B7280" FontSize="10.5" VerticalAlignment="Center" Margin="0,0,6,0"/>
            <Border Background="#16181D" BorderBrush="#12FFFFFF" BorderThickness="1" CornerRadius="6" Padding="8,3">
              <TextBox x:Name="ModelBox" Width="132" Background="Transparent" Foreground="#CFD3D6" BorderThickness="0"
                       FontFamily="Cascadia Mono, Consolas" FontSize="11.5" VerticalContentAlignment="Center"/>
            </Border>
          </StackPanel>
        </DockPanel>
      </Border>

      <!-- 会话内容 -->
      <ScrollViewer Grid.Row="1" x:Name="Scroller" VerticalScrollBarVisibility="Auto" Padding="24,18,18,18">
        <StackPanel x:Name="Transcript" MaxWidth="820" HorizontalAlignment="Left"/>
      </ScrollViewer>

      <!-- 输入区 -->
      <Grid Grid.Row="2" Margin="24,0,24,14">
        <Border Background="#16181D" BorderBrush="#1FFFFFFF" BorderThickness="1" CornerRadius="12" Padding="14,10,12,8">
          <StackPanel>
            <TextBox x:Name="Input" AcceptsReturn="True" TextWrapping="Wrap" MinHeight="46" MaxHeight="160"
                     Background="Transparent" Foreground="#F9FAFB" BorderThickness="0"
                     VerticalScrollBarVisibility="Auto" FontSize="13.5" FontFamily="Segoe UI"
                     CaretBrush="#F9FAFB" SelectionBrush="#2B5CFF" Padding="0"/>
            <DockPanel Margin="0,6,0,0">
              <TextBlock x:Name="Hint" DockPanel.Dock="Left" Text="Enter 发送 · Shift+Enter 换行"
                         Foreground="#5B626D" FontSize="10.5" VerticalAlignment="Center"/>
              <StackPanel DockPanel.Dock="Right" Orientation="Horizontal" HorizontalAlignment="Right">
                <TextBlock x:Name="UsageText" Text="" Foreground="#5B626D" FontSize="10.5"
                           VerticalAlignment="Center" Margin="0,0,10,0"/>
                <Button x:Name="StopBtn" Content="停止" Height="26" Padding="10,0" Cursor="Hand" FontSize="11.5"
                        Background="Transparent" Foreground="#F87171" BorderBrush="#66F87171" BorderThickness="1"
                        IsEnabled="False" Visibility="Collapsed"/>
                <Button x:Name="SendBtn" Content="发送" Height="26" Padding="14,0" Cursor="Hand" FontSize="11.5"
                        FontWeight="SemiBold" Background="#2B5CFF" Foreground="White" BorderThickness="0"/>
              </StackPanel>
            </DockPanel>
          </StackPanel>
        </Border>
      </Grid>
    </Grid>
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
$UsageText = $window.FindName('UsageText')
$WorkspaceLabel = $window.FindName('WorkspaceLabel')
$PickFolderBtn = $window.FindName('PickFolderBtn')
$ModeRead = $window.FindName('ModeRead')
$ModeGuard = $window.FindName('ModeGuard')
$ModeFull = $window.FindName('ModeFull')
$ModelBox = $window.FindName('ModelBox')
$NewChatBtn = $window.FindName('NewChatBtn')
$SessionList = $window.FindName('SessionList')
$TitleText = $window.FindName('TitleText')
$SubTitle = $window.FindName('SubTitle')

# ---------------------------------------------------------------- 画东西的小工具
function Brush([string]$hex) {
  return (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($hex)))
}

function New-Text {
  param([string]$text = '', [double]$size = 13.5, [string]$color = '#F9FAFB',
        [string]$weight = 'Normal', [string]$font = 'Segoe UI', [double]$mb = 0)
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Text = $text
  $tb.FontSize = $size
  $tb.Foreground = (Brush $color)
  $tb.FontFamily = (New-Object System.Windows.Media.FontFamily($font))
  $tb.TextWrapping = 'Wrap'
  $tb.Margin = "0,0,0,$mb"
  if ($weight -eq 'SemiBold') { $tb.FontWeight = [System.Windows.FontWeights]::SemiBold }
  elseif ($weight -eq 'Bold') { $tb.FontWeight = [System.Windows.FontWeights]::Bold }
  return $tb
}

function Add-Container([double]$mb = 14) {
  $sp = New-Object System.Windows.Controls.StackPanel
  $sp.Margin = "0,0,0,$mb"
  $Transcript.Children.Add($sp) | Out-Null
  return $sp
}

function Add-UserMessage([string]$text) {
  $sp = Add-Container 20
  $label = New-Text '你' 10.5 '#6B7280' 'Normal' 'Segoe UI' 4
  $sp.Children.Add($label) | Out-Null
  $body = New-Text $text 14 '#F9FAFB' 'Normal' 'Segoe UI' 0
  $body.LineHeight = 23
  $body.LineStackingStrategy = 'BlockLineHeight'
  $sp.Children.Add($body) | Out-Null
  $script:currentAssistant = $null
}

function Add-AssistantMessage {
  $sp = Add-Container 16
  $head = New-Text $script:modelName 10.5 '#7C838E' 'Normal' 'Segoe UI' 4
  $sp.Children.Add($head) | Out-Null
  $tb = New-Text '' 14 '#E6E8EE' 'Normal' 'Segoe UI' 0
  $tb.LineHeight = 23
  $tb.LineStackingStrategy = 'BlockLineHeight'
  $sp.Children.Add($tb) | Out-Null
  return $tb
}

function Add-ToolRow([string]$name, [string]$summary) {
  $outer = New-Object System.Windows.Controls.Border
  $outer.Background = (Brush '#12141A')
  $outer.BorderBrush = (Brush '#0FFFFFFF')
  $outer.BorderThickness = '1'
  $outer.CornerRadius = '6'
  $outer.Padding = '9,5'
  $outer.Margin = '0,0,0,5'
  $outer.HorizontalAlignment = 'Left'
  $outer.MaxWidth = 720

  $dp = New-Object System.Windows.Controls.DockPanel
  $status = New-Text '运行中…' 10.5 '#7C838E' 'Normal' 'Cascadia Mono, Consolas' 0
  $status.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($status, 'Right')
  $dp.Children.Add($status) | Out-Null

  $icon = New-Text '⚙' 11 '#7C838E' 'Normal' 'Segoe UI' 0
  $icon.VerticalAlignment = 'Center'
  $icon.Margin = '0,0,6,0'
  [System.Windows.Controls.DockPanel]::SetDock($icon, 'Left')
  $dp.Children.Add($icon) | Out-Null

  $nameTb = New-Text $name 11 '#9BA3B4' 'Normal' 'Cascadia Mono, Consolas' 0
  $nameTb.VerticalAlignment = 'Center'
  $nameTb.Margin = '0,0,8,0'
  [System.Windows.Controls.DockPanel]::SetDock($nameTb, 'Left')
  $dp.Children.Add($nameTb) | Out-Null

  $sumTb = New-Text $summary 11 '#CFD3D6' 'Normal' 'Cascadia Mono, Consolas' 0
  $sumTb.TextTrimming = 'CharacterEllipsis'
  $sumTb.TextWrapping = 'NoWrap'
  $sumTb.VerticalAlignment = 'Center'
  $dp.Children.Add($sumTb) | Out-Null

  $outer.Child = $dp
  $Transcript.Children.Add($outer) | Out-Null
  return $status
}

function Add-SystemLine([string]$text, [string]$color = '#7C838E') {
  $tb = New-Text $text 11 $color 'Normal' 'Segoe UI' 10
  $tb.HorizontalAlignment = 'Left'
  $Transcript.Children.Add($tb) | Out-Null
}

# ---------------- 极简 Markdown：粗体、行内代码、标题、列表、代码块 ----------------
function New-Run([string]$t, [string]$color, [bool]$bold, [bool]$mono) {
  $r = New-Object System.Windows.Documents.Run
  $r.Text = $t
  $r.Foreground = (Brush $color)
  if ($bold) { $r.FontWeight = [System.Windows.FontWeights]::SemiBold }
  if ($mono) { $r.FontFamily = (New-Object System.Windows.Media.FontFamily('Cascadia Mono, Consolas')) }
  return $r
}

function Set-RichText($tb, [string]$text) {
  $tb.Text = ''
  $tb.Inlines.Clear()
  $lines = ($text -replace "`r`n", "`n") -split "`n"
  $inCode = $false
  $first = $true
  foreach ($raw in $lines) {
    $line = [string]$raw
    if ($line -match '^\s*```') { $inCode = -not $inCode; continue }
    if (-not $first) { $tb.Inlines.Add((New-Object System.Windows.Documents.LineBreak)) | Out-Null }
    $first = $false
    if ($inCode) {
      $tb.Inlines.Add((New-Run $line '#A5B4C4' $false $true)) | Out-Null
      continue
    }
    if ($line -match '^(#{1,6})\s+(.*)$') {
      $tb.Inlines.Add((New-Run $Matches[2] '#F9FAFB' $true $false)) | Out-Null
      continue
    }
    if ($line -match '^(\s*)[-*]\s+(.*)$') { $line = "$($Matches[1])• $($Matches[2])" }
    $parts = [regex]::Split($line, '(\*\*[^*]+\*\*|`[^`]+`)')
    foreach ($p in $parts) {
      if (-not $p) { continue }
      if ($p -match '^\*\*(.+)\*\*$') { $tb.Inlines.Add((New-Run $Matches[1] '#F9FAFB' $true $false)) | Out-Null }
      elseif ($p -match '^`(.+)`$') { $tb.Inlines.Add((New-Run $Matches[1] '#9FC7FF' $false $true)) | Out-Null }
      else { $tb.Inlines.Add((New-Run $p '#E6E8EE' $false $false)) | Out-Null }
    }
  }
}

function Add-ApprovalCard($e) {
  $card = New-Object System.Windows.Controls.Border
  $card.Background = (Brush '#17140C')
  $card.BorderBrush = (Brush '#59FBBF24')
  $card.BorderThickness = '1'
  $card.CornerRadius = '8'
  $card.Padding = '12,10'
  $card.Margin = '0,2,0,10'

  $sp = New-Object System.Windows.Controls.StackPanel
  $head = New-Text "需要确认 · $($e.tool)" 12 '#FBBF24' 'SemiBold' 'Segoe UI' 3
  $sp.Children.Add($head) | Out-Null
  $reason = New-Text ([string]$e.reason) 11.5 '#CFD3D6' 'Normal' 'Segoe UI' 6
  $sp.Children.Add($reason) | Out-Null

  if ($e.detail) {
    $det = New-Text ([string]$e.detail) 11 '#9BA3B4' 'Normal' 'Cascadia Mono, Consolas' 8
    $det.TextWrapping = 'Wrap'
    $det.MaxHeight = 90
    $sp.Children.Add($det) | Out-Null
  }

  $btns = New-Object System.Windows.Controls.StackPanel
  $btns.Orientation = 'Horizontal'

  $yes = New-Object System.Windows.Controls.Button
  $yes.Content = '允许一次'
  $yes.Height = 26
  $yes.Padding = '12,0'
  $yes.FontSize = 11.5
  $yes.Cursor = 'Hand'
  $yes.Background = (Brush '#FBBF24')
  $yes.Foreground = (Brush '#1A1710')
  $yes.BorderThickness = '0'
  $yes.FontWeight = [System.Windows.FontWeights]::SemiBold

  $no = New-Object System.Windows.Controls.Button
  $no.Content = '拒绝'
  $no.Height = 26
  $no.Padding = '12,0'
  $no.FontSize = 11.5
  $no.Cursor = 'Hand'
  $no.Margin = '8,0,0,0'
  $no.Background = [System.Windows.Media.Brushes]::Transparent
  $no.Foreground = (Brush '#CFD3D6')
  $no.BorderBrush = (Brush '#26FFFFFF')
  $no.BorderThickness = '1'

  $reqId = $e.reqId
  $yes.Add_Click({
    Send-Host @{ cmd = 'approve'; reqId = $reqId; allowed = $true }
    $btns.IsEnabled = $false
    $yes.Content = '已允许'
  }.GetNewClosure())
  $no.Add_Click({
    Send-Host @{ cmd = 'approve'; reqId = $reqId; allowed = $false }
    $btns.IsEnabled = $false
    $no.Content = '已拒绝'
  }.GetNewClosure())

  $btns.Children.Add($yes) | Out-Null
  $btns.Children.Add($no) | Out-Null
  $sp.Children.Add($btns) | Out-Null

  $card.Child = $sp
  $Transcript.Children.Add($card) | Out-Null
  $Scroller.ScrollToEnd()
}

function Format-Ago($ms) {
  # .NET Framework 4.8 没有 DateTime.ToUnixTimeMilliseconds（那是 .NET Core 的）
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $m = [math]::Round(($now - [double]$ms) / 60000)
  if ($m -lt 1) { return '刚刚' }
  if ($m -lt 60) { return "$m 分钟前" }
  $h = [math]::Floor($m / 60)
  if ($h -lt 24) { return "$h 小时前" }
  return "$([math]::Floor($h / 24)) 天前"
}

function Set-Sessions($items) {
  $SessionList.Children.Clear()
  if (-not $items -or $items.Count -eq 0) {
    $empty = New-Text '还没有会话' 11 '#5B626D' 'Normal' 'Segoe UI' 0
    $empty.Margin = '8,4,0,0'
    $SessionList.Children.Add($empty) | Out-Null
    return
  }
  foreach ($it in $items) {
    $row = New-Object System.Windows.Controls.Border
    $row.CornerRadius = '7'
    $row.Padding = '8,6'
    $row.Margin = '0,2,0,2'
    $row.Cursor = 'Hand'
    $selected = ([string]$it.id -eq [string]$script:sessionId)
    $row.Background = $(if ($selected) { Brush '#20242E' } else { [System.Windows.Media.Brushes]::Transparent })

    $sp = New-Object System.Windows.Controls.StackPanel
    $t = New-Text ([string]$it.title) 12 '#E6E8EE' 'Normal' 'Segoe UI' 2
    $t.TextTrimming = 'CharacterEllipsis'
    $t.TextWrapping = 'NoWrap'
    $sp.Children.Add($t) | Out-Null
    $meta = New-Text "$($it.turns) 轮 · $(Format-Ago $it.updatedAt)" 10 '#6B7280' 'Normal' 'Segoe UI' 0
    $sp.Children.Add($meta) | Out-Null
    $row.Child = $sp

    $id = [string]$it.id
    $row.Add_MouseLeftButtonUp({
      Send-Host @{ cmd = 'load-session'; id = $id }
    }.GetNewClosure())
    $row.Add_MouseEnter({
      $this.Background = (Brush '#1B1F27')
    }.GetNewClosure())
    $row.Add_MouseLeave({
      if ($id -eq [string]$script:sessionId) { $this.Background = (Brush '#20242E') }
      else { $this.Background = [System.Windows.Media.Brushes]::Transparent }
    }.GetNewClosure())

    $SessionList.Children.Add($row) | Out-Null
  }
}

function Clear-Transcript {
  $Transcript.Children.Clear()
  $script:currentAssistant = $null
  $script:pendingText.Clear() | Out-Null
  $script:toolRows = @{}
}

function Add-EmptyState {
  $sp = New-Object System.Windows.Controls.StackPanel
  $sp.Margin = '0,48,0,0'
  $sp.Children.Add((New-Text '开始对话' 20 '#F9FAFB' 'SemiBold' 'Segoe UI' 8)) | Out-Null
  $sp.Children.Add((New-Text '读文件、改代码、跑命令。每个写操作都会先问你。' 12.5 '#7C838E' 'Normal' 'Segoe UI' 20)) | Out-Null
  foreach ($ex in @('这个项目的入口在哪里？', '帮我改掉 src 里的 bug', '把 README 里过时的部分更新一下')) {
    $b = New-Object System.Windows.Controls.Button
    $b.Content = $ex
    $b.HorizontalAlignment = 'Left'
    $b.Height = 28
    $b.Padding = '12,0'
    $b.FontSize = 12
    $b.Margin = '0,0,0,7'
    $b.Cursor = 'Hand'
    $b.Background = (Brush '#12141A')
    $b.Foreground = (Brush '#CFD3D6')
    $b.BorderBrush = (Brush '#1FFFFFFF')
    $b.BorderThickness = '1'
    $b.Add_Click({ Start-Turn $ex }.GetNewClosure())
    $sp.Children.Add($b) | Out-Null
  }
  $Transcript.Children.Add($sp) | Out-Null
}

# ---------------------------------------------------------------- 与 host 通信
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
Log "host 已启动 pid=$($proc.Id)"

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

$pumpOut = New-Object LinePump -ArgumentList $proc.StandardOutput
$pumpOut.Start()
$pumpErr = New-Object LinePump -ArgumentList $proc.StandardError
$pumpErr.Start()
Log '输出泵已启动'

function Send-Host($obj) {
  try {
    $line = ($obj | ConvertTo-Json -Compress -Depth 6)
    # 必须走 BaseStream 自己写 UTF-8 字节：.NET Framework 4.8 的 StandardInput 是
    # 按 Console.InputEncoding（中文系统是 GBK）编码的，中文提示词写到子进程就变乱码了。
    # 4.8 也没有 StandardInputEncoding 这个属性（.NET Core 才有）。
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($line + "`n")
    $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $proc.StandardInput.BaseStream.Flush()
  } catch {
    Log ("写入 host 失败: " + ($_ | Out-String))
  }
}

# ---------------------------------------------------------------- 状态
$script:busy = $false
$script:currentAssistant = $null
$script:pendingText = New-Object System.Text.StringBuilder
$script:toolRows = @{}
$script:tickSeen = $false
$script:modelName = $Model
$script:sessionId = ''
$script:hostGone = $false

$script:modeButtons = @{ 'read-only' = $ModeRead; 'guarded' = $ModeGuard; 'full' = $ModeFull }

function Set-ModeVisual([string]$m) {
  foreach ($k in $script:modeButtons.Keys) {
    $b = $script:modeButtons[$k]
    if ($k -eq $m) {
      $b.Background = (Brush '#232A3D')
      $b.Foreground = (Brush '#8FA6FF')
    } else {
      $b.Background = [System.Windows.Media.Brushes]::Transparent
      $b.Foreground = (Brush '#ADB2B8')
    }
  }
}

function Set-Busy([bool]$on) {
  $script:busy = $on
  $SendBtn.IsEnabled = -not $on
  $SendBtn.Visibility = $(if ($on) { 'Collapsed' } else { 'Visible' })
  $StopBtn.IsEnabled = $on
  $StopBtn.Visibility = $(if ($on) { 'Visible' } else { 'Collapsed' })
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

# ---------------------------------------------------------------- 事件处理
function Handle-Event([string]$line) {
  try { $e = $line | ConvertFrom-Json } catch { return }
  switch ($e.type) {
    'ready' {
      $script:sessionId = [string]$e.session
      $script:modelName = [string]$e.model
      $WorkspaceLabel.Text = [string]$e.cwd
      $ModelBox.Text = [string]$e.model
      $TitleText.Text = $(if ($e.title -and $e.title -ne '(empty)') { [string]$e.title } else { '新对话' })
      $SubTitle.Text = [string]$e.mode
      Set-ModeVisual ([string]$e.mode)

      if (-not $script:busy) {
        Clear-Transcript
        $hasUser = $false
        foreach ($ev in $e.events) {
          if ($ev.kind -eq 'user/message') { Add-UserMessage ([string]$ev.text); $hasUser = $true }
          elseif ($ev.kind -eq 'assistant/message') {
            if ($ev.text) {
              if (-not $script:currentAssistant) { $script:currentAssistant = Add-AssistantMessage }
              Set-RichText $script:currentAssistant ([string]$ev.text)
              $script:currentAssistant = $null
            }
          }
          elseif ($ev.kind -eq 'tool/call') {
            $sum = ''
            if ($ev.args) { $sum = ($ev.args | ConvertTo-Json -Compress -Depth 4) }
            $st = Add-ToolRow ([string]$ev.name) $sum
            $script:toolRows[[string]$ev.id] = $st
          }
          elseif ($ev.kind -eq 'tool/result') {
            $st = $script:toolRows[[string]$ev.callId]
            if ($st) {
              if ($ev.ok) { $st.Text = "✓  $($ev.ms)ms"; $st.Foreground = (Brush '#4ADE80') }
              else { $st.Text = '✕  失败'; $st.Foreground = (Brush '#F87171') }
            }
          }
        }
        if ($e.events.Count -gt 0) {
          if ($hasUser) {
            $end = New-Text "— 以上为历史记录 · $($e.events.Count) 条事件 —" 10 '#4B5158' 'Normal' 'Segoe UI' 0
            $Transcript.Children.Add($end) | Out-Null
          } else {
            Add-EmptyState
          }
        } else {
          Add-EmptyState
        }
        $Scroller.ScrollToEnd()
      }
      Send-Host @{ cmd = 'list-sessions' }
    }
    'text' {
      if (-not $script:currentAssistant) { $script:currentAssistant = Add-AssistantMessage }
      $script:pendingText.Append([string]$e.delta) | Out-Null
    }
    'assistant-end' {
      if ($e.text -and ([string]$e.text).Trim()) {
        if (-not $script:currentAssistant) { $script:currentAssistant = Add-AssistantMessage }
        Set-RichText $script:currentAssistant ([string]$e.text)
      } elseif ($script:currentAssistant) {
        # 只有工具调用、没有文字：把这个空块删掉
        $parent = $script:currentAssistant.Parent
        if ($parent) { $Transcript.Children.Remove($parent) | Out-Null }
      }
      $script:pendingText.Clear() | Out-Null
      $script:currentAssistant = $null
    }
    'tool-start' {
      $script:currentAssistant = $null
      $st = Add-ToolRow ([string]$e.name) ([string]$e.summary)
      $script:toolRows[[string]$e.id] = $st
      $Scroller.ScrollToEnd()
    }
    'tool-end' {
      $st = $script:toolRows[[string]$e.id]
      if ($st) {
        if ($e.ok) {
          $st.Text = "✓  $($e.ms)ms"
          $st.Foreground = (Brush '#4ADE80')
        } else {
          $msg = ([string]$e.error).Split("`n")[0]
          if ($msg.Length -gt 40) { $msg = $msg.Substring(0, 40) + '…' }
          $st.Text = "✕  $msg"
          $st.Foreground = (Brush '#F87171')
        }
      }
      $script:currentAssistant = $null
      $Scroller.ScrollToEnd()
    }
    'approval' { Add-ApprovalCard $e }
    'notice' { Add-SystemLine ([string]$e.text) '#9BA3B4' }
    'error' {
      Add-SystemLine ("错误：" + $e.message) '#F87171'
      if ($e.fatal) { Set-Busy $false }
    }
    'usage' {
      $p = [int]$e.prompt; $c = [int]$e.completion; $cr = [int]$e.cacheRead
      $pct = if ($p -gt 0) { [math]::Round($cr * 100 / $p) } else { 0 }
      $UsageText.Text = "$($e.calls) 次 · 缓存 $pct%"
    }
    'turn-end' {
      if ($script:pendingText.Length -gt 0 -and $script:currentAssistant) {
        $script:currentAssistant.Text += $script:pendingText.ToString()
        $script:pendingText.Clear() | Out-Null
      }
      Set-Busy $false
      $script:currentAssistant = $null
      if ($e.reason -eq 'max-steps') { Add-SystemLine '已到步数上限（已让模型收尾）' '#FBBF24' }
      if ($e.reason -eq 'cancelled') { Add-SystemLine '已中断' '#FBBF24' }
      if ($e.reason -eq 'error') { Add-SystemLine '本轮出错' '#F87171' }
      Send-Host @{ cmd = 'list-sessions' }
      $Scroller.ScrollToEnd()
    }
    'sessions' { Set-Sessions $e.items }
    'mode' { Set-ModeVisual ([string]$e.mode); $SubTitle.Text = [string]$e.mode }
    'model' { $script:modelName = [string]$e.model; $ModelBox.Text = [string]$e.model }
    'cwd' { $WorkspaceLabel.Text = [string]$e.cwd }
    'stderr' { Log ("host stderr: " + $e.message) }
  }
}

# ---------------------------------------------------------------- 交互
$SendBtn.Add_Click({ Start-Turn $InputBox.Text })
$StopBtn.Add_Click({ Send-Host @{ cmd = 'abort' } })

$InputBox.Add_KeyDown({
  param($s, $e)
  if ($e.Key -eq [System.Windows.Input.Key]::Return -and -not ($e.KeyboardDevice.Modifiers -band [System.Windows.Input.ModifierKeys]::Shift)) {
    $e.Handled = $true
    Start-Turn $InputBox.Text
  }
})

$ModelBox.Add_KeyDown({
  param($s, $e)
  if ($e.Key -eq [System.Windows.Input.Key]::Return) {
    $e.Handled = $true
    Send-Host @{ cmd = 'model'; model = $ModelBox.Text }
  }
})

$NewChatBtn.Add_Click({
  Send-Host @{ cmd = 'new-session' }
  Clear-Transcript
  Add-EmptyState
  $TitleText.Text = '新对话'
})

foreach ($pair in @(@('read-only', $ModeRead), @('guarded', $ModeGuard), @('full', $ModeFull))) {
  $m = $pair[0]
  $pair[1].Add_Click({
    Set-ModeVisual $m
    Send-Host @{ cmd = 'mode'; mode = $m }
  }.GetNewClosure())
}

$PickFolderBtn.Add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = '选择工作目录'
  $dlg.SelectedPath = $WorkspaceLabel.Text
  $dlg.ShowNewFolderButton = $false
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    Send-Host @{ cmd = 'cwd'; cwd = $dlg.SelectedPath }
  }
})

# ---------------------------------------------------------------- 定时器：抽事件 + 流式渲染
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(50)
$timer.Add_Tick({
  try {
    if (-not $script:tickSeen) { $script:tickSeen = $true; Log 'Tick 首次触发' }
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
    if ($script:pendingText.Length -gt 0 -and $script:currentAssistant) {
      $script:currentAssistant.Text += $script:pendingText.ToString()
      $script:pendingText.Clear() | Out-Null
      $Scroller.ScrollToEnd()
    }
    if ($pumpOut.Finished -and -not $script:hostGone) {
      $script:hostGone = $true
      Add-SystemLine 'host 进程已退出' '#F87171'
      Set-Busy $false
    }
  } catch {
    Log ("Tick 异常: " + ($_ | Out-String))
  }
})

$window.Add_Loaded({
  Log '窗口 Loaded'
  $WorkspaceLabel.Text = $Cwd
  $ModelBox.Text = $Model
  Set-ModeVisual $Mode
  $SubTitle.Text = $Mode
  Clear-Transcript
  $timer.Start()
  $InputBox.Focus() | Out-Null
  # 自测入口：设置 PL_GUI_TASK 会自动发第一条任务（也方便截图验证）
  if ($env:PL_GUI_TASK) { Start-Turn $env:PL_GUI_TASK }
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
