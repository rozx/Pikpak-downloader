// Bun 1.4.2 在 Windows 上经 expect(...).rejects 等待时，可能不再读取文件桥子进程的输出，测试会一直挂起；
// 正式代码不经过这条路径。先取得拒绝结果再对错误断言，与 rejects.toThrow 的判断等价。
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(() => undefined, (error: unknown) => error);
  if (!(outcome instanceof Error)) throw Error(outcome === undefined ? "expected-rejection" : "rejection-is-not-error");
  return outcome;
}
