#import <AppKit/AppKit.h>
#include <node_api.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <errno.h>
#include <string>

// 隔离 Node-API 探针。错误只返回固定类别，不返回路径或剪贴板内容。
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
  @autoreleasepool { return text(env, [NSPasteboard pasteboardWithUniqueName].name); }
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
    if (value.length > 1024 * 1024) return fail(env, "clipboard-too-large");
    return text(env, value);
  }
}
// 测试写入只允许本进程创建的独立 pasteboard，由 TS 持有名称；探针不传 general。
static napi_value writeBoard(napi_env env, napi_callback_info info) {
  napi_value values[2]; std::string name, value;
  if (!args(env, info, 2, values) || !stringArg(env, values[0], name) || !stringArg(env, values[1], value)) return nullptr;
  @autoreleasepool {
    if ([board(name).name isEqualToString:NSPasteboardNameGeneral]) return fail(env, "general-write-forbidden");
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
    if ([board(name).name isEqualToString:NSPasteboardNameGeneral]) return fail(env, "general-release-forbidden");
    [board(name) releaseGlobally]; return boolean(env, true);
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
static napi_value init(napi_env env, napi_value exports) {
  struct Method { const char *name; napi_callback method; } methods[] = {
    {"createBoard", createBoard}, {"boardCount", boardCount}, {"boardText", boardText},
    {"writeBoard", writeBoard}, {"releaseBoard", releaseBoard}, {"acquireLock", acquireLock},
    {"releaseLock", releaseLock}, {"identity", identity}, {"publish", publish},
  };
  for (const Method &method : methods) {
    napi_value function; napi_create_function(env, method.name, NAPI_AUTO_LENGTH, method.method, nullptr, &function);
    napi_set_named_property(env, exports, method.name, function);
  }
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
