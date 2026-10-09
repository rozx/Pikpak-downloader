import type { Clipboard } from "../intake/clipboard";
import { stableSnapshot } from "../intake/clipboard";
import { macNative } from "./macos";

export function macClipboard(board?: string): Clipboard {
  const native = macNative();
  const name = board ?? native.generalBoard();
  return { read: () => stableSnapshot({ sequence: () => native.boardCount(name).toString(), text: () => native.boardText(name) }),
    close: async () => {} };
}
