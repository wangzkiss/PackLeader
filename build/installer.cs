// PackLeader 安装包（自解压 + 注册卸载项）。
// 负载以 payload.bin 资源形式嵌进 exe，编译时用 /resource:payload.bin,payload.bin 传进来。
// 单文件、无第三方依赖、用 in-box 的 csc.exe 编译，产物几百 KB。
// 界面（SetupForm / UninstallForm / 主题与自绘控件）在 build/installer-ui.cs，两个文件一起编译。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;


static class Installer
{
    public const string AppName = "PackLeader";
    public const string Version = "0.1.0";
    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\PackLeader";
    /// <summary>开机自启：HKCU 的 Run 项，默认勾上（启动时只进托盘，不弹窗口）</summary>
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunName = "PackLeader";

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
        bool purge = Has(args, "--purge") || Has(args, "/purge");

        // 卸载意图有两个来源：
        //   1) 命令行带 --uninstall —— 注册表 UninstallString 就是这么调的
        //   2) 自己被复制成 Uninstall.exe 之后被双击 —— 一个参数都没有
        // 只认参数的话，双击 Uninstall.exe 会掉进"安装界面"，这就是之前的 bug。
        bool byName = Path.GetFileNameWithoutExtension(Application.ExecutablePath)
            .StartsWith("Uninstall", StringComparison.OrdinalIgnoreCase);

        if (Has(args, "--uninstall") || Has(args, "/uninstall") || byName)
        {
            if (silent)
            {
                Uninstall(true, purge);
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new UninstallForm());
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
        return Run(desktop, false, report);
    }

    /// <summary>
    /// autostart = 勾了「开机自启」：写 HKCU\...\Run 一个 --tray 的启动项。
    /// 为什么 --tray：开机时用户正在干别的，弹一个窗口出来是打扰；只进托盘，
    /// 点托盘图标立刻就能用（窗口早已建好，只是藏着）。
    /// </summary>
    public static bool Run(bool desktop, bool autostart, Action<int, string> report)
    {
        try
        {
            Log("开始安装 -> " + TargetDir + " desktop=" + desktop + " autostart=" + autostart);
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

            report(96, autostart ? "设置开机自启…" : "清理开机自启项…");
            SetAutostart(autostart, exe);

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

    /// <summary>
    /// 写/删 HKCU 的开机自启项。命令里必须带 --tray：开机时只进托盘不弹窗。
    /// 删除时只在值确实指向本程序时才删，别把同名的别人的项清掉。
    /// </summary>
    static void SetAutostart(bool enable, string exe)
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (k == null) return;
                if (enable)
                {
                    k.SetValue(RunName, "\"" + exe + "\" --tray");
                    Log("已设置开机自启（--tray）");
                }
                else
                {
                    string cur = k.GetValue(RunName) as string;
                    if (cur != null && cur.IndexOf(exe, StringComparison.OrdinalIgnoreCase) >= 0) k.DeleteValue(RunName, false);
                    Log("已清理开机自启项");
                }
            }
        }
        catch (Exception ex) { Log("设置开机自启失败: " + ex.Message); }
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
    /// <summary>返回删掉的文件数；用户取消返回 -1</summary>
    public static int Uninstall(bool silent, bool purgeData)
    {
        if (!silent)
        {
            DialogResult r = MessageBox.Show("要卸载 PackLeader 吗？\r\n\r\n会删除程序文件、快捷方式和卸载项，不会动你自己的项目目录。",
                AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes) return -1;
        }
        try { if (File.Exists(StartMenuLnk)) File.Delete(StartMenuLnk); } catch { }
        try { if (File.Exists(DesktopLnk)) File.Delete(DesktopLnk); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }
        // 卸载要清掉开机自启项：否则下次开机还会去拉一个已经不存在的 exe（弹一条系统错误）
        SetAutostart(false, Path.Combine(TargetDir, "PackLeader.exe"));

        // 除了"正在运行的自己"，其余文件同步删干净。
        // 为什么不用 `rd /s /q` 延迟整目录：如果用户在几秒内重装，那条延迟命令会
        // 把新装进去的文件一起删掉（实测过，装完只剩 PackLeader.exe）。
        string self = Application.ExecutablePath;
        int removed = 0;
        try
        {
            foreach (string f in Directory.GetFiles(TargetDir, "*", SearchOption.AllDirectories))
            {
                if (PathsEqual(f, self)) continue;
                try { File.Delete(f); removed++; } catch { }
            }
            foreach (string d in Directory.GetDirectories(TargetDir, "*", SearchOption.AllDirectories))
            {
                try { Directory.Delete(d, true); } catch { }
            }
        }
        catch { }

        if (purgeData) PurgeData();

        // 自己删不掉自己。静默卸载到这里就可以排删除；有界面时不能排，
        // 因为用户还会盯着「已卸载」看一会儿，那时 exe 被占用，del 必然失败
        // （实测：点完卸载不关窗，目录和 Uninstall.exe 都会留下来）。
        // 界面路径改在 FormClosed 里调 ScheduleSelfDelete()。
        if (silent) ScheduleSelfDelete();
        if (!silent) MessageBox.Show("已卸载。", AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
        return removed;
    }

    /// <summary>
    /// 退出后再删自己 + 删目录。
    ///
    /// 为什么不是"ping 几秒再 del"：用户卸载完会盯着「已卸载」看一会儿，那几秒早就过去了，
    /// exe 还占着，del 必然失败（实测过：点完卸载不关窗，目录和 Uninstall.exe 都留着）。
    /// 所以交给一个旁观进程 Wait-Process，等本进程真退出了再动手。
    /// 另外工作目录必须设到别处：自己的 cwd 就是安装目录，rd 删不掉"当前目录"。
    /// </summary>
    public static void ScheduleSelfDelete()
    {
        string self = Application.ExecutablePath;
        int pid = System.Diagnostics.Process.GetCurrentProcess().Id;
        bool selfInside = self.StartsWith(TargetDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

        StringBuilder sb = new StringBuilder();
        sb.Append("Wait-Process -Id ").Append(pid).Append(" -ErrorAction SilentlyContinue;");
        sb.Append(" Start-Sleep -Milliseconds 500;");
        if (selfInside) sb.Append(" Remove-Item -LiteralPath '").Append(self).Append("' -Force -ErrorAction SilentlyContinue;");
        sb.Append(" Remove-Item -LiteralPath '").Append(TargetDir).Append("' -Recurse -Force -ErrorAction SilentlyContinue;");

        try
        {
            System.Diagnostics.ProcessStartInfo psi = new System.Diagnostics.ProcessStartInfo(
                "powershell.exe",
                "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command \"" + sb.ToString() + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
            System.Diagnostics.Process.Start(psi);
        }
        catch { }
    }
    /// <summary>会话日志、审计库、checkpoint、config.json（含 API Key）都在这里</summary>
    public static string[] DataDirs()
    {
        return new string[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".packleader"),
        };
    }

    static void PurgeData()
    {
        foreach (string dir in DataDirs())
        {
            try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
        }
    }
}
