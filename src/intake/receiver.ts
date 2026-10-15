import { acceptShare } from "../auth/share-access";
import type { ClipboardSnapshot, SecretStore } from "../platform/types";
import type { Store } from "../state/store";
import { parseShares, type ShareInput } from "./parse";
import { AppError } from "../errors";

export type IntakeResult = { ids: string[]; issues: string[]; failure: "credentials" | "database" | null };
const failureOf = (error: unknown): "credentials" | "database" => error instanceof AppError && error.code === "credentials_unavailable" ? "credentials" : "database";

export class IntakeReceiver {
  private acceptedSequence: string | null = null;
  private partialSequence: string | null = null;
  private partialShares = new Set<string>();
  constructor(private readonly store: Store, private readonly secrets: SecretStore, private readonly accountId: string,
    private outputRoot: string) {}
  // 只影响之后接收的分享；已接收分享的目标保存在任务库中。
  setOutputRoot(outputRoot: string): void { this.outputRoot = outputRoot; }
  private async accept(share: ShareInput): Promise<string> {
    const received = await acceptShare(this.store, this.secrets, { accountId: this.accountId, shareId: share.shareId,
      passCode: share.passCode, outputRoot: this.outputRoot });
    return received.share.id;
  }
  async receive(snapshot: ClipboardSnapshot): Promise<IntakeResult> {
    if (snapshot.sequence === this.acceptedSequence) return { ids: [], issues: [], failure: null };
    if (snapshot.sequence !== this.partialSequence) { this.partialSequence = snapshot.sequence; this.partialShares.clear(); }
    const parsed = parseShares(snapshot.text ?? "");
    const ids: string[] = [];
    // 每个分享均先持久化再确认；失败时不推进整个快照游标。
    for (const share of parsed.shares) {
      if (this.partialShares.has(share.shareId)) continue;
      try { ids.push(await this.accept(share)); this.partialShares.add(share.shareId); }
      catch (error) { return { ids, issues: parsed.issues, failure: failureOf(error) }; }
    }
    this.acceptedSequence = snapshot.sequence;
    return { ids, issues: parsed.issues, failure: null };
  }
  // 手动输入是独立的输入事件：不读写剪贴板快照的去重状态，也不与先前任何输入拼接配对。
  async receiveText(text: string): Promise<IntakeResult> {
    const parsed = parseShares(text);
    const ids: string[] = [];
    for (const share of parsed.shares) {
      try { ids.push(await this.accept(share)); }
      catch (error) { return { ids, issues: parsed.issues, failure: failureOf(error) }; }
    }
    return { ids, issues: parsed.issues, failure: null };
  }
}
