import { Store } from "../../src/state/store";
import { acquireQueueLock } from "../../src/state/lock";
import { join } from "node:path";
import { Engine } from "../../src/runtime/engine";
import { Drive } from "../../src/pikpak/drive";
import { IntakeReceiver } from "../../src/intake/receiver";
import { foregroundLoop } from "../../src/runtime/watch";
import { interruptible } from "../../src/runtime/lifecycle";

const root = process.argv[2]!;
const lock = acquireQueueLock(join(root, "queue-lock.sqlite")), store = new Store(join(root, "tasks.sqlite"));
store.ensureAccount("synthetic-account");
const secrets = { get: async () => null, set: async () => {}, delete: async () => {} };
const clipboard = { read: async () => ({ sequence: "1", text: "ordinary-unrelated-text" }), close: async () => { console.log("clipboard-closed"); } };
const filesystem = { root: async () => { throw Error("no-files-expected"); }, close: async () => {} };
const engine = new Engine(store, secrets, new Drive({ request: async () => { throw Error("no-network-expected"); } }, "synthetic-account"), filesystem);
try {
  await interruptible(signal => foregroundLoop(store, "synthetic-account", clipboard, new IntakeReceiver(store, secrets, "synthetic-account", root), engine, signal,
    message => { if (message.startsWith("监听已启动")) console.log("ready"); }), () => {});
} finally { store.close(); lock.release(); }
