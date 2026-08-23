# One-shot background removal: flood-fill from edges + edge feathering -> transparent PNG
# Uses LockBits pixel copy (no DrawImage, which fails on some PNGs)
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File make-transparent.ps1 -Src <in.png> -Dst <out.png> [-Threshold 200]
param(
  [string]$Src,
  [string]$Dst,
  [int]$Threshold = 226
)
Add-Type -AssemblyName System.Drawing
$petCode = @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class PetBgRemover {
  public static void Run(string src, string dst, int threshold) {
    Bitmap srcBmp = new Bitmap(src);
    int w = srcBmp.Width, h = srcBmp.Height;
    Rectangle rect = new Rectangle(0, 0, w, h);
    BitmapData srcData = srcBmp.LockBits(rect, ImageLockMode.ReadOnly, srcBmp.PixelFormat);
    int sStride = srcData.Stride;
    byte[] sBytes = new byte[sStride * h];
    Marshal.Copy(srcData.Scan0, sBytes, 0, sBytes.Length);
    srcBmp.UnlockBits(srcData);
    srcBmp.Dispose();
    int spp = Image.GetPixelFormatSize(srcData.PixelFormat) / 8;
    if (spp < 3) spp = 3;
    int stride = w * 4;
    byte[] px = new byte[stride * h];
    for (int y = 0; y < h; y++) {
      int srow = y * sStride;
      int trow = y * stride;
      for (int x = 0; x < w; x++) {
        int so = srow + x * spp;
        int to = trow + x * 4;
        px[to] = sBytes[so];
        px[to + 1] = sBytes[so + 1];
        px[to + 2] = sBytes[so + 2];
        px[to + 3] = 255;
      }
    }
    bool[] bg = new bool[w * h];
    Stack<int> stack = new Stack<int>();
    Func<int, bool> isBg = delegate (int i) {
      int o = i * 4;
      int m = px[o];
      if (px[o + 1] < m) m = px[o + 1];
      if (px[o + 2] < m) m = px[o + 2];
      return m >= threshold;
    };
    for (int x = 0; x < w; x++) {
      int i0 = x, i1 = (h - 1) * w + x;
      if (!bg[i0] && isBg(i0)) { bg[i0] = true; stack.Push(i0); }
      if (!bg[i1] && isBg(i1)) { bg[i1] = true; stack.Push(i1); }
    }
    for (int y = 1; y < h - 1; y++) {
      int i0 = y * w, i1 = y * w + w - 1;
      if (!bg[i0] && isBg(i0)) { bg[i0] = true; stack.Push(i0); }
      if (!bg[i1] && isBg(i1)) { bg[i1] = true; stack.Push(i1); }
    }
    while (stack.Count > 0) {
      int i = stack.Pop();
      int x = i % w, y = i / w;
      for (int dy = -1; dy <= 1; dy++) {
        int ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (int dx = -1; dx <= 1; dx++) {
          if (dx == 0 && dy == 0) continue;
          int nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          int j = ny * w + nx;
          if (!bg[j] && isBg(j)) { bg[j] = true; stack.Push(j); }
        }
      }
    }
    int bgCount = 0;
    for (int i = 0; i < w * h; i++) if (bg[i]) bgCount++;
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int i = y * w + x, o = i * 4;
        if (bg[i]) {
          px[o + 3] = 0;
        } else {
          bool edge = false;
          for (int dy = -1; dy <= 1 && !edge; dy++) {
            int ny = y + dy;
            if (ny < 0 || ny >= h) continue;
            for (int dx = -1; dx <= 1; dx++) {
              if (dx == 0 && dy == 0) continue;
              int nx = x + dx;
              if (nx < 0 || nx >= w) continue;
              if (bg[ny * w + nx]) { edge = true; break; }
            }
          }
          if (edge) {
            int m = px[o];
            if (px[o + 1] < m) m = px[o + 1];
            if (px[o + 2] < m) m = px[o + 2];
            int a = (int)(((m - threshold) / 20.0) * 255);
            if (a < 0) a = 0; if (a > 255) a = 255;
            px[o + 3] = (byte)a;
          } else {
            px[o + 3] = 255;
          }
        }
      }
    }
    Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    BitmapData data = bmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    Marshal.Copy(px, 0, data.Scan0, px.Length);
    bmp.UnlockBits(data);
    bmp.Save(dst, ImageFormat.Png);
    bmp.Dispose();
    Console.Error.WriteLine("bgCount=" + bgCount + " of " + (w * h));
  }
}
"@
Add-Type -TypeDefinition $petCode -ReferencedAssemblies @('System.Drawing')
[PetBgRemover]::Run($Src, $Dst, $Threshold)
Write-Output "done"
