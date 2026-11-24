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
            <Button x:Name="SettingsBtn" Content="设置" Height="24" Padding="8,0" Cursor="Hand" FontSize="11"
                    Background="Transparent" Foreground="#7C838E" BorderBrush="#1FFFFFFF" BorderThickness="1"
                    Margin="0,0,10,0" ToolTip="填写模型端点地址和 API Key"/>
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

    <!-- 设置面板：做成遮罩层而不是第二个窗口，省掉嵌套消息循环那堆坑 -->
    <Grid x:Name="SettingsOverlay" Grid.ColumnSpan="2" Visibility="Collapsed" Background="#B8000000">
      <Border Width="452" Background="#16181D" BorderBrush="#26FFFFFF" BorderThickness="1" CornerRadius="12"
              HorizontalAlignment="Center" VerticalAlignment="Center" Padding="22,18,22,16">
        <StackPanel>
          <TextBlock Text="模型设置" Foreground="#F9FAFB" FontSize="14.5" FontWeight="SemiBold"/>
          <TextBlock Text="填 OpenAI 兼容的端点地址和 Key，保存后立刻生效，并写进数据目录的 config.json。"
                     Foreground="#7C838E" FontSize="11" Margin="0,5,0,16" TextWrapping="Wrap"/>

          <TextBlock Text="端点地址" Foreground="#ADB2B8" FontSize="11" Margin="0,0,0,5"/>
          <TextBox x:Name="CfgUrl" Height="30" Background="#0F1115" Foreground="#F9FAFB" BorderBrush="#1FFFFFFF"
                   BorderThickness="1" Padding="9,0" VerticalContentAlignment="Center" FontSize="11.5"
                   FontFamily="Cascadia Mono, Consolas"/>

          <TextBlock Text="API Key" Foreground="#ADB2B8" FontSize="11" Margin="0,13,0,5"/>
          <TextBox x:Name="CfgKey" Height="30" Background="#0F1115" Foreground="#F9FAFB" BorderBrush="#1FFFFFFF"
                   BorderThickness="1" Padding="9,0" VerticalContentAlignment="Center" FontSize="11.5"
                   FontFamily="Cascadia Mono, Consolas"/>
          <TextBlock x:Name="CfgKeyHint" Text="" Foreground="#5B626D" FontSize="10.5" Margin="0,5,0,0" TextWrapping="Wrap"/>

          <TextBlock Text="模型名" Foreground="#ADB2B8" FontSize="11" Margin="0,13,0,5"/>
          <TextBox x:Name="CfgModel" Height="30" Background="#0F1115" Foreground="#F9FAFB" BorderBrush="#1FFFFFFF"
                   BorderThickness="1" Padding="9,0" VerticalContentAlignment="Center" FontSize="11.5"
                   FontFamily="Cascadia Mono, Consolas"/>

          <TextBlock x:Name="CfgError" Text="" Foreground="#F87171" FontSize="11" Margin="0,10,0,0" TextWrapping="Wrap"/>

          <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,16,0,0">
            <Button x:Name="CfgCancel" Content="取消" Height="28" Padding="14,0" Cursor="Hand" FontSize="11.5"
                    Background="Transparent" Foreground="#ADB2B8" BorderBrush="#1FFFFFFF" BorderThickness="1"
                    Margin="0,0,8,0"/>
            <Button x:Name="CfgSave" Content="保存" Height="28" Padding="18,0" Cursor="Hand" FontSize="11.5"
                    FontWeight="SemiBold" Background="#2B5CFF" Foreground="White" BorderThickness="0"/>
          </StackPanel>
        </StackPanel>
      </Border>
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
$SettingsBtn = $window.FindName('SettingsBtn')
$SettingsOverlay = $window.FindName('SettingsOverlay')
$CfgUrl = $window.FindName('CfgUrl')
$CfgKey = $window.FindName('CfgKey')
$CfgKeyHint = $window.FindName('CfgKeyHint')
$CfgModel = $window.FindName('CfgModel')
$CfgError = $window.FindName('CfgError')
$CfgCancel = $window.FindName('CfgCancel')
$CfgSave = $window.FindName('CfgSave')

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
  # 正文宿主：流式时里面只有一个 TextBlock，回答结束时整体重绘成
  # 「段落 + 代码块卡片」的结构，所以 流式和最终渲染要分开
  $body = New-Object System.Windows.Controls.StackPanel
  $sp.Children.Add($body) | Out-Null
  $tb = New-Text '' 14 '#E6E8EE' 'Normal' 'Segoe UI' 0
  $tb.LineHeight = 23
  $tb.LineStackingStrategy = 'BlockLineHeight'
  $body.Children.Add($tb) | Out-Null
  $script:assistantBody = $body
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

function Add-InlineLines($tb, $lines) {
  $first = $true
  foreach ($raw in $lines) {
    $line = [string]$raw
    if (-not $first) { $tb.Inlines.Add((New-Object System.Windows.Documents.LineBreak)) | Out-Null }
    $first = $false
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

# 代码块做成一张卡片：深底 + 细描边 + 语言标签，和 DSH 里的样子一致
function New-CodeBlock([string]$code, [string]$lang) {
  $outer = New-Object System.Windows.Controls.Border
  $outer.Background = (Brush '#0A0C10')
  $outer.BorderBrush = (Brush '#1FFFFFFF')
  $outer.BorderThickness = '1'
  $outer.CornerRadius = '8'
  $outer.Padding = '12,8,12,10'
  $outer.Margin = '0,4,0,10'

  $sp = New-Object System.Windows.Controls.StackPanel
  if ($lang) {
    $sp.Children.Add((New-Text $lang 10 '#5B626D' 'Normal' 'Segoe UI' 6)) | Out-Null
  }
  $tb = New-Text $code 12.5 '#C9D6E4' 'Normal' 'Cascadia Mono, Consolas' 0
  $tb.LineHeight = 19
  $tb.LineStackingStrategy = 'BlockLineHeight'
  $sp.Children.Add($tb) | Out-Null

  $outer.Child = $sp
  return $outer
}

# 把整段回答重绘成「段落 + 代码块卡片」。流式阶段仍然是纯文本，结束时再格式化。
function Render-Markdown($hostPanel, [string]$text) {
  $hostPanel.Children.Clear()
  $lines = ($text -replace "`r`n", "`n") -split "`n"
  $i = 0
  $n = $lines.Count
  while ($i -lt $n) {
    if ($lines[$i] -match '^\s*```\s*([^`]*)$') {
      $lang = $Matches[1].Trim()
      $buf = New-Object System.Text.StringBuilder
      $i++
      while ($i -lt $n -and $lines[$i] -notmatch '^\s*```') {
        if ($buf.Length -gt 0) { $buf.Append("`n") | Out-Null }
        $buf.Append([string]$lines[$i]) | Out-Null
        $i++
      }
      $i++
      $hostPanel.Children.Add((New-CodeBlock $buf.ToString() $lang)) | Out-Null
      continue
    }
    $chunk = New-Object System.Collections.ArrayList
    while ($i -lt $n -and $lines[$i] -notmatch '^\s*```') {
      [void]$chunk.Add([string]$lines[$i])
      $i++
    }
    while ($chunk.Count -gt 0 -and -not ([string]$chunk[0]).Trim()) { $chunk.RemoveAt(0) }
    while ($chunk.Count -gt 0 -and -not ([string]$chunk[$chunk.Count - 1]).Trim()) { $chunk.RemoveAt($chunk.Count - 1) }
    if ($chunk.Count -eq 0) { continue }
    $tb = New-Text '' 14 '#E6E8EE' 'Normal' 'Segoe UI' 8
    $tb.LineHeight = 23
    $tb.LineStackingStrategy = 'BlockLineHeight'
    Add-InlineLines $tb $chunk
    $hostPanel.Children.Add($tb) | Out-Null
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
    $sid = [string]$it.id
    $stitle = [string]$it.title
    $selected = ($sid -eq [string]$script:sessionId)
    $row.Background = $(if ($selected) { Brush '#20242E' } else { [System.Windows.Media.Brushes]::Transparent })

    $grid = New-Object System.Windows.Controls.Grid
    $c1 = New-Object System.Windows.Controls.ColumnDefinition
    $c1.Width = New-Object System.Windows.GridLength 1, ([System.Windows.GridUnitType]::Star)
    $c2 = New-Object System.Windows.Controls.ColumnDefinition
    $c2.Width = [System.Windows.GridLength]::Auto
    $grid.ColumnDefinitions.Add($c1)
    $grid.ColumnDefinitions.Add($c2)

    $sp = New-Object System.Windows.Controls.StackPanel
    $t = New-Text $stitle 12 '#E6E8EE' 'Normal' 'Segoe UI' 2
    $t.TextTrimming = 'CharacterEllipsis'
    $t.TextWrapping = 'NoWrap'
    $sp.Children.Add($t) | Out-Null
    $meta = New-Text "$($it.turns) 轮 · $(Format-Ago $it.updatedAt)" 10 '#6B7280' 'Normal' 'Segoe UI' 0
    $sp.Children.Add($meta) | Out-Null
    [System.Windows.Controls.Grid]::SetColumn($sp, 0)
    $grid.Children.Add($sp) | Out-Null

    # 删除按钮：平时藏着，鼠标移到这一行才露出来
    $del = New-Object System.Windows.Controls.Button
    $del.Content = '×'
    $del.FontSize = 15
    $del.Width = 22
    $del.Height = 22
    $del.Padding = '0'
    $del.Cursor = 'Hand'
    $del.Background = [System.Windows.Media.Brushes]::Transparent
    $del.Foreground = (Brush '#6B7280')
    $del.BorderThickness = '0'
    $del.VerticalAlignment = 'Center'
    $del.Visibility = 'Hidden'
    $del.ToolTip = '删除这个会话'
    [System.Windows.Controls.Grid]::SetColumn($del, 1)
    $grid.Children.Add($del) | Out-Null

    $del.Add_Click({
      param($s, $ev)
      $ev.Handled = $true
      $r = [System.Windows.MessageBox]::Show("删除会话「$stitle」？`n`n会删掉它的会话日志和 checkpoint，不能恢复。", 'PackLeader', 'YesNo', 'Warning')
      if ($r -eq [System.Windows.MessageBoxResult]::Yes) {
        Send-Host @{ cmd = 'delete-session'; id = $sid }
      }
    }.GetNewClosure())
    $del.Add_MouseEnter({ $this.Foreground = (Brush '#F87171') }.GetNewClosure())
    $del.Add_MouseLeave({ $this.Foreground = (Brush '#6B7280') }.GetNewClosure())

    $row.Child = $grid

    $row.Add_MouseLeftButtonUp({
      Send-Host @{ cmd = 'load-session'; id = $sid }
    }.GetNewClosure())
    $row.Add_MouseEnter({
      $this.Background = (Brush '#1B1F27')
      $del.Visibility = 'Visible'
    }.GetNewClosure())
    $row.Add_MouseLeave({
      $del.Visibility = 'Hidden'
      if ($sid -eq [string]$script:sessionId) { $this.Background = (Brush '#20242E') }
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

# 深色标题栏：WPF 自己的 chrome 是白色的，只能调 DWM
Add-Type -Namespace PL -Name Dwm -MemberDefinition @'
[DllImport("dwmapi.dll")]
public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
'@

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
$script:assistantBody = $null
$script:pendingText = New-Object System.Text.StringBuilder
$script:toolRows = @{}
$script:tickSeen = $false
$script:modelName = $Model
$script:sessionId = ''
$script:hostGone = $false
$script:history = New-Object System.Collections.ArrayList
$script:historyIdx = 0
$script:cfgBaseURL = ''
$script:cfgKeyMasked = ''
$script:hasKey = $true

# ---------------------------------------------------------------- 设置面板
function Open-Settings {
  $CfgUrl.Text = $(if ($script:cfgBaseURL) { $script:cfgBaseURL } else { '' })
  $CfgKey.Text = ''
  $CfgModel.Text = $script:modelName
  if ($script:hasKey) {
    $CfgKeyHint.Text = "已设置（$($script:cfgKeyMasked)）；留空表示保持不变。"
  } else {
    $CfgKeyHint.Text = '还没有设置 Key，填一个才能开始对话。'
  }
  $CfgError.Text = ''
  $SettingsOverlay.Visibility = 'Visible'
  $CfgUrl.Focus() | Out-Null
  $CfgUrl.CaretIndex = $CfgUrl.Text.Length
}

function Close-Settings {
  $SettingsOverlay.Visibility = 'Collapsed'
  $InputBox.Focus() | Out-Null
}

function Save-Settings {
  $url = $CfgUrl.Text.Trim()
  $key = $CfgKey.Text.Trim()
  $model = $CfgModel.Text.Trim()
  if (-not $url) { $CfgError.Text = '端点地址不能为空（例：http://127.0.0.1:19790/v1）'; return }
  if (-not $url.StartsWith('http')) { $CfgError.Text = '端点地址要以 http:// 或 https:// 开头'; return }
  if (-not $key -and -not $script:hasKey) { $CfgError.Text = 'API Key 不能为空'; return }
  $CfgError.Text = ''
  $payload = @{ cmd = 'config'; baseURL = $url; model = $model }
  if ($key) { $payload.apiKey = $key }
  Send-Host $payload
}

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
  # 输入历史：连续重复的不重复记，指针归到末尾
  $trimmed = $text.Trim()
  if ($script:history.Count -eq 0 -or [string]$script:history[$script:history.Count - 1] -ne $trimmed) {
    [void]$script:history.Add($trimmed)
  }
  $script:historyIdx = $script:history.Count
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
      $script:cfgBaseURL = [string]$e.baseURL
      $script:cfgKeyMasked = [string]$e.apiKeyMasked
      $script:hasKey = [bool]$e.hasKey
      $WorkspaceLabel.Text = [string]$e.cwd
      $ModelBox.Text = [string]$e.model
      $TitleText.Text = $(if ($e.title -and $e.title -ne '(empty)') { [string]$e.title } else { '新对话' })
      $SubTitle.Text = [string]$e.mode
      Set-ModeVisual ([string]$e.mode)
      # 第一次用（没 Key）：直接把设置面板弹出来，别让用户对着输入框发呆
      if (-not $script:hasKey) { Open-Settings }

      if (-not $script:busy) {
        Clear-Transcript
        $hasUser = $false
        foreach ($ev in $e.events) {
          if ($ev.kind -eq 'user/message') { Add-UserMessage ([string]$ev.text); $hasUser = $true }
          elseif ($ev.kind -eq 'assistant/message') {
            if ($ev.text) {
              if (-not $script:currentAssistant) { $script:currentAssistant = Add-AssistantMessage }
              Render-Markdown $script:assistantBody ([string]$ev.text)
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
        Render-Markdown $script:assistantBody ([string]$e.text)
      } elseif ($script:currentAssistant -and $script:assistantBody) {
        # 只有工具调用、没有文字：把这个空块删掉
        $container = $script:assistantBody.Parent
        if ($container) { $Transcript.Children.Remove($container) | Out-Null }
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
      if ($e.needsSetup) { Open-Settings }
      if ($e.fatal) { Set-Busy $false }
    }
    'config' {
      $script:cfgBaseURL = [string]$e.baseURL
      $script:cfgKeyMasked = [string]$e.apiKeyMasked
      $script:modelName = [string]$e.model
      $script:hasKey = $true
      $ModelBox.Text = [string]$e.model
      Close-Settings
      Add-SystemLine ("已切换模型：" + $e.model + " @ " + $e.baseURL) '#4ADE80'
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
    'cwd' {
      $WorkspaceLabel.Text = [string]$e.cwd
      # 记住上次用的目录：下次双击启动直接从这里开始，不用每次都换
      try {
        $stateDir = Join-Path $env:LOCALAPPDATA 'PackLeader'
        New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $stateDir 'last-cwd.txt'), [string]$e.cwd, (New-Object System.Text.UTF8Encoding $false))
      } catch { }
    }
    'stderr' { Log ("host stderr: " + $e.message) }
  }
}

# ---------------------------------------------------------------- 交互
$SendBtn.Add_Click({ Start-Turn $InputBox.Text })
$StopBtn.Add_Click({ Send-Host @{ cmd = 'abort' } })

# 设置面板
$SettingsBtn.Add_Click({ Open-Settings })
$CfgCancel.Add_Click({ Close-Settings })
$CfgSave.Add_Click({ Save-Settings })
foreach ($box in @($CfgUrl, $CfgKey, $CfgModel)) {
  $box.Add_PreviewKeyDown({
    param($s, $e)
    if ($e.Key -eq [System.Windows.Input.Key]::Return) { $e.Handled = $true; Save-Settings }
    elseif ($e.Key -eq [System.Windows.Input.Key]::Escape) { $e.Handled = $true; Close-Settings }
  })
}
$window.Add_PreviewKeyDown({
  param($s, $e)
  if ($e.Key -eq [System.Windows.Input.Key]::Escape -and $SettingsOverlay.Visibility -eq 'Visible') {
    $e.Handled = $true
    Close-Settings
  }
})

# 必须用 PreviewKeyDown（隧道）：TextBox 会自己吃掉方向键和回车并在冒泡阶段标记
# Handled，挂在 KeyDown 上的处理器根本不会被调用。
$InputBox.Add_PreviewKeyDown({
  param($s, $e)
  $mods = $e.KeyboardDevice.Modifiers
  if ($e.Key -eq [System.Windows.Input.Key]::Return -and -not ($mods -band [System.Windows.Input.ModifierKeys]::Shift)) {
    $e.Handled = $true
    Start-Turn $InputBox.Text
    return
  }
  # 输入历史：单行内容时 ↑↓ 翻历史（多行时不抢键，留给光标移动）
  if ($mods -ne [System.Windows.Input.ModifierKeys]::None) { return }
  $multi = $InputBox.Text.Contains("`n")
  if ($e.Key -eq [System.Windows.Input.Key]::Up -and -not $multi) {
    if ($script:history.Count -eq 0) { return }
    $e.Handled = $true
    if ($script:historyIdx -gt 0) { $script:historyIdx-- }
    $InputBox.Text = [string]$script:history[$script:historyIdx]
    $InputBox.CaretIndex = $InputBox.Text.Length
  }
  elseif ($e.Key -eq [System.Windows.Input.Key]::Down -and -not $multi) {
    if ($script:history.Count -eq 0) { return }
    $e.Handled = $true
    if ($script:historyIdx -lt $script:history.Count) { $script:historyIdx++ }
    $InputBox.Text = $(if ($script:historyIdx -lt $script:history.Count) { [string]$script:history[$script:historyIdx] } else { '' })
    $InputBox.CaretIndex = $InputBox.Text.Length
  }
})

$ModelBox.Add_PreviewKeyDown({
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
$script:tickCount = 0
$timer.Add_Tick({
  try {
    if (-not $script:tickSeen) { $script:tickSeen = $true; Log 'Tick 首次触发' }
    # 启动器（PackLeader.exe）没了就自己退出：覆盖安装时它会被安装器关掉，
    # 不跟着退就会留下孤儿窗口，看起来像"装了两个"。
    $script:tickCount++
    if (($script:tickCount % 40) -eq 0 -and $env:PL_GUI_PARENT_PID) {
      $alive = $false
      try { $alive = -not (Get-Process -Id ([int]$env:PL_GUI_PARENT_PID) -ErrorAction Stop).HasExited } catch { $alive = $false }
      if (-not $alive) { Log '启动器已退出，关闭窗口'; $window.Close(); return }
    }
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
  # 深色标题栏：WPF 默认给的是白色系统 chrome，和深色底不搭。
  # DWMWA_USE_IMMERSIVE_DARK_MODE = 20（Win10 2004+），更早的版本用 19。
  try {
    $h = (New-Object System.Windows.Interop.WindowInteropHelper $window).Handle
    $on = 1
    [void][PL.Dwm]::DwmSetWindowAttribute($h, 20, [ref]$on, 4)
    [void][PL.Dwm]::DwmSetWindowAttribute($h, 19, [ref]$on, 4)
  } catch { Log ("深色标题栏失败: " + ($_ | Out-String)) }
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
