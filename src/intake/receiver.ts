import { acceptShare } from "../auth/share-access";
import type { ClipboardSnapshot, SecretStore } from "../platform/types";
import type { Store } from "../state/store";
import { parseShares } from "./parse";
import { AppError } from "../errors";

export class IntakeReceiver {
  private acceptedSequence: string | null = null;
  private partialSequence: string | null = null;
  private partialShares = new Set<string>();
  constructor(private readonly store: Store, private readonly secrets: SecretStore, private readonly accountId: string,
    private readonly outputRoot: string) {}
  async receive(snapshot: ClipboardSnapshot): Promise<{ ids: string[]; issues: string[]; failure: "credentials" | "database" | null }> {
    if (snapshot.sequence === this.acceptedSequence) return { ids: [], issues: [], failure: null };
    if (snapshot.sequence !== this.partialSequence) { this.partialSequence = snapshot.sequence; this.partialShares.clear(); }
    const parsed = parseShares(snapshot.text ?? "");
    const ids: string[] = [];
    // 每个分享均先持久化再确认；失败时不推进整个快照游标。
    for (const share of parsed.shares) {
      if (this.partialShares.has(share.shareId)) continue;
      try {
        const received = await acceptShare(this.store, this.secrets, { accountId: this.accountId, shareId: share.shareId,
          passCode: share.passCode, outputRoot: this.outputRoot });
        this.partialShares.add(share.shareId);
        ids.push(received.share.id);
      } catch (error) {
        return { ids, issues: parsed.issues, failure: error instanceof AppError && error.code === "credentials_unavailable" ? "credentials" : "database" };
      }
    }
    this.acceptedSequence = snapshot.sequence;
    return { ids, issues: parsed.issues, failure: null };
  }
}
