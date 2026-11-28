// PackLeader 安装包 / 卸载包的界面层。
//
// 和主窗口（ui/PackLeader.ps1）一套观感：纯色深灰底 #0E1015 + 圆角卡片 #191C24 +
// 蓝渐变主按钮 #3B82F6→#2B6CB0，危险动作用暗红。WinForms 的 Button / CheckBox /
// ProgressBar 都是系统画的，深色底上一眼就是「另一个年代」，所以这几个都自绘。
// 编译见 scripts/build-dist.ps1：和 installer.cs 一起交给 in-box 的 csc.exe。
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Windows.Forms;

// 深色标题栏：WinForms 的 chrome 是系统画的，和深色窗体贴不上，只能找 DWM。
// 和主窗口的 Set-TitleBarLook 一致：关掉 Win11 的 Mica，再把标题栏 / 文字 / 边框
// 换成 #0F1115 / #E6E8EE / #0F1115。
// DWMWA_USE_IMMERSIVE_DARK_MODE = 20（Win10 2004+），更早的版本用 19。
static class DarkChrome
{
    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    const int ImmersiveDarkMode = 20;
    const int ImmersiveDarkModeLegacy = 19;
    const int CaptionColor = 35;
    const int TextColor = 36;
    const int BorderColor = 34;
    const int SystemBackdropType = 38;

    /// <summary>COLORREF 是 0x00BBGGRR，不是 RGB</summary>
    static int ColorRef(int r, int g, int b) { return r | (g << 8) | (b << 16); }

    public static void Apply(IntPtr hwnd)
    {
        try
        {
            int on = 1;
            DwmSetWindowAttribute(hwnd, ImmersiveDarkMode, ref on, 4);
            DwmSetWindowAttribute(hwnd, ImmersiveDarkModeLegacy, ref on, 4);
            // DWMSBT_NONE：不关掉的话 Win11 会给标题栏铺 Mica，设了 CAPTION_COLOR 也不生效
            int backdrop = 0;
            DwmSetWindowAttribute(hwnd, SystemBackdropType, ref backdrop, 4);
            int caption = ColorRef(0x0F, 0x11, 0x15);
            int text = ColorRef(0xE6, 0xE8, 0xEE);
            int border = ColorRef(0x0F, 0x11, 0x15);
            DwmSetWindowAttribute(hwnd, CaptionColor, ref caption, 4);
            DwmSetWindowAttribute(hwnd, TextColor, ref text, 4);
            DwmSetWindowAttribute(hwnd, BorderColor, ref border, 4);
        }
        catch { }
    }
}

// ------------------------------------------------------------------ 主题
static class Theme
{
    public static readonly Color Window = Color.FromArgb(0x0E, 0x10, 0x15);
    public static readonly Color Card = Color.FromArgb(0x19, 0x1C, 0x24);
    public static readonly Color Sunken = Color.FromArgb(0x0F, 0x11, 0x15);
    public static readonly Color Raised = Color.FromArgb(0x1B, 0x1E, 0x27);
    public static readonly Color BlueTop = Color.FromArgb(0x3B, 0x82, 0xF6);
    public static readonly Color BlueBottom = Color.FromArgb(0x2B, 0x6C, 0xB0);
    public static readonly Color Text = Color.FromArgb(0xF9, 0xFA, 0xFB);
    public static readonly Color TextSub = Color.FromArgb(0xCF, 0xD3, 0xD6);
    public static readonly Color TextDim = Color.FromArgb(0x7C, 0x83, 0x8E);
    public static readonly Color TextFaint = Color.FromArgb(0x5B, 0x62, 0x6D);
    public static readonly Color Hairline = Color.FromArgb(0x1A, 0xFF, 0xFF, 0xFF);
    public static readonly Color Stroke = Color.FromArgb(0x1F, 0xFF, 0xFF, 0xFF);
    public static readonly Color Good = Color.FromArgb(0x4A, 0xDE, 0x80);
    public static readonly Color Bad = Color.FromArgb(0xF8, 0x71, 0x71);
    public static readonly Color BadLine = Color.FromArgb(0x4D, 0xF8, 0x71, 0x71);
    public static readonly Color Danger = Color.FromArgb(0x2A, 0x14, 0x17);
    public static readonly Color Track = Color.FromArgb(0x2C, 0x31, 0x3D);

    public static Font Ui(float size) { return new Font("Segoe UI", size); }
    public static Font UiBold(float size) { return new Font("Segoe UI", size, FontStyle.Bold); }
    public static Font Mono(float size) { return new Font("Consolas", size); }

    public static GraphicsPath Round(Rectangle r, int radius)
    {
        GraphicsPath p = new GraphicsPath();
        if (radius <= 0 || r.Width <= 2 || r.Height <= 2) { p.AddRectangle(r); return p; }
        int d = radius * 2;
        if (d > r.Width) d = r.Width;
        if (d > r.Height) d = r.Height;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    public static LinearGradientBrush BlueBrush(Rectangle r)
    {
        Rectangle safe = new Rectangle(0, 0, Math.Max(2, r.Width), Math.Max(2, r.Height));
        return new LinearGradientBrush(safe, BlueTop, BlueBottom, 45f);
    }

    /// <summary>控件清屏用父容器底色，免得圆角外露一条窗口底色</summary>
    public static Color ParentColor(Control c)
    {
        return c.Parent != null ? c.Parent.BackColor : c.BackColor;
    }

    /// <summary>AutoSize=false 的单行/多行文字块（Label 直接 new 出来默认是 AutoSize）</summary>
    public static Label Txt(string text, int x, int y, int w, int h, Font font, Color color)
    {
        Label l = new Label();
        l.Text = text;
        l.Font = font;
        l.ForeColor = color;
        l.BackColor = Color.Transparent;
        l.AutoSize = false;
        l.SetBounds(x, y, w, h);
        l.TextAlign = ContentAlignment.MiddleLeft;
        return l;
    }
}

// ------------------------------------------------------------------ 控件
/// <summary>圆角卡片：浅一层底 + 1px 半透明白描边</summary>
class Card : Panel
{
    public int Radius = 12;

    public Card()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
            | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        BackColor = Theme.Card;
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (GraphicsPath p = Theme.Round(new Rectangle(0, 0, Width - 1, Height - 1), Radius))
        {
            using (SolidBrush b = new SolidBrush(BackColor)) g.FillPath(b, p);
            using (Pen pen = new Pen(Theme.Hairline)) g.DrawPath(pen, p);
        }
    }
}

/// <summary>下沉一层的圆角容器（路径框那种）：#0F1115 底 + 细描边</summary>
class SunkenPanel : Panel
{
    public int Radius = 10;

    public SunkenPanel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
            | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        BackColor = Theme.Sunken;
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (GraphicsPath p = Theme.Round(new Rectangle(0, 0, Width - 1, Height - 1), Radius))
        {
            using (SolidBrush b = new SolidBrush(BackColor)) g.FillPath(b, p);
            using (Pen pen = new Pen(Theme.Stroke)) g.DrawPath(pen, p);
        }
    }
}

/// <summary>左边一个蓝渐变圆角方块 + 白色 P，和 exe 图标一个意思</summary>
class LogoBox : Control
{
    public int Radius = 12;

    public LogoBox()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
            | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        BackColor = Theme.Window;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(Theme.ParentColor(this));
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
        using (GraphicsPath p = Theme.Round(r, Radius))
        {
            using (LinearGradientBrush b = Theme.BlueBrush(r)) g.FillPath(b, p);
            using (Pen pen = new Pen(Color.FromArgb(0x40, 0x7D, 0xBA, 0xFF))) g.DrawPath(pen, p);
        }
        using (Font f = new Font("Segoe UI", Height * 0.56f, FontStyle.Bold, GraphicsUnit.Pixel))
        using (StringFormat sf = new StringFormat())
        {
            sf.Alignment = StringAlignment.Center;
            sf.LineAlignment = StringAlignment.Center;
            g.DrawString("P", f, Brushes.White, new RectangleF(0, 1, Width, Height), sf);
        }
    }
}

/// <summary>胶囊按钮。Primary=蓝渐变，Danger=暗红描边，其余=浅灰底描边</summary>
class PillButton : Button
{
    public bool Primary;
    public bool Danger;
    bool _hover;
    bool _down;

    public PillButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
            | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        Font = Theme.Ui(9.2f);
        Cursor = Cursors.Hand;
        BackColor = Theme.Window;
        ForeColor = Theme.Text;
        TabStop = false;
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { _down = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(Theme.ParentColor(this));
        g.SmoothingMode = SmoothingMode.AntiAlias;

        Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
        using (GraphicsPath path = Theme.Round(r, Height / 2))
        {
            if (Enabled && Primary)
            {
                using (LinearGradientBrush b = Theme.BlueBrush(r)) g.FillPath(b, path);
            }
            else
            {
                Color bg = !Enabled ? Theme.Sunken : (Danger ? Theme.Danger : Theme.Raised);
                using (SolidBrush b = new SolidBrush(bg)) g.FillPath(b, path);
                Color line = !Enabled ? Theme.Hairline : (Danger ? Theme.BadLine : Theme.Stroke);
                using (Pen pen = new Pen(line)) g.DrawPath(pen, path);
            }
            if (Enabled && (_hover || _down))
            {
                using (SolidBrush o = new SolidBrush(Color.FromArgb(_down ? 0x29 : 0x18, 0xFF, 0xFF, 0xFF)))
                    g.FillPath(o, path);
            }
        }

        Color textColor = !Enabled ? Theme.TextFaint : (Primary ? Color.White : (Danger ? Theme.Bad : Theme.TextSub));
        TextRenderer.DrawText(g, Text, Font, new Rectangle(0, 0, Width, Height), textColor,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter
            | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
    }
}

/// <summary>自绘复选框：圆角小方块 + 蓝色对勾</summary>
class RoundCheck : CheckBox
{
    bool _hover;

    public RoundCheck()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
            | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        AutoSize = false;
        Height = 24;
        Cursor = Cursors.Hand;
        Font = Theme.Ui(9.2f);
        ForeColor = Theme.TextSub;
        BackColor = Theme.Window;
        TabStop = false;
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnCheckedChanged(EventArgs e) { Invalidate(); base.OnCheckedChanged(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(Theme.ParentColor(this));
        g.SmoothingMode = SmoothingMode.AntiAlias;

        const int box = 16;
        Rectangle r = new Rectangle(0, (Height - box) / 2, box, box);
        using (GraphicsPath p = Theme.Round(r, 5))
        {
            if (Checked)
            {
                using (LinearGradientBrush b = Theme.BlueBrush(r)) g.FillPath(b, p);
                using (Pen pen = new Pen(Color.White, 1.6f))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    pen.LineJoin = LineJoin.Round;
                    g.DrawLines(pen, new PointF[]
                    {
                        new PointF(r.X + 3.9f, r.Y + 8.1f),
                        new PointF(r.X + 6.9f, r.Y + 11.1f),
                        new PointF(r.X + 12.2f, r.Y + 5.0f)
                    });
                }
            }
            else
            {
                using (SolidBrush b = new SolidBrush(Theme.Sunken)) g.FillPath(b, p);
                Color line = _hover ? Color.FromArgb(0x59, 0xFF, 0xFF, 0xFF) : Color.FromArgb(0x33, 0xFF, 0xFF, 0xFF);
                using (Pen pen = new Pen(line)) g.DrawPath(pen, p);
            }
        }

        Rectangle text = new Rectangle(box + 9, 0, Math.Max(0, Width - box - 9), Height);
        TextRenderer.DrawText(g, Text, Font, text, Enabled ? Theme.TextSub : Theme.TextFaint,
            TextFormatFlags.VerticalCenter | TextFormatFlags.Left
            | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
    }
}

/// <summary>细圆角进度条：底槽 #1B1E27，填充蓝渐变（系统那条绿块的复古感太强）</summary>
class SlimBar : Control
{
    int _value;

    public SlimBar()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
            | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        BackColor = Theme.Window;
        Height = 6;
    }

    public int Value
    {
        get { return _value; }
        set
        {
            int v = value < 0 ? 0 : (value > 100 ? 100 : value);
            if (v == _value) return;
            _value = v;
            Invalidate();
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(Theme.ParentColor(this));
        g.SmoothingMode = SmoothingMode.AntiAlias;

        Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
        // 底槽要比卡片(#191C24)亮一点，否则没开工时整条进度条像是没有
        using (GraphicsPath p = Theme.Round(r, Height / 2))
        {
            using (SolidBrush b = new SolidBrush(Theme.Track)) g.FillPath(b, p);
        }
        if (_value <= 0) return;

        int w = (int)Math.Round((Width - 1) * (_value / 100.0));
        if (w < Height) w = Height;   // 刚开工也画个圆头，不然看不出动静
        using (GraphicsPath p = Theme.Round(r, Height / 2))
        {
            Region old = g.Clip;
            g.SetClip(p, CombineMode.Intersect);
            using (LinearGradientBrush b = Theme.BlueBrush(r))
                g.FillRectangle(b, new Rectangle(0, 0, Math.Min(w, Width - 1), Height - 1));
            g.Clip = old;
        }
    }
}

// ------------------------------------------------------------------ 窗体基类
class DarkForm : Form
{
    public DarkForm()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Theme.Window;
        ForeColor = Theme.Text;
        Font = Theme.Ui(9f);
        DoubleBuffered = true;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        DarkChrome.Apply(Handle);
    }

    /// <summary>
    /// 干完活自己关窗：装完/卸完用户下一步就是去点开始菜单（或看一眼桌面），
    /// 没必要再逼他点一次「完成」。状态行里倒数，让人知道不是崩了。
    /// </summary>
    protected void AutoClose(Label status, string doneText, int seconds)
    {
        int left = seconds;
        status.Text = doneText + " · " + left + " 秒后自动关闭";
        Timer t = new Timer();
        t.Interval = 1000;
        t.Tick += delegate
        {
            left--;
            if (left <= 0)
            {
                t.Stop();
                t.Dispose();
                Close();
                return;
            }
            status.Text = doneText + " · " + left + " 秒后自动关闭";
        };
        t.Start();
    }

    /// <summary>两个窗体的抬头（logo + 标题 + 副标题 + 版本号）长得一样</summary>
    protected void BuildHeader(string title, string subtitle)
    {
        LogoBox logo = new LogoBox();
        logo.SetBounds(28, 24, 40, 40);
        Controls.Add(logo);

        Controls.Add(Theme.Txt(title, 80, 22, 360, 28, Theme.UiBold(15f), Theme.Text));
        Controls.Add(Theme.Txt(subtitle, 81, 51, 420, 18, Theme.Ui(9f), Theme.TextDim));

        Label ver = Theme.Txt("v" + Installer.Version, 470, 26, 124, 18, Theme.Ui(8.6f), Theme.TextFaint);
        ver.TextAlign = ContentAlignment.MiddleRight;
        Controls.Add(ver);
    }
}

// ------------------------------------------------------------------ 安装界面
class SetupForm : DarkForm
{
    Label _status;
    Label _path;
    SlimBar _bar;
    RoundCheck _desktop;
    RoundCheck _autostart;
    PillButton _go;
    PillButton _close;
    bool _done;

    public SetupForm()
    {
        Text = "PackLeader 安装程序";
        ClientSize = new Size(620, 414);

        BuildHeader("PackLeader", "单机 Agent · 零依赖 · 会审批、会审计、能撤销");

        Card card = new Card();
        card.SetBounds(28, 84, 564, 244);
        Controls.Add(card);

        card.Controls.Add(Theme.Txt("安装到", 20, 18, 200, 18, Theme.Ui(9f), Theme.TextSub));

        SunkenPanel pathBox = new SunkenPanel();
        pathBox.SetBounds(20, 42, 524, 34);
        card.Controls.Add(pathBox);

        _path = Theme.Txt(Installer.TargetDir, 13, 0, 498, 34, Theme.Mono(8.8f), Theme.TextSub);
        pathBox.Controls.Add(_path);

        card.Controls.Add(Theme.Txt("需要系统已安装 Node.js 22.18 或更新版本（安装包不含运行时）",
            20, 84, 524, 18, Theme.Ui(8.6f), Theme.TextFaint));

        _desktop = new RoundCheck();
        _desktop.Text = "同时创建桌面快捷方式";
        _desktop.Checked = true;
        _desktop.SetBounds(18, 112, 260, 24);
        card.Controls.Add(_desktop);

        _autostart = new RoundCheck();
        _autostart.Text = "开机自动启动（只在托盘，不弹窗）";
        _autostart.Checked = true;
        _autostart.SetBounds(18, 136, 360, 24);
        card.Controls.Add(_autostart);
        // 「自启只进托盘」这件事在这里说清楚：用户看到这句才知道开机后去哪找它
        card.Controls.Add(Theme.Txt("关掉窗口不会退出，点托盘图标可以叫回来", 300, 112, 244, 48, Theme.Ui(8.4f), Theme.TextFaint));

        _bar = new SlimBar();
        _bar.SetBounds(20, 178, 524, 6);
        card.Controls.Add(_bar);

        _status = Theme.Txt("点「安装」开始：装到上面的目录，建开始菜单快捷方式并注册卸载项。",
            20, 196, 524, 42, Theme.Ui(9f), Theme.TextDim);
        _status.TextAlign = ContentAlignment.TopLeft;
        card.Controls.Add(_status);

        _close = new PillButton();
        _close.Text = "关闭";
        _close.SetBounds(344, 344, 96, 38);
        _close.Click += delegate { Close(); };
        Controls.Add(_close);

        _go = new PillButton();
        _go.Text = "安装";
        _go.Primary = true;
        _go.SetBounds(452, 344, 140, 38);
        _go.Click += delegate { if (_done) Close(); else StartInstall(); };
        Controls.Add(_go);

        Controls.Add(Theme.Txt("安装包不含 Node 运行时，需要 Node 22.18+",
            28, 352, 300, 18, Theme.Ui(8.6f), Theme.TextFaint));
    }

    void StartInstall()
    {
        _go.Enabled = false;
        _close.Enabled = false;
        _desktop.Enabled = false;
        _autostart.Enabled = false;
        _status.ForeColor = Theme.TextDim;
        bool desktop = _desktop.Checked;
        bool autostart = _autostart.Checked;
        System.Threading.ThreadPool.QueueUserWorkItem(delegate(object state)
        {
            bool ok = Installer.Run(desktop, autostart, delegate(int pct, string msg)
            {
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        if (pct >= 0 && pct <= 100) _bar.Value = pct;
                        if (msg != null)
                        {
                            _status.ForeColor = Theme.TextDim;
                            _status.Text = msg;
                        }
                    });
                }
                catch { }
            });
            BeginInvoke((MethodInvoker)delegate
            {
                _bar.Value = 100;
                _close.Enabled = true;
                if (ok)
                {
                    _done = true;
                    _status.ForeColor = Theme.Good;
                    string done = "装好了，开始菜单里已经有 PackLeader。"
                        + (desktop ? "桌面上也有快捷方式。" : "")
                        + (autostart ? "开机后自动在托盘待命。" : "");
                    _status.Text = done + "3 秒后自动关闭。";
                    _go.Text = "完成";
                    _go.Enabled = true;
                    AutoClose(_status, done, 3);
                }
                else
                {
                    _status.ForeColor = Theme.Bad;
                    _go.Enabled = true;
                    _desktop.Enabled = true;
                    _autostart.Enabled = true;
                }
            });
        });
    }
}

// ------------------------------------------------------------------ 卸载界面
/// <summary>
/// 双击 Uninstall.exe 时看到的就是这个。
/// 以前没有它：同一个 exe 没参数就画安装界面，用户点「卸载」看到的却是「安装」。
/// </summary>
class UninstallForm : DarkForm
{
    Label _status;
    RoundCheck _purge;
    PillButton _go;
    PillButton _close;
    bool _done;
    bool _removed;

    public UninstallForm()
    {
        Text = "PackLeader 卸载程序";
        ClientSize = new Size(620, 400);

        BuildHeader("卸载 PackLeader", "会删除程序文件、快捷方式和卸载项，不会动你的项目目录。");

        Card card = new Card();
        card.SetBounds(28, 84, 564, 214);
        Controls.Add(card);

        card.Controls.Add(Theme.Txt("安装位置", 20, 18, 200, 18, Theme.Ui(9f), Theme.TextSub));

        SunkenPanel pathBox = new SunkenPanel();
        pathBox.SetBounds(20, 42, 524, 34);
        card.Controls.Add(pathBox);

        pathBox.Controls.Add(Theme.Txt(Installer.TargetDir, 13, 0, 498, 34, Theme.Mono(8.8f), Theme.TextSub));

        _purge = new RoundCheck();
        _purge.Text = "同时删除会话记录和配置（含 API Key，删了恢复不了）";
        _purge.SetBounds(18, 94, 524, 24);
        card.Controls.Add(_purge);

        _status = Theme.Txt("会话数据默认留在 " + Installer.DataDirs()[1] + "，不勾选就不动它。",
            20, 128, 524, 60, Theme.Ui(8.8f), Theme.TextDim);
        _status.TextAlign = ContentAlignment.TopLeft;
        card.Controls.Add(_status);

        _close = new PillButton();
        _close.Text = "关闭";
        _close.SetBounds(344, 330, 96, 38);
        _close.Click += delegate { Close(); };
        Controls.Add(_close);

        _go = new PillButton();
        _go.Text = "卸载";
        _go.Danger = true;
        _go.SetBounds(452, 330, 140, 38);
        _go.Click += delegate { StartUninstall(); };
        Controls.Add(_go);

        Controls.Add(Theme.Txt("这个窗口关掉后，程序文件会自己删干净",
            28, 338, 300, 18, Theme.Ui(8.6f), Theme.TextFaint));

        // 窗口关掉之后才轮到删自己（这时 exe 才真的没人占用）
        FormClosed += delegate { if (_removed) Installer.ScheduleSelfDelete(); };
    }

    void StartUninstall()
    {
        if (_done) { Close(); return; }
        _go.Enabled = false;
        _close.Enabled = false;
        _purge.Enabled = false;
        bool purgeData = _purge.Checked;
        _status.ForeColor = Theme.TextDim;
        _status.Text = "正在卸载…";
        System.Threading.ThreadPool.QueueUserWorkItem(delegate(object state)
        {
            // silent=true：这一步的确认框就是窗口本身，别再弹一个
            int removed = Installer.Uninstall(true, purgeData);
            BeginInvoke((MethodInvoker)delegate
            {
                if (removed < 0)
                {
                    _status.Text = "已取消。";
                    _go.Enabled = true;
                    _close.Enabled = true;
                    _purge.Enabled = true;
                    return;
                }
                _done = true;
                _removed = true;
                _status.ForeColor = Theme.Good;
                string done = "已卸载（删除 " + removed + " 个文件"
                    + (purgeData ? "，会话数据也已清除" : "") + "）。";
                _go.Text = "完成";
                _go.Enabled = true;
                _close.Enabled = true;
                // 卸载完也自己关：关窗后才轮到删自己（FormClosed 里排删除）
                AutoClose(_status, done, 3);
            });
        });
    }
}
