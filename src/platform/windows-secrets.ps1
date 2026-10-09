$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PikpakCredentials {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool ReadNative(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool WriteNative(ref Credential credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool DeleteNative(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
  static readonly Encoding Utf8 = new UTF8Encoding(false, true);
  public static string Read(string target) {
    IntPtr pointer;
    if (!ReadNative(target, 1, 0, out pointer)) {
      if (Marshal.GetLastWin32Error() == 1168) return null;
      throw new Exception("credential-read-failed");
    }
    try {
      Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (credential.Type != 1 || credential.Persist != 2 || credential.CredentialBlobSize > 2560) throw new Exception("credential-policy-mismatch");
      byte[] bytes = new byte[credential.CredentialBlobSize];
      try { Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length); return Utf8.GetString(bytes); }
      finally { Array.Clear(bytes, 0, bytes.Length); }
    } finally { CredFree(pointer); }
  }
  public static void Write(string target, string value) {
    byte[] bytes = Utf8.GetBytes(value);
    if (bytes.Length > 2560) throw new Exception("credential-too-large");
    IntPtr blob = Marshal.AllocHGlobal(Math.Max(1, bytes.Length));
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      Credential credential = new Credential();
      credential.Type = 1; credential.TargetName = target;
      credential.CredentialBlob = blob; credential.CredentialBlobSize = (UInt32)bytes.Length;
      credential.Persist = 2; // CRED_PERSIST_LOCAL_MACHINE，禁止漫游。
      if (!WriteNative(ref credential, 0)) throw new Exception("credential-write-failed");
      if (Read(target) != value) throw new Exception("credential-verification-failed");
    } finally {
      for (int i=0; i<bytes.Length; i++) Marshal.WriteByte(blob, i, 0);
      Marshal.FreeHGlobal(blob); Array.Clear(bytes, 0, bytes.Length);
    }
  }
  public static void Delete(string target) {
    if (!DeleteNative(target, 1, 0) && Marshal.GetLastWin32Error() != 1168) throw new Exception("credential-delete-failed");
  }
}
'@
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.reference -notmatch '^[a-zA-Z0-9.-]{1,200}$') { throw 'invalid-reference' }
  $target = 'com.rozx.pikpak-downloader/' + $request.reference
  $value = $null
  switch ($request.action) {
    'get' { $value = [PikpakCredentials]::Read($target) }
    'set' { [PikpakCredentials]::Write($target, [string]$request.value) }
    'delete' { [PikpakCredentials]::Delete($target) }
    default { throw 'invalid-action' }
  }
  [Console]::WriteLine((@{ok=$true;value=$value} | ConvertTo-Json -Compress))
} catch {
  [Console]::WriteLine('{"ok":false}')
  exit 1
}
