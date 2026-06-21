param([Parameter(Mandatory)][string]$Path)

# Play an audio file (mp3/wav/etc) via Windows MCI — no GUI window, no dispatcher required.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MCINative {
  [DllImport("winmm.dll", CharSet = CharSet.Auto)]
  public static extern int mciSendString(string command, System.Text.StringBuilder ret, int len, IntPtr hwnd);
}
'@

$resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
if (-not $resolved) { exit 1 }
$resolved = $resolved.Path

$buf = New-Object System.Text.StringBuilder(256)
[MCINative]::mciSendString("open `"$resolved`" type mpegvideo alias clawbell", $buf, 256, [IntPtr]::Zero) | Out-Null
[MCINative]::mciSendString("play clawbell wait", $buf, 256, [IntPtr]::Zero) | Out-Null
[MCINative]::mciSendString("close clawbell", $buf, 256, [IntPtr]::Zero) | Out-Null
