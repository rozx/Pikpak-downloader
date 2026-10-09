/// <reference path="./assets.d.ts" />
import script from "./windows-clipboard.ps1" with { type: "text" };
import type { Clipboard } from "../intake/clipboard";
import type { ClipboardSnapshot } from "./types";

function start() {
  return Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
}
type Worker = ReturnType<typeof start>;
const readWorker = (worker: Worker) => worker.stdout.getReader();
type Reader = ReturnType<typeof readWorker>;

export class ProcessClipboard implements Clipboard {
  private worker: Worker | null = null;
  private reader: Reader | null = null;
  private buffered = "";
  private decoder = new TextDecoder();
  private busy = false;
  constructor(private readonly launch: () => Worker = start) {}
  private async line(reader: Reader): Promise<string> {
    while (!this.buffered.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw Error("clipboard-worker-exited");
      this.buffered += this.decoder.decode(chunk.value, { stream: true });
      if (this.buffered.length > 524288) throw Error("clipboard-response-too-large");
    }
    const end = this.buffered.indexOf("\n"); const line = this.buffered.slice(0, end); this.buffered = this.buffered.slice(end + 1);
    return line;
  }
  async read(): Promise<ClipboardSnapshot | null> {
    if (this.busy) throw Error("clipboard-request-already-running");
    this.busy = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!this.worker) { this.worker = this.launch(); this.reader = this.worker.stdout.getReader(); }
      const worker = this.worker; const reader = this.reader!;
      timeout = setTimeout(() => worker.kill(), 5000);
      for (let attempt = 0; attempt < 3; attempt++) {
        worker.stdin.write("read\n"); await worker.stdin.flush();
        const data = JSON.parse(await this.line(reader)) as Record<string, unknown>;
        if (data.ok !== true || typeof data.sequence !== "string" || !/^\d+$/.test(data.sequence)
          || (data.text !== null && typeof data.text !== "string")) throw Error("clipboard-read-failed");
        if (data.stable === true) return { sequence: data.sequence, text: data.text };
      }
      return null;
    } catch {
      await this.close();
      throw Error("clipboard-unavailable");
    } finally { if (timeout) clearTimeout(timeout); this.busy = false; }
  }
  async close(): Promise<void> {
    const worker = this.worker; this.worker = null;
    worker?.kill();
    await worker?.exited;
    await this.reader?.cancel().catch(() => {}); this.reader = null;
    this.buffered = ""; this.decoder = new TextDecoder();
  }
}
