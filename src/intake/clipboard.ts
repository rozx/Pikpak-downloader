import type { ClipboardSnapshot } from "../platform/types";

export interface Clipboard { read(): Promise<ClipboardSnapshot | null>; close(): Promise<void> }
export async function stableSnapshot(adapter: { sequence(): string; text(): string | null }, tries = 3): Promise<ClipboardSnapshot | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const before = adapter.sequence();
    const text = adapter.text();
    const after = adapter.sequence();
    if (before === after) return { sequence: after, text };
  }
  return null;
}

export async function pollClipboard(clipboard: Clipboard, signal: AbortSignal,
  receive: (snapshot: ClipboardSnapshot) => Promise<void>, notify: (failed: boolean) => void,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void> = async (milliseconds, signal) => {
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, milliseconds); signal.addEventListener("abort", done, { once: true });
    });
  }): Promise<void> {
  let failures = 0;
  try {
    while (!signal.aborted) {
      let snapshot: ClipboardSnapshot | null = null;
      try {
        snapshot = await clipboard.read();
        if (!snapshot) throw Error("unstable-snapshot");
        if (failures >= 3) notify(false);
        failures = 0;
      } catch {
        failures++;
        if (failures === 3) notify(true);
      }
      if (snapshot && !signal.aborted) await receive(snapshot);
      await wait(failures ? Math.min(30_000, 500 * 2 ** Math.min(failures, 6)) : 500, signal);
    }
  } finally { await clipboard.close(); }
}
