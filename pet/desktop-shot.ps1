# Desktop screenshot capture (primary screen) -> PNG
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File desktop-shot.ps1 -Out <path.png> [-MaxW <pixels>]
param([string]$Out, [int]$MaxW = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DskCap {
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr hdc, int nIndex);
}
"@
$hdc = [DskCap]::GetDC([IntPtr]::Zero)
$w = [DskCap]::GetDeviceCaps($hdc, 118)
$h = [DskCap]::GetDeviceCaps($hdc, 117)
[void][DskCap]::ReleaseDC([IntPtr]::Zero, $hdc)
if ($w -le 0 -or $h -le 0) { throw 'failed to query screen size' }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$g.Dispose()
if ($MaxW -gt 0 -and $w -gt $MaxW) {
  $nh = [int]($h * $MaxW / $w)
  if ($nh -lt 1) { $nh = 1 }
  $nbmp = New-Object System.Drawing.Bitmap($MaxW, $nh)
  $ng = [System.Drawing.Graphics]::FromImage($nbmp)
  $ng.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $ng.DrawImage($bmp, 0, 0, $MaxW, $nh)
  $ng.Dispose()
  $bmp.Dispose()
  $bmp = $nbmp
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("captured " + $w + "x" + $h)
