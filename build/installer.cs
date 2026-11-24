// PackLeader 安装包（自解压 + 注册卸载项）。
// 负载以 payload.bin 资源形式嵌进 exe，编译时用 /resource:payload.bin,payload.bin 传进来。
// 单文件、无第三方依赖、用 in-box 的 csc.exe 编译，产物几百 KB。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

// 深色标题栏：WinForms 的 chrome 也是白色的，和深色窗体贴不上，只能找 DWM。
// DWMWA_USE_IMMERSIVE_DARK_MODE = 20（Win10 2004+），更早的版本用 19。
static class DarkChrome
{
    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    public static void Apply(IntPtr hwnd)
    {
        try
        {
            int on = 1;
            DwmSetWindowAttribute(hwnd, 20, ref on, 4);
            DwmSetWindowAttribute(hwnd, 19, ref on, 4);
        }
        catch { }
    }
}

static class Installer
{
    public const string AppName = "PackLeader";
    public const string Version = "0.1.0";
    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\PackLeader";

    public static string TargetDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\PackLeader"); }
    }
    static string StartMenuLnk
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk"); }
    }
    static string DesktopLnk
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"); }
    }

    [STAThread]
    static int Main(string[] args)
    {
        bool silent = Has(args, "/S") || Has(args, "/silent");
        if (Has(args, "--uninstall") || Has(args, "/uninstall"))
        {
            Uninstall(silent);
            return 0;
        }
        if (silent)
        {
            bool ok = Run(true, delegate(int pct, string msg) { if (msg != null) Console.WriteLine(msg); });
            return ok ? 0 : 1;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm());
        return 0;
    }

    static bool Has(string[] args, string flag)
    {
        foreach (string a in args) { if (string.Equals(a, flag, StringComparison.OrdinalIgnoreCase)) return true; }
        return false;
    }

    // ---------------------------------------------------------------- 负载
    class Entry
    {
        public string Name;
        public byte[] Data;
    }

    static List<Entry> LoadPayload()
    {
        List<Entry> list = new List<Entry>();
        Stream s = typeof(Installer).Assembly.GetManifestResourceStream("payload.bin");
        if (s == null) throw new InvalidOperationException("安装包损坏：找不到内嵌负载");
        using (s)
        {
            BinaryReader br = new BinaryReader(s);
            while (s.Position < s.Length)
            {
                int nameLen = br.ReadInt32();
                if (nameLen <= 0) break;
                string name = Encoding.UTF8.GetString(br.ReadBytes(nameLen));
                int len = br.ReadInt32();
                list.Add(new Entry { Name = name, Data = br.ReadBytes(len) });
            }
        }
        return list;
    }

    // ---------------------------------------------------------------- 安装
    public static bool Run(bool desktop, Action<int, string> report)
    {
        try
        {
            Log("开始安装 -> " + TargetDir + " desktop=" + desktop);
            report(2, "准备目录…");
            List<Entry> payload = LoadPayload();
            Log("负载条目: " + payload.Count);
            // 覆盖安装时，旧的 PackLeader.exe 可能还开着（Launcher 会一直守到窗口关闭）。
            // 不先关掉就只能报 IOException —— 这是几乎所有 Windows 安装器都要做的一步。
            CloseRunningInstances();
            Directory.CreateDirectory(TargetDir);

            int i = 0;
            foreach (Entry e in payload)
            {
                i++;
                string dest = Path.Combine(TargetDir, e.Name);
                string dir = Path.GetDirectoryName(dest);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                WriteFileRobust(dest, e.Data);
                Log("  [" + i + "/" + payload.Count + "] " + e.Name + " " + e.Data.Length + "B");
                report(5 + (int)(70.0 * i / payload.Count), "写入 " + e.Name);
            }

            report(78, "创建快捷方式…");
            string exe = Path.Combine(TargetDir, "PackLeader.exe");
            CreateShortcut(StartMenuLnk, exe, TargetDir, exe);
            if (desktop) CreateShortcut(DesktopLnk, exe, TargetDir, exe);
            else { try { if (File.Exists(DesktopLnk)) File.Delete(DesktopLnk); } catch { } }

            report(86, "复制卸载程序…");
            string uninst = Path.Combine(TargetDir, "Uninstall.exe");
            if (!PathsEqual(Application.ExecutablePath, uninst))
            {
                try { File.Copy(Application.ExecutablePath, uninst, true); } catch { }
            }

            report(92, "注册卸载项…");
            WriteUninstallEntry(exe, uninst, payload);

            report(100, "完成");
            Log("安装完成");
            return true;
        }
        catch (Exception ex)
        {
            Log("安装失败: " + ex.ToString());
            report(0, "安装失败：" + ex.Message);
            return false;
        }
    }

    static void CloseRunningInstances()
    {
        try
        {
            foreach (Process p in Process.GetProcessesByName("PackLeader"))
            {
                try
                {
                    string path = p.MainModule.FileName;
                    if (path == null || !path.StartsWith(TargetDir, StringComparison.OrdinalIgnoreCase)) continue;
                    Log("关闭运行中的实例 pid=" + p.Id);
                    if (p.CloseMainWindow() && p.WaitForExit(4000)) continue;
                    p.Kill();
                    p.WaitForExit(2000);
                }
                catch { }
            }
        }
        catch { }
    }

    // 正被占用的文件：先改名再写（改名对运行中的 exe 是允许的，删除不是）
    static void WriteFileRobust(string dest, byte[] data)
    {
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try { File.WriteAllBytes(dest, data); return; }
            catch (IOException)
            {
                try
                {
                    if (File.Exists(dest)) File.Move(dest, dest + ".old-" + Environment.TickCount);
                }
                catch { }
                System.Threading.Thread.Sleep(250);
            }
        }
        File.WriteAllBytes(dest, data);
    }

    static void Log(string line)
    {
        try
        {
            string p = Path.Combine(Path.GetTempPath(), "packleader-setup.log");
            File.AppendAllText(p, DateTime.Now.ToString("HH:mm:ss.fff") + " " + line + "\r\n", new UTF8Encoding(false));
        }
        catch { }
    }

    static bool PathsEqual(string a, string b)
    {
        return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
    }

    static void WriteUninstallEntry(string exe, string uninst, List<Entry> payload)
    {
        long total = 0;
        foreach (Entry e in payload) total += e.Data.Length;
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            k.SetValue("DisplayName", AppName + " 单机 Agent");
            k.SetValue("DisplayVersion", Version);
            k.SetValue("Publisher", "PackLeader");
            k.SetValue("InstallLocation", TargetDir);
            k.SetValue("DisplayIcon", exe);
            k.SetValue("UninstallString", "\"" + uninst + "\" --uninstall");
            k.SetValue("QuietUninstallString", "\"" + uninst + "\" --uninstall /S");
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            k.SetValue("EstimatedSize", (int)(total / 1024), RegistryValueKind.DWord);
        }
    }

    static void CreateShortcut(string lnkPath, string target, string workDir, string icon)
    {
        try
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            object sc = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
            Type scType = sc.GetType();
            scType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { target });
            scType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workDir });
            scType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { icon + ",0" });
            scType.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { "PackLeader 单机 Agent" });
            scType.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
        }
        catch { }
    }

    // ---------------------------------------------------------------- 卸载
    static void Uninstall(bool silent)
    {
        if (!silent)
        {
            DialogResult r = MessageBox.Show("要卸载 PackLeader 吗？\r\n\r\n会删除程序文件、快捷方式和卸载项，不会动你自己的项目目录和会话记录。",
                AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes) return;
        }
        try { if (File.Exists(StartMenuLnk)) File.Delete(StartMenuLnk); } catch { }
        try { if (File.Exists(DesktopLnk)) File.Delete(DesktopLnk); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }

        // 除了"正在运行的自己"，其余文件同步删干净。
        // 为什么不用 `rd /s /q` 延迟整目录：如果用户在几秒内重装，那条延迟命令会
        // 把新装进去的文件一起删掉（实测过，装完只剩 PackLeader.exe）。
        string self = Application.ExecutablePath;
        try
        {
            foreach (string f in Directory.GetFiles(TargetDir, "*", SearchOption.AllDirectories))
            {
                if (PathsEqual(f, self)) continue;
                try { File.Delete(f); } catch { }
            }
            foreach (string d in Directory.GetDirectories(TargetDir, "*", SearchOption.AllDirectories))
            {
                try { Directory.Delete(d, true); } catch { }
            }
        }
        catch { }

        // 自己删不掉自己：交给 cmd 退出后再删，且 rd 不带 /s —— 目录非空时它会失败，
        // 这样即使和重装撞上也不会误删。
        try
        {
            string cmd = "/c ping -n 3 127.0.0.1 >nul & del /f /q \"" + self + "\" 2>nul & rd \"" + TargetDir + "\" 2>nul & ping -n 2 127.0.0.1 >nul & rd \"" + TargetDir + "\" 2>nul";
            System.Diagnostics.ProcessStartInfo psi = new System.Diagnostics.ProcessStartInfo("cmd.exe", cmd);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            System.Diagnostics.Process.Start(psi);
        }
        catch { }
        if (!silent) MessageBox.Show("已卸载。", AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}

// -------------------------------------------------------------------- 安装界面
class SetupForm : Form
{
    Label _path = new Label();
    Label _status = new Label();
    ProgressBar _bar = new ProgressBar();
    CheckBox _desktop = new CheckBox();
    Button _go = new Button();
    Button _close = new Button();

    public SetupForm()
    {
        Text = "PackLeader 安装程序";
        ClientSize = new Size(560, 268);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(15, 17, 21);
        ForeColor = Color.FromArgb(249, 250, 251);
        Font = new Font("Segoe UI", 9f);

        Label title = new Label();
        title.Text = "PackLeader";
        title.Font = new Font("Segoe UI", 17f, FontStyle.Bold);
        title.ForeColor = Color.FromArgb(249, 250, 251);
        title.SetBounds(24, 18, 400, 34);
        Controls.Add(title);

        Label sub = new Label();
        sub.Text = "单机 Agent · 零依赖 · 会审批、会审计、能撤销";
        sub.ForeColor = Color.FromArgb(124, 131, 142);
        sub.SetBounds(26, 52, 480, 20);
        Controls.Add(sub);

        Label to = new Label();
        to.Text = "安装到";
        to.ForeColor = Color.FromArgb(173, 178, 184);
        to.SetBounds(26, 92, 60, 20);
        Controls.Add(to);

        _path.Text = Installer.TargetDir;
        _path.ForeColor = Color.FromArgb(207, 211, 214);
        _path.SetBounds(88, 92, 440, 20);
        Controls.Add(_path);

        _desktop.Text = "同时创建桌面快捷方式";
        _desktop.Checked = true;
        _desktop.ForeColor = Color.FromArgb(207, 211, 214);
        _desktop.SetBounds(26, 120, 300, 22);
        Controls.Add(_desktop);

        _bar.SetBounds(26, 156, 508, 8);
        _bar.Style = ProgressBarStyle.Continuous;
        Controls.Add(_bar);

        _status.Text = "需要系统已安装 Node.js 22.18 或更新版本（安装包不含运行时）。";
        _status.ForeColor = Color.FromArgb(124, 131, 142);
        _status.SetBounds(26, 172, 508, 40);
        Controls.Add(_status);

        _go.Text = "安装";
        _go.SetBounds(352, 222, 88, 30);
        _go.BackColor = Color.FromArgb(43, 92, 255);
        _go.ForeColor = Color.White;
        _go.FlatStyle = FlatStyle.Flat;
        _go.FlatAppearance.BorderSize = 0;
        _go.Click += delegate { StartInstall(); };
        Controls.Add(_go);

        _close.Text = "关闭";
        _close.SetBounds(446, 222, 88, 30);
        _close.FlatStyle = FlatStyle.Flat;
        _close.BackColor = Color.FromArgb(28, 31, 38);
        _close.ForeColor = Color.FromArgb(207, 211, 214);
        _close.FlatAppearance.BorderColor = Color.FromArgb(60, 64, 72);
        _close.Click += delegate { Close(); };
        Controls.Add(_close);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        DarkChrome.Apply(Handle);
    }

    void StartInstall()
    {
        _go.Enabled = false;
        _desktop.Enabled = false;
        bool desktop = _desktop.Checked;
        System.Threading.ThreadPool.QueueUserWorkItem(delegate(object state)
        {
            bool ok = Installer.Run(desktop, delegate(int pct, string msg)
            {
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        if (pct >= 0 && pct <= 100) _bar.Value = pct;
                        if (msg != null)
                        {
                            _status.ForeColor = Color.FromArgb(124, 131, 142);
                            _status.Text = msg;
                        }
                    });
                }
                catch { }
            });
            BeginInvoke((MethodInvoker)delegate
            {
                _bar.Value = 100;
                if (ok)
                {
                    _status.ForeColor = Color.FromArgb(74, 222, 128);
                    _status.Text = "安装完成，开始菜单里已经有 PackLeader 了。";
                    _go.Text = "完成";
                    _go.Enabled = true;
                    _go.Click += delegate { Close(); };
                }
                else
                {
                    _status.ForeColor = Color.FromArgb(248, 113, 113);
                    _go.Enabled = true;
                    _desktop.Enabled = true;
                }
            });
        });
    }
}
