# 录导览用：把贴在台面块上的应用窗口画成 PNG（PrintWindow，窗口在屏幕外也画得出来）。
# 标准输入一行一个「十六进制 hwnd|输出路径」，每画完一张回一行「ok 左 上 宽 高」（失败回「err」）。只读，不动窗口。
Add-Type -ReferencedAssemblies System.Drawing @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class PW {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public static string Shot(IntPtr h, string path) {
    R r; if (!GetWindowRect(h, out r)) return "err";
    int w = r.Rt - r.L, ht = r.B - r.T; if (w < 4 || ht < 4) return "err";
    using (Bitmap b = new Bitmap(w, ht, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(b)) { IntPtr dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
      b.Save(path, ImageFormat.Png);
    }
    return "ok " + r.L + " " + r.T + " " + w + " " + ht;
  }
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split('|')
  try { [Console]::Out.WriteLine([PW]::Shot([IntPtr][Convert]::ToInt64($p[0], 16), $p[1])) } catch { [Console]::Out.WriteLine("err") }
  [Console]::Out.Flush()
}
