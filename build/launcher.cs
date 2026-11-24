// PackLeader 启动器：找到系统里的 Node，再把窗口拉起来。
// 用 in-box 的 csc.exe 编译（.NET Framework 4.8，系统自带），产物约 15 KB。
// 刻意不打包 Node 运行时：那会让安装包从几百 KB 变成 30 MB（见 README 的体积测算）。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
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

        string node = FindNode(appDir);
        if (node == null)
        {
            string msg = "找不到 Node.js（需要 " + MinVersion + " 或更新版本）。\r\n\r\n"
                + "PackLeader 是零依赖的单机 agent，直接复用系统里的 Node 运行时，\r\n"
                + "所以安装包只有几百 KB，而不是把 150 MB 的运行时打包进来。\r\n\r\n"
                + "装好 Node 后重新双击即可：https://nodejs.org/";
            if (cli) { Console.Error.WriteLine(msg); return 2; }
            MessageBox.Show(msg, "PackLeader", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 2;
        }

        string entry = Path.Combine(appDir, Path.Combine("src", "cli.ts"));
        if (!File.Exists(entry))
        {
            string msg = "安装不完整：找不到\r\n" + entry + "\r\n\r\n请重新运行安装包。";
            if (cli) { Console.Error.WriteLine(msg); return 3; }
            MessageBox.Show(msg, "PackLeader", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 3;
        }

        string version = NodeVersion(node);
        if (version != null && !VersionOk(version))
        {
            string msg = "Node 版本太低：找到 " + version + "，PackLeader 需要 " + MinVersion + " 或更新版本。\r\n\r\n"
                + "（Node 22.18 起才原生支持直接运行 TypeScript，装新版即可：https://nodejs.org/）";
            if (cli) { Console.Error.WriteLine(msg); return 4; }
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

        using (Process p = Process.Start(psi))
        {
            p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { Append(log, e.Data); };
            p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { Append(log, e.Data); };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            p.WaitForExit();
            return p.ExitCode;
        }
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
