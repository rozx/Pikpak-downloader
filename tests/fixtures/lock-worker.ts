import { acquireQueueLock } from "../../src/state/lock";
const handle = acquireQueueLock(process.argv[2]!);
console.log("held");
process.on("SIGTERM", () => { handle.release(); process.exit(0); });
await new Promise<never>(() => setInterval(() => {}, 60_000));
