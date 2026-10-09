export async function interruptible(action: (signal: AbortSignal) => Promise<void>, notify = console.log): Promise<void> {
  const abort = new AbortController(); let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (abort.signal.aborted) return;
    notify("正在停止新工作并保存进度……"); abort.abort();
    deadline = setTimeout(() => process.exit(130), 10000); deadline.unref();
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try { await action(abort.signal); }
  finally { if (deadline) clearTimeout(deadline); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
