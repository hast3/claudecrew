# Crew screen bridge: the part of the "screen" MCP (lib/screen-mcp.js) that lives on the owner's desktop.
# Crew and its agents run in session 0, which cannot see or touch the desktop ("The handle is
# invalid"). So this runs in the owner's logged-in session via the "CrewScreen" scheduled task
# (Interactive only, at logon) and listens on 127.0.0.1:<Port>.
# One request per connection: "<token> <base64 of UTF-8 JSON {cmd,...}>\n" -> one JSON line back.
# The token is in data/screen-token.txt. Every command is refused while Computer control is OFF.
# All the Win32 work is in the C# class below; JSON out is ASCII-escaped so encodings never bite.
param([int]$Port = 7790)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tokenFile = Join-Path $root 'data\screen-token.txt'
$controlFile = Join-Path $root 'data\computer-control.json'
Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class CrewScreen {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] static extern short VkKeyScan(char c);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);

  public static void Init() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}
    try { SetProcessDPIAware(); } catch {}
  }

  // ---- JSON out (ASCII only)
  public static string Q(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"') b.Append("\\\""); else if (c == '\\') b.Append("\\\\");
      else if (c < 32 || c > 126) b.AppendFormat("\\u{0:x4}", (int)c); else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  // ---- windows
  static string Title(IntPtr h) {
    int n = GetWindowTextLength(h); if (n <= 0) return "";
    var s = new StringBuilder(n + 1); GetWindowText(h, s, s.Capacity); return s.ToString();
  }
  static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }
  static string ProcName(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }
  static List<IntPtr> TopWindows() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h) && GetWindowTextLength(h) > 0 && !Cloaked(h) && GetWindow(h, 4) == IntPtr.Zero) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static string ListWindows() {
    var fg = GetForegroundWindow();
    var b = new StringBuilder("[");
    bool first = true;
    foreach (var h in TopWindows()) {
      RECT r; GetWindowRect(h, out r);
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!first) b.Append(','); first = false;
      b.AppendFormat("{{\"hwnd\":{0},\"title\":{1},\"process\":{2},\"pid\":{3},\"x\":{4},\"y\":{5},\"w\":{6},\"h\":{7},\"minimized\":{8},\"focused\":{9}}}",
        h.ToInt64(), Q(Title(h)), Q(ProcName(h)), pid, r.L, r.T, r.R - r.L, r.B - r.T,
        IsIconic(h) ? "true" : "false", h == fg ? "true" : "false");
    }
    return b.Append(']').ToString();
  }
  // Exact title first, then "starts with", then "contains" (case-insensitive). Process name counts too.
  public static long Find(string q) {
    if (string.IsNullOrEmpty(q)) return 0;
    var ws = TopWindows();
    string lq = q.ToLowerInvariant();
    foreach (var h in ws) if (Title(h).ToLowerInvariant() == lq) return h.ToInt64();
    foreach (var h in ws) if (Title(h).ToLowerInvariant().StartsWith(lq)) return h.ToInt64();
    foreach (var h in ws) if (Title(h).ToLowerInvariant().Contains(lq)) return h.ToInt64();
    foreach (var h in ws) { var p = ProcName(h).ToLowerInvariant(); if (p == lq || p + ".exe" == lq) return h.ToInt64(); }
    return 0;
  }
  public static string Focus(long hw) {
    var h = new IntPtr(hw);
    if (!IsWindow(h)) return "{\"error\":\"That window is gone.\"}";
    if (IsIconic(h)) ShowWindow(h, 9);
    uint pid;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    // A tap of Alt lets a background process take the foreground.
    Key(new ushort[] { 0x12 });
    AttachThreadInput(me, fgThread, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    AttachThreadInput(me, fgThread, false);
    System.Threading.Thread.Sleep(150);
    return "{\"ok\":true,\"focused\":" + (GetForegroundWindow() == h ? "true" : "false") + "}";
  }

  // ---- capture
  static bool MostlyBlack(Bitmap b) {
    int dark = 0, n = 0;
    for (int y = 0; y < b.Height; y += Math.Max(1, b.Height / 24))
      for (int x = 0; x < b.Width; x += Math.Max(1, b.Width / 24)) {
        var c = b.GetPixel(x, y); n++;
        if (c.R + c.G + c.B < 24) dark++;
      }
    return n == 0 || dark > n * 0.97;
  }
  public static string Capture(long hw, int maxW, string savePath, int rx, int ry, int rw, int rh) {
    int ox, oy, w, h; Bitmap bmp;
    if (hw == 0) {
      var vs = System.Windows.Forms.SystemInformation.VirtualScreen;
      ox = vs.X; oy = vs.Y; w = vs.Width; h = vs.Height;
      bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(ox, oy, 0, 0, new Size(w, h));
    } else {
      var hwnd = new IntPtr(hw);
      if (!IsWindow(hwnd)) return "{\"error\":\"That window is gone.\"}";
      if (IsIconic(hwnd)) return "{\"error\":\"That window is minimized. Use focus_window first.\"}";
      RECT r; GetWindowRect(hwnd, out r);
      ox = r.L; oy = r.T; w = r.R - r.L; h = r.B - r.T;
      if (w <= 0 || h <= 0) return "{\"error\":\"That window has no size.\"}";
      bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      bool ok;
      using (var g = Graphics.FromImage(bmp)) { var dc = g.GetHdc(); ok = PrintWindow(hwnd, dc, 2); g.ReleaseHdc(dc); }
      // Games and some GPU windows paint black through PrintWindow: copy the screen area instead.
      if (!ok || MostlyBlack(bmp)) {
        using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(ox, oy, 0, 0, new Size(w, h));
      }
    }
    // Optional zoom: crop to a screen-pixel region (clipped to the capture), then allow up to 2x.
    bool zoom = rw > 0 && rh > 0;
    if (zoom) {
      int cx = Math.Max(rx, ox), cy = Math.Max(ry, oy);
      int cr = Math.Min(rx + rw, ox + w), cb = Math.Min(ry + rh, oy + h);
      if (cr - cx < 1 || cb - cy < 1) { bmp.Dispose(); return "{\"error\":\"That region is outside the captured area.\"}"; }
      var crop = new Bitmap(cr - cx, cb - cy, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(crop)) g.DrawImage(bmp, new Rectangle(0, 0, crop.Width, crop.Height), new Rectangle(cx - ox, cy - oy, crop.Width, crop.Height), GraphicsUnit.Pixel);
      bmp.Dispose(); bmp = crop;
      ox = cx; oy = cy; w = crop.Width; h = crop.Height;
    }
    // maxW caps the longer side, so a portrait screen is not sent at full height.
    int longSide = Math.Max(w, h);
    double scale = (maxW > 0 && longSide > maxW) ? (double)maxW / longSide : 1.0;
    if (zoom) scale = Math.Min(2.0, maxW > 0 ? (double)maxW / longSide : 2.0);
    int sw = Math.Max(1, (int)Math.Round(w * scale)), sh = Math.Max(1, (int)Math.Round(h * scale));
    Bitmap small = bmp;
    if (scale != 1.0) {
      small = new Bitmap(sw, sh, PixelFormat.Format24bppRgb);
      using (var g = Graphics.FromImage(small)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImage(bmp, 0, 0, sw, sh);
      }
    }
    string saved = "";
    if (!string.IsNullOrEmpty(savePath)) {
      Directory.CreateDirectory(Path.GetDirectoryName(savePath));
      small.Save(savePath, ImageFormat.Png); saved = savePath;
    }
    string b64;
    using (var ms = new MemoryStream()) {
      var enc = Array.Find(ImageCodecInfo.GetImageEncoders(), e => e.MimeType == "image/jpeg");
      var ps = new EncoderParameters(1); ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 85L);
      small.Save(ms, enc, ps); b64 = Convert.ToBase64String(ms.ToArray());
    }
    if (small != bmp) small.Dispose(); bmp.Dispose();
    return string.Format(System.Globalization.CultureInfo.InvariantCulture,
      "{{\"ox\":{0},\"oy\":{1},\"w\":{2},\"h\":{3},\"sw\":{4},\"sh\":{5},\"scale\":{6},\"saved\":{7},\"jpeg\":\"{8}\"}}",
      ox, oy, w, h, sw, sh, scale, Q(saved), b64);
  }

  // ---- input
  static INPUT M(uint flags, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
  static INPUT K(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  static void Send(params INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
  public static string Click(int x, int y, string button, int count) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(40);
    uint down = 2, up = 4;
    if (button == "right") { down = 8; up = 16; } else if (button == "middle") { down = 32; up = 64; }
    for (int i = 0; i < Math.Max(1, count); i++) { Send(M(down, 0)); System.Threading.Thread.Sleep(30); Send(M(up, 0)); System.Threading.Thread.Sleep(60); }
    return "{\"ok\":true}";
  }
  public static string Move(int x, int y) { SetCursorPos(x, y); return "{\"ok\":true}"; }
  public static string Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1); System.Threading.Thread.Sleep(40); Send(M(2, 0));
    for (int i = 1; i <= 10; i++) { SetCursorPos(x1 + (x2 - x1) * i / 10, y1 + (y2 - y1) * i / 10); System.Threading.Thread.Sleep(20); }
    Send(M(4, 0)); return "{\"ok\":true}";
  }
  public static string Scroll(int x, int y, int down, int right) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(30);
    if (down != 0) Send(M(0x0800, unchecked((uint)(-120 * down))));
    if (right != 0) Send(M(0x1000, unchecked((uint)(120 * right))));
    return "{\"ok\":true}";
  }
  public static string TypeText(string text) {
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { Key(new ushort[] { 0x0D }); continue; }
      if (c == '\t') { Key(new ushort[] { 0x09 }); continue; }
      Send(K(0, c, 4), K(0, c, 4 | 2));
      System.Threading.Thread.Sleep(8);
    }
    return "{\"ok\":true}";
  }
  static bool Extended(ushort vk) {
    return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F || vk == 0x90 || vk == 0xA3 || vk == 0xA5;
  }
  // Press all keys in order, release in reverse: a hotkey like ctrl+shift+s.
  public static string Key(ushort[] vks) {
    foreach (var vk in vks) { Send(K(vk, (ushort)MapVirtualKey(vk, 0), Extended(vk) ? 1u : 0u)); System.Threading.Thread.Sleep(20); }
    for (int i = vks.Length - 1; i >= 0; i--) { var vk = vks[i]; Send(K(vk, (ushort)MapVirtualKey(vk, 0), (Extended(vk) ? 1u : 0u) | 2u)); System.Threading.Thread.Sleep(20); }
    return "{\"ok\":true}";
  }
  public static int CharVk(char c) { return VkKeyScan(c) & 0xFF; }
  public static int GameCount() { return Process.GetProcessesByName("Game").Length; }
}
'@
[CrewScreen]::Init()

$names = @{
  ctrl=0x11; control=0x11; shift=0x10; alt=0x12; win=0x5B; windows=0x5B; meta=0x5B; cmd=0x5B
  enter=0x0D; return=0x0D; tab=0x09; esc=0x1B; escape=0x1B; space=0x20; backspace=0x08; delete=0x2E; del=0x2E; insert=0x2D
  up=0x26; down=0x28; left=0x25; right=0x27; home=0x24; end=0x23; pageup=0x21; pagedown=0x22; pgup=0x21; pgdn=0x22
  capslock=0x14; printscreen=0x2C; pause=0x13; menu=0x5D; numlock=0x90
}
for ($i = 1; $i -le 24; $i++) { $names["f$i"] = 0x6F + $i }
for ($i = 0; $i -le 9; $i++) { $names["num$i"] = 0x60 + $i }

function Get-Vks([string]$combo) {
  $out = @()
  foreach ($part in ($combo.ToLowerInvariant() -split '\+')) {
    $p = $part.Trim()
    if ($p -eq '' -and $combo.EndsWith('+')) { $p = '+' }
    if ($names.ContainsKey($p)) { $out += [uint16]$names[$p] }
    elseif ($p.Length -eq 1) { $out += [uint16][CrewScreen]::CharVk($p[0]) }
    else { throw "Unknown key '$p'. Use names like ctrl, shift, alt, win, enter, esc, tab, f1-f12, up, a, 1." }
  }
  ,[uint16[]]$out
}

function Invoke-Request([string]$line) {
  $parts = $line.Trim() -split ' ', 2
  $token = ''
  try { $token = (Get-Content -Raw $tokenFile).Trim() } catch {}
  if (-not $token -or $parts.Count -ne 2 -or $parts[0] -ne $token) { return '{"error":"Not allowed."}' }
  $on = $false
  try { $on = [bool](Get-Content -Raw $controlFile | ConvertFrom-Json).on } catch {}
  if (-not $on) { return '{"error":"Computer control is OFF."}' }
  try {
    $r = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1])))
    switch ($r.cmd) {
      'list'    { '{"windows":' + [CrewScreen]::ListWindows() + '}' }
      'find'    { '{"hwnd":' + [CrewScreen]::Find([string]$r.title) + '}' }
      'focus'   { [CrewScreen]::Focus([long]$r.hwnd) }
      'capture' { [CrewScreen]::Capture([long]$r.hwnd, [int]$r.maxW, [string]$r.save, [int]$r.rx, [int]$r.ry, [int]$r.rw, [int]$r.rh) }
      'click'   { [CrewScreen]::Click([int]$r.x, [int]$r.y, [string]$r.button, [int]$r.count) }
      'move'    { [CrewScreen]::Move([int]$r.x, [int]$r.y) }
      'drag'    { [CrewScreen]::Drag([int]$r.x, [int]$r.y, [int]$r.x2, [int]$r.y2) }
      'scroll'  { [CrewScreen]::Scroll([int]$r.x, [int]$r.y, [int]$r.down, [int]$r.right) }
      'type'    { [CrewScreen]::TypeText([string]$r.text) }
      'key'     { [CrewScreen]::Key((Get-Vks ([string]$r.keys))) }
      'games'   { '{"count":' + [CrewScreen]::GameCount() + '}' }
      'ping'    { '{"ok":true,"session":' + (Get-Process -Id $PID).SessionId + '}' }
      default   { '{"error":"unknown command"}' }
    }
  } catch {
    '{"error":' + [CrewScreen]::Q($_.Exception.Message) + '}'
  }
}

# Only one bridge: if the port is taken, another copy is already serving.
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } catch { exit 0 }
while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $client.ReceiveTimeout = 10000
    $stream = $client.GetStream()
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::ASCII)
    $line = $reader.ReadLine()
    $res = if ($line) { Invoke-Request $line } else { '{"error":"empty request"}' }
    $bytes = [Text.Encoding]::ASCII.GetBytes($res + "`n")
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
  } catch {} finally { $client.Close() }
}
