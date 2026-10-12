// PowerTerminal 🧭 도우미 앱 — 화면 맨 위에 포인터와 말풍선을 띄워 "다음에 할 일"을 짚어 준다.
// PT 서버(/api/guide/helper)에서 지금 단계를 읽고, 바탕화면 단계는 창 이름·버튼 이름으로 대상을 찾아(UI Automation)
// 사용자가 그곳을 누르면 체크한다. 웹 단계의 위치는 PT 가 브라우저에서 재 준다.
// PT 의 [🧭 도우미 설치] 가 윈도우에 기본으로 있는 C# 컴파일러(.NET Framework 4)로 이 파일을 PtHelper.exe 로 만든다 — C# 5 문법만.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

static class Program {
  public const string VER = "1";
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [STAThread]
  static void Main(string[] args) {
    try { SetProcessDPIAware(); } catch { }
    bool fresh;
    Mutex mx = new Mutex(true, "PowerTerminalGuideHelper", out fresh);
    if (!fresh) return;                       // 이미 떠 있다
    int port = 7777;
    if (args.Length > 0) int.TryParse(args[0], out port);
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    Application.Run(new Helper(port));
    GC.KeepAlive(mx);
  }
}

static class W32 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
  [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int W, H; public SIZE(int w, int h) { W = w; H = h; } }
  [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct BLEND { public byte Op, Flags, Alpha, Format; }
  [DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref POINT pt, ref SIZE sz, IntPtr src, ref POINT spt, int key, ref BLEND b, int flags);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  public static readonly IntPtr TOPMOST = new IntPtr(-1);
}

// 마우스가 통과하는 반투명 창(포인터·테두리용). 픽셀마다 투명도를 준다.
class LayerForm : Form {
  public LayerForm() { FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual; TopMost = true; }
  protected override CreateParams CreateParams {
    get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x80000 | 0x20 | 0x80 | 0x8000000 | 0x8; return cp; }   // LAYERED·TRANSPARENT·TOOLWINDOW·NOACTIVATE·TOPMOST
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  public void SetBits(Bitmap bmp, int x, int y) {
    IntPtr scr = W32.GetDC(IntPtr.Zero), mem = W32.CreateCompatibleDC(scr), hb = IntPtr.Zero, old = IntPtr.Zero;
    try {
      hb = bmp.GetHbitmap(Color.FromArgb(0)); old = W32.SelectObject(mem, hb);
      W32.POINT p = new W32.POINT(x, y), s0 = new W32.POINT(0, 0); W32.SIZE sz = new W32.SIZE(bmp.Width, bmp.Height);
      W32.BLEND b = new W32.BLEND(); b.Op = 0; b.Flags = 0; b.Alpha = 255; b.Format = 1;
      W32.UpdateLayeredWindow(Handle, scr, ref p, ref sz, mem, ref s0, 0, ref b, 2);
    } finally {
      W32.ReleaseDC(IntPtr.Zero, scr);
      if (hb != IntPtr.Zero) { W32.SelectObject(mem, old); W32.DeleteObject(hb); }
      W32.DeleteDC(mem);
    }
  }
  public void MoveTo(int x, int y) { W32.SetWindowPos(Handle, W32.TOPMOST, x, y, 0, 0, 0x1 | 0x10); }
}

// 말풍선 — 단계 글과 [했어요][이전][닫기]. 눌러야 하니 마우스를 받는다(포커스는 뺏지 않음).
class Bubble : Form {
  public string Head = "", Text1 = "", Note = "";
  public string[] Btn = new string[0];
  public Action<int> OnBtn;
  readonly float k;
  readonly Font fHead, fText, fNote, fBtn;
  Rectangle[] btnR = new Rectangle[0];
  int hover = -1;
  public Bubble(float scale) {
    k = scale;
    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual; TopMost = true;
    BackColor = Color.FromArgb(31, 22, 48); DoubleBuffered = true;
    fHead = new Font("Malgun Gothic", 8.5f, FontStyle.Bold); fText = new Font("Malgun Gothic", 10.5f, FontStyle.Bold);
    fNote = new Font("Malgun Gothic", 8.5f); fBtn = new Font("Malgun Gothic", 9f, FontStyle.Bold);
  }
  protected override CreateParams CreateParams { get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x80 | 0x8000000 | 0x8; return cp; } }
  protected override bool ShowWithoutActivation { get { return true; } }
  int P(float v) { return (int)Math.Round(v * k); }
  public void Layout2() {
    int maxW = P(300), pad = P(12);
    TextFormatFlags wrap = TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix;
    Size hs = TextRenderer.MeasureText(Head, fHead, new Size(maxW, 999), wrap);
    Size ts = TextRenderer.MeasureText(Text1, fText, new Size(maxW, 999), wrap);
    Size ns = Note.Length > 0 ? TextRenderer.MeasureText(Note, fNote, new Size(maxW, 999), wrap) : Size.Empty;
    int bx = pad, bw = 0, bh = P(28);
    btnR = new Rectangle[Btn.Length];
    for (int i = 0; i < Btn.Length; i++) {
      int w = TextRenderer.MeasureText(Btn[i], fBtn).Width + P(18);
      btnR[i] = new Rectangle(bx, 0, w, bh); bx += w + P(6); bw = bx - P(6);
    }
    int w0 = Math.Max(Math.Max(hs.Width, ts.Width), Math.Max(ns.Width, bw - pad)) + pad * 2;
    int y = pad + hs.Height + P(3) + ts.Height + (ns.Height > 0 ? P(4) + ns.Height : 0) + (Btn.Length > 0 ? P(10) : 0);
    for (int i = 0; i < btnR.Length; i++) btnR[i].Y = y;
    // [닫기] 는 오른쪽 끝으로
    if (btnR.Length > 1) { Rectangle r = btnR[btnR.Length - 1]; r.X = w0 - pad - r.Width; btnR[btnR.Length - 1] = r; }
    int h0 = y + (Btn.Length > 0 ? bh : 0) + pad;
    Size = new Size(w0, h0);
    using (GraphicsPath gp = Round(new Rectangle(0, 0, w0, h0), P(12))) Region = new Region(gp);
    Invalidate();
  }
  static GraphicsPath Round(Rectangle r, int rad) {
    GraphicsPath p = new GraphicsPath(); int d = rad * 2;
    p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90); p.CloseFigure(); return p;
  }
  protected override void OnPaint(PaintEventArgs e) {
    Graphics g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
    int pad = P(12), maxW = Width - pad * 2;
    using (Pen pen = new Pen(Color.FromArgb(168, 85, 247), Math.Max(2, P(2)))) using (GraphicsPath gp = Round(new Rectangle(1, 1, Width - 3, Height - 3), P(11))) g.DrawPath(pen, gp);
    TextFormatFlags wrap = TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix;
    Size hs = TextRenderer.MeasureText(Head, fHead, new Size(maxW, 999), wrap);
    TextRenderer.DrawText(g, Head, fHead, new Rectangle(pad, pad, maxW, hs.Height), Color.FromArgb(216, 180, 254), wrap);
    int y = pad + hs.Height + P(3);
    Size ts = TextRenderer.MeasureText(Text1, fText, new Size(maxW, 999), wrap);
    TextRenderer.DrawText(g, Text1, fText, new Rectangle(pad, y, maxW, ts.Height), Color.White, wrap);
    y += ts.Height;
    if (Note.Length > 0) { y += P(4); TextRenderer.DrawText(g, Note, fNote, new Rectangle(pad, y, maxW, 999), Color.FromArgb(252, 165, 165), wrap); }
    for (int i = 0; i < btnR.Length; i++) {
      Rectangle r = btnR[i];
      bool main = i == 0 && Btn.Length > 1, last = i == btnR.Length - 1 && Btn.Length > 1;
      using (GraphicsPath gp = Round(r, P(7))) {
        if (main) using (LinearGradientBrush lb = new LinearGradientBrush(r, Color.FromArgb(138, 56, 245), Color.FromArgb(236, 72, 153), 0f)) g.FillPath(lb, gp);
        else if (!last) using (SolidBrush sb = new SolidBrush(hover == i ? Color.FromArgb(75, 85, 99) : Color.FromArgb(55, 65, 81))) g.FillPath(sb, gp);
        else if (hover == i) using (SolidBrush sb = new SolidBrush(Color.FromArgb(55, 65, 81))) g.FillPath(sb, gp);
        if (main && hover == i) using (Pen hp = new Pen(Color.White, Math.Max(1, P(1.5f)))) g.DrawPath(hp, gp);
      }
      TextRenderer.DrawText(g, Btn[i], fBtn, r, last ? Color.FromArgb(203, 213, 225) : Color.White, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
    }
  }
  protected override void OnMouseMove(MouseEventArgs e) {
    int h = -1; for (int i = 0; i < btnR.Length; i++) if (btnR[i].Contains(e.Location)) h = i;
    if (h != hover) { hover = h; Cursor = h >= 0 ? Cursors.Hand : Cursors.Default; Invalidate(); }
  }
  protected override void OnMouseLeave(EventArgs e) { if (hover != -1) { hover = -1; Invalidate(); } }
  protected override void OnMouseClick(MouseEventArgs e) {
    for (int i = 0; i < btnR.Length; i++) if (btnR[i].Contains(e.Location) && OnBtn != null) OnBtn(i);
  }
}

class Helper : ApplicationContext {
  readonly int port;
  readonly float k;
  readonly LayerForm cur, ring;
  readonly Bubble bub;
  readonly NotifyIcon tray;
  readonly System.Windows.Forms.Timer ui;
  readonly JavaScriptSerializer json = new JavaScriptSerializer();
  readonly object lk = new object();
  Dictionary<string, object> st;           // 서버가 준 지금 단계
  Rectangle deskRect = Rectangle.Empty;    // UI Automation 으로 찾은 바탕화면 대상
  string deskKey = "", deskNote = "";
  bool paused, quitting;
  DateTime lastOk = DateTime.Now;
  // 그리기 상태
  PointF curPos = new PointF(float.NaN, float.NaN);
  string shownKey = "", bubSig = "", postedKey = "";
  Rectangle ringRect = Rectangle.Empty;
  bool wasDown;
  int pulse;
  Point bubAnchor = Point.Empty;
  Bitmap curBmp;                           // 포인터 그림 — 창을 보일 때마다 다시 얹는다(숨겼다 보이면 지워짐)

  public Helper(int p) {
    port = p;
    using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) k = g.DpiX / 96f;
    cur = new LayerForm(); ring = new LayerForm(); bub = new Bubble(k);
    bub.OnBtn = OnButton;
    DrawCursor();
    tray = new NotifyIcon();
    tray.Icon = MakeIcon(); tray.Text = "PowerTerminal 도우미"; tray.Visible = true;
    ContextMenu menu = new ContextMenu();
    MenuItem pause = new MenuItem("잠시 숨기기 / Hide");
    pause.Click += delegate { paused = !paused; pause.Checked = paused; };
    menu.MenuItems.Add(pause);
    menu.MenuItems.Add(new MenuItem("PowerTerminal 열기 / Open", delegate { try { System.Diagnostics.Process.Start("http://localhost:" + port + "/"); } catch { } }));
    menu.MenuItems.Add(new MenuItem("끝내기 / Quit", delegate { Quit(); }));
    tray.ContextMenu = menu;
    new Thread(PollLoop) { IsBackground = true }.Start();
    new Thread(UiaLoop) { IsBackground = true }.Start();
    ui = new System.Windows.Forms.Timer(); ui.Interval = 16; ui.Tick += delegate { Tick(); }; ui.Start();
  }
  int P(float v) { return (int)Math.Round(v * k); }
  void Quit() {
    if (quitting) return; quitting = true;
    try { tray.Visible = false; tray.Dispose(); } catch { }
    ExitThread();
  }
  static Icon MakeIcon() {
    Bitmap b = new Bitmap(32, 32);
    using (Graphics g = Graphics.FromImage(b)) {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      using (LinearGradientBrush lb = new LinearGradientBrush(new Rectangle(0, 0, 32, 32), Color.FromArgb(138, 56, 245), Color.FromArgb(236, 72, 153), 45f)) g.FillEllipse(lb, 1, 1, 30, 30);
      Point[] arrow = { new Point(10, 7), new Point(23, 15), new Point(17, 17), new Point(15, 24) };
      g.FillPolygon(Brushes.White, arrow);
    }
    return Icon.FromHandle(b.GetHicon());
  }
  // 포인터 — 보라 화살표, 흰 테두리, 그림자
  void DrawCursor() {
    int s = P(40);
    Bitmap b = new Bitmap(s, s, PixelFormat.Format32bppArgb); {
      using (Graphics g = Graphics.FromImage(b)) {
        g.SmoothingMode = SmoothingMode.AntiAlias; g.Clear(Color.Transparent);
        float q = k * 1.35f;
        PointF[] a = { new PointF(3 * q, 2 * q), new PointF(10.5f * q, 21 * q), new PointF(13.1f * q, 13.1f * q), new PointF(21 * q, 10.5f * q) };
        PointF[] sh = new PointF[a.Length]; for (int i = 0; i < a.Length; i++) sh[i] = new PointF(a[i].X + 2 * k, a[i].Y + 3 * k);
        using (SolidBrush sb = new SolidBrush(Color.FromArgb(90, 0, 0, 0))) g.FillPolygon(sb, sh);
        using (SolidBrush fb = new SolidBrush(Color.FromArgb(168, 85, 247))) g.FillPolygon(fb, a);
        using (Pen pen = new Pen(Color.White, 1.8f * k)) { pen.LineJoin = LineJoin.Round; g.DrawPolygon(pen, a); }
      }
      curBmp = b;
    }
  }
  void DrawRing(Rectangle r) {
    int m = P(12);
    int w = r.Width + m * 2, h = r.Height + m * 2;
    if (w < 4 || h < 4 || w > 8000 || h > 8000) return;
    using (Bitmap b = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(b)) {
        g.SmoothingMode = SmoothingMode.AntiAlias; g.Clear(Color.Transparent);
        double t = (Math.Sin(pulse / 10.0) + 1) / 2;            // 0..1 숨쉬기
        int glow = (int)(P(3) + t * P(5));
        for (int i = glow; i > 0; i--) {
          using (Pen gp = new Pen(Color.FromArgb((int)(18 + 30 * (1 - (double)i / glow)), 236, 72, 153), 2f))
            g.DrawRectangle(gp, m - P(4) - i, m - P(4) - i, r.Width + P(8) + i * 2, r.Height + P(8) + i * 2);
        }
        using (Pen pen = new Pen(Color.FromArgb(168, 85, 247), Math.Max(2.5f, 3 * k))) g.DrawRectangle(pen, m - P(4), m - P(4), r.Width + P(8), r.Height + P(8));
      }
      ring.SetBits(b, r.X - m, r.Y - m);
    }
  }

  // ---------- 서버 ----------
  void PollLoop() {
    int pid = System.Diagnostics.Process.GetCurrentProcess().Id;
    while (!quitting) {
      try {
        using (WebClient wc = new WebClient()) {
          wc.Encoding = Encoding.UTF8;
          string s = wc.DownloadString("http://127.0.0.1:" + port + "/api/guide/helper?v=" + Program.VER + "&pid=" + pid);
          Dictionary<string, object> d = json.Deserialize<Dictionary<string, object>>(s);
          lock (lk) st = d;
          lastOk = DateTime.Now;
          if (B(d, "quit")) { Invoke0(Quit); return; }
        }
      } catch {
        lock (lk) st = null;
        if ((DateTime.Now - lastOk).TotalSeconds > 90) { Invoke0(Quit); return; }   // PT 가 꺼졌다
      }
      Thread.Sleep(350);
    }
  }
  void Invoke0(Action a) { try { if (bub.IsHandleCreated) bub.BeginInvoke(a); else a(); } catch { } }
  void Post(string act, Dictionary<string, object> d) {
    if (d == null) return;
    string body = json.Serialize(new Dictionary<string, object> { { "sid", S(d, "sid") }, { "gid", S(d, "gid") }, { "act", act }, { "i", I(d, "i") } });
    ThreadPool.QueueUserWorkItem(delegate {
      try { using (WebClient wc = new WebClient()) { wc.Encoding = Encoding.UTF8; wc.Headers[HttpRequestHeader.ContentType] = "application/json"; wc.UploadString("http://127.0.0.1:" + port + "/api/guide/helper/act", body); } } catch { }
    });
  }
  static string S(Dictionary<string, object> d, string key) { object v; return d != null && d.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : ""; }
  static int I(Dictionary<string, object> d, string key) { object v; try { return d != null && d.TryGetValue(key, out v) && v != null ? Convert.ToInt32(v) : -1; } catch { return -1; } }
  static bool B(Dictionary<string, object> d, string key) { object v; return d != null && d.TryGetValue(key, out v) && v is bool && (bool)v; }
  static Dictionary<string, object> D(Dictionary<string, object> d, string key) { object v; return d != null && d.TryGetValue(key, out v) ? v as Dictionary<string, object> : null; }
  static Rectangle R(object v) {
    IList a = v as IList; if (a == null || a.Count < 4) return Rectangle.Empty;
    try { return new Rectangle(Convert.ToInt32(a[0]), Convert.ToInt32(a[1]), Convert.ToInt32(a[2]), Convert.ToInt32(a[3])); } catch { return Rectangle.Empty; }
  }

  // ---------- 바탕화면 대상 찾기 (UI Automation) ----------
  void UiaLoop() {
    AutomationElement cached = null; string cachedFor = "";
    int me = System.Diagnostics.Process.GetCurrentProcess().Id;
    while (!quitting) {
      Dictionary<string, object> d; lock (lk) d = st;
      string key = d == null ? "" : S(d, "gid") + ":" + S(d, "i");
      try {
        if (d != null && B(d, "on") && !B(d, "finished") && S(d, "kind") == "desktop") {
          string win = S(d, "window"), ctl = S(d, "control"), done = S(d, "done"), until = S(d, "until");
          if (done == "window" && until.Length > 0 && FindWindow(until, me) != null && postedKey != key) { postedKey = key; Post("done", d); }
          AutomationElement w = win.Length > 0 ? FindWindow(win, me) : null;
          Rectangle r = Rectangle.Empty; string note = "";
          if (ctl.Length > 0) {
            if (cached != null && cachedFor == key) { try { r = ToRect(cached.Current.BoundingRectangle); if (cached.Current.IsOffscreen) r = Rectangle.Empty; } catch { cached = null; } }
            if (r.IsEmpty) {
              cached = FindControl(w, ctl, me); cachedFor = key;
              if (cached != null) try { r = ToRect(cached.Current.BoundingRectangle); } catch { r = Rectangle.Empty; }
            }
            Dictionary<string, object> L = D(d, "L");
            if (r.IsEmpty) note = (w == null && win.Length > 0) ? S(L, "findWin").Replace("{t}", win) : S(L, "findCtl").Replace("{t}", ctl);
          } else if (w != null) {
            Rectangle wr = Rectangle.Empty; try { wr = ToRect(w.Current.BoundingRectangle); } catch { }
            if (!wr.IsEmpty) r = new Rectangle(wr.X, wr.Y, wr.Width, Math.Min(wr.Height, P(36)));   // 창이면 제목줄을 짚는다
          } else if (win.Length > 0 && done != "window") note = S(D(d, "L"), "findWin").Replace("{t}", win);
          lock (lk) { deskRect = r; deskKey = key; deskNote = note; }
        } else { cached = null; lock (lk) { deskRect = Rectangle.Empty; deskKey = key; deskNote = ""; } }
      } catch { }
      Thread.Sleep(600);
    }
  }
  static Rectangle ToRect(System.Windows.Rect r) {
    if (r.IsEmpty || double.IsInfinity(r.Width) || r.Width < 2 || r.Height < 2) return Rectangle.Empty;
    return new Rectangle((int)r.X, (int)r.Y, (int)r.Width, (int)r.Height);
  }
  static AutomationElement FindWindow(string part, int me) {
    string p = part.ToLowerInvariant();
    AutomationElementCollection all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
    AutomationElement best = null;
    foreach (AutomationElement e in all) {
      try {
        if (e.Current.ProcessId == me) continue;
        string n = (e.Current.Name ?? "").ToLowerInvariant();
        if (n.Length == 0 || !n.Contains(p)) continue;
        if (e.Current.BoundingRectangle.IsEmpty) { if (best == null) best = e; continue; }
        return e;
      } catch { }
    }
    return best;
  }
  // 이름이 맞는 요소 — 똑같은 이름 > 앞이 같음 > 포함, 누를 수 있는 종류를 먼저. 큰 창도 2초 안에서 끊는다.
  static AutomationElement FindControl(AutomationElement scope, string name, int me) {
    string want = name.Trim().ToLowerInvariant();
    List<AutomationElement> roots = new List<AutomationElement>();
    if (scope != null) roots.Add(scope);
    else foreach (AutomationElement e in AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition)) {
      try { if (e.Current.ProcessId != me && !e.Current.IsOffscreen) roots.Add(e); } catch { }
    }
    TreeWalker tw = TreeWalker.ControlViewWalker;
    DateTime until = DateTime.Now.AddSeconds(2);
    AutomationElement best = null; int bestScore = 0, seen = 0;
    Queue<AutomationElement> q = new Queue<AutomationElement>(roots);
    while (q.Count > 0 && seen < 6000 && DateTime.Now < until) {
      AutomationElement e = q.Dequeue(); seen++;
      try {
        string n = (e.Current.Name ?? "").Trim().ToLowerInvariant();
        if (n.Length > 0 && !e.Current.IsOffscreen) {
          int s = n == want ? 30 : n.StartsWith(want) ? 20 : n.Contains(want) ? 10 : 0;
          if (s > 0) {
            ControlType t = e.Current.ControlType;
            if (t == ControlType.Button || t == ControlType.MenuItem || t == ControlType.Hyperlink || t == ControlType.TabItem || t == ControlType.ListItem
                || t == ControlType.CheckBox || t == ControlType.Edit || t == ControlType.ComboBox || t == ControlType.TreeItem || t == ControlType.SplitButton) s += 5;
            if (s > bestScore && !e.Current.BoundingRectangle.IsEmpty) { best = e; bestScore = s; if (s >= 35) break; }
          }
        }
        AutomationElement c = tw.GetFirstChild(e);
        while (c != null) { q.Enqueue(c); c = tw.GetNextSibling(c); }
      } catch { }
    }
    return best;
  }

  // ---------- 그리기 (60fps) ----------
  void Tick() {
    if (quitting) return;
    Dictionary<string, object> d; Rectangle dr; string dk, dnote;
    lock (lk) { d = st; dr = deskRect; dk = deskKey; dnote = deskNote; }
    bool on = d != null && B(d, "on") && !paused;
    if (!on) { HideAll(); return; }
    string key = S(d, "gid") + ":" + S(d, "i");
    bool fin = B(d, "finished");
    string kind = S(d, "kind");
    Dictionary<string, object> L = D(d, "L");
    Rectangle target = Rectangle.Empty; bool showRing = false; string note = "";
    if (!fin && kind == "desktop" && dk == key) { target = dr; showRing = !dr.IsEmpty; note = dr.IsEmpty ? dnote : ""; }
    if (!fin && kind == "web") {
      Dictionary<string, object> wb = D(d, "web");
      Rectangle r = R(wb == null ? null : (wb.ContainsKey("rect") ? wb["rect"] : null));
      if (!r.IsEmpty && B(wb, "front")) target = r;       // 테두리는 페이지가 그린다
      else note = r.IsEmpty ? S(L, "inBrowser") : S(L, "inTab").Replace("{t}", S(wb, "title"));
    }
    // 말풍선 내용
    int n = I(d, "n"), i = I(d, "i");
    string head = "🧭 " + S(d, "title") + (fin ? "" : "  ·  " + (i + 1) + " / " + n);
    string[] btns = fin ? new string[] { S(L, "close") } : (i > 0 ? new string[] { S(L, "ok"), S(L, "prev"), S(L, "close") } : new string[] { S(L, "ok"), S(L, "close") });
    string sig = head + "|" + S(d, "text") + "|" + note + "|" + string.Join(",", btns);
    if (sig != bubSig) { bubSig = sig; bub.Head = head; bub.Text1 = S(d, "text"); bub.Note = note; bub.Btn = btns; bub.Layout2(); }
    if (key != shownKey) { shownKey = key; wasDown = true; }
    // 대상이 있으면 포인터가 그리로 미끄러져 가고, 없으면 말풍선이 마우스를 따라다닌다
    Point m = Cursor.Position;
    if (!target.IsEmpty) {
      PointF to = new PointF(target.X + Math.Min(target.Width / 2f, P(40)), target.Y + Math.Min(target.Height / 2f, P(18)));
      if (float.IsNaN(curPos.X)) curPos = new PointF(m.X, m.Y);
      curPos = new PointF(curPos.X + (to.X - curPos.X) * 0.14f, curPos.Y + (to.Y - curPos.Y) * 0.14f);
      if (!cur.Visible) cur.Show();
      cur.SetBits(curBmp, (int)curPos.X - P(4), (int)curPos.Y - P(3));   // 매번 얹는다 — 한 번만 얹으면 보이자마자 지워졌다(실측)
      Rectangle wa = Screen.FromPoint(Point.Round(to)).WorkingArea;
      int bx = (int)to.X + P(16), by = target.Bottom + P(14);
      if (by + bub.Height > wa.Bottom - P(8)) by = target.Y - bub.Height - P(14);
      bx = Math.Max(wa.X + P(8), Math.Min(wa.Right - bub.Width - P(8), bx));
      by = Math.Max(wa.Y + P(8), by);
      PlaceBubble(new Point(bx, by), true);
    } else {
      curPos = new PointF(float.NaN, float.NaN);
      if (cur.Visible) cur.Hide();
      Rectangle near = bub.Bounds; near.Inflate(P(60), P(60));
      if (!bub.Visible || !near.Contains(m)) {      // 말풍선 쪽으로 다가가면 멈춰서 누를 수 있게
        Rectangle wa = Screen.FromPoint(m).WorkingArea;
        int bx = m.X + P(22), by = m.Y + P(26);
        if (bx + bub.Width > wa.Right - P(8)) bx = m.X - bub.Width - P(16);
        if (by + bub.Height > wa.Bottom - P(8)) by = m.Y - bub.Height - P(16);
        PlaceBubble(new Point(Math.Max(wa.X, bx), Math.Max(wa.Y, by)), false);
      }
    }
    if (showRing) {
      pulse++;
      if (target != ringRect || pulse % 4 == 0) { ringRect = target; DrawRing(target); }
      if (!ring.Visible) ring.Show();
    } else if (ring.Visible) { ring.Hide(); ringRect = Rectangle.Empty; }
    if (pulse % 60 == 0) { W32.SetWindowPos(bub.Handle, W32.TOPMOST, 0, 0, 0, 0, 0x1 | 0x2 | 0x10); }
    pulse++;
    // 바탕화면 대상 클릭 = 그 단계 끝
    bool down = (W32.GetAsyncKeyState(0x01) & 0x8000) != 0;
    if (down && !wasDown && kind == "desktop" && !fin && !target.IsEmpty && S(d, "done") == "click") {
      Rectangle hit = target; hit.Inflate(P(4), P(4));
      if (hit.Contains(m) && !bub.Bounds.Contains(m) && postedKey != key) { postedKey = key; Post("done", d); }
    }
    wasDown = down;
  }
  void PlaceBubble(Point p, bool smooth) {
    if (!bub.Visible) { bub.Location = p; bubAnchor = p; bub.Show(); return; }
    if (smooth) {
      int x = bub.Left + (int)Math.Round((p.X - bub.Left) * 0.18), y = bub.Top + (int)Math.Round((p.Y - bub.Top) * 0.18);
      if (Math.Abs(p.X - x) < 2) x = p.X; if (Math.Abs(p.Y - y) < 2) y = p.Y;
      if (x != bub.Left || y != bub.Top) bub.Location = new Point(x, y);
    } else if (bub.Location != p) bub.Location = p;
  }
  void HideAll() {
    if (cur.Visible) cur.Hide(); if (ring.Visible) ring.Hide(); if (bub.Visible) bub.Hide();
    curPos = new PointF(float.NaN, float.NaN); ringRect = Rectangle.Empty; bubSig = "";
  }
  void OnButton(int idx) {
    Dictionary<string, object> d; lock (lk) d = st;
    if (d == null) return;
    string label = bub.Btn.Length > idx ? bub.Btn[idx] : "";
    Dictionary<string, object> L = D(d, "L");
    string act = label == S(L, "ok") ? "done" : label == S(L, "prev") ? "prev" : "stop";
    if (act == "done") postedKey = S(d, "gid") + ":" + S(d, "i");
    Post(act, d);
  }
}
