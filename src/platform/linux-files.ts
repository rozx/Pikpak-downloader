import { dlopen, FFIType, read as readPointer } from "bun:ffi";
import { close, constants, fsync, ftruncate, read, write } from "node:fs";
import type { LocalDirectory, LocalFile, LocalFileSystem } from "./files";
import type { FileIdentity } from "./types";

// Linux 目录句柄经 bun:ffi 直接调用 glibc，语义与 native/macos.mm 一致。错误只返回固定类别，不返回路径。
const symbols = {
  openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  fsync: { args: [FFIType.i32], returns: FFIType.i32 },
  statx: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  fstatfs: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
} as const;
type Libc = ReturnType<typeof dlopen<typeof symbols>>["symbols"];
let libc: Libc | undefined;
function c(): Libc { return libc ??= dlopen("libc.so.6", symbols).symbols; }

const AT_FDCWD = -100, AT_SYMLINK_NOFOLLOW = 0x100, AT_EMPTY_PATH = 0x1000;
// O_DIRECTORY 与 O_NOFOLLOW 在 x64 与 arm64 上取值不同，取运行时常量；O_CLOEXEC 两者相同。
const O_CLOEXEC = 0o2000000;
const STATX_BASIC_STATS = 0x7ff, STATX_BTIME = 0x800, RENAME_NOREPLACE = 1;
const S_IFMT = 0o170000, S_IFREG = 0o100000;
const errno = { EPERM: 1, ENOENT: 2, EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENOSPC: 28, ENAMETOOLONG: 36, ENOTEMPTY: 39, ELOOP: 40 };

function fail(code: string): never { throw Object.assign(Error(code), { code }); }
// 失败调用后立即读取 errno，中间不执行其他 JS。
function lastError(): number { const location = c().__errno_location(); return location ? readPointer.i32(location, 0) : 0; }
function fileError(reason: number): never {
  switch (reason) {
    case errno.EEXIST: fail("EEXIST");
    case errno.ENOENT: fail("ENOENT");
    case errno.ENOSPC: fail("ENOSPC");
    case errno.ELOOP: case errno.ENOTDIR: fail("unsafe-path");
    case errno.EACCES: case errno.EPERM: fail("EACCES");
    case errno.ENAMETOOLONG: fail("ENAMETOOLONG");
    default: fail("filesystem-operation-failed");
  }
}
function check(result: number): number { if (result < 0) fileError(lastError()); return result; }
function text(value: string): Buffer {
  if (value.includes("\0")) fail("embedded-null");
  return Buffer.from(`${value}\0`, "utf8");
}
function component(name: string): Buffer {
  if (!name || name === "." || name === ".." || name.includes("/")) fail("unsafe-component");
  return text(name);
}
const empty = Buffer.from("\0");

type Status = { mode: number; links: number; inode: bigint; device: string; birth: string | null; size: bigint };
// struct statx 的布局与架构无关。
function status(fd: number, name: Buffer = empty, flags = AT_EMPTY_PATH): Status {
  const buffer = Buffer.alloc(256);
  check(c().statx(fd, name, flags | AT_SYMLINK_NOFOLLOW, STATX_BASIC_STATS | STATX_BTIME, buffer));
  const mask = buffer.readUInt32LE(0);
  return {
    mode: buffer.readUInt16LE(28), links: buffer.readUInt32LE(16), inode: buffer.readBigUInt64LE(32), size: buffer.readBigUInt64LE(40),
    device: `${buffer.readUInt32LE(136)}:${buffer.readUInt32LE(140)}`,
    birth: mask & STATX_BTIME ? `${buffer.readBigInt64LE(80)}:${buffer.readUInt32LE(88)}` : null,
  };
}
// x64 与 arm64 的 glibc struct statfs 布局相同：f_bsize@8、f_bavail@32、f_fsid@56、f_frsize@72。
function filesystem(fd: number): Buffer { const buffer = Buffer.alloc(128); check(c().fstatfs(fd, buffer)); return buffer; }
// 卷标识取 f_fsid（ext4、xfs、btrfs 由文件系统 UUID 派生）；文件标识为 inode 加创建时间，文件系统不提供创建时间时记为 0:0。
function identity(fd: number): FileIdentity {
  const fsid = filesystem(fd).subarray(56, 64);
  if (fsid.every(byte => byte === 0)) fail("volume-identity-unavailable");
  const info = status(fd);
  return { volume: fsid.toString("hex"), file: `${info.inode}:${info.birth ?? "0:0"}` };
}
const settle = <T>(run: (done: (error: NodeJS.ErrnoException | null, value?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => run((error, value) => error ? reject(error) : resolve(value as T)));
function position(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("file-offset-unrepresentable");
  return Number(value);
}
// 未显式关闭的目录句柄在回收时关闭，与 macOS 原生句柄的析构一致。
const leaked = new FinalizationRegistry<number>(fd => { c().close(fd); });

class LinuxFile implements LocalFile {
  private closed = false;
  constructor(private readonly fd: number) {}
  private check() { if (this.closed) throw Error("file-closed"); }
  async info() { this.check(); return { identity: identity(this.fd), size: status(this.fd).size }; }
  async read(offset: bigint, length: number) {
    this.check(); const fd = this.fd, buffer = Buffer.alloc(length);
    const bytes = await settle<number>(done => read(fd, buffer, 0, length, position(offset), done));
    return buffer.subarray(0, bytes);
  }
  async write(offset: bigint, data: Uint8Array) {
    this.check(); const fd = this.fd;
    for (let written = 0; written < data.byteLength;) {
      const bytes = await settle<number>(done => write(fd, data, written, data.byteLength - written, position(offset + BigInt(written)), done));
      if (!bytes) throw Error("zero-byte-write");
      written += bytes;
    }
  }
  async truncate(size: bigint) { this.check(); const fd = this.fd; await settle<void>(done => ftruncate(fd, position(size), done)); }
  async sync() { this.check(); const fd = this.fd; await settle<void>(done => fsync(fd, done)); }
  async close() { if (!this.closed) { this.closed = true; const fd = this.fd; await settle<void>(done => close(fd, done)); } }
}

class LinuxDirectory implements LocalDirectory {
  private closed = false;
  private constructor(private readonly fd: number, private readonly device: string) { leaked.register(this, fd, this); }
  static open(parent: number, name: Buffer, device: string | null): LinuxDirectory {
    const fd = check(c().openat(parent, name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC, 0));
    let actual: string;
    try { actual = status(fd).device; } catch (error) { c().close(fd); throw error; }
    if (device !== null && actual !== device) { c().close(fd); fail("unexpected-filesystem"); }
    return new LinuxDirectory(fd, actual);
  }
  private check() { if (this.closed) throw Error("directory-closed"); }
  async identity() { this.check(); return identity(this.fd); }
  async freeBytes() {
    this.check(); const stats = filesystem(this.fd);
    const fragment = stats.readBigInt64LE(72);
    return stats.readBigUInt64LE(32) * BigInt(fragment > 0n ? fragment : stats.readBigInt64LE(8));
  }
  async child(name: string, create: boolean) {
    this.check(); const encoded = component(name);
    if (create) check(c().mkdirat(this.fd, encoded, 0o700));
    const directory = LinuxDirectory.open(this.fd, encoded, this.device);
    if (create && c().fsync(this.fd) < 0) { const reason = lastError(); await directory.close(); fileError(reason); }
    return directory;
  }
  async file(name: string, create: boolean, readOnly = false) {
    this.check(); const encoded = component(name);
    if (create && readOnly) fail("invalid-file-arguments");
    const flags = (readOnly ? constants.O_RDONLY : constants.O_RDWR) | constants.O_NOFOLLOW | O_CLOEXEC | (create ? constants.O_CREAT | constants.O_EXCL : 0);
    const fd = check(c().openat(this.fd, encoded, flags, 0o600));
    let info: Status;
    try { info = status(fd); } catch (error) { c().close(fd); throw error; }
    if ((info.mode & S_IFMT) !== S_IFREG || info.links !== 1 || info.device !== this.device) { c().close(fd); fail("unsafe-file"); }
    return new LinuxFile(fd);
  }
  async publish(sourceName: string, target: LocalDirectory, targetName: string) {
    this.check(); if (!(target instanceof LinuxDirectory)) throw Error("filesystem-mismatch"); target.check();
    const from = component(sourceName), to = component(targetName);
    if (this.device !== target.device) fail("unexpected-filesystem");
    const info = status(this.fd, from, 0);
    if ((info.mode & S_IFMT) !== S_IFREG || info.links !== 1) fail("unsafe-file");
    if (c().renameat2(this.fd, from, target.fd, to, RENAME_NOREPLACE) < 0) {
      const reason = lastError();
      if (reason === errno.EEXIST || reason === errno.EISDIR || reason === errno.ENOTEMPTY) return false;
      // 文件系统不支持不覆盖改名时直接报错，不以可能覆盖目标的方式代替。
      if (reason === errno.EINVAL) fail("exclusive-rename-unsupported");
      fileError(reason);
    }
    check(c().fsync(target.fd)); check(c().fsync(this.fd));
    return true;
  }
  async sync() { this.check(); check(c().fsync(this.fd)); }
  async close() { if (!this.closed) { this.closed = true; leaked.unregister(this); c().close(this.fd); } }
}

export const linuxFileSystem: LocalFileSystem = {
  root: async path => LinuxDirectory.open(AT_FDCWD, text(path), null),
  close: async () => {},
};
