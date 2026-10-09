function start(script: string) {
  const bootstrap = "& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))))";
  const worker = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64")],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, PIKPAK_BRIDGE_PARENT_PID: String(process.pid) } });
  worker.stdin.write(`${Buffer.from(script, "utf8").toString("base64")}\n`);
  return worker;
}
type Worker = ReturnType<typeof start>;
const readerFor = (worker: Worker) => worker.stdout.getReader();
type Reader = ReturnType<typeof readerFor>;
export class ProcessBridge {
  private worker: Worker | null = null;
  private reader: Reader | null = null;
  private decoder = new TextDecoder();
  private buffer = "";
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private ready = false;
  constructor(private readonly script: string) {}
  call(request: Record<string, unknown>): Promise<unknown> {
    const next = this.queue.then(() => this.exchange(request)); this.queue = next.catch(() => {}); return next;
  }
  private async exchange(request: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw Error("native-session-closed");
    if (!this.worker) { this.worker = start(this.script); this.reader = readerFor(this.worker); }
    const worker = this.worker; const reader = this.reader!;
    const timeout = setTimeout(() => worker.kill(), 15000);
    let result: Record<string, unknown>;
    try {
      if (!this.ready) {
        await worker.stdin.flush();
        const hello = JSON.parse(await this.line(reader)) as Record<string, unknown>;
        if (hello.ready !== true) throw Error("native-initialization-failed");
        this.ready = true;
      }
      worker.stdin.write(`${JSON.stringify(request)}\n`); await worker.stdin.flush();
      result = JSON.parse(await this.line(reader)) as Record<string, unknown>;
    } catch { await this.close(); throw Error("native-session-closed"); }
    finally { clearTimeout(timeout); }
    if (result.ok !== true) {
      const code = ["EEXIST", "ENOENT", "ENOSPC", "EACCES", "unsafe-path"].includes(String(result.code)) ? String(result.code) : "native-failure";
      throw Object.assign(Error(code), { code });
    }
    return result.value;
  }
  private async line(reader: Reader): Promise<string> {
    while (!this.buffer.includes("\n")) {
      const chunk = await reader.read(); if (chunk.done) throw Error("native-session-closed");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      if (this.buffer.length > 1048576) throw Error("native-response-too-large");
    }
    const end = this.buffer.indexOf("\n"); const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
    return line;
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    this.worker?.kill(); await this.worker?.exited;
    await this.reader?.cancel().catch(() => {}); this.buffer = "";
  }
}
