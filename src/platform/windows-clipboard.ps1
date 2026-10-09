$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PikpakClipboard {
  [DllImport("user32.dll")] static extern UInt32 GetClipboardSequenceNumber();
  [DllImport("user32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool CloseClipboard();
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool IsClipboardFormatAvailable(UInt32 format);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetClipboardData(UInt32 format);
  [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr memory);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
  [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GlobalUnlock(IntPtr memory);
  public class Snapshot { public string sequence; public string text; public bool stable; }
  public static Snapshot Read() {
    UInt32 before = GetClipboardSequenceNumber();
    if (!OpenClipboard(IntPtr.Zero)) throw new Exception("clipboard-unavailable");
    string text = null;
    try {
      if (IsClipboardFormatAvailable(13)) {
        IntPtr memory = GetClipboardData(13);
        if (memory == IntPtr.Zero) throw new Exception("clipboard-unavailable");
        UInt64 bytes = GlobalSize(memory).ToUInt64();
        if (bytes <= 131074 && bytes >= 2 && bytes % 2 == 0) {
          IntPtr pointer = GlobalLock(memory);
          if (pointer == IntPtr.Zero) throw new Exception("clipboard-unavailable");
          try {
            char[] chars = new char[(int)(bytes/2)];
            Marshal.Copy(pointer, chars, 0, chars.Length);
            int length = Array.IndexOf(chars, '\0');
            if (length < 0) throw new Exception("clipboard-invalid-text");
            text = new string(chars, 0, length);
          } finally { GlobalUnlock(memory); }
        }
      }
    } finally { CloseClipboard(); }
    UInt32 after = GetClipboardSequenceNumber();
    return new Snapshot { sequence=after.ToString(), text=text, stable=before==after };
  }
}
'@
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    if ($line -ne 'read') { throw 'invalid-command' }
    $snapshot = [PikpakClipboard]::Read()
    [Console]::WriteLine((@{ok=$true;sequence=$snapshot.sequence;text=$snapshot.text;stable=$snapshot.stable} | ConvertTo-Json -Compress))
  } catch { [Console]::WriteLine('{"ok":false}') }
}
} catch { [Console]::WriteLine('{"ok":false}'); exit 1 }
