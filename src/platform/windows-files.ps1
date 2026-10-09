$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
Add-Type -WarningAction SilentlyContinue -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PikpakLocalFiles {
  public static void WatchParent(int pid) {
    System.Diagnostics.Process parent = System.Diagnostics.Process.GetProcessById(pid);
    System.Threading.Thread watcher = new System.Threading.Thread(delegate() { try { parent.WaitForExit(); } finally { Environment.Exit(1); } });
    watcher.IsBackground = true; watcher.Start();
  }
  [StructLayout(LayoutKind.Sequential)] struct UnicodeName { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct Attributes { public int Length; public IntPtr RootDirectory, ObjectName; public uint Flags; public IntPtr SecurityDescriptor, QualityOfService; }
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status, Information; }
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Flags; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Modified;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetDiskFreeSpaceExW(string path, out ulong available, out ulong total, out ulong free);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int type, IntPtr data, uint size);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref Attributes attributes, out IoStatus status, IntPtr allocationSize, uint flags, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
  class Entry { public SafeFileHandle Handle; public FileStream Stream; public bool Directory; public string Volume; public uint Serial; }
  public class Identity { public string volume, file; }
  public class Info { public Identity identity; public string size; }
  static Dictionary<string, Entry> entries = new Dictionary<string, Entry>();
  static Exception Failure(uint error) {
    string code = error == 80 || error == 183 ? "EEXIST" : error == 2 || error == 3 ? "ENOENT"
      : error == 112 || error == 39 ? "ENOSPC" : error == 5 ? "EACCES" : "native-failure";
    return new Exception(code);
  }
  static void Name(string value) {
    if (String.IsNullOrEmpty(value) || value == "." || value == ".." || value.IndexOfAny(new char[]{'\\','/',':','\0'}) >= 0) throw new Exception("unsafe-path");
  }
  static Entry Get(string key) { Entry entry; if (!entries.TryGetValue(key, out entry)) throw new Exception("native-failure"); return entry; }
  static FileInfo NativeInfo(SafeFileHandle handle) {
    FileInfo info; if (!GetFileInformationByHandle(handle, out info)) throw Failure((uint)Marshal.GetLastWin32Error()); return info;
  }
  static string Save(Entry entry) { string id = Guid.NewGuid().ToString(); entries.Add(id, entry); return id; }
  public static string Root(string path) {
    SafeFileHandle handle = CreateFileW(path, 0x001201BF, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw Failure((uint)Marshal.GetLastWin32Error()); }
    try {
      FileInfo info = NativeInfo(handle);
      if ((info.Flags & 0x400) != 0 || (info.Flags & 0x10) == 0) throw new Exception("unsafe-path");
      StringBuilder pathBuffer = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandleW(handle, pathBuffer, (uint)pathBuffer.Capacity, 1);
      if (length == 0 || length >= pathBuffer.Capacity) throw new Exception("native-failure");
      string full = pathBuffer.ToString(); int end = full.IndexOf('}');
      if (!full.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase) || end < 0) throw new Exception("native-failure");
      return Save(new Entry { Handle=handle, Directory=true, Volume=full.Substring(0,end+1).ToLowerInvariant(), Serial=info.Volume });
    } catch { handle.Dispose(); throw; }
  }
  static Entry Open(Entry parent, string name, bool directory, bool create, bool readOnly) {
    if (create && readOnly) throw new Exception("native-failure");
    if (!parent.Directory) throw new Exception("unsafe-path"); Name(name);
    IntPtr buffer = Marshal.StringToHGlobalUni(name), unicodePointer = IntPtr.Zero;
    SafeFileHandle handle = null;
    try {
      int length = Encoding.Unicode.GetByteCount(name); if (length > 65532) throw new Exception("unsafe-path");
      UnicodeName unicode = new UnicodeName { Length=(ushort)length, MaximumLength=(ushort)(length+2), Buffer=buffer };
      unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeName))); Marshal.StructureToPtr(unicode, unicodePointer, false);
      Attributes attributes = new Attributes { Length=Marshal.SizeOf(typeof(Attributes)), RootDirectory=parent.Handle.DangerousGetHandle(), ObjectName=unicodePointer, Flags=0x1040 };
      IoStatus status;
      int result = NtCreateFile(out handle, directory ? 0x001201BFu : readOnly ? 0x00120089u : 0x0013019Fu, ref attributes, out status, IntPtr.Zero,
        directory ? 0x10u : 0x80u, 3, create ? 2u : 1u, 0x00200020u | (readOnly ? 0u : 2u) | (directory ? 1u : 0x40u), IntPtr.Zero, 0);
      if (result < 0 || handle == null || handle.IsInvalid) throw Failure(RtlNtStatusToDosError(result));
      FileInfo info = NativeInfo(handle);
      if ((info.Flags & 0x400) != 0 || info.Volume != parent.Serial || ((info.Flags & 0x10) != 0) != directory || (!directory && info.Links != 1)) throw new Exception("unsafe-path");
      Entry entry = new Entry { Handle=handle, Directory=directory, Volume=parent.Volume, Serial=parent.Serial };
      if (!directory) entry.Stream = new FileStream(handle, readOnly ? FileAccess.Read : FileAccess.ReadWrite, 65536, false);
      return entry;
    } catch { if (handle != null) handle.Dispose(); throw; }
    finally { Marshal.FreeHGlobal(buffer); if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer); }
  }
  public static string Child(string parent, string name, bool directory, bool create, bool readOnly) { return Save(Open(Get(parent), name, directory, create, readOnly)); }
  static ulong Pair(uint high, uint low) { return ((ulong)high << 32) | low; }
  public static Info Information(string key) {
    Entry entry = Get(key); FileInfo info = NativeInfo(entry.Handle);
    if ((info.Flags & 0x400) != 0 || info.Volume != entry.Serial) throw new Exception("unsafe-path");
    return new Info { identity=new Identity { volume=entry.Volume, file=Pair(info.IndexHigh,info.IndexLow).ToString()+":"+Pair((uint)info.Created.dwHighDateTime,(uint)info.Created.dwLowDateTime).ToString() }, size=Pair(info.SizeHigh,info.SizeLow).ToString() };
  }
  public static string Free(string key) {
    Entry entry = Get(key); ulong available,total,free;
    if (!GetDiskFreeSpaceExW(entry.Volume+"\\",out available,out total,out free)) throw Failure((uint)Marshal.GetLastWin32Error());
    return available.ToString();
  }
  public static string Read(string key, string offset, int length) {
    if (length < 0 || length > 65536) throw new Exception("native-failure");
    Entry entry=Get(key); if (entry.Directory) throw new Exception("native-failure");
    entry.Stream.Position=Int64.Parse(offset); byte[] bytes=new byte[length]; int read=entry.Stream.Read(bytes,0,length); return Convert.ToBase64String(bytes,0,read);
  }
  public static void Write(string key, string offset, string data) {
    Entry entry=Get(key); if (entry.Directory) throw new Exception("native-failure");
    byte[] bytes=Convert.FromBase64String(data); if (bytes.Length>65536) throw new Exception("native-failure");
    entry.Stream.Position=Int64.Parse(offset); entry.Stream.Write(bytes,0,bytes.Length);
  }
  public static void Truncate(string key, string size) { Get(key).Stream.SetLength(Int64.Parse(size)); }
  public static void Sync(string key) {
    Entry entry=Get(key);
    if (entry.Stream != null) entry.Stream.Flush(true);
    else if (!FlushFileBuffers(entry.Handle)) throw Failure((uint)Marshal.GetLastWin32Error());
  }
  public static bool Publish(string source, string name, string destination, string target) {
    Name(target); Entry parent=Get(source), destinationEntry=Get(destination);
    if (!destinationEntry.Directory || parent.Volume!=destinationEntry.Volume) throw new Exception("unsafe-path");
    Entry file=Open(parent,name,false,false,false);
    try {
      file.Stream.Flush(true);
      byte[] text=Encoding.Unicode.GetBytes(target);
      int rootOffset=IntPtr.Size==8 ? 8 : 4, lengthOffset=rootOffset+IntPtr.Size, nameOffset=lengthOffset+4;
      IntPtr data=Marshal.AllocHGlobal(nameOffset+text.Length+2);
      try {
        for (int i=0;i<nameOffset+text.Length+2;i++) Marshal.WriteByte(data,i,0);
        Marshal.WriteIntPtr(data,rootOffset,destinationEntry.Handle.DangerousGetHandle());
        Marshal.WriteInt32(data,lengthOffset,text.Length); Marshal.Copy(text,0,IntPtr.Add(data,nameOffset),text.Length);
        if (!SetFileInformationByHandle(file.Handle,3,data,(uint)(nameOffset+text.Length+2))) {
          uint error=(uint)Marshal.GetLastWin32Error(); if (error==80 || error==183) return false; throw Failure(error);
        }
        file.Stream.Flush(true);
        return true;
      } finally { Marshal.FreeHGlobal(data); }
    } finally { file.Stream.Dispose(); }
  }
  public static void Close(string key) {
    Entry entry; if (!entries.TryGetValue(key,out entry)) return;
    entries.Remove(key); if (entry.Stream!=null) entry.Stream.Dispose(); else entry.Handle.Dispose();
  }
  public static void CloseAll() { foreach (string key in new List<string>(entries.Keys)) Close(key); }
}
'@
[PikpakLocalFiles]::WatchParent([int]$env:PIKPAK_BRIDGE_PARENT_PID)
[Console]::WriteLine('{"ready":true}')
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $r = $line | ConvertFrom-Json
    $value = $null
    switch ($r.action) {
      'root' { $value = [PikpakLocalFiles]::Root([string]$r.path) }
      'child' { $value = [PikpakLocalFiles]::Child([string]$r.parent,[string]$r.name,[bool]$r.directory,[bool]$r.create,[bool]$r.readOnly) }
      'info' { $value = [PikpakLocalFiles]::Information([string]$r.id) }
      'free' { $value = [PikpakLocalFiles]::Free([string]$r.id) }
      'read' { $value = [PikpakLocalFiles]::Read([string]$r.id,[string]$r.offset,[int]$r.length) }
      'write' { [PikpakLocalFiles]::Write([string]$r.id,[string]$r.offset,[string]$r.data) }
      'truncate' { [PikpakLocalFiles]::Truncate([string]$r.id,[string]$r.size) }
      'sync' { [PikpakLocalFiles]::Sync([string]$r.id) }
      'publish' { $value = [PikpakLocalFiles]::Publish([string]$r.id,[string]$r.name,[string]$r.target,[string]$r.targetName) }
      'close' { [PikpakLocalFiles]::Close([string]$r.id) }
      default { throw 'native-failure' }
    }
    [Console]::WriteLine((@{ok=$true;value=$value} | ConvertTo-Json -Compress -Depth 5))
  } catch {
    $errorValue=$_.Exception
    while ($errorValue.InnerException) { $errorValue=$errorValue.InnerException }
    $code=[string]$errorValue.Message
    if (($errorValue.HResult -band 65535) -in @(112,39)) { $code='ENOSPC' }
    if ($code -notin @('EEXIST','ENOENT','ENOSPC','EACCES','unsafe-path')) { $code='native-failure' }
    [Console]::WriteLine((@{ok=$false;code=$code} | ConvertTo-Json -Compress))
  }
}
} catch { [Console]::WriteLine('{"ok":false,"code":"native-failure"}'); exit 1 }
finally { if ('PikpakLocalFiles' -as [type]) { [PikpakLocalFiles]::CloseAll() } }
