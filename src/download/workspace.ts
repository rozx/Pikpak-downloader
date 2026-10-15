import { join } from "node:path";
import { AppError } from "../errors";
import type { Store, FileRecord, SourceComponent, DeliveryPlan } from "../state/store";
import type { LocalDirectory, LocalFile, LocalFileSystem } from "../platform/files";
import { sameIdentity } from "../platform/files";
import { safeName, foldedName, shortId, nodeId } from "./names";

export class FileWorkspace {
  private readonly opened = new Map<string, LocalDirectory>();
  private readonly paths = new Map<string, string>();
  private constructor(private readonly store: Store, private readonly accountId: string, private readonly shareId: string) {}
  static async open(store: Store, accountId: string, shareId: string, fs: LocalFileSystem): Promise<FileWorkspace> {
    for (let attempt = 0; ; attempt++) {
      const share = store.share(accountId, shareId);
      const root = await fs.root(share.outputRoot);
      let identity;
      try { identity = await root.identity(); } catch (error) { await root.close(); throw error; }
      // 打开期间默认目录可能被修改，这个尚未开始的分享随之迁移到新目录：按新目录重新打开。
      // 这里的比较与写入根目录身份之间没有 await，迁移不会插在两者之间。
      if (store.share(accountId, shareId).outputRoot !== share.outputRoot && attempt < 3) { await root.close(); continue; }
      return FileWorkspace.bind(store, accountId, share, root, identity);
    }
  }
  private static async bind(store: Store, accountId: string, share: { id: string; outputRoot: string; remoteId: string }, root: LocalDirectory,
    identity: Awaited<ReturnType<LocalDirectory["identity"]>>): Promise<FileWorkspace> {
    const shareId = share.id, workspace = new FileWorkspace(store, accountId, shareId);
    try {
      store.bindRoot(accountId, shareId, identity);
      workspace.opened.set("@root", root); workspace.paths.set("@root", share.outputRoot);
      await workspace.ensure("@share", "@root", safeName(store.shareTitle(accountId, shareId) ?? "PikPak", `~${shortId(share.remoteId)}`));
      await workspace.ensure("@temp", "@share", ".pikpak-staging");
      return workspace;
    } catch (error) { const registered = workspace.opened.has("@root"); await workspace.close(); if (!registered) await root.close(); throw error; }
  }
  private maxName(parent: string): number {
    const prefix = this.paths.get(parent); if (!prefix) throw new AppError("state_unavailable");
    const remaining = process.platform === "win32" ? 32760 - prefix.length - 1 : 1023 - Buffer.byteLength(prefix, "utf8") - 1;
    return Math.min(240, remaining);
  }
  private async ensure(node: string, parent: string, suggested: string): Promise<LocalDirectory> {
    const existing = this.store.directory(this.accountId, this.shareId, node);
    if (existing) return this.directory(node);
    const container = await this.directory(parent);
    for (let attempt = 0; attempt < 1000; attempt++) {
      const name = safeName(suggested, attempt ? `~${shortId(node)}${attempt > 1 ? `-${attempt}` : ""}` : "", this.maxName(parent));
      if (this.store.directoryNameTaken(this.shareId, parent, foldedName(name))) continue;
      let child: LocalDirectory;
      try { child = await container.child(name, true); }
      catch (error) { if ((error as { code?: string }).code === "EEXIST") continue; throw error; }
      try {
        await container.sync(); const identity = await child.identity();
        this.store.recordDirectory(this.accountId, this.shareId, { nodeId: node, parentId: parent, name, folded: foldedName(name), volume: identity.volume, identity: identity.file });
        this.opened.set(node, child); this.paths.set(node, join(this.paths.get(parent)!, name)); return child;
      } catch (error) { await child.close(); throw error; }
    }
    throw Error("directory-conflict-limit");
  }
  async directory(node: string, visiting = new Set<string>()): Promise<LocalDirectory> {
    const cached = this.opened.get(node); if (cached) return cached;
    if (visiting.has(node)) throw new AppError("state_unavailable"); visiting.add(node);
    const record = this.store.directory(this.accountId, this.shareId, node); if (!record) throw new AppError("state_unavailable");
    const parent = await this.directory(record.parentId, visiting);
    let child: LocalDirectory;
    try { child = await parent.child(record.name, false); }
    catch (error) {
      if ((error as { code?: string }).code !== "ENOENT" || this.store.pendingPublication(this.accountId, this.shareId)) throw error;
      child = await parent.child(record.name, true);
      try {
        await parent.sync(); const current = await child.identity();
        this.store.replaceDirectoryIdentity(this.accountId, this.shareId, record, current);
        record.volume = current.volume; record.identity = current.file;
      } catch (error) { await child.close(); throw error; }
    }
    if (!sameIdentity(await child.identity(), { volume: record.volume, file: record.identity })) { await child.close(); throw new AppError("needs_reconciliation"); }
    this.opened.set(node, child); this.paths.set(node, join(this.paths.get(record.parentId)!, record.name)); return child;
  }
  private chooseName(file: FileRecord, parent: string, baseName: string, from = 0): string {
    for (let attempt = from; attempt < from + 1000; attempt++) {
      const name = safeName(baseName, attempt ? `~${shortId(file.id)}${attempt > 1 ? `-${attempt}` : ""}` : "", this.maxName(parent));
      if (!this.store.directoryNameTaken(this.shareId, parent, foldedName(name)) && this.store.reserveName(this.accountId, file.id, parent, name, foldedName(name))) return name;
    }
    throw Error("file-conflict-limit");
  }
  async prepare(file: FileRecord): Promise<DeliveryPlan> {
    const saved = this.store.deliveryPlan(this.accountId, file.id); if (saved) { await this.directory(saved.parent); return saved; }
    if (this.store.delivery(this.accountId, file.id)) throw new AppError("needs_reconciliation");
    let source: unknown; try { source = JSON.parse(file.relativePath); } catch { throw Error("invalid-source-path"); }
    if (!Array.isArray(source) || !source.length || !source.every(part => part && typeof part.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(part.id) && typeof part.name === "string")) throw Error("invalid-source-path");
    const parts = source as SourceComponent[]; let parent = "@share";
    for (const part of parts.slice(0, -1)) {
      const node = `directory-${nodeId(`${parent}/${part.id}`)}`;
      await this.ensure(node, parent, part.name); parent = node;
    }
    const baseName = parts.at(-1)!.name; const name = this.chooseName(file, parent, baseName);
    const plan = { parent, name, tempParent: "@temp", tempName: `${file.id}.part`, baseName };
    this.store.transaction(() => {
      this.store.allocateDelivery(this.accountId, file.id, join(this.paths.get("@temp")!, plan.tempName), join(this.paths.get(parent)!, name));
      this.store.setDeliveryPlan(this.accountId, file.id, plan);
    });
    return plan;
  }
  async temporary(file: FileRecord): Promise<LocalFile> {
    const plan = await this.prepare(file); const delivery = this.store.delivery(this.accountId, file.id)!;
    const directory = await this.directory(plan.tempParent);
    let handle: LocalFile; let replaced = false;
    try { handle = await directory.file(plan.tempName, delivery.identity === null); }
    catch (error) {
      if ((error as { code?: string }).code !== "ENOENT" || delivery.sha256 !== null || ["publishing", "completed", "reconciling"].includes(file.state)) throw error;
      handle = await directory.file(plan.tempName, true); replaced = true;
    }
    try {
      const identity = (await handle.info()).identity;
      if (!replaced && delivery.identity !== null && !sameIdentity(identity, { volume: delivery.volume!, file: delivery.identity })) throw new AppError("needs_reconciliation");
      if (replaced) this.store.replaceMissingTemporary(this.accountId, file.id, identity);
      else this.store.bindTemporary(this.accountId, file.id, identity);
      await directory.sync(); return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async freeBytes(): Promise<bigint> { return (await this.directory("@root")).freeBytes(); }
  async targetPath(plan: DeliveryPlan): Promise<string> { await this.directory(plan.parent); return join(this.paths.get(plan.parent)!, plan.name); }
  async nextTarget(file: FileRecord, attempt: number): Promise<DeliveryPlan> {
    const plan = await this.prepare(file); return { ...plan, name: this.chooseName(file, plan.parent, plan.baseName, attempt) };
  }
  async close(): Promise<void> {
    const handles = [...this.opened.values()].reverse(); this.opened.clear();
    for (const handle of handles) await handle.close().catch(() => {});
  }
}
