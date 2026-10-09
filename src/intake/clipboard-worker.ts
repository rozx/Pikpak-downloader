import { macClipboard } from "../platform/mac-clipboard";

// 只用于父进程的管道协议；不在主进程线程执行可能等待剪贴板拥有者的原生读取。
export async function clipboardWorker(board?: string): Promise<void> {
  const clipboard = macClipboard(board); const decoder = new TextDecoder(); let pending = "";
  try {
    for await (const bytes of Bun.stdin.stream()) {
      pending += decoder.decode(bytes, { stream: true });
      if (pending.length > 1024) throw Error("invalid-clipboard-command");
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n"); const command = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        try {
          if (command !== "read") throw Error("invalid-command");
          const snapshot = await clipboard.read();
          console.log(JSON.stringify({ ok: true, sequence: snapshot?.sequence ?? "0", text: snapshot?.text ?? null, stable: snapshot !== null }));
        } catch { console.log(JSON.stringify({ ok: false })); }
      }
    }
  } finally { await clipboard.close(); }
}
