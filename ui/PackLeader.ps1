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
# 没有控制台时会话里没有 stdout（启动器是 WinExe，spawn 后子进程无控制台）：
# 在这里设 OutputEncoding 会抛 IOException，而 trap 那时还没生效，报错会变成"找不到 Log"，
# 真正的错因被吃掉。所以这一句必须容错。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 任务栏图标为什么必须设 AUMID：
# 窗口是 powershell.exe 起的，进程没有自己的 AppUserModelID 时，任务栏把它并进
# 「Windows PowerShell」那个分组，按钮图标取自 powershell.exe 的 exe 图标，
# 窗口级图标（Window.Icon / WM_SETICON）全被忽略——任务栏上永远是 PowerShell 的白蓝图标。
# 给进程一个独立的 AUMID，任务栏才会单独分组并按窗口图标绘制。
# 必须在创建任何窗口之前调用；窗口建好后再设就不生效了。
$script:appUserModelId = 'PackLeader.Desktop'
try {
  if (-not ('PL.ShellNative' -as [type])) {
    Add-Type -Namespace PL -Name ShellNative -MemberDefinition @'
[DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string id);
'@
  }
  $script:aumidHr = [PL.ShellNative]::SetCurrentProcessExplicitAppUserModelID($script:appUserModelId)
} catch {
  # 设不上就退回旧行为（任务栏会显示 PowerShell 的图标），但不能因此打断启动
  $script:aumidHr = -1
}

$script:guiLog = Join-Path $env:TEMP 'packleader-ui.log'
# 启动早期就得能落盘：trap 里不能再依赖 Log（它自己可能就是没生效的那个）
$script:boot = {
  param([string]$m)
  try { [System.IO.File]::AppendAllText($script:guiLog, ("{0:HH:mm:ss.fff} {1}`r`n" -f (Get-Date), $m), (New-Object System.Text.UTF8Encoding $false)) } catch { }
}
[System.IO.File]::WriteAllText($script:guiLog, "", (New-Object System.Text.UTF8Encoding $false))
& $script:boot "boot ps=$($PSVersionTable.PSVersion) aumid=$($script:appUserModelId) hr=$($script:aumidHr)"
function Log([string]$m) { & $script:boot $m }
trap { if ($script:boot) { & $script:boot ("异常: " + ($_ | Out-String)) } else { try { [System.IO.File]::AppendAllText((Join-Path $env:TEMP 'packleader-ui.log'), ("early: " + ($_ | Out-String)), (New-Object System.Text.UTF8Encoding $false)) } catch { } }; throw }

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
    <!-- 滚动条：系统默认那条带箭头的浅色槽在深色底上太跳，整个重画（宽 10、无箭头、圆角滑块） -->
    <Style x:Key="ThinThumb" TargetType="Thumb">
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Thumb">
            <Border x:Name="bd" Background="#333A46" CornerRadius="4" Margin="2"/>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bd" Property="Background" Value="#4B5563"/>
              </Trigger>
              <Trigger Property="IsDragging" Value="True">
                <Setter TargetName="bd" Property="Background" Value="#5B6675"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style TargetType="ScrollBar">
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Width" Value="10"/>
      <Setter Property="MinWidth" Value="10"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ScrollBar">
            <Grid Background="Transparent">
              <Track x:Name="PART_Track" IsDirectionReversed="True">
                <Track.DecreaseRepeatButton>
                  <RepeatButton Command="ScrollBar.PageUpCommand" Opacity="0" Focusable="False"/>
                </Track.DecreaseRepeatButton>
                <Track.Thumb>
                  <Thumb Style="{StaticResource ThinThumb}"/>
                </Track.Thumb>
                <Track.IncreaseRepeatButton>
                  <RepeatButton Command="ScrollBar.PageDownCommand" Opacity="0" Focusable="False"/>
                </Track.IncreaseRepeatButton>
              </Track>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="Orientation" Value="Horizontal">
                <Setter Property="Width" Value="Auto"/>
                <Setter Property="Height" Value="10"/>
                <Setter TargetName="PART_Track" Property="IsDirectionReversed" Value="False"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Grid x:Name="RootGrid">
    <Grid.ColumnDefinitions>
      <!-- 列 0 = 左侧栏（宽度可拖）；列 1 = 分隔条；列 2 = 右侧对话区 -->
      <!-- 起始宽度给到 MinWidth，真实宽度由 Loaded 里的 Restore-SideWidth 决定。
           写死 Width="252" 时窗口一宽，拖到 252 附近就拖不动了（GridSplitter 不动 Auto/固定列） -->
      <ColumnDefinition Width="180" MinWidth="180"/>
      <ColumnDefinition Width="6"/>
      <ColumnDefinition Width="*" MinWidth="420"/>
    </Grid.ColumnDefinitions>

    <!-- ================= 左侧栏 ================= -->
    <Border Grid.Column="0" Background="#0B0D11">
      <Grid>
        <Grid.RowDefinitions>
          <RowDefinition Height="Auto"/>
          <RowDefinition Height="Auto"/>
          <RowDefinition Height="*"/>
          <RowDefinition Height="Auto"/>
        </Grid.RowDefinitions>

        <!-- 新对话 -->
        <Button Grid.Row="1" x:Name="NewChatBtn" Margin="12,16,12,8" Height="32" Cursor="Hand"
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
                  <Setter TargetName="bd" Property="Background" Value="#1B2029"/>
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
        <ScrollViewer Grid.Row="2" x:Name="SideScroll" VerticalScrollBarVisibility="Auto" Padding="8,4,8,8">
          <StackPanel>
            <TextBlock Text="最近" Foreground="#6B7280" FontSize="10.5" Margin="8,6,0,6"/>
            <StackPanel x:Name="SessionList"/>
          </StackPanel>
        </ScrollViewer>

      </Grid>
    </Border>

    <!-- ================= 右侧 ================= -->
    <GridSplitter x:Name="SideSplitter" Grid.Column="1" Width="6" HorizontalAlignment="Stretch"
                  VerticalAlignment="Stretch" ResizeBehavior="PreviousAndNext" ResizeDirection="Columns"
                  ShowsPreview="False" Background="Transparent" Cursor="SizeWE"
                  ToolTip="拖动调整左右宽度（双击复位）">
      <GridSplitter.Template>
        <ControlTemplate TargetType="GridSplitter">
          <Border Background="Transparent">
            <Rectangle x:Name="ln" Width="1" HorizontalAlignment="Center" Fill="#12FFFFFF"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True">
              <Setter TargetName="ln" Property="Fill" Value="#4A8AB4FF"/>
            </Trigger>
            <Trigger Property="IsDragging" Value="True">
              <Setter TargetName="ln" Property="Fill" Value="#8AB4FF"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </GridSplitter.Template>
    </GridSplitter>

    <Grid Grid.Column="2">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>

      <!-- 顶栏 -->
      <Border Grid.Row="0" BorderBrush="#12FFFFFF" BorderThickness="0,0,0,1" Padding="24,0" Height="48">
        <DockPanel VerticalAlignment="Center">
          <StackPanel Orientation="Horizontal" DockPanel.Dock="Left" VerticalAlignment="Center">
            <Border Width="18" Height="18" CornerRadius="5" Background="#2B5CFF" VerticalAlignment="Center" Margin="0,0,9,0">
              <TextBlock Text="P" Foreground="White" FontSize="11" FontWeight="Bold"
                         HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <TextBlock x:Name="TitleText" Text="新对话" Foreground="#F9FAFB" FontSize="13" FontWeight="SemiBold"
                       VerticalAlignment="Center" TextTrimming="CharacterEllipsis" MaxWidth="420"/>
            <TextBlock x:Name="SubTitle" Text="" Foreground="#6B7280" FontSize="11" Margin="10,1,0,0"
                       VerticalAlignment="Center"/>
          </StackPanel>
          <StackPanel Orientation="Horizontal" DockPanel.Dock="Right" HorizontalAlignment="Right" VerticalAlignment="Center">
            <Button x:Name="SettingsBtn" Content="设置" Height="24" Padding="8,0" Cursor="Hand" FontSize="11"
                    Background="Transparent" Foreground="#7C838E" BorderBrush="#1FFFFFFF" BorderThickness="1"
                    ToolTip="填写模型端点地址和 API Key"/>
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
            <!-- 读秒条：这一轮在跑时显示「思考中 · 用时 12 秒」，空闲时收起 -->
            <Border x:Name="ThinkRow" Visibility="Collapsed" HorizontalAlignment="Left" Margin="0,0,0,8"
                    Background="#141821" BorderBrush="#1FFFFFFF" BorderThickness="1" CornerRadius="6" Padding="8,3">
              <StackPanel Orientation="Horizontal">
                <TextBlock Text="✦" Foreground="#8FA6FF" FontSize="10.5" VerticalAlignment="Center" Margin="0,0,6,0"/>
                <TextBlock x:Name="ThinkText" Text="思考中 · 用时 0 秒" Foreground="#8FA6FF" FontSize="11.5"
                           FontFamily="Cascadia Mono, Consolas" VerticalAlignment="Center"/>
              </StackPanel>
            </Border>
            <WrapPanel x:Name="AttachList" Orientation="Horizontal" Margin="0,0,0,7" Visibility="Collapsed"/>
          <TextBox x:Name="Input" AcceptsReturn="True" TextWrapping="Wrap" MinHeight="46" MaxHeight="160"
                     Background="Transparent" Foreground="#F9FAFB" BorderThickness="0"
                     VerticalScrollBarVisibility="Auto" FontSize="13.5" FontFamily="Segoe UI"
                     CaretBrush="#F9FAFB" SelectionBrush="#2B5CFF" Padding="0"/>
            <DockPanel Margin="0,6,0,0">
              <Button x:Name="AttachBtn" DockPanel.Dock="Left" Content="+ 附件" Height="26" Padding="9,0"
                      Cursor="Hand" FontSize="11.5" Margin="0,0,10,0"
                      Background="Transparent" Foreground="#7C838E" BorderBrush="#1FFFFFFF" BorderThickness="1"/>
              <Button x:Name="InsertConvBtn" DockPanel.Dock="Left" Content="插入对话" Height="26" Padding="9,0"
                      Cursor="Hand" FontSize="11" Margin="0,0,10,0"
                      Background="Transparent" Foreground="#7C838E" BorderBrush="#1FFFFFFF" BorderThickness="1"
                      ToolTip="引用本会话之前的消息：发送时把那段原文一起带给模型"/>
              <Button x:Name="PickFolderBtn" DockPanel.Dock="Left" Content="目录" Height="26" Padding="9,0"
                      Cursor="Hand" FontSize="11" Margin="0,0,10,0" MaxWidth="240"
                      Background="Transparent" Foreground="#7C838E" BorderBrush="#1FFFFFFF" BorderThickness="1"
                      ToolTip="切换工作目录"/>
              <!-- 模型和权限都放在输入框下面这条：发消息时就在手边，不用再往左上角去找 -->
              <StackPanel DockPanel.Dock="Right" Orientation="Horizontal" HorizontalAlignment="Right">
                <TextBlock x:Name="UsageText" Text="" Foreground="#5B626D" FontSize="10.5"
                           VerticalAlignment="Center" Margin="0,0,8,0"/>
                <Button x:Name="ModelPill" Content="模型" Height="26" Padding="9,0" Cursor="Hand" FontSize="11"
                        FontFamily="Cascadia Mono, Consolas" Background="#16181D" Foreground="#ADB2B8"
                        BorderBrush="#1FFFFFFF" BorderThickness="1" ToolTip="切换模型" Margin="0,0,8,0"/>
                <Border Background="#16181D" BorderBrush="#1FFFFFFF" BorderThickness="1" CornerRadius="6"
                        Padding="2,0" Margin="0,0,10,0">
                  <StackPanel Orientation="Horizontal">
                    <Button x:Name="ModeRead" Content="只读" Cursor="Hand" FontSize="10.5" Padding="7,2" Height="22"
                            Background="Transparent" Foreground="#ADB2B8" BorderThickness="0" ToolTip="只能读，改动一律拒绕"/>
                    <Button x:Name="ModeGuard" Content="询问" Cursor="Hand" FontSize="10.5" Padding="7,2" Height="22"
                            Background="Transparent" Foreground="#ADB2B8" BorderThickness="0" ToolTip="改文件 / 跑命令前先问你"/>
                    <Button x:Name="ModeFull" Content="完全" Cursor="Hand" FontSize="10.5" Padding="7,2" Height="22"
                            Background="Transparent" Foreground="#ADB2B8" BorderThickness="0" ToolTip="全部放行，不再询问"/>
                  </StackPanel>
                </Border>
                <Button x:Name="StopBtn" Content="停止" Height="26" Padding="10,0" Cursor="Hand" FontSize="11.5"
                        Background="Transparent" Foreground="#F87171" BorderBrush="#66F87171" BorderThickness="1"
                        IsEnabled="False" Visibility="Collapsed"/>
                <Button x:Name="SendBtn" Content="发送" Height="26" Padding="14,0" Cursor="Hand" FontSize="11.5"
                        FontWeight="SemiBold" Background="#2B5CFF" Foreground="White" BorderThickness="0"/>
              </StackPanel>
              <TextBlock x:Name="Hint" DockPanel.Dock="Left" Text="Enter 发送 · Shift+Enter 换行 · Ctrl+V 贴图"
                         Foreground="#5B626D" FontSize="10.5" VerticalAlignment="Center"
                         TextTrimming="CharacterEllipsis" TextWrapping="NoWrap"/>
            </DockPanel>
          </StackPanel>
        </Border>
      </Grid>
    </Grid>

    <!-- 设置面板：做成遮罩层而不是第二个窗口，省掉嵌套消息循环那堆坑 -->
    <Grid x:Name="SettingsOverlay" Grid.ColumnSpan="3" Visibility="Collapsed" Background="#B8000000">
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
          <DockPanel>
            <Button x:Name="CfgFetch" DockPanel.Dock="Right" Content="拉取" Height="30" Padding="12,0" Cursor="Hand"
                    FontSize="11.5" Margin="8,0,0,0" Background="Transparent" Foreground="#8AB4FF"
                    BorderBrush="#4D8AB4FF" BorderThickness="1"/>
            <TextBox x:Name="CfgModel" Height="30" Background="#0F1115" Foreground="#F9FAFB" BorderBrush="#1FFFFFFF"
                     BorderThickness="1" Padding="9,0" VerticalContentAlignment="Center" FontSize="11.5"
                     FontFamily="Cascadia Mono, Consolas"/>
          </DockPanel>
          <WrapPanel x:Name="ModelChips" Orientation="Horizontal" Margin="0,7,0,0" Visibility="Collapsed"/>
          <TextBlock x:Name="ModelHint" Text="" Foreground="#5B626D" FontSize="10.5" Margin="0,6,0,0" TextWrapping="Wrap"/>

          <CheckBox x:Name="CfgVision" Content="模型支持看图（图片会作为图片发过去，不是只给路径）"
                    Foreground="#CFD3D6" FontSize="11" Margin="0,13,0,0"/>

          <TextBlock Text="验证命令（可选）" Foreground="#ADB2B8" FontSize="11" Margin="0,13,0,5"/>
          <TextBox x:Name="CfgVerify" Height="30" Background="#0F1115" Foreground="#F9FAFB" BorderBrush="#1FFFFFFF"
                   BorderThickness="1" Padding="9,0" VerticalContentAlignment="Center" FontSize="11.5"
                   FontFamily="Cascadia Mono, Consolas"/>
          <TextBlock Text="改完文件后自动跑它，失败会把输出回灌给模型让它自己修。留空＝自动识别（npm test / cargo test / go test / pytest）。"
                     Foreground="#5B626D" FontSize="10.5" Margin="0,5,0,0" TextWrapping="Wrap"/>

          <!-- 工具调用日志：每次调用往这里追加一行，复杂任务卡在哪一步就看它 -->
          <TextBlock Text="工具调用日志" Foreground="#ADB2B8" FontSize="11" Margin="0,13,0,5"/>
          <DockPanel>
            <Button x:Name="CfgOpenLogs" DockPanel.Dock="Right" Content="打开目录" Height="30" Padding="12,0" Cursor="Hand"
                    FontSize="11.5" Margin="8,0,0,0" Background="Transparent" Foreground="#8AB4FF"
                    BorderBrush="#4D8AB4FF" BorderThickness="1"/>
            <TextBox x:Name="CfgLogsDir" IsReadOnly="True" Height="30" Background="#0F1115" Foreground="#ADB2B8"
                     BorderBrush="#1FFFFFFF" BorderThickness="1" Padding="9,0" VerticalContentAlignment="Center"
                     FontSize="10.5" FontFamily="Cascadia Mono, Consolas" ToolTip="日志文件：tool-calls-YYYY-MM-DD.jsonl"/>
          </DockPanel>
          <TextBlock Text="每次调用工具追加一行 jsonl（轮次/步号/工具/参数/审批/成败/耗时），排查复杂任务卡在哪一步就看它。"
                     Foreground="#5B626D" FontSize="10.5" Margin="0,5,0,0" TextWrapping="Wrap"/>

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

    <!-- 删除类操作的确认框：用窗口内的深色浮层，不用系统 MessageBox
         —— 后者是白底系统字，在这套深色界面里像从别的程序弹出来的 -->
    <Grid x:Name="ConfirmOverlay" Grid.ColumnSpan="3" Visibility="Collapsed" Background="#B8000000">
      <Border Width="420" Background="#16181D" BorderBrush="#26FFFFFF" BorderThickness="1" CornerRadius="12"
              HorizontalAlignment="Center" VerticalAlignment="Center" Padding="22,20,22,18">
        <StackPanel>
          <TextBlock x:Name="ConfirmTitle" Text="" Foreground="#F9FAFB" FontSize="14" FontWeight="SemiBold"
                     TextWrapping="Wrap"/>
          <TextBlock x:Name="ConfirmText" Text="" Foreground="#ADB2B8" FontSize="11.5" Margin="0,8,0,0"
                     TextWrapping="Wrap" LineHeight="18"/>
          <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,18,0,0">
            <Button x:Name="ConfirmNo" Content="取消" Height="28" Padding="14,0" Cursor="Hand" FontSize="11.5"
                    Background="Transparent" Foreground="#ADB2B8" BorderBrush="#1FFFFFFF" BorderThickness="1"
                    Margin="0,0,8,0"/>
            <Button x:Name="ConfirmYes" Content="删除" Height="28" Padding="18,0" Cursor="Hand" FontSize="11.5"
                    FontWeight="SemiBold" Background="#F87171" Foreground="#1A0B0B" BorderThickness="0"/>
          </StackPanel>
        </StackPanel>
      </Border>
    </Grid>

    <!-- 单行输入浮层：重命名会话、填分组名都用它（同样不用系统 InputBox，那是白底对话框） -->
    <Grid x:Name="InputOverlay" Grid.ColumnSpan="3" Visibility="Collapsed" Background="#B8000000">
      <Border Width="420" Background="#16181D" BorderBrush="#26FFFFFF" BorderThickness="1" CornerRadius="12"
              HorizontalAlignment="Center" VerticalAlignment="Center" Padding="22,20,22,18">
        <StackPanel>
          <TextBlock x:Name="InputTitle" Text="" Foreground="#F9FAFB" FontSize="14" FontWeight="SemiBold"
                     TextWrapping="Wrap"/>
          <TextBlock x:Name="InputHint" Text="" Foreground="#6B7280" FontSize="10.5" Margin="0,7,0,0"
                     TextWrapping="Wrap" LineHeight="16"/>
          <TextBox x:Name="InputField" AutomationProperties.AutomationId="InputField" Height="30"
                   Margin="0,12,0,0" Background="#0F1115" Foreground="#F9FAFB" BorderBrush="#1FFFFFFF"
                   BorderThickness="1" Padding="9,0" VerticalContentAlignment="Center" FontSize="12"
                   CaretBrush="#8AB4FF"/>
          <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,18,0,0">
            <Button x:Name="InputNo" Content="取消" Height="28" Padding="14,0" Cursor="Hand" FontSize="11.5"
                    Background="Transparent" Foreground="#ADB2B8" BorderBrush="#1FFFFFFF" BorderThickness="1"
                    Margin="0,0,8,0"/>
            <Button x:Name="InputYes" AutomationProperties.AutomationId="InputYes" Content="确定" Height="28"
                    Padding="18,0" Cursor="Hand" FontSize="11.5" FontWeight="SemiBold" Background="#2B5CFF"
                    Foreground="White" BorderThickness="0"/>
          </StackPanel>
        </StackPanel>
      </Border>
    </Grid>
    <!-- 图片预览：点缩略图弹大图，点背景 / × / Esc 都能关 -->
    <Grid x:Name="ImagePreview" Grid.ColumnSpan="3" Visibility="Collapsed" Background="#F2000000">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="*"/>
      </Grid.RowDefinitions>
      <DockPanel Grid.Row="0" Margin="20,14,20,0">
        <Button x:Name="PreviewClose" DockPanel.Dock="Right" Content="×" Width="32" Height="32" Cursor="Hand"
                FontSize="17" Background="Transparent" Foreground="#CFD3D6" BorderThickness="0"
                ToolTip="关闭（Esc）"/>
        <TextBlock x:Name="PreviewName" Text="" Foreground="#ADB2B8" FontSize="11.5" VerticalAlignment="Center"
                   TextTrimming="CharacterEllipsis" TextWrapping="NoWrap" Margin="0,0,12,0"/>
      </DockPanel>
      <Border Grid.Row="1" Margin="20,8,20,20" Background="#0B0E12" BorderBrush="#6B7484" BorderThickness="1"
              HorizontalAlignment="Center" VerticalAlignment="Center">
        <Image x:Name="PreviewImage" Stretch="Uniform"/>
      </Border>
    </Grid>
  </Grid>
</Window>
'@

$window = [Windows.Markup.XamlReader]::Parse($xaml)
Log 'XAML 解析成功'
# 图标：默认是 powershell.exe 的白蓝图标，换成左栏那个 P 徽标。
# 坑：WPF 的 Window.Icon 只吃「一张图」，系统需要 16/20/24/32px 时自己去缩这张图，
# 缩出来的 16px 就是一个白团——任务栏上看到的就是那团白。
# 所以这里按系统实际要的每个尺寸各画一张（几何笔画，不用字体渲染），
# 再用 WM_SETICON 把小图标（标题栏/任务栏）和大图标（Alt+Tab）分别交给窗口。
$script:iconHandles = @()
try {
  Add-Type -Namespace PL -Name IconNative -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
[DllImport("user32.dll", EntryPoint = "SetClassLongPtr")] public static extern IntPtr SetClassLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hAfter, int x, int y, int cx, int cy, uint flags);
'@

  # 画一张 $Size×$Size 的 P 徽标（和 scripts/make-icon.ps1 同一套比例）
  function New-LogoBitmap([int]$Size) {
    $visual = New-Object System.Windows.Media.DrawingVisual
    $dc = $visual.RenderOpen()
    try {
      $pad = [math]::Max(1.0, $Size * 0.03)
      $rad = [math]::Max(2.0, $Size * 0.22)
      $rect = New-Object System.Windows.Rect $pad, $pad, ($Size - 2 * $pad), ($Size - 2 * $pad)
      $brush = New-Object System.Windows.Media.LinearGradientBrush
      $brush.StartPoint = New-Object System.Windows.Point 0, 0
      $brush.EndPoint = New-Object System.Windows.Point 0, 1
      $brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop ([System.Windows.Media.Color]::FromRgb(43, 92, 255), 0)))
      $brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop ([System.Windows.Media.Color]::FromRgb(22, 48, 170), 1)))
      $dc.DrawGeometry($brush, $null, (New-Object System.Windows.Media.RectangleGeometry $rect, $rad, $rad))

      # 白 P：竖笔 + 右侧圆环（内圆偏右下，左边自然并进竖笔）
      $white = [System.Windows.Media.Brushes]::White
      $stroke = [math]::Max(1.0, $Size * 0.135)
      $stemX = $Size * 0.28
      $top = $Size * 0.20
      $bottom = $Size * 0.80
      $bowl = [math]::Max(4.0, $Size * 0.46)
      $dc.DrawRectangle($white, $null, (New-Object System.Windows.Rect $stemX, $top, $stroke, ($bottom - $top)))
      $inner = $bowl - 2 * $stroke
      if ($inner -ge 1) {
        $cx = $stemX + $bowl / 2
        $cy = $top + $bowl / 2
        $outerGeo = New-Object System.Windows.Media.EllipseGeometry (New-Object System.Windows.Point $cx, $cy), ($bowl / 2), ($bowl / 2)
        $holeGeo = New-Object System.Windows.Media.EllipseGeometry (New-Object System.Windows.Point ($cx + $stroke / 2), ($cy + $stroke / 2)), ($inner / 2), ($inner / 2)
        $ring = New-Object System.Windows.Media.CombinedGeometry ([System.Windows.Media.GeometryCombineMode]::Exclude), $outerGeo, $holeGeo
        $dc.DrawGeometry($white, $null, $ring)
      } else {
        $dc.DrawEllipse($white, $null, (New-Object System.Windows.Point ($stemX + $bowl / 2), ($top + $bowl / 2)), ($bowl / 2), ($bowl / 2))
      }
    } finally { $dc.Close() }
    $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap $Size, $Size, 96, 96, ([System.Windows.Media.PixelFormats]::Pbgra32)
    $rtb.Render($visual)
    return $rtb
  }

  # BitmapSource -> HICON（走一趟 PNG 内存流，System.Drawing 负责生成句柄）
  function New-HiconFromBitmap($bitmapSource) {
    $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
    $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmapSource))
    $ms = New-Object System.IO.MemoryStream
    try {
      $enc.Save($ms)
      $ms.Position = 0
      $bmp = New-Object System.Drawing.Bitmap $ms
      try { return $bmp.GetHicon() } finally { $bmp.Dispose() }
    } finally { $ms.Dispose() }
  }

  $dpi = 1.0
  try { $dpi = [System.Windows.Media.VisualTreeHelper]::GetDpi($window).DpiScaleX } catch { }
  if ($dpi -le 0) { $dpi = 1.0 }
  $smallPx = [int][math]::Round(16 * $dpi)
  $bigPx = [int][math]::Round(32 * $dpi)

  # 优先用仓库里那张 packleader.ico（多帧，含 16/32/256）；找不到才退回现画。
  # 注意：cli.ts 会把本脚本复制到 %TEMP% 再跑，$PSScriptRoot 是临时目录，
  # 图标真实位置要从 cli.ts 传的 PL_GUI_ROOT（仓库根）取。
  $icoPath = ''
  if ($env:PL_GUI_ROOT) { $icoPath = Join-Path $env:PL_GUI_ROOT 'ui\packleader.ico' }
  if (-not $icoPath -or -not (Test-Path $icoPath)) { $icoPath = Join-Path $PSScriptRoot 'packleader.ico' }
  if (-not (Test-Path $icoPath)) { $icoPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'packleader.ico' }
  $script:iconKind = 'drawn'
  if (Test-Path $icoPath) {
    Add-Type -AssemblyName System.Drawing
    $icoSmall = New-Object System.Drawing.Icon $icoPath, $smallPx, $smallPx
    $icoBig = New-Object System.Drawing.Icon $icoPath, $bigPx, $bigPx
    $icoHuge = New-Object System.Drawing.Icon $icoPath, 256, 256
    # Icon 对象自己持有 HICON：交出去后不要再 DestroyIcon（Dispose 会自己收）
    $script:iconObjects = @($icoSmall, $icoBig, $icoHuge)
    $script:iconSmall = $icoSmall.Handle
    $script:iconBig = $icoBig.Handle
    $script:iconKind = 'ico'
    # 坑：Int32Rect 的宽高必须与图标帧真实尺寸一致。这张 ico 里最大帧是 128，
    # 硬写 256 会抛 "Value does not fall within the expected range"，整个图标设置就此被跳过。
    # Int32Rect.Empty = 按实际帧尺寸取。
    $window.Icon = [System.Windows.Interop.Imaging]::CreateBitmapSourceFromHIcon(
      $icoHuge.Handle,
      [System.Windows.Int32Rect]::Empty,
      [System.Windows.Media.Imaging.BitmapSizeOptions]::FromEmptyOptions())
  } else {
    # Window.Icon 给最大的那张（Alt+Tab / 任务视图 / 资源管理器缩略图都用它）
    $window.Icon = New-LogoBitmap 256
    # 句柄先建好（Loaded 里只发消息，不再分配资源，重复触发也不会泄漏）
    $smallIcon = New-HiconFromBitmap (New-LogoBitmap $smallPx)
    $bigIcon = New-HiconFromBitmap (New-LogoBitmap $bigPx)
    $script:iconHandles = @($smallIcon, $bigIcon)
    $script:iconSmall = $smallIcon
    $script:iconBig = $bigIcon
  }

  # 坑：只能用函数，不能用闭包。PS 5.1 里 add_Loaded({...}) 的回调执行时看不到脚本级变量，
  # 原来写成 & $applyWindowIcons 的话句柄全是 $null，图标根本没设上去（任务栏还是 powershell 的白蓝图标）。
  function Set-WindowIcons {
    if (-not $window) { return }
    # 坑：WPF 的 Window 没有 Handle 属性（$window.Handle 恒为 $null，传给 SendMessage 直接抛错），
    # 真句柄只能走 WindowInteropHelper；而且窗口创建前拿到的就是 0，所以要在 Loaded 里再调一次。
    $h = [IntPtr]::Zero
    try { $h = (New-Object System.Windows.Interop.WindowInteropHelper $window).Handle } catch { }
    if (-not $h -or $h -eq [IntPtr]::Zero) { return }
    if (-not $script:iconSmall -or -not $script:iconBig) { return }
    # ICON_SMALL=0（标题栏）、ICON_SMALL2=2（任务栏按钮）、ICON_BIG=1（Alt+Tab）
    [void][PL.IconNative]::SendMessage($h, 0x0080, [IntPtr]0, $script:iconSmall)
    [void][PL.IconNative]::SendMessage($h, 0x0080, [IntPtr]2, $script:iconSmall)
    [void][PL.IconNative]::SendMessage($h, 0x0080, [IntPtr]1, $script:iconBig)
    # 类图标也换掉：任务栏在没有窗口级图标时会回落到它
    [void][PL.IconNative]::SetClassLongPtr($h, -14, $script:iconBig)
    [void][PL.IconNative]::SetClassLongPtr($h, -34, $script:iconSmall)
    # 通知系统刷新（不然任务栏会继续用缓存的旧图标）
    [void][PL.IconNative]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0027)
  }
  & Set-WindowIcons
  $window.add_Loaded({ Set-WindowIcons })
  if ($script:iconKind -eq 'ico') { Log "窗口图标用 $icoPath（small=${smallPx} big=${bigPx} 帧=$($icoBig.Width)/$($icoHuge.Width)）" }
  else { Log "窗口图标按尺寸绘制（small=${smallPx}px big=${bigPx}px dpi=$dpi）" }
} catch {
  Log ('设置窗口图标失败: ' + $_.Exception.Message)
}
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
$ThinkRow = $window.FindName('ThinkRow')
$ThinkText = $window.FindName('ThinkText')
$PickFolderBtn = $window.FindName('PickFolderBtn')
$ModeRead = $window.FindName('ModeRead')
$ModeGuard = $window.FindName('ModeGuard')
$ModeFull = $window.FindName('ModeFull')
$ModelPill = $window.FindName('ModelPill')
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
$CfgVerify = $window.FindName('CfgVerify')
$CfgError = $window.FindName('CfgError')
$CfgCancel = $window.FindName('CfgCancel')
$CfgSave = $window.FindName('CfgSave')
$CfgFetch = $window.FindName('CfgFetch')
$CfgVision = $window.FindName('CfgVision')
$CfgLogsDir = $window.FindName('CfgLogsDir')
$CfgOpenLogs = $window.FindName('CfgOpenLogs')
$ModelChips = $window.FindName('ModelChips')
$ModelHint = $window.FindName('ModelHint')
$AttachBtn = $window.FindName('AttachBtn')
$InsertConvBtn = $window.FindName('InsertConvBtn')
$AttachList = $window.FindName('AttachList')
$ImagePreview = $window.FindName('ImagePreview')
$PreviewImage = $window.FindName('PreviewImage')
$PreviewName = $window.FindName('PreviewName')
$PreviewClose = $window.FindName('PreviewClose')
$ConfirmOverlay = $window.FindName('ConfirmOverlay')
$ConfirmTitle = $window.FindName('ConfirmTitle')
$ConfirmText = $window.FindName('ConfirmText')
$ConfirmYes = $window.FindName('ConfirmYes')
$ConfirmNo = $window.FindName('ConfirmNo')
$SideSplitter = $window.FindName('SideSplitter')
$SideCol = $window.FindName('RootGrid').ColumnDefinitions[0]
$SideScroll = $window.FindName('SideScroll')
$InputOverlay = $window.FindName('InputOverlay')
$InputTitle = $window.FindName('InputTitle')
$InputHint = $window.FindName('InputHint')
$InputField = $window.FindName('InputField')
$InputYes = $window.FindName('InputYes')
$InputNo = $window.FindName('InputNo')

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

# ---------------------------------------------------------------- 复制
# WPF 的 TextBlock 不能拖蓝选中，所以每块内容挂右键菜单：复制本段 / 复制整段对话。
# 待复制的文本放在哈希表里，由调用方随时更新（流式时内容一直在变），
# 回调从 Tag 上取那份引用——PS 5.1 下事件里的 GetNewClosure 拿不到外部变量。
$script:copyLog = New-Object System.Text.StringBuilder

function Append-CopyLog([string]$t) {
  if (-not $t) { return }
  $script:copyLog.Append($t) | Out-Null
  if (-not $t.EndsWith("`n")) { $script:copyLog.Append("`n") | Out-Null }
}

function Copy-Text([object]$t) {
  $s = [string]$t
  if (-not $s) { return }
  try { [System.Windows.Clipboard]::SetText($s) } catch { Log ('复制失败: ' + ($_ | Out-String)) }
}

# 右键菜单的深色模板：系统默认的 ContextMenu / MenuItem 是浅灰底，和深色界面不搭
$script:ctxTpl = $null
$script:miTpl = $null

function New-CtxTemplate {
  if ($script:ctxTpl) { return $script:ctxTpl }
  $xaml = @'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="ContextMenu">
  <Border Background="#14171D" BorderBrush="#2A2F39" BorderThickness="1" CornerRadius="6" Padding="4">
    <StackPanel IsItemsHost="True" KeyboardNavigation.DirectionalNavigation="Cycle"/>
  </Border>
</ControlTemplate>
'@
  $script:ctxTpl = [System.Windows.Markup.XamlReader]::Parse($xaml)
  return $script:ctxTpl
}

function New-MenuItemTemplate {
  if ($script:miTpl) { return $script:miTpl }
  $xaml = @'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="MenuItem">
  <Border x:Name="bd" Background="{TemplateBinding Background}" Padding="14,6" CornerRadius="4">
    <ContentPresenter ContentSource="Header" VerticalAlignment="Center" TextBlock.Foreground="{TemplateBinding Foreground}" TextBlock.FontSize="12"/>
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="IsHighlighted" Value="True">
      <Setter TargetName="bd" Property="Background" Value="#1B2029"/>
    </Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
'@
  $script:miTpl = [System.Windows.Markup.XamlReader]::Parse($xaml)
  return $script:miTpl
}

function New-CopyMenu([object]$box) {
  $cm = New-Object System.Windows.Controls.ContextMenu
  $cm.Background = (Brush '#14171D')
  $cm.Foreground = (Brush '#E6E8EE')
  $cm.BorderBrush = (Brush '#2A2F39')
  $cm.BorderThickness = '1'
  $cm.Template = (New-CtxTemplate)
  $mi = New-Object System.Windows.Controls.MenuItem
  $mi.Foreground = (Brush '#E6E8EE')
  $mi.Background = [System.Windows.Media.Brushes]::Transparent
  $mi.Padding = '0'
  $mi.Template = (New-MenuItemTemplate)
  $mi.Header = '复制'
  $mi.Tag = $box
  $mi.Add_Click({ param($s, $e) Copy-Text ([string]$s.Tag.text) })
  $cm.Items.Add($mi) | Out-Null
  $ma = New-Object System.Windows.Controls.MenuItem
  $ma.Header = '复制整段对话'
  $ma.Foreground = (Brush '#E6E8EE')
  $ma.Background = [System.Windows.Media.Brushes]::Transparent
  $ma.Padding = '0'
  $ma.Template = (New-MenuItemTemplate)
  $ma.Add_Click({ param($s, $e) Copy-Text $script:copyLog.ToString() })
  $cm.Items.Add($ma) | Out-Null
  return $cm
}
function Add-UserMessage([string]$text, [object]$files = $null, [object]$quotes = $null) {
  $sp = Add-Container 20
  $label = New-Text '你' 10.5 '#6B7280' 'Normal' 'Segoe UI' 4
  $sp.Children.Add($label) | Out-Null
  if ($text.Trim()) {
    $body = New-Text $text 14 '#F9FAFB' 'Normal' 'Segoe UI' 0
    $body.LineHeight = 23
    $body.LineStackingStrategy = 'BlockLineHeight'
    $sp.Children.Add($body) | Out-Null
  }
  # 附件：只显示名字和大小，不显示数据目录里那一长串路径
  $list = @($files)
  if ($list.Count -gt 0) {
    $wrap = New-Object System.Windows.Controls.WrapPanel
    $wrap.Orientation = 'Horizontal'
    $wrap.Margin = '0,6,0,0'
    foreach ($f in $list) {
      $nm = if ($f.name) { [string]$f.name } else { [System.IO.Path]::GetFileName([string]$f) }
      $fp = [string]$f.path
      $sz = if ($null -ne $f.bytes) { Format-FileSize ([double]$f.bytes) } else { '' }
      $b = New-Object System.Windows.Controls.Border
      $b.Background = (Brush '#1F242C')
      $b.BorderBrush = (Brush '#1FFFFFFF')
      $b.BorderThickness = '1'
      $b.CornerRadius = '6'
      $b.Padding = '6,4,8,4'
      $b.Margin = '0,0,6,6'
      # 发出去的图片也留个缩略图（用数据目录里那份拷贝，原文件删了也还在）
      if ($fp -and (Test-ImagePath $fp)) {
        $box = New-Object System.Windows.Controls.StackPanel
        $box.Orientation = 'Horizontal'
        $thumb = New-ImageThumb $fp 56
        if ($thumb) { $box.Children.Add($thumb) | Out-Null }
        $meta = New-Object System.Windows.Controls.StackPanel
        $meta.VerticalAlignment = 'Center'
        $nTb = New-Text $nm 10.5 '#9AA1AC' 'Normal' 'Segoe UI' 0
        $nTb.MaxWidth = 200
        $nTb.TextTrimming = 'CharacterEllipsis'
        $nTb.TextWrapping = 'NoWrap'
        $meta.Children.Add($nTb) | Out-Null
        if ($sz) { $meta.Children.Add((New-Text $sz 9.5 '#6B7280' 'Normal' 'Segoe UI' 1)) | Out-Null }
        $box.Children.Add($meta) | Out-Null
        $b.Child = $box
      } else {
        $b.Child = (New-Text $(if ($sz) { "$nm · $sz" } else { $nm }) 10.5 '#9AA1AC')
      }
      $wrap.Children.Add($b) | Out-Null
    }
    $sp.Children.Add($wrap) | Out-Null
  }
  # 引用了之前的消息：在气泡里留一行标记，不然发出去的内容和屏幕上看对不上
  $qs = @($quotes)
  if ($qs.Count -gt 0) {
    $qw = New-Object System.Windows.Controls.WrapPanel
    $qw.Orientation = 'Horizontal'
    $qw.Margin = '0,6,0,0'
    foreach ($q in $qs) {
      $who = $(if ($q.role -eq 'user') { '你' } else { '模型' })
      $snip = ([string]$q.text) -replace "\s+", ' '
      if ($snip.Length -gt 40) { $snip = $snip.Substring(0, 40) + '…' }
      if (-not $snip) { $snip = '(空)' }
      $qb = New-Object System.Windows.Controls.Border
      $qb.Background = (Brush '#1B2433')
      $qb.BorderBrush = (Brush '#3D6CFF')
      $qb.BorderThickness = '1'
      $qb.CornerRadius = '6'
      $qb.Padding = '6,3,8,3'
      $qb.Margin = '0,0,6,6'
      $qb.Child = (New-Text "引用 · $who：$snip" 10 '#8AB4FF' 'Normal' 'Segoe UI' 0)
      $qw.Children.Add($qb) | Out-Null
    }
    $sp.Children.Add($qw) | Out-Null
  }
  $sp.ContextMenu = (New-CopyMenu (@{ text = "你：$text" }))
  Append-CopyLog "你：$text"
  [void]$script:msgLog.Add(@{ role = 'user'; text = $text })
  $script:currentAssistant = $null
}

# ---------------------------------------------------------------- 记忆卡片
# 一轮结束后模型写了记忆就在这里显出来，并给一个「撤销」——
# 不想要那条记忆时不用去翻数据目录里的 jsonl
$script:memoryCards = New-Object System.Collections.ArrayList

function Set-MemoryUndone($ids) {
  $drop = @{}
  foreach ($i in @($ids)) { $drop[[string]$i] = $true }
  foreach ($c in @($script:memoryCards)) {
    $all = @($c.ids)
    $left = @($all | Where-Object { -not $drop.ContainsKey([string]$_) })
    if ($left.Count -eq $all.Count) { continue }
    $c.ids = $left
    if ($left.Count -eq 0) {
      $c.state.Text = '已撤销'
      $c.state.Foreground = (Brush '#6B7280')
      $c.btn.Visibility = 'Collapsed'
      foreach ($row in @($c.rows)) { $row.Foreground = (Brush '#5B626D') }
    }
  }
}

function Add-MemoryCard([object]$items) {
  $list = @(@($items) | Where-Object { $_ -and [string]$_.text })
  if ($list.Count -eq 0) { return }
  $sp = Add-Container 16
  $outer = New-Object System.Windows.Controls.Border
  $outer.Background = (Brush '#12141A')
  $outer.BorderBrush = (Brush '#12FFFFFF')
  $outer.BorderThickness = '1'
  $outer.CornerRadius = '8'
  $outer.Padding = '10,8'
  $inner = New-Object System.Windows.Controls.StackPanel
  $outer.Child = $inner

  $head = New-Object System.Windows.Controls.DockPanel
  $state = New-Text '' 10.5 '#5B626D' 'Normal' 'Segoe UI' 0
  $state.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($state, 'Right')
  $head.Children.Add($state) | Out-Null

  $undo = New-Object System.Windows.Controls.Button
  $undo.Content = '撤销'
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($undo, 'MemoryUndo')
  $undo.FontSize = 10.5
  $undo.Padding = '8,2'
  $undo.Cursor = 'Hand'
  $undo.Background = [System.Windows.Media.Brushes]::Transparent
  $undo.Foreground = (Brush '#8AB4FF')
  $undo.BorderThickness = '0'
  $undo.ToolTip = '把这轮记下的记忆删掉'
  [System.Windows.Controls.DockPanel]::SetDock($undo, 'Right')
  $undo.Add_MouseEnter({ param($s, $e) $s.Foreground = (Brush '#B9CDFF') })
  $undo.Add_MouseLeave({ param($s, $e) $s.Foreground = (Brush '#8AB4FF') })
  $head.Children.Add($undo) | Out-Null

  $title = New-Text ("记住了 " + $list.Count + " 条") 11 '#9BA3B4' 'SemiBold' 'Segoe UI' 0
  $title.VerticalAlignment = 'Center'
  $head.Children.Add($title) | Out-Null
  $inner.Children.Add($head) | Out-Null

  $rows = New-Object System.Collections.ArrayList
  foreach ($m in $list) {
    $line = New-Text ('· ' + [string]$m.text) 11 '#7C838E' 'Normal' 'Segoe UI' 0
    $line.TextWrapping = 'Wrap'
    $line.LineHeight = 18
    $line.LineStackingStrategy = 'BlockLineHeight'
    $line.Margin = '0,5,0,0'
    $inner.Children.Add($line) | Out-Null
    [void]$rows.Add($line)
  }

  $card = @{ ids = @($list | ForEach-Object { [string]$_.id }); state = $state; btn = $undo; rows = $rows }
  $undo.Tag = $card
  $undo.Add_Click({ param($s, $e) Send-Host @{ cmd = 'undo-memory'; ids = @($s.Tag.ids) } })
  [void]$script:memoryCards.Add($card)

  $sp.Children.Add($outer) | Out-Null
  $Scroller.ScrollToEnd()
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
  $script:assistantBox = @{ text = '' }
  $sp.ContextMenu = (New-CopyMenu $script:assistantBox)
  return $tb
}

# 工具行：平时收在「N 次工具调用」分组里，展开后一行一条
function Add-ToolRow([string]$name, [string]$summary, [object]$parent = $null) {
  $outer = New-Object System.Windows.Controls.Border
  $outer.Background = (Brush '#12141A')
  $outer.BorderBrush = (Brush '#0FFFFFFF')
  $outer.BorderThickness = '1'
  $outer.CornerRadius = '6'
  $outer.Padding = '9,5'
  $outer.Margin = '0,0,0,4'
  $outer.HorizontalAlignment = 'Stretch'

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
  # 右键可复制这一行的「工具名 + 参数 + 结果」；文本随着状态变，放在 $box 里跟着更新
  $box = @{ text = "$name  $summary" }
  $outer.ContextMenu = (New-CopyMenu $box)
  if ($parent) { $parent.Children.Add($outer) | Out-Null }
  else { $Transcript.Children.Add($outer) | Out-Null }
  $status.Tag = @{ box = $box }
  return $status
}

# ---------------------------------------------------------------- 工具调用分组
# 和 Kite 一样：连续几次调用收成一个可折叠的块，收起时就是一行
# 「▸  5 次工具调用                  fs.read ×3 · fs.edit ×2」，点一下展开看每一行。
$script:toolGroup = $null

function Update-ToolGroup($g) {
  if (-not $g) { return }
  $arrow = $(if ($g.Open) { '▾' } else { '▸' })
  $g.Head.Text = "$arrow  $($g.Count) 次工具调用"
  $parts = @()
  foreach ($k in $g.Order) { $parts += ("$k ×" + $g.Counts[$k]) }
  $sum = ($parts -join ' · ')
  if ($g.Running -gt 0) { $sum = $(if ($sum) { "运行中… · $sum" } else { '运行中…' }) }
  if ($g.Failed -gt 0) { $sum = "$sum · $($g.Failed) 失败" }
  if ($sum.Length -gt 72) { $sum = $sum.Substring(0, 72) + '…' }
  $g.Sum.Text = $sum
  $g.Sum.Foreground = $(if ($g.Failed -gt 0) { Brush '#F87171' } else { Brush '#6B7280' })
}

function New-ToolGroup {
  $outer = New-Object System.Windows.Controls.Border
  $outer.Background = (Brush '#0E1116')
  $outer.BorderBrush = (Brush '#0FFFFFFF')
  $outer.BorderThickness = '1'
  $outer.CornerRadius = '8'
  $outer.Margin = '0,0,0,6'
  $outer.HorizontalAlignment = 'Stretch'

  $sp = New-Object System.Windows.Controls.StackPanel

  $head = New-Object System.Windows.Controls.Button
  $head.Background = [System.Windows.Media.Brushes]::Transparent
  $head.BorderThickness = '0'
  $head.Padding = '10,7'
  $head.Cursor = 'Hand'
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($head, 'ToolGroupHead')
  $head.HorizontalContentAlignment = 'Stretch'
  $head.Template = (New-FlatTemplate)
  $dp = New-Object System.Windows.Controls.DockPanel
  $sum = New-Text '' 10.5 '#6B7280' 'Normal' 'Cascadia Mono, Consolas' 0
  $sum.VerticalAlignment = 'Center'
  $sum.TextTrimming = 'CharacterEllipsis'
  $sum.TextWrapping = 'NoWrap'
  [System.Windows.Controls.DockPanel]::SetDock($sum, 'Right')
  $dp.Children.Add($sum) | Out-Null
  $title = New-Text '▸  0 次工具调用' 11.5 '#C7CBD2' 'SemiBold' 'Segoe UI' 0
  $title.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($title, 'Left')
  $dp.Children.Add($title) | Out-Null
  $head.Content = $dp
  $sp.Children.Add($head) | Out-Null

  $items = New-Object System.Windows.Controls.StackPanel
  $items.Margin = '8,0,8,7'
  $items.Visibility = 'Collapsed'
  $sp.Children.Add($items) | Out-Null

  $outer.Child = $sp
  $Transcript.Children.Add($outer) | Out-Null

  $g = New-Object PSObject -Property @{
    Head = $title; Sum = $sum; Items = $items; Border = $outer
    Count = 0; Counts = @{}; Order = (New-Object System.Collections.ArrayList)
    Running = 0; Failed = 0; Open = $false
  }
  # 同样拿 Tag 传节点：事件里直接引用 $g 会拿到 null
  $head.Tag = $g
  $head.Add_Click({ param($s, $e) Toggle-ToolGroup $s.Tag })
  return $g
}

function Toggle-ToolGroup($g) {
  if (-not $g) { return }
  $g.Open = -not $g.Open
  $g.Items.Visibility = $(if ($g.Open) { 'Visible' } else { 'Collapsed' })
  Update-ToolGroup $g
}

# 拿「当前这一组」：没有就新建。出现正文/思考/审批时调 Close-ToolGroup 断开
function Get-ToolGroup {
  if (-not $script:toolGroup) { $script:toolGroup = New-ToolGroup }
  return $script:toolGroup
}

function Close-ToolGroup {
  if ($script:toolGroup) { Update-ToolGroup $script:toolGroup }
  $script:toolGroup = $null
}

function Add-ToolLine([string]$name, [string]$summary) {
  $g = Get-ToolGroup
  $st = Add-ToolRow $name $summary $g.Items
  $g.Count++
  if (-not $g.Counts.ContainsKey($name)) {
    $g.Counts[$name] = 0
    [void]$g.Order.Add($name)
  }
  $g.Counts[$name] = $g.Counts[$name] + 1
  $g.Running++
  # 组引挂在行上：组关闭后回来的结果也能把计数器减回去
  $st.Tag.group = $g
  Update-ToolGroup $g
  return $st
}

function Set-ToolLineDone([string]$id, [string]$text, [bool]$ok) {
  $st = $script:toolRows[$id]
  if (-not $st) { return }
  $st.Text = $text
  $st.Foreground = $(if ($ok) { Brush '#4ADE80' } else { Brush '#F87171' })
  $tag = $st.Tag
  if (-not $tag) { return }
  if ($tag.box) { $tag.box.text = $tag.box.text + " -> $text" }
  $g = $tag.group
  if (-not $g) { return }
  $g.Running = [math]::Max(0, $g.Running - 1)
  if (-not $ok) { $g.Failed++ }
  Update-ToolGroup $g
}

# ---------------------------------------------------------------- 思考链
# Kite 那样的样式：收起时就是一行「⋯ 思考了片刻  <开头一句>            0.9s ▸」，
# 点一下展开看全文。流式时展开，出正文 / 调工具后自动收起。
$script:reasonNode = $null

function Update-ReasoningHeader($n) {
  if (-not $n) { return }
  if ($n.Done) {
    $n.Title.Text = '思考了片刻'
    $n.Title.Foreground = (Brush '#9BA3B4')
  } else {
    $n.Title.Text = '思考中…'
    $n.Title.Foreground = (Brush '#8FA6FF')
  }
  $tail = $(if ($n.Secs -ge 0.1) { "$([math]::Round($n.Secs, 1))s " } else { '' })
  $n.Time.Text = $tail + $(if ($n.Open) { '▾' } else { '▸' })
  # 收起时用正文开头一句当摘要（压成单行，超长截断）
  $s = ($n.Body.Text -replace "\s+", ' ').Trim()
  if ($s.Length -gt 110) { $s = $s.Substring(0, 110) + '…' }
  $n.Sum.Text = $s
  $n.Sum.Visibility = $(if ($n.Open) { 'Collapsed' } else { 'Visible' })
  $n.Body.Visibility = $(if ($n.Open) { 'Visible' } else { 'Collapsed' })
}

# 读秒时每 0.25s 都要刷一次头部：只动时间那一格，
# 不重算摘要（正文一直在长，每 250ms 压一遍整个思考链太浪费）
function Update-ReasoningTime($n) {
  if (-not $n -or $n.Done) { return }
  $n.Secs = ((Get-Date) - $n.T0).TotalSeconds
  $tail = $(if ($n.Secs -ge 0.1) { "$([math]::Round($n.Secs, 1))s " } else { '' })
  $n.Time.Text = $tail + $(if ($n.Open) { '▾' } else { '▸' })
}

function Toggle-Reasoning($n) {
  if (-not $n) { return }
  $n.Open = -not $n.Open
  Update-ReasoningHeader $n
}

function Add-ReasoningBlock {
  $outer = New-Object System.Windows.Controls.Border
  $outer.Background = (Brush '#12141A')
  $outer.BorderBrush = (Brush '#12FFFFFF')
  $outer.BorderThickness = '1'
  $outer.CornerRadius = '8'
  $outer.Padding = '10,7'
  $outer.Margin = '0,0,0,6'
  $outer.HorizontalAlignment = 'Stretch'

  $stack = New-Object System.Windows.Controls.StackPanel

  $head = New-Object System.Windows.Controls.Button
  $head.Background = [System.Windows.Media.Brushes]::Transparent
  $head.BorderThickness = '0'
  $head.Padding = '0'
  $head.Cursor = 'Hand'
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($head, 'ReasonHead')
  $head.HorizontalContentAlignment = 'Stretch'
  $head.Template = (New-FlatTemplate)
  $head.ToolTip = '点一下收起 / 展开思考过程'
  $dp = New-Object System.Windows.Controls.DockPanel
  $time = New-Text '' 10.5 '#5B626D' 'Normal' 'Cascadia Mono, Consolas' 0
  $time.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($time, 'Right')
  $dp.Children.Add($time) | Out-Null
  $icon = New-Text '⋯' 12 '#7C838E' 'SemiBold' 'Segoe UI' 0
  $icon.VerticalAlignment = 'Center'
  $icon.Margin = '0,0,7,0'
  [System.Windows.Controls.DockPanel]::SetDock($icon, 'Left')
  $dp.Children.Add($icon) | Out-Null
  $title = New-Text '思考中…' 11.5 '#8FA6FF' 'SemiBold' 'Segoe UI' 0
  $title.VerticalAlignment = 'Center'
  $title.Margin = '0,0,10,0'
  [System.Windows.Controls.DockPanel]::SetDock($title, 'Left')
  $dp.Children.Add($title) | Out-Null
  $sum = New-Text '' 11.5 '#6F7684' 'Normal' 'Segoe UI' 0
  $sum.VerticalAlignment = 'Center'
  $sum.TextTrimming = 'CharacterEllipsis'
  $sum.TextWrapping = 'NoWrap'
  $dp.Children.Add($sum) | Out-Null
  $head.Content = $dp
  $stack.Children.Add($head) | Out-Null

  $body = New-Text '' 12 '#878F9C' 'Normal' 'Segoe UI' 0
  $body.TextWrapping = 'Wrap'
  $body.LineHeight = 19
  $body.LineStackingStrategy = 'BlockLineHeight'
  $body.Margin = '0,5,0,0'
  $stack.Children.Add($body) | Out-Null

  $outer.Child = $stack
  $box = @{ text = '' }
  $outer.ContextMenu = (New-CopyMenu $box)
  $Transcript.Children.Add($outer) | Out-Null

  $node = New-Object PSObject -Property @{
    Head = $head; Title = $title; Time = $time; Sum = $sum; Body = $body
    Border = $outer; Box = $box
    T0 = (Get-Date); Open = $true; Done = $false; Secs = 0
  }
  # 节点挂在标题自己的 Tag 上：PS 5.1 下这个事件里的 GetNewClosure 拿不到 $node，点了会抛异常
  $head.Tag = $node
  $head.Add_Click({ param($s, $e) Toggle-Reasoning $s.Tag })
  $script:reasonNode = $node
  Update-ReasoningHeader $node
  return $node
}

function Complete-Reasoning {
  $n = $script:reasonNode
  if (-not $n -or $n.Done) { return }
  $n.Done = $true
  # 历史回放里已经给过耗时（$ev.ms）就别用「刚刚过去 0 秒」盖掉它
  if ($n.Secs -lt 0.1) { $n.Secs = ((Get-Date) - $n.T0).TotalSeconds }
  $n.Open = $false
  $n.Box.text = $n.Body.Text
  Append-CopyLog ('[思考] ' + $n.Body.Text)
  Update-ReasoningHeader $n
  # 只解绑"当前"，节点本身还在界面上（点标题仍能展开），toggle 用的是节点 Tag 上的那一份
  $script:reasonNode = $null
}

function Add-VerifyRow([string]$label, [int]$round) {
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
  $status = New-Text '验证中…' 10.5 '#7C838E' 'Normal' 'Cascadia Mono, Consolas' 0
  $status.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($status, 'Right')
  $dp.Children.Add($status) | Out-Null

  $icon = New-Text '🧪' 11 '#7C838E' 'Normal' 'Segoe UI Emoji, Segoe UI' 0
  $icon.VerticalAlignment = 'Center'
  $icon.Margin = '0,0,6,0'
  [System.Windows.Controls.DockPanel]::SetDock($icon, 'Left')
  $dp.Children.Add($icon) | Out-Null

  $name = $(if ($round -gt 1) { "验证（第 $round 次）" } else { '验证' })
  $nameTb = New-Text $name 11 '#9BA3B4' 'SemiBold' 'Segoe UI' 0
  $nameTb.VerticalAlignment = 'Center'
  $nameTb.Margin = '0,0,8,0'
  [System.Windows.Controls.DockPanel]::SetDock($nameTb, 'Left')
  $dp.Children.Add($nameTb) | Out-Null

  $cmdTb = New-Text $label 11 '#CFD3D6' 'Normal' 'Cascadia Mono, Consolas' 0
  $cmdTb.TextTrimming = 'CharacterEllipsis'
  $cmdTb.TextWrapping = 'NoWrap'
  $cmdTb.VerticalAlignment = 'Center'
  $dp.Children.Add($cmdTb) | Out-Null

  $outer.Child = $dp
  $Transcript.Children.Add($outer) | Out-Null
  return @{ Status = $status; Border = $outer }
}

function Add-SystemLine([string]$text, [string]$color = '#7C838E') {  $tb = New-Text $text 11 $color 'Normal' 'Segoe UI' 10
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

# 审批选项卡片模板：不用系统 Button 默认模板 —— 原生模板在 IsEnabled=False 时变浅灰白底，深色界面里刺眼
function New-OptionTemplate {
  if ($script:optTpl) { return $script:optTpl }
  $xaml = @'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="Button">
  <Border x:Name="bd" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="8" Padding="{TemplateBinding Padding}">
    <ContentPresenter HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}" VerticalAlignment="Center"/>
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="IsMouseOver" Value="True">
      <Setter TargetName="bd" Property="Background" Value="#1B2029"/>
    </Trigger>
    <Trigger Property="IsPressed" Value="True">
      <Setter TargetName="bd" Property="Background" Value="#263450"/>
    </Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
'@
  $script:optTpl = [System.Windows.Markup.XamlReader]::Parse($xaml)
  return $script:optTpl
}

# 一个可选项：左边勾选位 + 标题（可带徽标）+ 说明
function New-ChoiceCard([string]$title, [string]$desc, [string]$badge = '') {
  $b = New-Object System.Windows.Controls.Button
  $b.Cursor = 'Hand'
  $b.Padding = '10,8'
  $b.Margin = '0,5,0,0'
  $b.HorizontalContentAlignment = 'Left'
  $b.Background = (Brush '#12151A')
  $b.BorderBrush = (Brush '#1FFFFFFF')
  $b.BorderThickness = '1'
  $b.Template = (New-OptionTemplate)

  $grid = New-Object System.Windows.Controls.Grid
  $c1 = New-Object System.Windows.Controls.ColumnDefinition
  $c1.Width = [System.Windows.GridLength]::new(18.0)
  $c2 = New-Object System.Windows.Controls.ColumnDefinition
  $c2.Width = New-Object System.Windows.GridLength 1, ([System.Windows.GridUnitType]::Star)
  $grid.ColumnDefinitions.Add($c1)
  $grid.ColumnDefinitions.Add($c2)

  $chk = New-Text ([string][char]0x2713) 12 '#7EA6FF' 'Bold' 'Segoe UI' 0
  $chk.Visibility = 'Hidden'
  $chk.VerticalAlignment = 'Top'
  $chk.Margin = '0,1,0,0'
  [System.Windows.Controls.Grid]::SetColumn($chk, 0)
  $grid.Children.Add($chk) | Out-Null

  $box = New-Object System.Windows.Controls.StackPanel
  $tl = New-Object System.Windows.Controls.StackPanel
  $tl.Orientation = 'Horizontal'
  $tl.Children.Add((New-Text $title 11.5 '#E6E8EE' 'SemiBold' 'Segoe UI' 0)) | Out-Null
  if ($badge) {
    $bd = New-Object System.Windows.Controls.Border
    $bd.Background = (Brush '#1D3A2C')
    $bd.CornerRadius = '8'
    $bd.Padding = '6,1'
    $bd.Margin = '7,0,0,0'
    $bd.VerticalAlignment = 'Center'
    $bd.Child = (New-Text $badge 9.5 '#7BE0A8' 'Normal' 'Segoe UI' 0)
    $tl.Children.Add($bd) | Out-Null
  }
  $box.Children.Add($tl) | Out-Null
  if ($desc) {
    $dt = New-Text $desc 11 '#8B929E' 'Normal' 'Segoe UI' 0
    $dt.Margin = '0,3,0,0'
    $box.Children.Add($dt) | Out-Null
  }
  [System.Windows.Controls.Grid]::SetColumn($box, 1)
  $grid.Children.Add($box) | Out-Null

  $b.Content = $grid
  $b.Tag = @{ check = $chk }
  return $b
}

# 审批卡：照 Kite「模型在问你」的样子 —— 深色卡 + 整块选项（✓ 选中 + 推荐徽标），
# 选完收起选项、显示「你选了：…」。命令发 decision 字段，host 那边才认得出是允许还是拒绝
function Add-ApprovalCard($e) {
  $reqId = [string]$e.reqId

  $card = New-Object System.Windows.Controls.Border
  $card.Background = (Brush '#14171D')
  $card.BorderBrush = (Brush '#2A2F39')
  $card.BorderThickness = '1'
  $card.CornerRadius = '10'
  $card.Padding = '14,12'
  $card.Margin = '0,4,0,12'

  $sp = New-Object System.Windows.Controls.StackPanel

  # 标题行：橙点 + 「模型在问你 · 工具」
  $hd = New-Object System.Windows.Controls.DockPanel
  $dot = New-Object System.Windows.Controls.Border
  $dot.Width = 16
  $dot.Height = 16
  $dot.CornerRadius = '8'
  $dot.Background = (Brush '#FBBF24')
  $dot.VerticalAlignment = 'Center'
  $dot.Child = (New-Text '!' 10.5 '#1A1710' 'Bold' 'Segoe UI' 0)
  [System.Windows.Controls.DockPanel]::SetDock($dot, 'Left')
  $hd.Children.Add($dot) | Out-Null
  $tt = New-Text ('模型在问你 · ' + [string]$e.tool) 12.5 '#E6E8EE' 'SemiBold' 'Segoe UI' 0
  $tt.VerticalAlignment = 'Center'
  $tt.Margin = '8,0,0,0'
  $hd.Children.Add($tt) | Out-Null
  $sp.Children.Add($hd) | Out-Null

  # 问题：这个工具要什么权限
  $q = New-Text ([string]$e.reason) 12 '#CFD3D6' 'Normal' 'Segoe UI' 0
  $q.Margin = '0,8,0,0'
  $sp.Children.Add($q) | Out-Null

  if ($e.detail) {
    $detBox = New-Object System.Windows.Controls.Border
    $detBox.Background = (Brush '#0E1116')
    $detBox.BorderBrush = (Brush '#14FFFFFF')
    $detBox.BorderThickness = '1'
    $detBox.CornerRadius = '6'
    $detBox.Padding = '9,7'
    $detBox.Margin = '0,8,0,0'
    $det = New-Text ([string]$e.detail) 11 '#9BA3B4' 'Normal' 'Cascadia Mono, Consolas' 0
    $det.MaxHeight = 96
    $detBox.Child = $det
    $sp.Children.Add($detBox) | Out-Null
  }

  # 「你选了：…」，选完才显示
  $chosen = New-Text '' 11.5 '#C7CBD2' 'Normal' 'Segoe UI' 0
  $chosen.Margin = '0,8,0,0'
  $chosen.Visibility = 'Collapsed'
  $sp.Children.Add($chosen) | Out-Null

  $optWrap = New-Object System.Windows.Controls.StackPanel
  $optWrap.Margin = '0,6,0,0'
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($optWrap, 'ApprovalOptions')

  $yes = New-ChoiceCard '允许一次' '只放行这一次；下次遇到同样的操作还会再问' '推荐'
  $no = New-ChoiceCard '拒绝' '这一轮不再执行这条命令，模型要换个做法'
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($yes, 'ApprovalAllow')
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($no, 'ApprovalDeny')
  $optWrap.Children.Add($yes) | Out-Null
  $optWrap.Children.Add($no) | Out-Null
  $sp.Children.Add($optWrap) | Out-Null

  # 收起 / 展开选项
  $toggle = New-Object System.Windows.Controls.Button
  $toggle.Padding = '0'
  $toggle.Margin = '2,8,0,0'
  $toggle.HorizontalAlignment = 'Left'
  $toggle.Cursor = 'Hand'
  $toggle.Background = [System.Windows.Media.Brushes]::Transparent
  $toggle.BorderThickness = '0'
  $toggle.Foreground = (Brush '#7C838E')
  $toggle.FontSize = 11
  $toggle.Content = ([string][char]0x2304) + ' 收起选项'
  $toggle.Template = (New-FlatTemplate)
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($toggle, 'ApprovalToggle')
  $sp.Children.Add($toggle) | Out-Null

  # 卡片之间要互相引用，统一挂在一份哈希上（PS 5.1 的事件回调里拿不到外部变量，只能从 Tag 取）
  $ctx = @{ reqId = $reqId; options = $optWrap; toggle = $toggle; chosen = $chosen; yes = $yes; no = $no; done = $false }
  foreach ($b in @($yes, $no)) { $b.Tag.ctx = $ctx }
  $toggle.Tag = $ctx

  $yes.Add_Click({
    param($s, $ev)
    $c = $s.Tag.ctx
    if ($c.done) { return }
    $c.done = $true
    Send-Host @{ cmd = 'approve'; reqId = $c.reqId; decision = 'allowed-once' }
    $s.BorderBrush = (Brush '#4F7DF0')
    $s.Background = (Brush '#263450')
    $s.Tag.check.Visibility = 'Visible'
    $c.no.BorderBrush = (Brush '#1FFFFFFF')
    $c.no.IsEnabled = $false
    $c.chosen.Text = '你选了：允许一次'
    $c.chosen.Visibility = 'Visible'
    $c.options.Visibility = 'Collapsed'
    $c.toggle.Content = ([string][char]0x2304) + ' 展开选项'
  })
  $no.Add_Click({
    param($s, $ev)
    $c = $s.Tag.ctx
    if ($c.done) { return }
    $c.done = $true
    Send-Host @{ cmd = 'approve'; reqId = $c.reqId; decision = 'denied' }
    $s.BorderBrush = (Brush '#B45454')
    $s.Background = (Brush '#263450')
    $s.Tag.check.Visibility = 'Visible'
    $c.yes.BorderBrush = (Brush '#1FFFFFFF')
    $c.yes.IsEnabled = $false
    $c.chosen.Text = '你选了：拒绝'
    $c.chosen.Visibility = 'Visible'
    $c.options.Visibility = 'Collapsed'
    $c.toggle.Content = ([string][char]0x2304) + ' 展开选项'
  })
  $toggle.Add_Click({
    param($s, $ev)
    $c = $s.Tag
    if ([string]$c.options.Visibility -eq 'Collapsed') {
      $c.options.Visibility = 'Visible'
      $s.Content = ([string][char]0x2304) + ' 收起选项'
    } else {
      $c.options.Visibility = 'Collapsed'
      $s.Content = ([string][char]0x2304) + ' 展开选项'
    }
  })

  $card.Child = $sp
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($card, 'ApprovalCard')
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

# 会话行的右键菜单：重命名 / 移到分组 / 取消分组 / 删除
# 菜单项的 Tag 挂一份哈希表（id / title / group），回调从 $s.Tag 取——
# PS 5.1 下事件里的 GetNewClosure 拿不到外部变量
function New-SessionMenu([object]$box) {
  $cm = New-Object System.Windows.Controls.ContextMenu
  $cm.Background = (Brush '#14171D')
  $cm.Foreground = (Brush '#E6E8EE')
  $cm.BorderBrush = (Brush '#2A2F39')
  $cm.BorderThickness = '1'
  $cm.Template = (New-CtxTemplate)

  $mi = New-Object System.Windows.Controls.MenuItem
  $mi.Header = '重命名…'
  $mi.Foreground = (Brush '#E6E8EE')
  $mi.Background = [System.Windows.Media.Brushes]::Transparent
  $mi.Padding = '0'
  $mi.Template = (New-MenuItemTemplate)
  $mi.Tag = $box
  $mi.Add_Click({
    param($s, $e)
    $b = $s.Tag
    Show-Input -title ('重命名「' + $b.title + '」') -hint '留空＝恢复成用第一条消息当标题' -value ([string]$b.title) -okText '重命名' `
               -onOk { param($r) Send-Host @{ cmd = 'rename-session'; id = [string]$r.arg.id; title = [string]$r.text } } `
               -arg @{ id = [string]$b.id }
  })
  $cm.Items.Add($mi) | Out-Null

  $mg = New-Object System.Windows.Controls.MenuItem
  $mg.Header = '移到分组…'
  $mg.Foreground = (Brush '#E6E8EE')
  $mg.Background = [System.Windows.Media.Brushes]::Transparent
  $mg.Padding = '0'
  $mg.Template = (New-MenuItemTemplate)
  $mg.Tag = $box
  $mg.Add_Click({
    param($s, $e)
    $b = $s.Tag
    $hint = $(if (@($script:sessionGroups).Count -gt 0) {
      '已有分组：' + (@($script:sessionGroups) -join '、') + '。填新名字就是新建一个分组；留空＝移到未分组'
    } else { '填一个组名（比如项目名）；留空＝未分组' })
    Show-Input -title '移到分组' -hint $hint -value ([string]$b.group) -okText '移动' `
               -onOk { param($r) Send-Host @{ cmd = 'group-session'; id = [string]$r.arg.id; group = [string]$r.text } } `
               -arg @{ id = [string]$b.id }
  })
  $cm.Items.Add($mg) | Out-Null

  if ([string]$box.group) {
    $mu = New-Object System.Windows.Controls.MenuItem
    $mu.Header = '取消分组'
    $mu.Foreground = (Brush '#E6E8EE')
    $mu.Background = [System.Windows.Media.Brushes]::Transparent
    $mu.Padding = '0'
    $mu.Template = (New-MenuItemTemplate)
    $mu.Tag = $box
    $mu.Add_Click({ param($s, $e) Send-Host @{ cmd = 'group-session'; id = [string]$s.Tag.id; group = '' } })
    $cm.Items.Add($mu) | Out-Null
  }

  $md = New-Object System.Windows.Controls.MenuItem
  $md.Header = '删除会话…'
  $md.Foreground = (Brush '#E6E8EE')
  $md.Background = [System.Windows.Media.Brushes]::Transparent
  $md.Padding = '0'
  $md.Template = (New-MenuItemTemplate)
  $md.Tag = $box
  $md.Add_Click({
    param($s, $e)
    $b = $s.Tag
    Show-Confirm -title ('删除会话「' + $b.title + '」？') `
                 -text "会删掉它的会话日志和 checkpoint，不能恢复。会话里的附件文件也会一起删。" `
                 -yesText '删除' `
                 -onYes { param($targetId) Send-Host @{ cmd = 'delete-session'; id = $targetId } } `
                 -arg $b.id
  })
  $cm.Items.Add($md) | Out-Null

  return $cm
}

# 左栏一行会话：标题 + N 轮 · 时间，悬停露出 ×，右键出菜单
function New-SessionRow($it) {
  $row = New-Object System.Windows.Controls.Border
  $row.CornerRadius = '7'
  $row.Padding = '8,6'
  $row.Margin = '0,2,0,2'
  $row.Cursor = 'Hand'
  $sid = [string]$it.id
  $stitle = [string]$it.title
  $selected = ($sid -eq [string]$script:sessionId)
  $row.Background = $(if ($selected) { Brush '#263450' } else { [System.Windows.Media.Brushes]::Transparent })

  $grid = New-Object System.Windows.Controls.Grid
  $c1 = New-Object System.Windows.Controls.ColumnDefinition
  $c1.Width = New-Object System.Windows.GridLength 1, ([System.Windows.GridUnitType]::Star)
  $c2 = New-Object System.Windows.Controls.ColumnDefinition
  $c2.Width = [System.Windows.GridLength]::Auto
  $grid.ColumnDefinitions.Add($c1)
  $grid.ColumnDefinitions.Add($c2)

  $sp = New-Object System.Windows.Controls.StackPanel
  $t = New-Text $stitle 12 '#E6E8EE' 'Normal' 'Segoe UI' 2
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($t, 'SessionTitle')
  $t.TextTrimming = 'CharacterEllipsis'
  $t.TextWrapping = 'NoWrap'
  $sp.Children.Add($t) | Out-Null
  $meta = New-Text "$($it.turns) 轮 · $(Format-Ago $it.updatedAt)" 10 '#6B7280' 'Normal' 'Segoe UI' 0
  $sp.Children.Add($meta) | Out-Null
  [System.Windows.Controls.Grid]::SetColumn($sp, 0)
  $grid.Children.Add($sp) | Out-Null

  # 删除按钮：平时藏着，鼠标移到这一行才露出来
  $del = New-Object System.Windows.Controls.Button
  # 删除用垃圾桶图标（Segoe MDL2 Assets 的 E74D），不用字符 ×——在深色界面上太像关窗口
  $del.Content = [string][char]0xE74D
  $del.FontFamily = (New-Object System.Windows.Media.FontFamily('Segoe MDL2 Assets'))
  $del.FontSize = 12
  $del.Width = 22
  $del.Height = 22
  $del.Padding = '0'
  $del.Cursor = 'Hand'
  $del.Background = [System.Windows.Media.Brushes]::Transparent
  $del.Foreground = (Brush '#6B7280')
  $del.BorderThickness = '0'
  # 自绘模板：系统 Button 一悬停就是浅色底，深色行上一块白方块很跳
  $del.Template = (New-FlatTemplate)
  $del.VerticalAlignment = 'Center'
  $del.Visibility = 'Hidden'
  $del.ToolTip = '删除这个会话'
  [System.Windows.Controls.Grid]::SetColumn($del, 1)
  $grid.Children.Add($del) | Out-Null

  $row.Tag = @{ id = $sid; title = $stitle; group = ([string]$it.group); del = $del }
  $del.Tag = $row.Tag
  $del.Add_Click({
    param($s, $ev)
    $ev.Handled = $true
    Show-Confirm -title ('删除会话「' + $s.Tag.title + '」？') `
                 -text "会删掉它的会话日志和 checkpoint，不能恢复。会话里的附件文件也会一起删。" `
                 -yesText '删除' `
                 -onYes { param($targetId) Send-Host @{ cmd = 'delete-session'; id = $targetId } } `
                 -arg $s.Tag.id
  })
  $del.Add_MouseEnter({ param($s, $e) $s.Foreground = (Brush '#F87171') })
  $del.Add_MouseLeave({ param($s, $e) $s.Foreground = (Brush '#6B7280') })

  $row.Child = $grid
  $row.ContextMenu = (New-SessionMenu $row.Tag)

  $row.Add_MouseLeftButtonUp({
    param($s, $e)
    Send-Host @{ cmd = 'load-session'; id = [string]$s.Tag.id }
  })
  $row.Add_MouseEnter({
    param($s, $e)
    $s.Background = (Brush '#1B2029')
    $s.Tag.del.Visibility = 'Visible'
  })
  $row.Add_MouseLeave({
    param($s, $e)
    $s.Tag.del.Visibility = 'Hidden'
    if ($s.Tag.id -eq [string]$script:sessionId) { $s.Background = (Brush '#263450') }
    else { $s.Background = [System.Windows.Media.Brushes]::Transparent }
  })
  return $row
}

# 组名 → 是否收起（只在这次运行里记，不落盘）
$script:groupCollapsed = @{}
# 现有的分组名：右键「移到分组」时当提示
$script:sessionGroups = @()

function Toggle-SessionGroup($t) {
  $now = -not [bool]$script:groupCollapsed[$t.key]
  $script:groupCollapsed[$t.key] = $now
  $t.panel.Visibility = $(if ($now) { 'Collapsed' } else { 'Visible' })
  $t.chevron.Text = $(if ($now) { '▸' } else { '▾' })
  Log ("组头切换：'" + [string]$t.key + "' → " + $(if ($now) { '收起' } else { '展开' }))
}

function Set-Sessions($items) {
  # 记一份标题：左栏宽度上限按「最长的那个标题能不能完整显示」来定
  $script:sideTitles = @()
  if ($items) { $script:sideTitles = @($items | ForEach-Object { [string]$_.title }) }
  $SessionList.Children.Clear()
  if (-not $items -or $items.Count -eq 0) {
    $empty = New-Text '还没有会话' 11 '#5B626D' 'Normal' 'Segoe UI' 0
    $empty.Margin = '8,4,0,0'
    $SessionList.Children.Add($empty) | Out-Null
    Update-SideFit
    return
  }
  # 按组分：有组的按名字排，没组的放最后。host 已经按 updatedAt 倒序给过，组内不再重排
  $buckets = [ordered]@{}
  foreach ($it in $items) {
    $g = ([string]$it.group).Trim()
    if (-not $buckets.Contains($g)) { $buckets[$g] = New-Object System.Collections.ArrayList }
    $buckets[$g].Add($it) | Out-Null
  }
  $script:sessionGroups = @($buckets.Keys | Where-Object { $_ -ne '' } | Sort-Object)
  $names = @($script:sessionGroups) + ''
  foreach ($g in $names) {
    if (-not $buckets.Contains($g)) { continue }
    $rows = $buckets[$g]
    $panel = New-Object System.Windows.Controls.StackPanel
    foreach ($it in $rows) { $panel.Children.Add((New-SessionRow $it)) | Out-Null }
    # 一个分组都没有时不显示「未分组」这个头，跟以前一样平铺
    if ($g -ne '' -or $script:sessionGroups.Count -gt 0) {
      $label = $(if ($g) { $g } else { '未分组' })
      $collapsed = [bool]$script:groupCollapsed[$g]
      # 组头用 Button 而不是 Border：Button 有 AutomationPeer，UIA 能直接 Invoke，
      # 圆角/悬停交给 New-FlatTemplate（和底部模型按钮同一套）
      $head = New-Object System.Windows.Controls.Button
      $head.Padding = '8,3'
      $head.Margin = '0,6,0,2'
      $head.Cursor = 'Hand'
      $head.HorizontalContentAlignment = 'Left'
      $head.Background = [System.Windows.Media.Brushes]::Transparent
      $head.BorderThickness = '0'
      $head.Template = (New-FlatTemplate)
      $head.ToolTip = '点击收起 / 展开这个分组'
      [System.Windows.Automation.AutomationProperties]::SetAutomationId($head, 'SessionGroupHead')
      # Button 的 Content 是个 StackPanel，UIA 取不到 Name；显式给一个（验证脚本靠它认组）
      [System.Windows.Automation.AutomationProperties]::SetName($head, $label)
      $hline = New-Object System.Windows.Controls.StackPanel
      $hline.Orientation = 'Horizontal'
      $ch = New-Text $(if ($collapsed) { '▸' } else { '▾' }) 9.5 '#6B7280' 'Normal' 'Segoe UI' 0
      $ch.VerticalAlignment = 'Center'
      $nm = New-Text $label 10.5 '#8A91A0' 'SemiBold' 'Segoe UI' 0
      [System.Windows.Automation.AutomationProperties]::SetAutomationId($nm, 'SessionGroupName')
      $nm.Margin = '5,0,0,0'
      $nm.TextTrimming = 'CharacterEllipsis'
      $nm.VerticalAlignment = 'Center'
      $cnt = New-Text ([string]$rows.Count) 9.5 '#4B5158' 'Normal' 'Segoe UI' 0
      $cnt.Margin = '6,0,0,0'
      $cnt.VerticalAlignment = 'Center'
      $hline.Children.Add($ch) | Out-Null
      $hline.Children.Add($nm) | Out-Null
      $hline.Children.Add($cnt) | Out-Null
      $head.Content = $hline
      $head.Tag = @{ key = $g; panel = $panel; chevron = $ch }
      $head.Add_Click({ param($s, $e) Toggle-SessionGroup $s.Tag })
      $SessionList.Children.Add($head) | Out-Null
      $panel.Visibility = $(if ($collapsed) { 'Collapsed' } else { 'Visible' })
    }
    $SessionList.Children.Add($panel) | Out-Null
  }
  # 标题变了：重新量一次左栏该有多宽（撑不下就放宽上限，全都装得下就收紧）
  Update-SideFit
}

function Clear-Transcript {
  $Transcript.Children.Clear()
  $script:currentAssistant = $null
  $script:pendingText.Clear() | Out-Null
  $script:reasonNode = $null
  $script:toolRows = @{}
  $script:toolGroup = $null
  $script:assistantBox = $null
  $script:copyLog.Clear() | Out-Null
  $script:memoryCards = New-Object System.Collections.ArrayList
  $script:msgLog = New-Object System.Collections.ArrayList
  $script:quoteRefs = New-Object System.Collections.ArrayList
  if ($AttachList) { Update-AttachList }
$script:verifyRows = @{}
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
    $b.Tag = [string]$ex
    $b.Template = (New-FlatTemplate)
    $b.Add_Click({ param($s, $e) Start-Turn ([string]$s.Tag) })
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
$script:verifyRows = @{}
$script:tickSeen = $false
$script:modelName = $Model
$script:modelChoices = @()
$script:cwdPath = ''
$script:modelPopup = $null
$script:flatTpl = $null
$script:fetching = $false
$script:sessionId = ''
$script:hostGone = $false
$script:history = New-Object System.Collections.ArrayList
$script:historyIdx = 0
$script:cfgBaseURL = ''
$script:cfgKeyMasked = ''
$script:verifyCmd = ''
$script:visionOn = $false
$script:logsDir = ''
$script:hasKey = $true

# ---------------------------------------------------------------- 确认框
# 为什么不用 MessageBox：它画的是系统白底，和这套深色界面完全不搭（用户原话：样式不统一）。
# 这里是窗口内的浮层，回调式：点"删除"才执行，点取消什么也不做。
$script:confirmRun = $null

function Show-Confirm {
  # $arg 是给回调的实参：不靠 GetNewClosure 隐式捕获，PowerShell 5.1 下那个写法不可靠
  # （见下面删除按钮处的注释）
  param([string]$title, [string]$text, [string]$yesText = '确定', [scriptblock]$onYes, [object]$arg)
  $ConfirmTitle.Text = $title
  $ConfirmText.Text = $text
  $ConfirmYes.Content = $yesText
  $script:confirmRun = $onYes
  $script:confirmArg = $arg
  $ConfirmOverlay.Visibility = 'Visible'
  $ConfirmYes.Focus() | Out-Null
}

function Hide-Confirm {
  $ConfirmOverlay.Visibility = 'Collapsed'
  $script:confirmRun = $null
  $script:confirmArg = $null
}

$ConfirmNo.Add_Click({ Hide-Confirm })
$ConfirmYes.Add_Click({
  $run = $script:confirmRun
  $arg = $script:confirmArg
  Hide-Confirm
  if ($run) { & $run $arg }
})

# ---------------------------------------------------------------- 单行输入（重命名 / 分组）
# 和确认框同一套深色浮层：不用 Microsoft.VisualBasic 的 InputBox（白底系统框，样式不统一）
$script:inputRun = $null
$script:inputArg = $null

# 回调参数：$r.arg 是调用方给的上下文，$r.text 是用户输入（已 Trim）
function Show-Input {
  param([string]$title, [string]$hint = '', [string]$value = '', [string]$okText = '确定', [scriptblock]$onOk, [object]$arg)
  $InputTitle.Text = $title
  $InputHint.Text = $hint
  $InputHint.Visibility = $(if ($hint) { 'Visible' } else { 'Collapsed' })
  $InputField.Text = $value
  $InputYes.Content = $okText
  $script:inputRun = $onOk
  $script:inputArg = $arg
  $InputOverlay.Visibility = 'Visible'
  $InputField.Focus() | Out-Null
  $InputField.SelectAll()
}

function Hide-Input {
  $InputOverlay.Visibility = 'Collapsed'
  $script:inputRun = $null
  $script:inputArg = $null
}

function Submit-Input {
  $run = $script:inputRun
  $r = @{ arg = $script:inputArg; text = ([string]$InputField.Text).Trim() }
  Hide-Input
  if ($run) { & $run $r }
}

$InputNo.Add_Click({ Hide-Input })
$InputYes.Add_Click({ Submit-Input })
$InputField.Add_PreviewKeyDown({
  param($s, $e)
  if ($e.Key -eq [System.Windows.Input.Key]::Return) { $e.Handled = $true; Submit-Input }
  elseif ($e.Key -eq [System.Windows.Input.Key]::Escape) { $e.Handled = $true; Hide-Input }
})
$InputOverlay.Add_MouseLeftButtonUp({
  param($s, $e)
  # 点浮层的空白处 = 取消（点在卡片上时 OriginalSource 不是浮层本身）
  if ([object]::ReferenceEquals($e.OriginalSource, $InputOverlay)) { Hide-Input }
})

# ---------------------------------------------------------------- 附件
$script:attachFiles = New-Object System.Collections.ArrayList
# 本会话的消息记录：给「插入对话」用，引用的就是这里的一条
$script:msgLog = New-Object System.Collections.ArrayList
# 输入框上方挂着的引用（@{ idx; role; text }），发送时把 text 一起带给模型
$script:quoteRefs = New-Object System.Collections.ArrayList
$script:quotePopup = $null

function Format-FileSize([double]$n) {
  if ($n -lt 1024) { return "$([int]$n) B" }
  if ($n -lt 1048576) { return "$([math]::Round($n / 1024)) KB" }
  return "$([math]::Round($n / 1048576, 1)) MB"
}

# ---------------- 图片预览 ----------------
function Show-ImagePreview([string]$path) {
  if (-not $path) { return }
  try {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $ms = [System.IO.MemoryStream]::new($bytes)
    $bi = New-Object System.Windows.Media.Imaging.BitmapImage
    $bi.BeginInit()
    $bi.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bi.StreamSource = $ms
    $bi.EndInit()
    $PreviewImage.Source = $bi
    # 按窗口现尺寸算最大边，别让图顶到标题栏或两边
    $PreviewImage.MaxWidth = [math]::Max(320, $window.ActualWidth - 40)
    $PreviewImage.MaxHeight = [math]::Max(240, $window.ActualHeight - 120)
    $PreviewName.Text = ('{0}  ·  {1} × {2}  ·  {3}' -f [System.IO.Path]::GetFileName($path), $bi.PixelWidth, $bi.PixelHeight, (Format-FileSize ([int64]$bytes.Length)))
    $ImagePreview.Visibility = 'Visible'
  } catch {
    Log ('预览失败（' + $path + '）: ' + ($_ | Out-String))
    Add-SystemLine ('打不开这张图：' + [System.IO.Path]::GetFileName($path)) '#F87171'
  }
}

function Hide-ImagePreview {
  $ImagePreview.Visibility = 'Collapsed'
  $PreviewImage.Source = $null
}

# ---------------- 模型切换（底部那颗按钮 + 弹出菜单） ----------------
function Update-ModelPill([string]$name) {
  $t = $name
  if (-not $t) { $t = '模型' }
  $short = $t
  if ($short.Length -gt 26) { $short = $short.Substring(0, 25) + '…' }
  $ModelPill.Content = $short
  $ModelPill.ToolTip = $(if ($name) { '当前模型：' + $name + '（点一下切换）' } else { '切换模型' })
}

# 工作目录按钮：只放最后两段目录名，完整路径放 ToolTip（中间那条工具栏位置有限）
function Update-CwdPill([string]$path) {
  $script:cwdPath = [string]$path
  $label = '目录'
  if ($path) {
    $trimmed = ([string]$path).TrimEnd([char]92, [char]47)
    $leaf = [System.IO.Path]::GetFileName($trimmed)
    if (-not $leaf) { $leaf = $trimmed }
    $parent = [System.IO.Path]::GetFileName([System.IO.Path]::GetDirectoryName($trimmed))
    $label = $(if ($parent) { [System.IO.Path]::Combine($parent, $leaf) } else { $leaf })
    if ($label.Length -gt 26) { $label = '…' + $label.Substring($label.Length - 25) }
  }
  $PickFolderBtn.Content = $label
  $PickFolderBtn.ToolTip = $(if ($path) { '工作目录：' + $path + '（点一下换）' } else { '选择工作目录' })
}

# 下拉菜单自己画：ContextMenu 的 MenuItem 是系统模板（白底、蓝高亮），深色界面上太跳
function New-FlatTemplate {
  if ($script:flatTpl) { return $script:flatTpl }
  $xaml = @'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="Button">
  <Border x:Name="bd" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="6" Padding="{TemplateBinding Padding}">
    <ContentPresenter HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}" VerticalAlignment="Center"/>
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="IsMouseOver" Value="True">
      <Setter TargetName="bd" Property="Background" Value="#1B2029"/>
    </Trigger>
    <Trigger Property="IsPressed" Value="True">
      <Setter TargetName="bd" Property="Background" Value="#2C333F"/>
    </Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
'@
  $script:flatTpl = [System.Windows.Markup.XamlReader]::Parse($xaml)
  return $script:flatTpl
}

# 选中态专用模板：悬停 / 按下都保持蓝底，不被灰色 hover 盖掉选中感
function New-SelTemplate {
  if ($script:selTpl) { return $script:selTpl }
  $xaml = @'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="Button">
  <Border x:Name="bd" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="6" Padding="{TemplateBinding Padding}">
    <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="IsMouseOver" Value="True">
      <Setter TargetName="bd" Property="Background" Value="#2E3D5C"/>
    </Trigger>
    <Trigger Property="IsPressed" Value="True">
      <Setter TargetName="bd" Property="Background" Value="#35466B"/>
    </Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
'@
  $script:selTpl = [System.Windows.Markup.XamlReader]::Parse($xaml)
  return $script:selTpl
}

# 发送键：蓝色实心，悬停亮一点、禁用变暗蓝，同样不走系统模板
function New-SendTemplate {
  if ($script:sendTpl) { return $script:sendTpl }
  $xaml = @'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="Button">
  <Border x:Name="bd" Background="{TemplateBinding Background}" CornerRadius="6" Padding="{TemplateBinding Padding}">
    <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="IsMouseOver" Value="True">
      <Setter TargetName="bd" Property="Background" Value="#3D6CFF"/>
    </Trigger>
    <Trigger Property="IsPressed" Value="True">
      <Setter TargetName="bd" Property="Background" Value="#2450E0"/>
    </Trigger>
    <Trigger Property="IsEnabled" Value="False">
      <Setter TargetName="bd" Property="Background" Value="#2F3A5C"/>
    </Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
'@
  $script:sendTpl = [System.Windows.Markup.XamlReader]::Parse($xaml)
  return $script:sendTpl
}

# 危险操作（删除/确认删）：红底按钮，悬停亮一点；不走系统模板，避免悬停变白底
function New-DangerTemplate {
  if ($script:dangerTpl) { return $script:dangerTpl }
  $xaml = @'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="Button">
  <Border x:Name="bd" Background="{TemplateBinding Background}" CornerRadius="6" Padding="{TemplateBinding Padding}">
    <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="IsMouseOver" Value="True">
      <Setter TargetName="bd" Property="Background" Value="#FF8A8A"/>
    </Trigger>
    <Trigger Property="IsPressed" Value="True">
      <Setter TargetName="bd" Property="Background" Value="#E05A5A"/>
    </Trigger>
    <Trigger Property="IsEnabled" Value="False">
      <Setter TargetName="bd" Property="Background" Value="#5A3A3E"/>
    </Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
'@
  $script:dangerTpl = [System.Windows.Markup.XamlReader]::Parse($xaml)
  return $script:dangerTpl
}

# 底栏、左栏的按钮统一自绘：系统模板一悬停就是浅灰/白底，跟深色界面对不上
$ModelPill.Template = (New-FlatTemplate)
$ModeRead.Template = (New-FlatTemplate)
$ModeGuard.Template = (New-FlatTemplate)
$ModeFull.Template = (New-FlatTemplate)
$AttachBtn.Template = (New-FlatTemplate)
$InsertConvBtn.Template = (New-FlatTemplate)
$PickFolderBtn.Template = (New-FlatTemplate)
$StopBtn.Template = (New-FlatTemplate)
$NewChatBtn.Template = (New-FlatTemplate)
$SettingsBtn.Template = (New-FlatTemplate)
$SendBtn.Template = (New-SendTemplate)
# 设置面板、确认框、预览、输入浮层里的按钮也要同一套，不然一悬停就冒浅色块
$CfgFetch.Template = (New-FlatTemplate)
$CfgOpenLogs.Template = (New-FlatTemplate)
$CfgCancel.Template = (New-FlatTemplate)
$ConfirmNo.Template = (New-FlatTemplate)
$InputNo.Template = (New-FlatTemplate)
$PreviewClose.Template = (New-FlatTemplate)
$CfgSave.Template = (New-SendTemplate)
$InputYes.Template = (New-SendTemplate)
$ConfirmYes.Template = (New-DangerTemplate)

function New-MenuRow([string]$text, [string]$mark) {
  $b = New-Object System.Windows.Controls.Button
  $b.Padding = '10,7'
  $b.HorizontalContentAlignment = 'Left'
  $b.Cursor = 'Hand'
  $b.FontSize = 11.5
  $b.FontFamily = 'Cascadia Mono, Consolas'
  $b.Foreground = (Brush '#CFD3D6')
  $b.Background = [System.Windows.Media.Brushes]::Transparent
  $b.BorderThickness = '0'
  $b.Template = (New-FlatTemplate)
  $inner = New-Object System.Windows.Controls.DockPanel
  $mk = New-Object System.Windows.Controls.TextBlock
  $mk.Text = $mark
  $mk.Width = 16
  $mk.Foreground = (Brush '#8AB4FF')
  $mk.FontFamily = 'Segoe UI'
  $mk.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($mk, 'Left')
  $inner.Children.Add($mk) | Out-Null
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Text = $text
  $tb.TextTrimming = 'CharacterEllipsis'
  $tb.TextWrapping = 'NoWrap'
  $tb.VerticalAlignment = 'Center'
  $inner.Children.Add($tb) | Out-Null
  $b.Content = $inner
  return $b
}

function Show-ModelMenu([object]$anchor) {
  if ($script:modelPopup) { $script:modelPopup.IsOpen = $false }
  $box = New-Object System.Windows.Controls.Border
  $box.Background = (Brush '#1B1F27')
  $box.BorderBrush = (Brush '#33FFFFFF')
  $box.BorderThickness = '1'
  $box.CornerRadius = '8'
  $box.Padding = '4'
  $box.MinWidth = 240
  $box.MaxWidth = 460
  $col = New-Object System.Windows.Controls.StackPanel

  $list = @($script:modelChoices)
  if ($list.Count -eq 0 -and $script:modelName) { $list = @($script:modelName) }
  foreach ($m in $list) {
    $isCur = ([string]$m -eq [string]$script:modelName)
    $row = New-MenuRow ([string]$m) $(if ($isCur) { '✓' } else { '' })
    $row.Tag = [string]$m
    $row.Add_Click({
      param($s, $e)
      if ($script:modelPopup) { $script:modelPopup.IsOpen = $false }
      Send-Host @{ cmd = 'model'; model = [string]$s.Tag }
    })
    $col.Children.Add($row) | Out-Null
  }
  if ($list.Count -eq 0) {
    $col.Children.Add((New-MenuRow '还没有模型列表，先去设置里拉一次' '')) | Out-Null
  }

  $sep = New-Object System.Windows.Controls.Border
  $sep.Height = '1'
  $sep.Margin = '6,4,6,4'
  $sep.Background = (Brush '#1FFFFFFF')
  $col.Children.Add($sep) | Out-Null

  $cfg = New-MenuRow '在设置里换端点 / 拉取模型…' ''
  $cfg.Foreground = (Brush '#8AB4FF')
  $cfg.FontFamily = 'Segoe UI'
  $cfg.Add_Click({
    if ($script:modelPopup) { $script:modelPopup.IsOpen = $false }
    Open-Settings
  })
  $col.Children.Add($cfg) | Out-Null

  $box.Child = $col
  $pop = New-Object System.Windows.Controls.Primitives.Popup
  $pop.PlacementTarget = $anchor
  $pop.Placement = [System.Windows.Controls.Primitives.PlacementMode]::Top
  $pop.VerticalOffset = -6
  $pop.StaysOpen = $false
  $pop.AllowsTransparency = $true
  $pop.Child = $box
  $script:modelPopup = $pop
  $pop.IsOpen = $true
}

# ---------------------------------------------------------------- 插入对话
# 把本会话之前的某条消息作为引用挂到输入框上方；发送时那段原文拼在问题前面带给模型。
# 用 Popup 自绘（系统菜单是白底），行和模型菜单同一套 MenuRow。
function Show-QuotePicker([object]$anchor) {
  if ($script:quotePopup) { $script:quotePopup.IsOpen = $false }
  $box = New-Object System.Windows.Controls.Border
  $box.Background = (Brush '#1B1F27')
  $box.BorderBrush = (Brush '#33FFFFFF')
  $box.BorderThickness = '1'
  $box.CornerRadius = '8'
  $box.Padding = '4'
  $box.MinWidth = 380
  $box.MaxWidth = 620
  $col = New-Object System.Windows.Controls.StackPanel
  $n = $script:msgLog.Count
  if ($n -eq 0) {
    $col.Children.Add((New-MenuRow '这个会话还没有消息可以引用' '')) | Out-Null
  } else {
    $from = [Math]::Max(0, $n - 40)
    for ($i = $n - 1; $i -ge $from; $i--) {
      $m = $script:msgLog[$i]
      $who = $(if ($m.role -eq 'user') { '你' } else { '模型' })
      $snip = ([string]$m.text) -replace "\s+", ' '
      if ($snip.Length -gt 56) { $snip = $snip.Substring(0, 56) + '…' }
      if (-not $snip) { $snip = '(只有附件)' }
      $row = New-MenuRow "$who · $snip" ''
      $row.FontFamily = 'Segoe UI'
      $row.Tag = $i
      $row.Add_Click({
        param($s, $e)
        if ($script:quotePopup) { $script:quotePopup.IsOpen = $false }
        $ix = [int]$s.Tag
        foreach ($q in $script:quoteRefs) { if ($q.idx -eq $ix) { return } }
        $mm = $script:msgLog[$ix]
        if (-not $mm) { return }
        [void]$script:quoteRefs.Add(@{ idx = $ix; role = [string]$mm.role; text = [string]$mm.text })
        Update-AttachList
      })
      $col.Children.Add($row) | Out-Null
    }
  }
  $sc = New-Object System.Windows.Controls.ScrollViewer
  $sc.MaxHeight = 320
  $sc.VerticalScrollBarVisibility = 'Auto'
  $sc.Content = $col
  $box.Child = $sc
  $pop = New-Object System.Windows.Controls.Primitives.Popup
  $pop.PlacementTarget = $anchor
  $pop.Placement = [System.Windows.Controls.Primitives.PlacementMode]::Top
  $pop.VerticalOffset = -6
  $pop.StaysOpen = $false
  $pop.AllowsTransparency = $true
  $pop.Child = $box
  $script:quotePopup = $pop
  $pop.IsOpen = $true
}

# 扩展名判断图片：和 src/core/attach.ts 里的 IMAGE_EXT 对齐
function Test-ImagePath([string]$path) {
  $ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
  return @('.png', '.jpg', '.jpeg', '.webp', '.gif') -contains $ext
}

# 缩略图：DecodePixelHeight 只解到 168px 高，几百 MB 的截图也不会把整张读进内存。
# 坑：必须先设 CacheOption=OnLoad 再给 StreamSource，EndInit 时才会真的解码；
# 顺序反过来（先给流、再设 OnLoad）会变成延迟解码，流一关就解不出来，
# 最后 Image 的宽是 0——附件条上只剩文件名，缩略图根本不显示（实测）。
# 用 MemoryStream 而非 FileStream：不占文件句柄，用户的原图随时能删能改。
function New-ImageThumb([string]$path, [double]$h = 40) {
  try {
    $ms = [System.IO.MemoryStream]::new([System.IO.File]::ReadAllBytes($path))
    $bi = New-Object System.Windows.Media.Imaging.BitmapImage
    $bi.BeginInit()
    $bi.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bi.DecodePixelHeight = 168
    $bi.StreamSource = $ms
    $bi.EndInit()
    $img = New-Object System.Windows.Controls.Image
    $img.Source = $bi
    $img.Height = $h
    $img.MaxWidth = 140
    $img.Stretch = 'Uniform'
    # 缩略图包一层无边框按钮：Image 本身不参与 UIA 的 Invoke，包成按钮既好点也好测
    $btn = New-Object System.Windows.Controls.Button
    $btn.Content = $img
    # 缩略图外面套一圈浅色边框：粘的是深色界面截图时，缩略图本身也是深色的，
    # 没有边框就和附件条底色糊成一片，看起来像“根本没生成缩略图”（用户实测踩过）
    $btn.Padding = '3'
    $btn.Margin = '0,0,7,0'
    $btn.Template = (New-FlatTemplate)
    $btn.BorderThickness = '1'
    $btn.BorderBrush = (Brush '#6B7484')
    $btn.Background = (Brush '#343C48')
    $btn.VerticalAlignment = 'Center'
    $btn.Cursor = 'Hand'
    $btn.ToolTip = '点开看大图'
    $btn.Tag = $path
    $btn.Add_Click({
      param($s, $e)
      $e.Handled = $true
      Show-ImagePreview ([string]$s.Tag)
    })
    return $btn
  } catch {
    Log ("缩略图生成失败（$path）: " + ($_ | Out-String))
    return $null
  }
}

function Update-AttachList {
  $AttachList.Children.Clear()
  $hasQuote = ($script:quoteRefs.Count -gt 0)
  if ($script:attachFiles.Count -eq 0 -and -not $hasQuote) {
    $AttachList.Visibility = 'Collapsed'
    return
  }
  $AttachList.Visibility = 'Visible'
  # 引用卡排在附件前面：一眼能看出这条消息带了哪几段旧对话
  foreach ($r in @($script:quoteRefs)) {
    $qb = New-Object System.Windows.Controls.Border
    $qb.Background = (Brush '#1B2433')
    $qb.BorderBrush = (Brush '#3D6CFF')
    $qb.BorderThickness = '1'
    $qb.CornerRadius = '6'
    $qb.Padding = '6,4,5,4'
    $qb.Margin = '0,0,6,6'
    $qsp = New-Object System.Windows.Controls.StackPanel
    $qsp.Orientation = 'Horizontal'
    $qtxt = New-Object System.Windows.Controls.StackPanel
    $qtxt.VerticalAlignment = 'Center'
    $whoTb = New-Text ("引用 · " + $(if ($r.role -eq 'user') { '你' } else { '模型' })) 9.5 '#8AB4FF' 'SemiBold' 'Segoe UI' 1
    $qtxt.Children.Add($whoTb) | Out-Null
    $snip = ([string]$r.text) -replace "\s+", ' '
    if ($snip.Length -gt 40) { $snip = $snip.Substring(0, 40) + '…' }
    if (-not $snip) { $snip = '(空)' }
    $sTb = New-Text $snip 10.5 '#CFD3D6' 'Normal' 'Segoe UI' 0
    $sTb.MaxWidth = 220
    $sTb.TextTrimming = 'CharacterEllipsis'
    $sTb.TextWrapping = 'NoWrap'
    $qtxt.Children.Add($sTb) | Out-Null
    $qsp.Children.Add($qtxt) | Out-Null
    $qx = New-Object System.Windows.Controls.Button
    # 去掉引用用垃圾桶图标，和附件移除一致
    $qx.Content = [string][char]0xE74D
    $qx.FontFamily = (New-Object System.Windows.Media.FontFamily('Segoe MDL2 Assets'))
    $qx.Width = 16
    $qx.Height = 16
    $qx.Margin = '6,0,0,0'
    $qx.FontSize = 10.5
    $qx.Cursor = 'Hand'
    $qx.BorderThickness = '0'
    $qx.Template = (New-FlatTemplate)
    $qx.Background = [System.Windows.Media.Brushes]::Transparent
    $qx.Foreground = (Brush '#7C838E')
    $qx.VerticalAlignment = 'Center'
    $qx.ToolTip = '取消引用'
    $qx.Tag = $r
    $qx.Add_Click({
      param($s, $e)
      # 按对象本身删：同一条消息可能先删后加，按 idx 比对会误删新挂的那条
      $t = $s.Tag
      for ($i = $script:quoteRefs.Count - 1; $i -ge 0; $i--) {
        if ([object]::ReferenceEquals($script:quoteRefs[$i], $t)) { $script:quoteRefs.RemoveAt($i) }
      }
      Update-AttachList
    })
    $qsp.Children.Add($qx) | Out-Null
    $qb.Child = $qsp
    $AttachList.Children.Add($qb) | Out-Null
  }
  foreach ($f in @($script:attachFiles)) {
    $size = 0
    try { $size = (Get-Item -LiteralPath $f -ErrorAction Stop).Length } catch { }
    $b = New-Object System.Windows.Controls.Border
    $b.Background = (Brush '#1F242C')
    $b.BorderBrush = (Brush '#1FFFFFFF')
    $b.BorderThickness = '1'
    $b.CornerRadius = '6'
    $b.Padding = '6,4,5,4'
    $b.Margin = '0,0,6,6'
    $sp = New-Object System.Windows.Controls.StackPanel
    $sp.Orientation = 'Horizontal'
    # 图片给缩略图：粘完截图要能一眼看出贴的是哪张，只给个文件名等于没预览
    if (Test-ImagePath $f) {
      $thumb = New-ImageThumb $f 56
      if ($thumb) { $sp.Children.Add($thumb) | Out-Null }
    }
    $txt = New-Object System.Windows.Controls.StackPanel
    $txt.VerticalAlignment = 'Center'
    $name = [System.IO.Path]::GetFileName($f)
    $nameTb = New-Text $name 10.5 '#CFD3D6' 'Normal' 'Segoe UI' 0
    $nameTb.MaxWidth = 200
    $nameTb.TextTrimming = 'CharacterEllipsis'
    $nameTb.TextWrapping = 'NoWrap'
    $txt.Children.Add($nameTb) | Out-Null
    $txt.Children.Add((New-Text (Format-FileSize $size) 9.5 '#7C838E' 'Normal' 'Segoe UI' 1)) | Out-Null
    $sp.Children.Add($txt) | Out-Null
    $x = New-Object System.Windows.Controls.Button
    # 移除也是这样：垃圾桶图标，不用字符 ×
    $x.Content = [string][char]0xE74D
    $x.FontFamily = (New-Object System.Windows.Media.FontFamily('Segoe MDL2 Assets'))
    $x.Width = 16
    $x.Height = 16
    $x.Margin = '6,0,0,0'
    $x.FontSize = 10.5
    $x.Cursor = 'Hand'
    $x.BorderThickness = '0'
    $x.Template = (New-FlatTemplate)
    $x.Background = [System.Windows.Media.Brushes]::Transparent
    $x.Foreground = (Brush '#7C838E')
    $x.VerticalAlignment = 'Center'
    $x.ToolTip = '移除'
    # 路径挂在按钮自己的 Tag 上：PS 5.1 下这里用 GetNewClosure 拿到的 $f 是 null，
    # 点 × 就抛「不能对 Null 值表达式调用方法」把整个窗口带崩（实测）
    $x.Tag = $f
    $x.Add_Click({
      param($s, $e)
      [void]$script:attachFiles.Remove([string]$s.Tag)
      Update-AttachList
    })
    $sp.Children.Add($x) | Out-Null
    $b.Child = $sp
    $AttachList.Children.Add($b) | Out-Null
  }
}

function Add-Attachments([object]$paths) {
  foreach ($p in @($paths)) {
    $path = [string]$p
    if (-not $path) { continue }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    if ($script:attachFiles -contains $path) { continue }
    $script:attachFiles.Add($path) | Out-Null
  }
  Update-AttachList
}

$AttachBtn.Add_Click({
  $dlg = New-Object Microsoft.Win32.OpenFileDialog
  $dlg.Multiselect = $true
  $dlg.Title = '选择要发给模型的文件'
  $dlg.Filter = '所有文件 (*.*)|*.*'
  if ($dlg.ShowDialog()) { Add-Attachments $dlg.FileNames }
})

# 插入对话：从本会话已经发过/收到的消息里挑一条，作为引用挂到输入框上方
$InsertConvBtn.Add_Click({
  param($s, $e)
  Show-QuotePicker $s
})

# 粘贴：Clipboard 里是图片或文件时收成附件。
# WPF 的 TextBox 只认文本格式，截图/文件在它眼里“没东西可粘”——Ctrl+V 毫无反应，也不报错。
# 所以自己在 PreviewKeyDown 里看一眼剪贴板，当成附件收下，再吃掉这次按键。
# 剪贴板位图落盘：CF_DIB 里的 alpha 字节常常是 0（截屏工具不填），原样编码就是全透明 PNG，
# 缩略图/预览看着一片白，发给模型的也是白板。这里把 alpha 统一补成 255，RGB 原样保留。
if (-not ('PLClipImage' -as [type])) {
  Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
  Add-Type -ReferencedAssemblies ([System.Drawing.Bitmap].Assembly.Location) -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class PLClipImage {
  public static void SaveOpaque(Bitmap src, string path) {
    int w = src.Width, h = src.Height;
    var rect = new Rectangle(0, 0, w, h);
    using (var dst = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      var sd = src.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      int stride = sd.Stride;
      int bytes = stride * h;
      var buf = new byte[bytes];
      Marshal.Copy(sd.Scan0, buf, 0, bytes);
      src.UnlockBits(sd);
      bool anyAlpha = false;
      for (int i = 3; i < bytes; i += 4) { if (buf[i] != 0) { anyAlpha = true; break; } }
      if (!anyAlpha) { for (int i = 3; i < bytes; i += 4) buf[i] = 255; }
      var dd = dst.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
      Marshal.Copy(buf, 0, dd.Scan0, bytes);
      dst.UnlockBits(dd);
      dst.Save(path, ImageFormat.Png);
    }
  }
}
'@
}
function Save-ClipboardImage {
  # 落成临时 png：附件入库是按文件路径拷的，剪贴板里的位图没路径
  $dir = Join-Path $env:TEMP 'packleader-paste'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $path = Join-Path $dir ('paste-{0}.png' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  # 剪贴板里直接带 PNG 流时原样落盘，最保真。多数截图工具不放这个格式，会走下面的回退。
  try {
    $png = [System.Windows.Clipboard]::GetData('PNG')
    $bytes = $null
    if ($png -is [System.IO.MemoryStream]) { $bytes = $png.ToArray() }
    elseif ($png -is [byte[]]) { $bytes = $png }
    if ($bytes -and $bytes.Length -gt 8) {
      [System.IO.File]::WriteAllBytes($path, $bytes)
      return $path
    }
  } catch { }
  # 回退：GetImage 拿回来的位图 alpha 常常整张是 0（RGB 内容还在），
  # 直接编码就存成全透明图 —— 缩略图、预览、发给模型的都是白板。保存前把 alpha 补成 255。
  $bmp = $null
  try { $bmp = [System.Windows.Forms.Clipboard]::GetImage() } catch { return $null }
  if (-not $bmp) { return $null }
  try {
    [PLClipImage]::SaveOpaque($bmp, $path)
  } catch {
    return $null
  } finally {
    $bmp.Dispose()
  }
  return $path
}

$InputBox.Add_PreviewKeyDown({
  param($s, $e)
  if ($e.Key -ne [System.Windows.Input.Key]::V) { return }
  if (([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Control) -eq 0) { return }
  $added = $false
  try {
    if ([System.Windows.Clipboard]::ContainsFileDropList()) {
      # 在资源管理器里 Ctrl+C 一个文件：剪贴板同时有文件名文本和文件列表，按附件走才对
      $paths = [System.Windows.Clipboard]::GetFileDropList()
      if ($paths -and $paths.Count -gt 0) { Add-Attachments @($paths); $added = $true }
    } elseif ([System.Windows.Clipboard]::ContainsImage()) {
      # 截图（Win+Shift+S、QQ/微信截图…）只有位图没有文件，存成临时 png 再当附件
      $imgPath = Save-ClipboardImage
      if ($imgPath) { Add-Attachments @($imgPath); $added = $true }
    }
  } catch {
    Log ("粘贴附件失败: " + ($_ | Out-String))
  }
  # 收进附件就吃掉这次粘贴，别让 TextBox 再插一段文件路径文本
  if ($added) { $e.Handled = $true }
})

# 拖拽：TextBox 自己会吞掉 Drop，所以把它的 AllowDrop 关掉，统一由窗口收
$window.AllowDrop = $true
$InputBox.AllowDrop = $false
$InputBox.Add_DragOver({ param($s, $e) if ($e.Data -and $e.Data.GetDataPresent([System.Windows.DataFormats]::FileDrop)) { $e.Effects = 'Copy' } })
$window.Add_DragOver({ param($s, $e) if ($e.Data.GetDataPresent([System.Windows.DataFormats]::FileDrop)) { $e.Effects = 'Copy'; $e.Handled = $true } })
$window.Add_Drop({
  param($s, $e)
  if ($e.Data.GetDataPresent([System.Windows.DataFormats]::FileDrop)) {
    Add-Attachments $e.Data.GetData([System.Windows.DataFormats]::FileDrop)
    $e.Handled = $true
  }
})


# ---------------------------------------------------------------- 设置面板
function Open-Settings {
  $CfgUrl.Text = $(if ($script:cfgBaseURL) { $script:cfgBaseURL } else { '' })
  $CfgKey.Text = ''
  $CfgModel.Text = $script:modelName
  $CfgVerify.Text = $script:verifyCmd
  $CfgLogsDir.Text = $script:logsDir
  $CfgVision.IsChecked = [bool]$script:visionOn
  $ModelChips.Children.Clear()
  $ModelChips.Visibility = 'Collapsed'
  $ModelHint.Text = '点「拉取」从端点列出可用模型。'
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
  $payload = @{ cmd = 'config'; baseURL = $url; model = $model; verify = $CfgVerify.Text.Trim(); vision = [bool]$CfgVision.IsChecked }
  if ($key) { $payload.apiKey = $key }
  Send-Host $payload
}

$script:modeButtons = @{ 'read-only' = $ModeRead; 'guarded' = $ModeGuard; 'full' = $ModeFull }

function Set-ModeVisual([string]$m) {
  foreach ($k in $script:modeButtons.Keys) {
    $b = $script:modeButtons[$k]
    if ($k -eq $m) {
      # 选中：蓝底蓝字，模板也换成 Sel 版 —— 悬停时仍是蓝的，不会被灰色 hover 盖掉
      $b.Background = (Brush '#263450')
      $b.Foreground = (Brush '#8FA6FF')
      $b.Template = (New-SelTemplate)
    } else {
      $b.Background = [System.Windows.Media.Brushes]::Transparent
      $b.Foreground = (Brush '#ADB2B8')
      $b.Template = (New-FlatTemplate)
    }
  }
}

# ---------------------------------------------------------------- 读秒
# 这一轮开始的时间戳；0 表示没在跑（读秒条收起）
$script:thinkT0 = 0
# 当前阶段文案（思考中 / 回答中 / 执行 xxx / 验证中），由 Handle-Event 更新
$script:thinkVerb = ''

function Format-Elapsed([double]$secs) {
  # 一分钟内报秒，往上报到分；都取整，读秒时数字才不会乱跳
  # 紧凑写法（和「用时 2分39秒」一致），省得读秒条随数字变宽而抖动
  $s = [int][math]::Floor($secs)
  if ($s -lt 60) { return "$s 秒" }
  $m = [int][math]::Floor($s / 60)
  $rest = $s % 60
  if ($m -lt 60) { return "$($m)分$('{0:00}' -f $rest)秒" }
  return "$([int][math]::Floor($m / 60))小时$('{0:00}' -f ($m % 60))分"
}

function Update-ThinkRow([string]$verb) {
  if (-not $script:thinkT0) { return }
  $secs = ((Get-Date) - $script:thinkT0).TotalSeconds
  $ThinkText.Text = $(if ($verb) { $verb } else { '思考中' }) + ' · 用时 ' + (Format-Elapsed $secs) + '…'
}

# 切阶段（思考中 / 回答中 / 执行 xxx / 验证中）时立刻刷新一次，别等下一个 tick
function Set-ThinkVerb([string]$verb) {
  $script:thinkVerb = $verb
  Update-ThinkRow $verb
}

function Set-Busy([bool]$on) {
  $script:busy = $on
  $SendBtn.IsEnabled = -not $on
  $SendBtn.Visibility = $(if ($on) { 'Collapsed' } else { 'Visible' })
  $StopBtn.IsEnabled = $on
  $StopBtn.Visibility = $(if ($on) { 'Visible' } else { 'Collapsed' })
  if ($on) {
    # 从发出这一刻开始算，别等第一个事件回来才跳（模型排队时那几秒最容易让人以为卡住）
    $script:thinkT0 = (Get-Date)
    $script:thinkVerb = '思考中'
    $ThinkRow.Visibility = 'Visible'
    Update-ThinkRow $script:thinkVerb
  } else {
    $script:thinkT0 = 0
    $script:thinkVerb = ''
    $ThinkText.Text = ''
    $ThinkRow.Visibility = 'Collapsed'
  }
}

function Start-Turn([string]$text) {
  $files = @($script:attachFiles)
  $quotes = @($script:quoteRefs)
  if ($script:busy -or (-not $text.Trim() -and $files.Count -eq 0 -and $quotes.Count -eq 0)) { return }
  # 输入历史：连续重复的不重复记，指针归到末尾
  $trimmed = $text.Trim()
  if ($trimmed -and ($script:history.Count -eq 0 -or [string]$script:history[$script:history.Count - 1] -ne $trimmed)) {
    [void]$script:history.Add($trimmed)
  }
  $script:historyIdx = $script:history.Count
  # 引用拼在最前面：模型看到的是「引用原文 + 这次的话」，屏幕上是原文 + 一行引用标记
  $sendText = $text
  if ($quotes.Count -gt 0) {
    $sb = New-Object System.Text.StringBuilder
    foreach ($q in $quotes) {
      $who = $(if ($q.role -eq 'user') { '用户' } else { '模型' })
      [void]$sb.AppendLine("[引用对话 · $who]")
      [void]$sb.AppendLine([string]$q.text)
      [void]$sb.AppendLine()
    }
    if ($text.Trim()) { [void]$sb.Append($text) }
    $sendText = $sb.ToString().TrimEnd()
  }
  Add-UserMessage $text $files $quotes
  $InputBox.Text = ''
  $script:attachFiles.Clear()
  $script:quoteRefs.Clear()
  Update-AttachList
  $script:currentAssistant = $null
  $script:pendingText.Clear() | Out-Null
  Set-Busy $true
  if ($files.Count) { Send-Host @{ cmd = 'task'; text = $sendText; files = $files } }
  else { Send-Host @{ cmd = 'task'; text = $sendText } }
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
      $script:verifyCmd = [string]$e.verify
      $script:visionOn = [bool]$e.vision
      $script:logsDir = [string]$e.logsDir
      $script:hasKey = [bool]$e.hasKey
      Update-CwdPill ([string]$e.cwd)
      Update-ModelPill ([string]$e.model)
      $TitleText.Text = $(if ($e.title -and $e.title -ne '(empty)') { [string]$e.title } else { '新对话' })
      $SubTitle.Text = [string]$e.mode
      Set-ModeVisual ([string]$e.mode)
      # 第一次用（没 Key）：直接把设置面板弹出来，别让用户对着输入框发呆
      if (-not $script:hasKey) { Open-Settings }

      if (-not $script:busy) {
        Clear-Transcript
        $hasUser = $false
        foreach ($ev in $e.events) {
          if ($ev.kind -eq 'user/message') { Add-UserMessage ([string]$ev.text) $ev.files; $hasUser = $true }
          elseif ($ev.kind -eq 'assistant/message') {
            # 历史里的思考过程也要能看，默认收起成一行摘要
            if ($ev.reasoning) {
              $rn = Add-ReasoningBlock
              $rn.Body.Text = [string]$ev.reasoning
              $rn.Secs = [math]::Round(([double]$ev.ms) / 1000.0, 1)
              Complete-Reasoning
            }
            if ($ev.text) {
              if (-not $script:currentAssistant) { $script:currentAssistant = Add-AssistantMessage }
              Render-Markdown $script:assistantBody ([string]$ev.text)
              $script:currentAssistant = $null
              [void]$script:msgLog.Add(@{ role = 'assistant'; text = [string]$ev.text })
            }
          }
          elseif ($ev.kind -eq 'tool/call') {
            $sum = ''
            if ($ev.call.args) { $sum = ($ev.call.args | ConvertTo-Json -Compress -Depth 4) }
            $st = Add-ToolLine ([string]$ev.call.name) $sum
            $script:toolRows[[string]$ev.call.id] = $st
          }
          elseif ($ev.kind -eq 'tool/result') {
            $st = $script:toolRows[[string]$ev.callId]
            if ($st) {
              if ($ev.ok) { Set-ToolLineDone ([string]$ev.callId) "✓  $($ev.ms)ms" $true }
              else { Set-ToolLineDone ([string]$ev.callId) '✕  失败' $false }
            }
          }
          elseif ($ev.kind -eq 'memory/saved') {
            # 历史里的记忆也回放出来，可以照样撤销
            Add-MemoryCard $ev.items | Out-Null
          }
          elseif ($ev.kind -eq 'memory/undone') {
            Set-MemoryUndone @($ev.ids)
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
    'reasoning' {
      Close-ToolGroup
      if (-not $script:reasonNode) { Add-ReasoningBlock | Out-Null }
      Set-ThinkVerb '思考中'
      $rn = $script:reasonNode
      $d = [string]$e.delta
      $rn.Body.Text = $rn.Body.Text + $d
      Update-ReasoningHeader $rn
      $Scroller.ScrollToEnd()
    }
    'text' {
      Close-ToolGroup
      Complete-Reasoning
      Set-ThinkVerb '回答中'
      if (-not $script:currentAssistant) { $script:currentAssistant = Add-AssistantMessage }
      $script:pendingText.Append([string]$e.delta) | Out-Null
      if ($script:assistantBox) { $script:assistantBox.text = $script:pendingText.ToString() }
    }
    'assistant-end' {
      Close-ToolGroup
      Complete-Reasoning
      if ($e.text -and ([string]$e.text).Trim()) {
        if (-not $script:currentAssistant) { $script:currentAssistant = Add-AssistantMessage }
        Render-Markdown $script:assistantBody ([string]$e.text)
      } elseif ($script:currentAssistant -and $script:assistantBody) {
        # 只有工具调用、没有文字：把这个空块删掉
        $container = $script:assistantBody.Parent
        if ($container) { $Transcript.Children.Remove($container) | Out-Null }
      }
      if ($script:assistantBox) { $script:assistantBox.text = [string]$e.text }
      if ($e.text) {
        Append-CopyLog ([string]$e.text)
        [void]$script:msgLog.Add(@{ role = 'assistant'; text = [string]$e.text })
      }
      $script:pendingText.Clear() | Out-Null
      $script:currentAssistant = $null
    }
    'tool-start' {
      Complete-Reasoning
      Set-ThinkVerb ('执行 ' + [string]$e.name)
      $script:currentAssistant = $null
      $st = Add-ToolLine ([string]$e.name) ([string]$e.summary)
      $script:toolRows[[string]$e.id] = $st
      $Scroller.ScrollToEnd()
    }
    'tool-end' {
      Set-ThinkVerb '思考中'
      if ($e.ok) {
        Set-ToolLineDone ([string]$e.id) "✓  $($e.ms)ms" $true
      } else {
        $msg = ([string]$e.error).Split("`n")[0]
        if ($msg.Length -gt 40) { $msg = $msg.Substring(0, 40) + '…' }
        Set-ToolLineDone ([string]$e.id) "✕  $msg" $false
      }
      $script:currentAssistant = $null
      $Scroller.ScrollToEnd()
    }
    'verify-start' {
      Close-ToolGroup
      Set-ThinkVerb '验证中'
      $script:currentAssistant = $null
      $r = Add-VerifyRow ([string]$e.label) ([int]$e.round)
      $script:verifyRows[[string]$e.round] = $r
      $Scroller.ScrollToEnd()
    }
    'verify-end' {
      $r = $script:verifyRows[[string]$e.round]
      if ($r) {
        $sec = [math]::Round([double]$e.ms / 1000, 1)
        if ($e.ok) {
          $r.Status.Text = "✓ 通过 · $sec s"
          $r.Status.Foreground = (Brush '#4ADE80')
          $r.Border.BorderBrush = (Brush '#2644C07A')
        } else {
          $r.Status.Text = "✗ 失败 · exit $($e.exitCode) · $sec s"
          $r.Status.Foreground = (Brush '#F87171')
          $r.Border.BorderBrush = (Brush '#33F87171')
          # 失败时给最后几行，够看出哪条挂了；整段留在会话日志里
          $lines = ([string]$e.output) -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 4
          foreach ($l in $lines) {
            $t = $l.Trim()
            if ($t.Length -gt 150) { $t = $t.Substring(0, 150) + '…' }
            Add-SystemLine ("    " + $t) '#A88A8A'
          }
        }
      }
      $script:currentAssistant = $null
      $Scroller.ScrollToEnd()
    }
    'approval' { Close-ToolGroup; Add-ApprovalCard $e }
    'notice' { Close-ToolGroup; Add-SystemLine ([string]$e.text) '#9BA3B4' }
    'error' {
      Add-SystemLine ("错误：" + $e.message) '#F87171'
      # 拉模型失败也要在设置面板里现形，别一直停在「拉取中…」
      if ($script:fetching) {
        $script:fetching = $false
        $ModelHint.Foreground = (Brush '#F87171')
        $ModelHint.Text = [string]$e.message
      }
      if ($e.needsSetup) { Open-Settings }
      if ($e.fatal) { Set-Busy $false }
    }
    'config' {
      $script:cfgBaseURL = [string]$e.baseURL
      $script:cfgKeyMasked = [string]$e.apiKeyMasked
      if ($null -ne $e.verify) { $script:verifyCmd = [string]$e.verify }
      if ($null -ne $e.vision) { $script:visionOn = [bool]$e.vision }
      if ($e.logsDir) { $script:logsDir = [string]$e.logsDir }
      $script:modelName = [string]$e.model
      $script:hasKey = $true
      Update-ModelPill ([string]$e.model)
      Close-Settings
      Add-SystemLine ("已切换模型：" + $e.model + " @ " + $e.baseURL) '#4ADE80'
    }
    'models' {
      $script:fetching = $false
      # 端点里真实存在的模型：点一个就填进「模型名」
      $ModelChips.Children.Clear()
      $items = @($e.items)
      # 底部模型菜单用同一份列表
      $script:modelChoices = @($items)
      if ($items.Count -eq 0) {
        $ModelHint.Foreground = (Brush '#F87171')
        $ModelHint.Text = '端点没返回任何模型（检查地址要不要带 /v1）'
      } else {
        $ModelHint.Foreground = (Brush '#7C838E')
        $ModelHint.Text = "共 $($items.Count) 个，点一下填进上面的框"
        $ModelChips.Visibility = 'Visible'
        foreach ($id in $items) {
          $btn = New-Object System.Windows.Controls.Button
          $btn.Content = [string]$id
          $btn.FontSize = 10.5
          $btn.FontFamily = 'Cascadia Mono, Consolas'
          $btn.Padding = '8,3,8,3'
          $btn.Margin = '0,0,6,6'
          $btn.Cursor = 'Hand'
          $btn.BorderThickness = '1'
          $btn.BorderBrush = (Brush '#1FFFFFFF')
          $btn.Template = (New-FlatTemplate)
          $btn.Background = (Brush '#1A1D24')
          $btn.Foreground = (Brush '#CFD3D6')
          $btn.Tag = [string]$id
          $btn.Add_Click({ param($s, $e) $CfgModel.Text = [string]$s.Tag })
          $ModelChips.Children.Add($btn) | Out-Null
        }
      }
    }
    'usage' {
      $p = [int]$e.prompt; $c = [int]$e.completion; $cr = [int]$e.cacheRead
      $pct = if ($p -gt 0) { [math]::Round($cr * 100 / $p) } else { 0 }
      $UsageText.Text = "$($e.calls) 次 · 缓存 $pct%"
    }
    'turn-end' {
      Close-ToolGroup
      Complete-Reasoning
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
    'memory-saved' { Add-MemoryCard $e.items }
    'memory-undone' { Set-MemoryUndone @($e.ids) }
    'sessions' { Set-Sessions $e.items }
    'mode' { Set-ModeVisual ([string]$e.mode); $SubTitle.Text = [string]$e.mode }
    'model' { $script:modelName = [string]$e.model; Update-ModelPill ([string]$e.model) }
    'cwd' {
      Update-CwdPill ([string]$e.cwd)
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

# 打开日志目录：资源管理器直接定位过去，方便复杂任务卡住时按日志复盘
$CfgOpenLogs.Add_Click({
  $dir = $script:logsDir
  if (-not $dir) { return }
  try { Start-Process explorer.exe -ArgumentList ('"' + $dir + '"') } catch { }
})

# 拉取模型：用对话框里当前填的地址和 Key（Key 留空就让 host 用已保存的那个）
$CfgFetch.Add_Click({
  & $script:boot '拉取模型: 点击'
  $ModelChips.Children.Clear()
  $ModelChips.Visibility = 'Collapsed'
  $ModelHint.Foreground = (Brush '#7C838E')
  $ModelHint.Text = '拉取中…'
  $script:fetching = $true
  Send-Host @{ cmd = 'list-models'; baseURL = $CfgUrl.Text.Trim(); apiKey = $CfgKey.Text.Trim() }
})
$CfgCancel.Add_Click({ Close-Settings })
$CfgSave.Add_Click({ Save-Settings })
foreach ($box in @($CfgUrl, $CfgKey, $CfgModel, $CfgVerify)) {
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

# 底部模型按钮：点开就是可选模型列表，选一个直接切
$ModelPill.Add_Click({
  param($s, $e)
  # 还没拉过列表就先问一次；没 key 就不问，免得每点一下都往对话里塞一条错误
  if ($script:modelChoices.Count -eq 0 -and $script:hasKey) {
    Send-Host @{ cmd = 'list-models'; baseURL = $script:cfgBaseURL }
  }
  Show-ModelMenu $s
})

# 图片预览：× / 点背景 / Esc 都能关
$PreviewClose.Add_Click({ Hide-ImagePreview })
$ImagePreview.Add_MouseLeftButtonUp({ Hide-ImagePreview })
$PreviewImage.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true })
$window.Add_PreviewKeyDown({
  param($s, $e)
  if ($e.Key -eq [System.Windows.Input.Key]::Escape -and $ImagePreview.Visibility -eq 'Visible') {
    $e.Handled = $true
    Hide-ImagePreview
  }
})

$NewChatBtn.Add_Click({
  Send-Host @{ cmd = 'new-session' }
  Clear-Transcript
  Add-EmptyState
  $TitleText.Text = '新对话'
})

foreach ($pair in @(@('read-only', $ModeRead), @('guarded', $ModeGuard), @('full', $ModeFull))) {
  $pair[1].Tag = [string]$pair[0]
  $pair[1].Add_Click({
    param($s, $e)
    $m = [string]$s.Tag
    Set-ModeVisual $m
    Send-Host @{ cmd = 'mode'; mode = $m }
  })
}

$PickFolderBtn.Add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = '选择工作目录'
  $dlg.SelectedPath = $(if ($script:cwdPath) { $script:cwdPath } else { $env:USERPROFILE })
  $dlg.ShowNewFolderButton = $false
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    Send-Host @{ cmd = 'cwd'; dir = $dlg.SelectedPath }
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
    # 读秒：每 5 个 tick（约 0.25s）刷新一次就够了，数字只到秒
    if ($script:busy -and $script:thinkT0) {
      $script:tickCount2 = ([int]$script:tickCount2) + 1
      if (($script:tickCount2 % 5) -eq 0) {
        Update-ThinkRow $script:thinkVerb
        # 流式中的思考块头部也一起跳，别一直停在 0.0s
        Update-ReasoningTime $script:reasonNode
      }
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

# ---------------- 左侧栏宽度：可拖动，记住上次的宽度 ----------------
# 存在数据目录（和 config.json 同一个地方），不塞进配置里免得污染模型设置
$script:layoutFile = Join-Path $DataDir 'ui-layout.json'
$script:sideDefault = 252
$script:sideMin = 180
# 最近一次 Set-Sessions 收到的标题；以及据此量出的「标题全放得下」所需宽度（0 = 还没量过）
# 缓存起来是为了让窗口缩放时的 SizeChanged 不做重复测量
$script:sideTitles = @()
$script:sideFitWidth = 0
# 行内除标题之外的固定开销：左栏 ScrollViewer Padding 8+8、行 Border Padding 8+8、
# 删除按钮 22、列表滚动条 10，再留 8 的余量，免得「刚好装下」时标题贴着删除按钮
$script:sideChrome = 64

# 用 TextBlock.Measure 量文字宽度：中英文混排比按字符数估算准得多，
# 而且走的是和实际显示完全相同的排版流程
function Measure-TextWidth([string]$text, [double]$size = 12) {
  if (-not $text) { return 0 }
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Text = $text
  $tb.FontSize = $size
  $tb.FontFamily = (New-Object System.Windows.Media.FontFamily('Segoe UI'))
  $tb.Measure([System.Windows.Size]::new([double]::PositiveInfinity, [double]::PositiveInfinity))
  return $tb.DesiredSize.Width
}

function Get-SideFitWidth {
  # 最长标题的像素宽度 + 行内固定开销 = 标题能完整显示所需的最小左栏宽度
  $text = 0
  foreach ($t in @($script:sideTitles)) {
    $w = Measure-TextWidth ([string]$t) 12
    if ($w -gt $text) { $text = $w }
  }
  if ($text -le 0) { return 0 }
  return [math]::Ceiling($text + $script:sideChrome)
}

function Get-SideMax {
  # 左栏硬上限 = min(窗口给得出多少, 标题全显示所需)；不小于 MinWidth
  $w = $window.ActualWidth
  if ($w -le 0) { $w = $window.Width }
  # 右边给对话区留 420（它的 MinWidth）+ 6（分隔条）
  $cap = [math]::Max($script:sideMin + 1, $w - 426)
  if ($script:sideFitWidth -gt 0) { $cap = [math]::Min($cap, $script:sideFitWidth) }
  return [math]::Max($script:sideMin, $cap)
}

function Set-SideWidth([double]$w) {
  if ($w -lt $script:sideMin) { $w = $script:sideMin }
  $max = Get-SideMax
  if ($w -gt $max) { $w = $max }
  $SideCol.Width = (New-Object System.Windows.GridLength $w)
}

# 把上限落到列上：MaxWidth 管「拖动时不能越过」，另外把已经超出的宽度收回来
function Sync-SideCap {
  if ($script:sideFitWidth -le 0) { $script:sideFitWidth = Get-SideFitWidth }
  if ($script:sideFitWidth -le 0) { return }
  $cap = Get-SideMax
  $SideCol.MaxWidth = $cap
  if ($SideCol.ActualWidth -gt $cap + 0.5) { Set-SideWidth $cap }
}

# 标题变了（Set-Sessions）才重量；没变化就直接返回，免得每次刷新会话列表都动布局
function Update-SideFit {
  $fit = Get-SideFitWidth
  if ($fit -le 0) { return }
  if ([math]::Abs($fit - $script:sideFitWidth) -lt 1) { return }
  $script:sideFitWidth = $fit
  Sync-SideCap
}

# 拖动结束后把列还原成按比例（"*"）：GridSplitter 拖完会把列写成固定像素，
# 之后窗口变宽左栏不再让位。改成 "*" 后窗口变宽它会自己长，长到 MaxWidth 就停。
function Recall-SideWidth {
  Sync-SideCap
  $cur = $SideCol.ActualWidth
  if ($cur -le 0) { return }
  $SideCol.Width = (New-Object System.Windows.GridLength 1, ([System.Windows.GridUnitType]::Star))
}

function Sync-SideCap {
  # 把「内容上限」落到列上：MaxWidth 管拖动时 GridSplitter 不会越过，
  # 同时兜一下当前位置（标题变短/窗口变窄后已经超了的话就收回来）
  $fit = Get-SideFitWidth
  if ($fit -le 0) { return }
  $script:sideFitWidth = $fit
  $cap = Get-SideMax
  $SideCol.MaxWidth = $cap
  if ($SideCol.ActualWidth -gt $cap + 0.5) { Set-SideWidth $cap }
  elseif ($SideCol.ActualWidth -lt $script:sideMin - 0.5) { Set-SideWidth $script:sideMin }
}

function Update-SideFit {
  # 标题变了（Set-Sessions）就重新量；量出来没变化就什么都不做，免得每次刷新会话列表都动布局
  $fit = Get-SideFitWidth
  if ($fit -le 0) { return }
  if ([math]::Abs($fit - $script:sideFitWidth) -lt 1) { return }
  Sync-SideCap
}

function Recall-SideWidth {
  # 拖动结束后把列还原成「按比例」而不是固定像素：
  # GridSplitter 拖完会把列写成固定 GridLength，窗口再变宽左栏不会跟着让位。
  # "*" 列在窗口变宽时会自动长，正好让上限继续生效（长到 MaxWidth 就停）。
  if ($script:sideFitWidth -le 0) { return }
  $cap = Get-SideMax
  $SideCol.MaxWidth = $cap
  $cur = $SideCol.ActualWidth
  if ($cur -le 0) { return }
  if ($cur -gt $cap) { Set-SideWidth $cap; return }
  $SideCol.Width = (New-Object System.Windows.GridLength 1, ([System.Windows.GridUnitType]::Star))
}

function Get-SideMax {
  $w = $window.ActualWidth
  if ($w -le 0) { $w = $window.Width }
  # 右边给对话区留 420（它的 MinWidth）+ 6（分隔条）
  $cap = [math]::Max($script:sideMin + 1, $w - 426)
  # 内容硬上限：标题全都显示得下之后就不该再往外拉
  if ($script:sideFitWidth -gt 0) {
    $cap = [math]::Max($script:sideMin, [math]::Min($cap, $script:sideFitWidth))
  }
  return $cap
}

function Set-SideWidth([double]$w) {
  if ($w -lt $script:sideMin) { $w = $script:sideMin }
  $max = Get-SideMax
  if ($w -gt $max) { $w = $max }
  $SideCol.Width = (New-Object System.Windows.GridLength $w)
}

# 窗口或内容变化后重新算一遍：列宽夹到 [MinWidth, 内容上限]
function Sync-SideMax {
  Sync-SideCap
}

function Save-SideWidth {
  try {
    $w = [math]::Round($SideCol.ActualWidth)
    if ($w -lt $script:sideMin) { return }
    # 合并写：以后这个文件里放别的东西（比如高度）也不会互相覆盖
    $obj = @{}
    if (Test-Path -LiteralPath $script:layoutFile) {
      try {
        $old = Get-Content -Raw -LiteralPath $script:layoutFile | ConvertFrom-Json
        foreach ($p in $old.PSObject.Properties) { $obj[$p.Name] = $p.Value }
      } catch { }
    }
    $obj['sideWidth'] = [int]$w
    [System.IO.File]::WriteAllText($script:layoutFile, ($obj | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
  } catch { Log ('保存左侧栏宽度失败: ' + ($_ | Out-String)) }
}

function Restore-SideWidth {
  $w = 0
  try {
    if (Test-Path -LiteralPath $script:layoutFile) {
      $o = Get-Content -Raw -LiteralPath $script:layoutFile | ConvertFrom-Json
      if ($o -and $null -ne $o.sideWidth) { $w = [double]$o.sideWidth }
    }
  } catch { Log ('读左侧栏宽度失败: ' + ($_ | Out-String)) }
  if ($w -ge $script:sideMin) { Set-SideWidth $w } else { Set-SideWidth $script:sideDefault }
}

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
  Update-CwdPill $Cwd
  Update-ModelPill ([string]$Model)
  Set-ModeVisual $Mode
  $SubTitle.Text = $Mode
  Clear-Transcript
  Restore-SideWidth
  # 列表建好、布局落定后再量一次：标题宽度决定左栏能拉到多宽
  try { $window.Dispatcher.Invoke([action]{ Update-SideFit }, [System.Windows.Threading.DispatcherPriority]::Background) } catch { }
  $timer.Start()
  $InputBox.Focus() | Out-Null
  # 自测入口：设置 PL_GUI_TASK 会自动发第一条任务（也方便截图验证）
  if ($env:PL_GUI_TASK) { Start-Turn $env:PL_GUI_TASK }
})

# 分隔条：拖动结束后把上限落到列上并记住宽度；双击复位到默认
$SideSplitter.Add_DragCompleted({
  Sync-SideCap
  Recall-SideWidth
  Save-SideWidth
})
$SideSplitter.Add_MouseDoubleClick({
  Set-SideWidth $script:sideDefault
  Save-SideWidth
})

# 窗口变宽/变窄：右栏 MinWidth 与内容上限都可能变，重新夹一次
$window.Add_SizeChanged({
  try { Sync-SideCap } catch { }
})

$window.Add_Closing({
  Log '窗口 Closing'
  try { Save-SideWidth } catch { }

  $timer.Stop()
  try { $proc.StandardInput.Close() } catch { }
  Start-Sleep -Milliseconds 150
  try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
})

Log '准备 ShowDialog'
$window.ShowDialog() | Out-Null
Log '窗口已关闭'
