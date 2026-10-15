import type { LocalDirectory, LocalFile, LocalFileSystem } from "../../src/platform/files";

// 包装真实文件系统，统计读取的字节数；发布时把真实目录交给原生实现。
export function countingFiles(base: LocalFileSystem) {
  const stats = { readBytes: 0 };
  const wrapFile = (file: LocalFile): LocalFile => ({
    info: () => file.info(),
    read: async (position, length) => { const bytes = await file.read(position, length); stats.readBytes += bytes.byteLength; return bytes; },
    write: (position, data) => file.write(position, data), truncate: size => file.truncate(size), sync: () => file.sync(), close: () => file.close(),
  });
  const wrapDirectory = (directory: LocalDirectory): LocalDirectory & { inner: LocalDirectory } => ({ inner: directory,
    identity: () => directory.identity(), freeBytes: () => directory.freeBytes(),
    child: async (name, create) => wrapDirectory(await directory.child(name, create)),
    file: async (name, create, readOnly) => wrapFile(await directory.file(name, create, readOnly)),
    publish: (name, target, targetName) => directory.publish(name, (target as LocalDirectory & { inner?: LocalDirectory }).inner ?? target, targetName),
    sync: () => directory.sync(), close: () => directory.close(),
  });
  const files: LocalFileSystem = { root: async path => wrapDirectory(await base.root(path)), close: async () => {} };
  return { files, stats };
}
