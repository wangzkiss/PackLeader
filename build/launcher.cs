// PackLeader 启动器：找到系统里的 Node，再把窗口拉起来。
// 用 in-box 的 csc.exe 编译（.NET Framework 4.8，系统自带），产物约 15 KB。
// 刻意不打包 Node 运行时：那会让安装包从几百 KB 变成 30 MB（见 README 的体积测算）。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    const string MinVersion = "22.18";

    [STAThread]
    static int Main(string[] args)
    {
        string appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        bool cli = false;
        bool hasCwd = false;
        List<string> pass = new List<string>();
        foreach (string a in args)
        {
            if (string.Equals(a, "--cli", StringComparison.OrdinalIgnoreCase)) { cli = true; continue; }
            if (string.Equals(a, "--cwd", StringComparison.OrdinalIgnoreCase)) { hasCwd = true; }
            pass.Add(a);
        }

        PerfInit();
        // ---------------------------------------------------------------- 单实例
        // 双击两次桌面图标不能变成两个程序：第二个只负责把已有窗口叫出来，然后自己退出。
        // 为什么互斥锁捏在启动器手里（而不是界面里）：界面是 powershell 子进程，启动器本来
        // 就要等它，锁放在这一层「一个 exe = 一个实例」最直观；--cli 不参与（命令行可以开多个）。
        Mutex single = null;
        if (!cli && !HasFlag(args, "--allow-multi"))
        {
            bool created;
            single = new Mutex(true, @"Local\PackLeader.SingleInstance", out created);
            if (!created)
            {
                ActivateRunningInstance();
                return 0;
            }
            // 退出时不能留一串「幽灵实例」：进程被强杀时锁要靠这个释放
            AppDomain.CurrentDomain.ProcessExit += delegate { try { single.ReleaseMutex(); } catch { } };
        }

        if (!cli) ShowSplash();
        PerfWrite("span", "splash", PerfClock.Elapsed.TotalMilliseconds, null);
        double mark = PerfClock.Elapsed.TotalMilliseconds;
        string node = FindNode(appDir);
        PerfWrite("span", "find-node", PerfClock.Elapsed.TotalMilliseconds - mark, null);
        if (node == null)
        {
            string msg = "找不到 Node.js（需要 " + MinVersion + " 或更新版本）。\r\n\r\n"
                + "PackLeader 是零依赖的单机 agent，直接复用系统里的 Node 运行时，\r\n"
                + "所以安装包只有几百 KB，而不是把 150 MB 的运行时打包进来。\r\n\r\n"
                + "装好 Node 后重新双击即可：https://nodejs.org/";
            if (cli) { Console.Error.WriteLine(msg); return 2; }
            CloseSplash();
            MessageBox.Show(msg, "PackLeader", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 2;
        }

        string entry = Path.Combine(appDir, Path.Combine("src", "cli.ts"));
        if (!File.Exists(entry))
        {
            string msg = "安装不完整：找不到\r\n" + entry + "\r\n\r\n请重新运行安装包。";
            if (cli) { Console.Error.WriteLine(msg); return 3; }
            CloseSplash();
            MessageBox.Show(msg, "PackLeader", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 3;
        }

        mark = PerfClock.Elapsed.TotalMilliseconds;
        string version = NodeVersion(node);
        PerfWrite("span", "node-version", PerfClock.Elapsed.TotalMilliseconds - mark, "\"version\":" + PerfStr(version));
        if (version != null && !VersionOk(version))
        {
            string msg = "Node 版本太低：找到 " + version + "，PackLeader 需要 " + MinVersion + " 或更新版本。\r\n\r\n"
                + "（Node 22.18 起才原生支持直接运行 TypeScript，装新版即可：https://nodejs.org/）";
            if (cli) { Console.Error.WriteLine(msg); return 4; }
            CloseSplash();
            MessageBox.Show(msg, "PackLeader", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 4;
        }

        StringBuilder sb = new StringBuilder();
        sb.Append("--disable-warning=ExperimentalWarning ");
        sb.Append(Quote(entry));
        if (!cli) sb.Append(" gui");
        // 双击启动时 cwd 会是安装目录，agent 在那儿什么也干不了。
        // 依次尝试：上次用过的目录 -> 用户主目录。
        // 用户也可以用界面上的「换」按钮或 --cwd 指定项目。
        if (!cli && !hasCwd)
        {
            sb.Append(" --cwd ").Append(Quote(DefaultWorkspace()));
        }
        foreach (string p in pass) { sb.Append(' ').Append(Quote(p)); }

        ProcessStartInfo psi = new ProcessStartInfo(node);
        psi.Arguments = sb.ToString();
        psi.WorkingDirectory = appDir;
        psi.UseShellExecute = false;

        if (cli)
        {
            psi.CreateNoWindow = false;
            using (Process p = Process.Start(psi)) { p.WaitForExit(); return p.ExitCode; }
        }

        // 窗口模式：不弹控制台。父进程留着抽干子进程的 stdout/stderr，
        // 否则管道写满会把 node 卡住（窗口看起来像卡死）。
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        // 窗口进程会盯着这个 PID：启动器没了（升级/被杀）就自己关掉，
        // 否则会留下一个孤儿窗口，覆盖安装时看起来像"装了两个"。
        psi.EnvironmentVariables["PL_GUI_PARENT_PID"] = Process.GetCurrentProcess().Id.ToString();

        string log = Path.Combine(Path.GetTempPath(), "packleader-launcher.log");
        try { if (File.Exists(log) && new FileInfo(log).Length > 2 * 1024 * 1024) File.Delete(log); } catch { }

        // 主窗口一露头就把启动提示撤掉（最多等 30 秒，防止永远挂着）
        WatchForWindow();
        mark = PerfClock.Elapsed.TotalMilliseconds;
        using (Process p = Process.Start(psi))
        {
            PerfWrite("span", "node-launch", PerfClock.Elapsed.TotalMilliseconds - mark, "\"node\":" + PerfStr(node));
            p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { Append(log, e.Data); };
            p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { Append(log, e.Data); };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            p.WaitForExit();
            PerfWrite("span", "launcher-total", PerfClock.Elapsed.TotalMilliseconds, null);
            return p.ExitCode;
        }
    }

    // ---------------- 启动提示（splash） ----------------
    // 双击之后到窗口出现要 0.6~1.5 秒（冷机、杀软扫描时更久），中间什么也不显示，
    // 用户感受就是「卡住了」。这里立刻弹一个极小的无边框条，主窗口露头即撤。
    static Form splash;
    static readonly object splashGate = new object();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    static void ShowSplash()
    {
        try
        {
            Thread t = new Thread(delegate()
            {
                try
                {
                    lock (splashGate) { splash = new SplashForm(); }
                    Application.Run(splash);
                }
                catch { }
            });
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
        }
        catch { }
    }

    static void WatchForWindow()
    {
        try
        {
            Thread t = new Thread(delegate()
            {
                try
                {
                    Stopwatch sw = Stopwatch.StartNew();
                    bool found = false;
                    while (sw.ElapsedMilliseconds < 30000)
                    {
                        if (FindWindow(null, "PackLeader") != IntPtr.Zero) { found = true; break; }
                        Thread.Sleep(30);
                    }
                    // 这是「双击到看得见窗口」最准的一个数（比界面里的 Loaded 打点更贴近用户感知）
                    PerfWrite("point", "main-window-found", PerfClock.Elapsed.TotalMilliseconds, found ? null : "\"timeout\":true");
                    // 让主窗口先画完一帧再撤，不然两个窗口会闪一下
                    Thread.Sleep(150);
                }
                catch { }
                CloseSplash();
            });
            t.IsBackground = true;
            t.Start();
        }
        catch { }
    }

    static void CloseSplash()
    {
        try
        {
            Form f;
            lock (splashGate) { f = splash; }
            if (f != null && f.IsHandleCreated) f.BeginInvoke(new Action(f.Close));
        }
        catch { }
    }

    sealed class SplashForm : Form
    {
        // 不抢焦点：用户双击后可能还在别的窗口里打字
        protected override bool ShowWithoutActivation { get { return true; } }

        public SplashForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(300, 62);
            BackColor = Color.FromArgb(15, 17, 21);
            ShowInTaskbar = false;
            TopMost = true;
            DoubleBuffered = true;
            Label l = new Label();
            l.Text = "PackLeader 正在启动…";
            l.ForeColor = Color.FromArgb(249, 250, 251);
            l.Dock = DockStyle.Fill;
            l.TextAlign = ContentAlignment.MiddleCenter;
            l.Font = new Font("Microsoft YaHei UI", 10.5f);
            Controls.Add(l);
            Paint += delegate(object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(Color.FromArgb(70, 43, 92, 255)))
                {
                    e.Graphics.DrawRectangle(p, 0, 0, ClientSize.Width - 1, ClientSize.Height - 1);
                }
            };
        }
    }

    // ---------------- 单实例 ----------------
    static bool HasFlag(string[] args, string name)
    {
        foreach (string a in args) if (string.Equals(a, name, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    const string WindowTitle = "PackLeader";
    /// <summary>
    /// 把已经在跑的那个窗口叫出来。两步：先按窗口类前缀找（WPF 的类名是
    /// HwndWrapper[PackLeader.xxx;;guid]，标题会随会话变，只能当兜底），
    /// 找到就还原+置前；找不到（比如它正收在托盘里、窗口 Hidden）就退回广播
    /// 一个自定义消息，界面那边在 Loaded 时挂了钩子，会自己 Show 出来。
    /// </summary>
    static void ActivateRunningInstance()
    {
        try
        {
            IntPtr h = FindWindowEx(IntPtr.Zero, IntPtr.Zero, null, WindowTitle);
            if (h == IntPtr.Zero) h = FindByClassPrefix(WPF_CLASS_PREFIX);
            if (h != IntPtr.Zero)
            {
                if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
                else ShowWindow(h, SW_SHOW);
                SetForegroundWindow(h);
            }
            // 不管找没找到都广播一次：窗口被 Hidden 时照样能被界面自己叫出来
            PostMessage(HWND_BROADCAST, WM_PL_ACTIVATE, IntPtr.Zero, IntPtr.Zero);
        }
        catch { }
    }

    static IntPtr FindByClassPrefix(string prefix)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            StringBuilder sb = new StringBuilder(512);
            if (GetClassName(h, sb, sb.Capacity) > 0 && sb.ToString().StartsWith(prefix, StringComparison.Ordinal))
            {
                found = h;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    const string WPF_CLASS_PREFIX = "HwndWrapper[PackLeader";
    const int SW_SHOW = 5;
    const int SW_RESTORE = 9;
    const uint WM_PL_ACTIVATE = 0x8000 + 0x51;   // 自定义消息，界面里 RegisterWindowMessage 同名
    static readonly IntPtr HWND_BROADCAST = new IntPtr(0xffff);

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);

    // ---------------- 性能日志 ----------------
    // 启动链每一段记一条（exe → splash → node → PS → 主窗口），落
    // %LOCALAPPDATA%\PackLeader\perf\launcher-YYYYMMDD.jsonl。只写几行，同步写无所谓；
    // node 与界面进程各自写自己的文件，分析时按 ts / mono 合并。
    static readonly Stopwatch PerfClock = Stopwatch.StartNew();
    static string perfFile;
    static string perfRun = "";
    static long perfT0;

    static void PerfInit()
    {
        try
        {
            string mode = Environment.GetEnvironmentVariable("PL_PERF");
            if (string.Equals(mode, "off", StringComparison.OrdinalIgnoreCase)) return;
            perfRun = Environment.GetEnvironmentVariable("PL_PERF_RUN");
            if (string.IsNullOrEmpty(perfRun))
            {
                perfRun = "r-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString("x") + "-" + Guid.NewGuid().ToString("N").Substring(0, 4);
            }
            long t0;
            if (!long.TryParse(Environment.GetEnvironmentVariable("PL_PERF_T0"), out t0) || t0 <= 0)
            {
                t0 = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
            perfT0 = t0;
            // 往下传：node（cli.ts）→ 界面 / host 进程都靠这两个值拼同一条时间轴
            Environment.SetEnvironmentVariable("PL_PERF_RUN", perfRun);
            Environment.SetEnvironmentVariable("PL_PERF_T0", perfT0.ToString());
            string dir = Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PackLeader"), "perf");
            Directory.CreateDirectory(dir);
            perfFile = Path.Combine(dir, "launcher-" + DateTime.Now.ToString("yyyyMMdd") + ".jsonl");
            PerfWrite("start", "exe", null, "\"pid\":" + Process.GetCurrentProcess().Id + ",\"os\":" + PerfStr(Environment.OSVersion.VersionString));
        }
        catch { }
    }

    static void PerfWrite(string type, string name, double? durMs, string extra)
    {
        if (perfFile == null) return;
        try
        {
            StringBuilder sb = new StringBuilder(192);
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            sb.Append("{\"v\":1,\"src\":\"launcher\",\"run\":").Append(PerfStr(perfRun));
            sb.Append(",\"ts\":").Append(now).Append(",\"mono\":").Append(now - perfT0);
            sb.Append(",\"type\":").Append(PerfStr(type)).Append(",\"name\":").Append(PerfStr(name));
            if (durMs.HasValue) sb.Append(",\"dur_ms\":").Append((long)Math.Round(durMs.Value));
            if (!string.IsNullOrEmpty(extra)) sb.Append(',').Append(extra);
            sb.Append('}');
            // 不带 BOM：带 BOM 的话首行不是 '{'，分析时会当成坏行跳过
            File.AppendAllText(perfFile, sb.ToString() + "\r\n", new UTF8Encoding(false));
        }
        catch { }
    }

    static string PerfStr(string s)
    {
        if (s == null) return "\"\"";
        return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\"";
    }

    static string DefaultWorkspace()
    {
        try
        {
            string state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Path.Combine("PackLeader", "last-cwd.txt"));
            if (File.Exists(state))
            {
                string last = File.ReadAllText(state).Trim();
                if (last.Length > 0 && Directory.Exists(last)) return last;
            }
        }
        catch { }
        return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    static void Append(string path, string line)
    {
        if (line == null) return;
        try { File.AppendAllText(path, line + "\r\n", Encoding.UTF8); } catch { }
    }

    static string Quote(string s)
    {
        if (s.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return s;
        return "\"" + s.Replace("\"", "\\\"") + "\"";
    }

    static string NodeVersion(string node)
    {
        // 每次启动都为一个 `node -v` 起子进程（冷机 100~800ms，杀软在扫的时候更久），
        // 而版本几乎不会变：按「node.exe 路径 + 修改时间」缓存起来，只在换过 node 时才重新问。
        string cache = Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PackLeader"), "node-version.txt");
        string stamp = node + "|" + SafeStamp(node);
        try
        {
            if (File.Exists(cache))
            {
                string[] lines = File.ReadAllLines(cache);
                if (lines.Length >= 2 && lines[0] == stamp) return lines[1].Length == 0 ? null : lines[1];
            }
        }
        catch { }
        string v = RunNodeVersion(node);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(cache));
            File.WriteAllLines(cache, new string[] { stamp, v == null ? "" : v });
        }
        catch { }
        return v;
    }

    static string SafeStamp(string path)
    {
        try { return new FileInfo(path).LastWriteTimeUtc.Ticks.ToString(); } catch { return "0"; }
    }

    static string RunNodeVersion(string node)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(node, "-v");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            using (Process p = Process.Start(psi))
            {
                string v = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit(4000);
                return v.Length == 0 ? null : v;
            }
        }
        catch { return null; }
    }

    static bool VersionOk(string version)
    {
        string v = version.TrimStart('v', 'V');
        string[] parts = v.Split('.');
        int major = 0, minor = 0;
        if (parts.Length >= 1) int.TryParse(parts[0], out major);
        if (parts.Length >= 2) int.TryParse(parts[1], out minor);
        return major > 22 || (major == 22 && minor >= 18);
    }

    static string FindNode(string appDir)
    {
        // 便携版优先用随包携带的运行时（如果有）
        string[] fixedPaths = new string[]
        {
            Path.Combine(appDir, Path.Combine("node", "node.exe")),
            Path.Combine(appDir, Path.Combine("runtime", "node.exe")),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Path.Combine("nodejs", "node.exe")),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Path.Combine(Path.Combine("Programs", "nodejs"), "node.exe"))
        };
        foreach (string p in fixedPaths) { if (File.Exists(p)) return p; }

        string pathVar = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrEmpty(pathVar))
        {
            string[] dirs = pathVar.Split(';');
            foreach (string d in dirs)
            {
                string dir = d.Trim().Trim('"');
                if (dir.Length == 0) continue;
                try
                {
                    string cand = Path.Combine(dir, "node.exe");
                    if (File.Exists(cand)) return cand;
                }
                catch { }
            }
        }
        return null;
    }
}
