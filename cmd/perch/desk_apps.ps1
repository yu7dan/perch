# 台面「应用」启动台的清单：开始菜单里的应用（shell:AppsFolder，桌面程序和商店应用都在里面）+ 每个应用自己的图标。
# 由 Perch 用 -EncodedCommand 跑（desk_native_windows.go），图标写进 $env:PERCH_APPICON_DIR，清单以 JSON 打到标准输出。
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$dir = $env:PERCH_APPICON_DIR
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class PerchAppIcon {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx; public int cy; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  public static bool Save(string parsing, string outPath, int px) {
    IntPtr hbm = IntPtr.Zero;
    try {
      IShellItemImageFactory f;
      SHCreateItemFromParsingName(parsing, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
      SIZE s; s.cx = px; s.cy = px;
      if (f.GetImage(s, 0, out hbm) != 0 || hbm == IntPtr.Zero) return false;
      using (Bitmap src = Image.FromHbitmap(hbm)) {
        // FromHbitmap 丢了透明度：按原始字节重新解释成预乘 ARGB（壳给的就是预乘的 32 位位图）
        Rectangle r = new Rectangle(0, 0, src.Width, src.Height);
        BitmapData bd = src.LockBits(r, ImageLockMode.ReadOnly, src.PixelFormat);
        try {
          using (Bitmap a = new Bitmap(bd.Width, bd.Height, bd.Stride, PixelFormat.Format32bppPArgb, bd.Scan0))
          using (Bitmap o = new Bitmap(a)) { o.Save(outPath, ImageFormat.Png); }
        } finally { src.UnlockBits(bd); }
      }
      return true;
    } catch { return false; }
    finally { if (hbm != IntPtr.Zero) DeleteObject(hbm); }
  }
}
"@
$md5 = [Security.Cryptography.MD5]::Create()
function Get-PerchHash([string]$s) { (($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)) | ForEach-Object { $_.ToString('x2') }) -join '') }
$skipName = '(?i)uninstall|卸载|readme|自述|release notes|help|帮助|manual|手册|documentation|文档|website|官网|license|许可'
$skipPath = '(?i)\.(url|chm|txt|pdf|html?|rtf|md|ini|log)$|^https?:'
$seen = @{}
$out = New-Object System.Collections.ArrayList
$shell = New-Object -ComObject Shell.Application
foreach ($it in $shell.NameSpace('shell:::{4234d49b-0245-4df3-b780-3893943456e1}').Items()) {
  $name = [string]$it.Name; $id = [string]$it.Path
  if (-not $name -or -not $id) { continue }
  if ($name -match $skipName -or $id -match $skipPath) { continue }
  if ($seen.ContainsKey($name)) { continue }
  $seen[$name] = 1
  $exe = ''
  if ($id -match '(?i)\.exe$') { $exe = [IO.Path]::GetFileName($id) }
  $icon = (Get-PerchHash $id) + '.png'
  $p = Join-Path $dir $icon
  if (-not (Test-Path $p)) { if (-not [PerchAppIcon]::Save("shell:AppsFolder\$id", $p, 64)) { $icon = '' } }
  [void]$out.Add([pscustomobject]@{ id = $id; name = $name; exe = $exe; icon = $icon })
}
ConvertTo-Json -InputObject @($out) -Compress
