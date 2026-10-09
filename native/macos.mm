#import <AppKit/AppKit.h>
#include <node_api.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/attr.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <errno.h>
#include <string>
#include <set>

// macOS Node-API 桥接。错误只返回固定类别，不返回路径或剪贴板内容。
static std::set<std::string> testBoards;
static napi_value fail(napi_env env, const char *code) {
  napi_throw_error(env, code, code);
  return nullptr;
}
static bool args(napi_env env, napi_callback_info info, size_t count, napi_value *values) {
  size_t actual = count;
  if (napi_get_cb_info(env, info, &actual, values, nullptr, nullptr) != napi_ok || actual != count) {
    fail(env, "invalid-arguments"); return false;
  }
  return true;
}
static bool stringArg(napi_env env, napi_value value, std::string &out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > 1024 * 1024) {
    fail(env, "invalid-string"); return false;
  }
  out.resize(length + 1);
  if (napi_get_value_string_utf8(env, value, out.data(), out.size(), &length) != napi_ok) {
    fail(env, "invalid-string"); return false;
  }
  out.resize(length);
  if (out.find('\0') != std::string::npos) { fail(env, "embedded-null"); return false; }
  return true;
}
static napi_value boolean(napi_env env, bool value) {
  napi_value result; napi_get_boolean(env, value, &result); return result;
}
static napi_value text(napi_env env, NSString *value) {
  if (!value) { napi_value empty; napi_get_null(env, &empty); return empty; }
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
  napi_value result;
  napi_create_string_utf8(env, static_cast<const char *>(data.bytes), data.length, &result);
  return result;
}
static NSPasteboard *board(const std::string &name) {
  NSString *value = [[NSString alloc] initWithBytes:name.data() length:name.size() encoding:NSUTF8StringEncoding];
  return [NSPasteboard pasteboardWithName:value];
}
static napi_value createBoard(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    NSString *name = [NSPasteboard pasteboardWithUniqueName].name;
    if (!name) return fail(env, "clipboard-unavailable");
    testBoards.insert(name.UTF8String);
    return text(env, name);
  }
}
static napi_value generalBoard(napi_env env, napi_callback_info info) {
  @autoreleasepool { return text(env, [NSPasteboard generalPasteboard].name); }
}
static napi_value boardCount(napi_env env, napi_callback_info info) {
  napi_value values[1]; std::string name;
  if (!args(env, info, 1, values) || !stringArg(env, values[0], name)) return nullptr;
  @autoreleasepool {
    NSPasteboard *pb = board(name);
    if (!pb) return fail(env, "clipboard-unavailable");
    napi_value result; napi_create_bigint_int64(env, pb.changeCount, &result); return result;
  }
}
static napi_value boardText(napi_env env, napi_callback_info info) {
  napi_value values[1]; std::string name;
  if (!args(env, info, 1, values) || !stringArg(env, values[0], name)) return nullptr;
  @autoreleasepool {
    NSPasteboard *pb = board(name);
    if (!pb) return fail(env, "clipboard-unavailable");
    NSString *value = [pb stringForType:NSPasteboardTypeString];
    if (!value && [pb.types containsObject:NSPasteboardTypeString]) return fail(env, "clipboard-unavailable");
    if (value.length > 1024 * 1024) return fail(env, "clipboard-too-large");
    return text(env, value);
  }
}
// 测试写入只允许本进程创建的独立 pasteboard，由 TS 持有名称；探针不传 general。
static napi_value writeBoard(napi_env env, napi_callback_info info) {
  napi_value values[2]; std::string name, value;
  if (!args(env, info, 2, values) || !stringArg(env, values[0], name) || !stringArg(env, values[1], value)) return nullptr;
  @autoreleasepool {
    if (!testBoards.count(name)) return fail(env, "test-board-required");
    NSPasteboard *pb = board(name);
    NSString *content = [[NSString alloc] initWithBytes:value.data() length:value.size() encoding:NSUTF8StringEncoding];
    [pb clearContents];
    if (![pb setString:content forType:NSPasteboardTypeString]) return fail(env, "clipboard-write-failed");
    return boolean(env, true);
  }
}
static napi_value releaseBoard(napi_env env, napi_callback_info info) {
  napi_value values[1]; std::string name;
  if (!args(env, info, 1, values) || !stringArg(env, values[0], name)) return nullptr;
  @autoreleasepool {
    if (!testBoards.count(name)) return fail(env, "test-board-required");
    [board(name) releaseGlobally]; testBoards.erase(name); return boolean(env, true);
  }
}

struct Lock { int fd; };
static void finalizeLock(napi_env env, void *data, void *hint) {
  Lock *lock = static_cast<Lock *>(data);
  if (lock->fd >= 0) close(lock->fd);
  delete lock;
}
static napi_value acquireLock(napi_env env, napi_callback_info info) {
  napi_value values[1]; std::string path;
  if (!args(env, info, 1, values) || !stringArg(env, values[0], path)) return nullptr;
  int fd = open(path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) return fail(env, "lock-open-failed");
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1) {
    close(fd); return fail(env, "invalid-lock-file");
  }
  if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    int reason = errno; close(fd);
    if (reason == EWOULDBLOCK) { napi_value empty; napi_get_null(env, &empty); return empty; }
    return fail(env, "lock-failed");
  }
  Lock *lock = new Lock{fd};
  napi_value result;
  if (napi_create_external(env, lock, finalizeLock, nullptr, &result) != napi_ok) {
    finalizeLock(env, lock, nullptr); return fail(env, "lock-handle-failed");
  }
  return result;
}
static napi_value releaseLock(napi_env env, napi_callback_info info) {
  napi_value values[1]; void *data = nullptr;
  if (!args(env, info, 1, values)) return nullptr;
  if (napi_get_value_external(env, values[0], &data) != napi_ok || !data) return fail(env, "invalid-lock-handle");
  Lock *lock = static_cast<Lock *>(data);
  if (lock->fd >= 0) { close(lock->fd); lock->fd = -1; }
  return boolean(env, true);
}
static napi_value identity(napi_env env, napi_callback_info info) {
  napi_value values[1]; std::string path;
  if (!args(env, info, 1, values) || !stringArg(env, values[0], path)) return nullptr;
  struct stat st;
  if (lstat(path.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) return fail(env, "invalid-file-identity");
  napi_value result, dev, ino;
  napi_create_object(env, &result);
  napi_create_bigint_uint64(env, static_cast<uint64_t>(st.st_dev), &dev);
  napi_create_bigint_uint64(env, static_cast<uint64_t>(st.st_ino), &ino);
  napi_set_named_property(env, result, "dev", dev); napi_set_named_property(env, result, "ino", ino);
  return result;
}
static napi_value publish(napi_env env, napi_callback_info info) {
  napi_value values[2]; std::string from, to;
  if (!args(env, info, 2, values) || !stringArg(env, values[0], from) || !stringArg(env, values[1], to)) return nullptr;
  if (renamex_np(from.c_str(), to.c_str(), RENAME_EXCL) == 0) return boolean(env, true);
  if (errno == EEXIST) return boolean(env, false);
  return fail(env, "exclusive-rename-failed");
}
struct Directory { int fd; dev_t device; };
static void finalizeDirectory(napi_env env, void *data, void *hint) {
  Directory *directory = static_cast<Directory *>(data);
  if (directory->fd >= 0) close(directory->fd);
  delete directory;
}
static napi_value directoryValue(napi_env env, int fd, dev_t device) {
  Directory *directory = new Directory{fd, device}; napi_value value;
  if (napi_create_external(env, directory, finalizeDirectory, nullptr, &value) != napi_ok) {
    finalizeDirectory(env, directory, nullptr); return fail(env, "native-handle-failed");
  }
  return value;
}
static Directory *directoryArg(napi_env env, napi_value value) {
  void *pointer = nullptr;
  if (napi_get_value_external(env, value, &pointer) != napi_ok || !pointer || static_cast<Directory *>(pointer)->fd < 0) {
    fail(env, "invalid-directory-handle"); return nullptr;
  }
  return static_cast<Directory *>(pointer);
}
static bool component(napi_env env, napi_value value, std::string &name) {
  if (!stringArg(env, value, name)) return false;
  if (name.empty() || name == "." || name == ".." || name.find('/') != std::string::npos) {
    fail(env, "unsafe-component"); return false;
  }
  return true;
}
static napi_value fileError(napi_env env) {
  switch (errno) {
    case EEXIST: return fail(env, "EEXIST");
    case ENOENT: return fail(env, "ENOENT");
    case ENOSPC: return fail(env, "ENOSPC");
    case ELOOP: case ENOTDIR: return fail(env, "unsafe-path");
    case EACCES: case EPERM: return fail(env, "EACCES");
    case ENAMETOOLONG: return fail(env, "ENAMETOOLONG");
    default: return fail(env, "filesystem-operation-failed");
  }
}
static napi_value rootOpen(napi_env env, napi_callback_info info) {
  napi_value values[1]; std::string path;
  if (!args(env, info, 1, values) || !stringArg(env, values[0], path)) return nullptr;
  int fd = open(path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return fileError(env);
  struct stat st;
  if (fstat(fd, &st) != 0) { close(fd); return fail(env, "directory-stat-failed"); }
  return directoryValue(env, fd, st.st_dev);
}
static napi_value directoryOpen(napi_env env, napi_callback_info info) {
  napi_value values[3]; std::string name; bool create = false;
  if (!args(env, info, 3, values) || !component(env, values[1], name) || napi_get_value_bool(env, values[2], &create) != napi_ok) return fail(env, "invalid-directory-arguments");
  Directory *parent = directoryArg(env, values[0]); if (!parent) return nullptr;
  if (create && mkdirat(parent->fd, name.c_str(), 0700) != 0) return fileError(env);
  int fd = openat(parent->fd, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return fileError(env);
  struct stat st;
  if (fstat(fd, &st) != 0 || st.st_dev != parent->device) { close(fd); return fail(env, "unexpected-filesystem"); }
  if (create && fsync(parent->fd) != 0) { close(fd); return fileError(env); }
  return directoryValue(env, fd, parent->device);
}
static napi_value directoryIdentity(napi_env env, napi_callback_info info) {
  napi_value values[1]; if (!args(env, info, 1, values)) return nullptr;
  Directory *directory = directoryArg(env, values[0]); if (!directory) return nullptr;
  struct stat st; if (fstat(directory->fd, &st) != 0) return fileError(env);
  napi_value result, dev, ino;
  napi_create_object(env, &result); napi_create_bigint_uint64(env, st.st_dev, &dev); napi_create_bigint_uint64(env, st.st_ino, &ino);
  napi_set_named_property(env, result, "dev", dev); napi_set_named_property(env, result, "ino", ino); return result;
}
static napi_value descriptorIdentity(napi_env env, int fd) {
  struct stat st; if (fstat(fd, &st) != 0) return fileError(env);
  struct attrlist attributes = {};
  attributes.bitmapcount = ATTR_BIT_MAP_COUNT;
  attributes.volattr = ATTR_VOL_INFO | ATTR_VOL_UUID;
  struct { uint32_t length; unsigned char uuid[16]; } volume = {};
  if (fgetattrlist(fd, &attributes, &volume, sizeof(volume), 0) != 0 || volume.length < sizeof(volume)) return fail(env, "volume-identity-unavailable");
  unsigned int nonzero = 0; char uuid[33] = {}; const char *hex = "0123456789abcdef";
  for (int i = 0; i < 16; i++) { nonzero |= volume.uuid[i]; uuid[2*i] = hex[volume.uuid[i] >> 4]; uuid[2*i+1] = hex[volume.uuid[i] & 15]; }
  if (!nonzero) return fail(env, "volume-identity-unavailable");
  std::string file = std::to_string(st.st_ino) + ":" + std::to_string(st.st_birthtimespec.tv_sec) + ":" + std::to_string(st.st_birthtimespec.tv_nsec);
  napi_value result, volumeId, fileId; napi_create_object(env, &result);
  napi_create_string_utf8(env, uuid, NAPI_AUTO_LENGTH, &volumeId); napi_create_string_utf8(env, file.c_str(), NAPI_AUTO_LENGTH, &fileId);
  napi_set_named_property(env, result, "volume", volumeId); napi_set_named_property(env, result, "file", fileId); return result;
}
static napi_value stableDirectoryIdentity(napi_env env, napi_callback_info info) {
  napi_value values[1]; if (!args(env, info, 1, values)) return nullptr;
  Directory *directory = directoryArg(env, values[0]); if (!directory) return nullptr;
  return descriptorIdentity(env, directory->fd);
}
static napi_value stableFileIdentity(napi_env env, napi_callback_info info) {
  napi_value values[1]; int32_t fd;
  if (!args(env, info, 1, values) || napi_get_value_int32(env, values[0], &fd) != napi_ok || fd < 0) return fail(env, "invalid-file-handle");
  return descriptorIdentity(env, fd);
}
static napi_value leafOpen(napi_env env, napi_callback_info info) {
  napi_value values[4]; std::string name; bool create = false, readOnly = false;
  if (!args(env, info, 4, values) || !component(env, values[1], name) || napi_get_value_bool(env, values[2], &create) != napi_ok
    || napi_get_value_bool(env, values[3], &readOnly) != napi_ok || (create && readOnly)) return fail(env, "invalid-file-arguments");
  Directory *directory = directoryArg(env, values[0]); if (!directory) return nullptr;
  int flags = (readOnly ? O_RDONLY : O_RDWR) | O_NOFOLLOW | O_CLOEXEC | (create ? O_CREAT | O_EXCL : 0);
  int fd = openat(directory->fd, name.c_str(), flags, 0600);
  if (fd < 0) return fileError(env);
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_dev != directory->device) {
    close(fd); return fail(env, "unsafe-file");
  }
  napi_value result; napi_create_int32(env, fd, &result); return result;
}
static napi_value leafRename(napi_env env, napi_callback_info info) {
  napi_value values[4]; std::string from, to;
  if (!args(env, info, 4, values) || !component(env, values[1], from) || !component(env, values[3], to)) return nullptr;
  Directory *source = directoryArg(env, values[0]); if (!source) return nullptr;
  Directory *target = directoryArg(env, values[2]); if (!target) return nullptr;
  if (source->device != target->device) return fail(env, "unexpected-filesystem");
  struct stat st;
  if (fstatat(source->fd, from.c_str(), &st, AT_SYMLINK_NOFOLLOW) != 0) return fileError(env);
  if (!S_ISREG(st.st_mode) || st.st_nlink != 1) return fail(env, "unsafe-file");
  if (renameatx_np(source->fd, from.c_str(), target->fd, to.c_str(), RENAME_EXCL) != 0) {
    if (errno == EEXIST || errno == EISDIR || errno == ENOTEMPTY) return boolean(env, false);
    return fileError(env);
  }
  if (fsync(target->fd) != 0 || fsync(source->fd) != 0) return fileError(env);
  return boolean(env, true);
}
static napi_value directoryFree(napi_env env, napi_callback_info info) {
  napi_value values[1]; if (!args(env, info, 1, values)) return nullptr;
  Directory *directory = directoryArg(env, values[0]); if (!directory) return nullptr;
  struct statfs stats; if (fstatfs(directory->fd, &stats) != 0) return fileError(env);
  napi_value result; napi_create_bigint_uint64(env, static_cast<uint64_t>(stats.f_bavail) * static_cast<uint64_t>(stats.f_bsize), &result); return result;
}
static napi_value directorySync(napi_env env, napi_callback_info info) {
  napi_value values[1]; if (!args(env, info, 1, values)) return nullptr;
  Directory *directory = directoryArg(env, values[0]); if (!directory) return nullptr;
  if (fsync(directory->fd) != 0) return fileError(env);
  return boolean(env, true);
}
static napi_value directoryClose(napi_env env, napi_callback_info info) {
  napi_value values[1]; if (!args(env, info, 1, values)) return nullptr;
  Directory *directory = directoryArg(env, values[0]); if (!directory) return nullptr;
  int fd = directory->fd; directory->fd = -1; close(fd); return boolean(env, true);
}
static napi_value init(napi_env env, napi_value exports) {
  struct Method { const char *name; napi_callback method; } methods[] = {
    {"createBoard", createBoard}, {"generalBoard", generalBoard}, {"boardCount", boardCount}, {"boardText", boardText},
    {"writeBoard", writeBoard}, {"releaseBoard", releaseBoard}, {"acquireLock", acquireLock},
    {"releaseLock", releaseLock}, {"identity", identity}, {"publish", publish},
    {"rootOpen", rootOpen}, {"directoryOpen", directoryOpen}, {"directoryIdentity", directoryIdentity},
    {"leafOpen", leafOpen}, {"leafRename", leafRename}, {"directoryFree", directoryFree}, {"directorySync", directorySync}, {"directoryClose", directoryClose},
    {"stableDirectoryIdentity", stableDirectoryIdentity}, {"stableFileIdentity", stableFileIdentity},
  };
  for (const Method &method : methods) {
    napi_value function; napi_create_function(env, method.name, NAPI_AUTO_LENGTH, method.method, nullptr, &function);
    napi_set_named_property(env, exports, method.name, function);
  }
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
