$ErrorActionPreference = "Stop"

$endpoint = $env:XSOAR_ASSISTANT_HOTKEY_ENDPOINT
$token = $env:XSOAR_ASSISTANT_HOTKEY_TOKEN
if ([string]::IsNullOrWhiteSpace($endpoint) -or [string]::IsNullOrWhiteSpace($token)) {
  throw "The XSOAR Incident Assistant keyboard trigger is missing its local session details."
}

$uri = [Uri]$endpoint
if ($uri.Scheme -ne "http" -or $uri.Host -ne "127.0.0.1") {
  throw "The XSOAR Incident Assistant keyboard trigger only accepts a loopback HTTP endpoint."
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class XsoarAssistantNative {
  public const uint WM_HOTKEY = 0x0312;

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int x; public int y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MSG {
    public IntPtr hwnd;
    public uint message;
    public UIntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public POINT pt;
  }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint virtualKey);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

  [DllImport("user32.dll")]
  public static extern int GetMessage(out MSG message, IntPtr hWnd, uint minFilter, uint maxFilter);
}
"@

# VK_ADD is the physical Numpad+ key. No modifiers are required.
if (-not [XsoarAssistantNative]::RegisterHotKey([IntPtr]::Zero, 1, 0, 0x6B)) {
  throw "Numpad+ is already registered by another application."
}

Write-Output "READY"

try {
  $message = New-Object XsoarAssistantNative+MSG
  while ([XsoarAssistantNative]::GetMessage([ref]$message, [IntPtr]::Zero, 0, 0) -gt 0) {
    if ($message.message -ne [XsoarAssistantNative]::WM_HOTKEY) {
      continue
    }

    try {
      Invoke-WebRequest -UseBasicParsing -Method Post -Uri $endpoint `
        -Headers @{ "X-Assistant-Hotkey-Token" = $token } -TimeoutSec 180 | Out-Null
    } catch {
      # The local page displays any workflow failure. Do not write incident data to disk.
    }
  }
} finally {
  [XsoarAssistantNative]::UnregisterHotKey([IntPtr]::Zero, 1) | Out-Null
}
