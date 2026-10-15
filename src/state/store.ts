import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../errors";
import { APPLICATION_ID, SCHEMA_VERSION, schema, migrationFrom1, migrationFrom2, migrationFrom3 } from "./schema";
import { migrationBackup } from "./migration-backup";
import { CHUNK_SIZE, parseRanges, persistedBytes, rangesValid, serializeRanges, type RangeCheckpoint } from "./ranges";
import { aggregateCounts, assertTransition, canResume, type Counts, type FileState, type Pause, type PauseReason } from "./model";
import type { FileIdentity } from "../platform/types";
import type { CreationEvidence } from "../pikpak/ownership";

export type Share = { id: string; accountId: string; remoteId: string; outputRoot: string; secretRef: string;
  requestedRevision: bigint; attemptedRevision: bigint; cancelled: boolean; scanStatus: "pending" | "active" | "complete" | "failed"; lastError: string | null };
export type FileRecord = { id: string; accountId: string; shareId: string; sourceId: string; gcid: string; size: bigint;
  relativePath: string; state: FileState; retries: bigint; cancelled: boolean; lastError: string | null };
export type Scan = { id: string; shareId: string; accountId: string; revision: bigint; secretRef: string };
export type SourceComponent = { id: string; name: string };
export type DirectoryRecord = { nodeId: string; parentId: string; name: string; folded: string; volume: string; identity: string };
export type DeliveryPlan = { parent: string; name: string; tempParent: string; tempName: string; baseName: string };
export type OperationPayload = { sent?: boolean; notBefore?: string; outcome?: string; copyId?: string; freeBefore?: string;
  usageBefore?: string; deadline?: number; polls?: number; targetPath?: string; attempt?: number; quotaPending?: boolean };
export type Operation = { id: string; accountId: string; fileId: string; kind: "restore" | "delete" | "publish";
  status: "intent" | "submitted" | "confirmed" | "attention"; taskId: string | null; resultId: string | null; secretRef: string; createdAt: bigint; payload: OperationPayload };
export type CopyRecord = { id: string; remoteId: string; parentId: string; size: bigint; gcid: string; ownership: "unverified" | "created";
  state: "retained" | "deleting" | "deleted" | "protected"; operationId: string; evidence: CreationEvidence | null };
export type ReclaimCandidate = CopyRecord & { fileId: string; completedAt: bigint };
export type Delivery = { fileId: string; tempPath: string; targetPath: string; checkpoint: bigint; prefixSha256: string | null;
  publishAttempt: bigint; volume: string | null; identity: string | null; sha256: string | null; verification: string | null; completedAt: bigint | null;
  ranges: RangeCheckpoint | null };
export type ConfigKey = "active_account" | "output_root" | "queue_paused" | "clipboard_watch" | "download_connections";
export type ShareSummary = ReturnType<typeof aggregateCounts> & { reason: string | null };
export type ShareView = { id: string; title: string | null; outputRoot: string; scanStatus: Share["scanStatus"]; cancelled: boolean;
  lastError: string | null; summary: ShareSummary };
export type FileView = Pick<FileRecord, "id" | "shareId" | "relativePath" | "size" | "state" | "retries" | "cancelled" | "lastError">
  & { checkpoint: bigint; copyState: CopyRecord["state"] | null };
type ShareRow = Omit<Share, "cancelled"> & { cancelled: bigint };
type FileRow = Omit<FileRecord, "size" | "cancelled"> & { size: string; cancelled: bigint };
const shareColumns = "id, account_id AS accountId, remote_id AS remoteId, output_root AS outputRoot, secret_ref AS secretRef, requested_revision AS requestedRevision, attempted_revision AS attemptedRevision, cancelled, scan_status AS scanStatus, last_error AS lastError";
const fileColumns = "id, account_id AS accountId, share_id AS shareId, source_id AS sourceId, gcid, size, relative_path AS relativePath, state, retries, cancelled, last_error AS lastError";
const fileValue = (row: FileRow): FileRecord => ({ ...row, size: BigInt(row.size), cancelled: row.cancelled === 1n });
const timestamp = () => BigInt(Date.now());
const identifier = (prefix: string) => `${prefix}_${randomUUID()}`;

export class Store {
  private readonly db: Database;
  constructor(readonly path: string, readonly readOnly = false) {
    this.db = new Database(path, { readonly: readOnly, create: !readOnly, safeIntegers: true, strict: true });
    try {
      const version = this.scalar("PRAGMA user_version");
      if (version > BigInt(SCHEMA_VERSION)) throw new AppError("newer_schema");
      if (version === 0n) {
        if (readOnly || this.scalar("SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'") !== 0n) throw new AppError("state_unavailable");
        this.db.transaction(() => {
          this.db.exec(schema);
          this.db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}`);
        })();
      } else {
        if (this.scalar("PRAGMA application_id") !== BigInt(APPLICATION_ID)) throw new AppError("state_unavailable");
        if (version >= 1n && version < BigInt(SCHEMA_VERSION)) {
          if (readOnly) throw new AppError("state_unavailable");
          if (this.get<{ value: string }>("SELECT value FROM metadata WHERE key='backup_review_required'")?.value !== "0") throw new AppError("backup_review_required");
          this.db.exec("PRAGMA synchronous=FULL");
          migrationBackup(this.db, path, version);
          // 逐级升级在同一事务中完成，任一步失败都整体回滚，版本号保持不变。
          this.db.transaction(() => {
            if (version <= 1n) this.db.exec(migrationFrom1);
            if (version <= 2n) this.db.exec(migrationFrom2);
            if (version <= 3n) this.db.exec(migrationFrom3);
            this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
          })();
        } else if (version !== BigInt(SCHEMA_VERSION)) throw new AppError("state_unavailable");
      }
      if (!readOnly && this.get<{ value: string }>("SELECT value FROM metadata WHERE key='backup_review_required'")?.value !== "0") {
        throw new AppError("backup_review_required");
      }
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
      if (!readOnly) this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  snapshot(): Uint8Array { return this.db.serialize(); }
  private scalar(sql: string): bigint { return (this.db.query(sql).values()[0]?.[0] ?? 0n) as bigint; }
  private get<T>(sql: string, ...bindings: SQLQueryBindings[]): T | null { return this.db.query<T, SQLQueryBindings[]>(sql).get(...bindings); }
  private all<T>(sql: string, ...bindings: SQLQueryBindings[]): T[] { return this.db.query<T, SQLQueryBindings[]>(sql).all(...bindings); }
  private run(sql: string, ...bindings: SQLQueryBindings[]) { return this.db.query(sql).run(...bindings); }

  // 回调由库内拥有；测试同时检查 async 回调在任何执行前被拒绝。
  transaction<T>(action: () => T extends PromiseLike<unknown> ? never : T): T {
    if (this.readOnly) throw new AppError("state_unavailable");
    if (action.constructor.name === "AsyncFunction") throw new AppError("invalid_input");
    return this.db.transaction(() => {
      const result = action();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new AppError("invalid_input");
      return result;
    }).immediate() as T;
  }

  ensureAccount(accountId: string): void {
    if (!accountId) throw new AppError("invalid_input");
    this.run("INSERT OR IGNORE INTO accounts(id,created_at) VALUES(?,?)", accountId, timestamp());
  }
  setConfig(key: ConfigKey, value: string): void {
    this.run("INSERT INTO config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
  }
  config(key: ConfigKey): string | null { return this.get<{ value: string }>("SELECT value FROM config WHERE key=?", key)?.value ?? null; }
  rateLimit(accountId: string, delayMs: number): void {
    const until = BigInt(Math.min(Number.MAX_SAFE_INTEGER, Date.now() + Math.max(0, delayMs)));
    this.run("INSERT INTO config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", `rate_limit:${accountId}`, until.toString());
  }
  rateLimited(accountId: string): boolean {
    return this.rateDelay(accountId) > 0;
  }
  rateDelay(accountId: string): number {
    const value = this.get<{ value: string }>("SELECT value FROM config WHERE key=?", `rate_limit:${accountId}`)?.value;
    if (!value) return 0;
    const remaining = BigInt(value) - BigInt(Date.now()); return remaining > 0n ? Number(remaining) : 0;
  }
  requestRescan(accountId: string, shareId: string): void {
    this.share(accountId, shareId);
    this.run("UPDATE shares SET requested_revision=requested_revision+1,scan_status=CASE WHEN scan_status='active' THEN 'active' ELSE 'pending' END WHERE id=? AND cancelled=0", shareId);
  }
  nextScan(accountId: string, now = Date.now()): Scan | null {
    const next = this.get<{ id: string }>(`SELECT s.id FROM shares s LEFT JOIN scans g ON g.share_id=s.id AND g.status='active'
      WHERE s.account_id=? AND s.cancelled=0 AND (s.requested_revision>s.attempted_revision OR
      (g.id IS NOT NULL AND COALESCE(json_extract(g.cursor_json,'$.retryAt'),0)<=?)) ORDER BY s.created_at,s.id LIMIT 1`, accountId, now);
    if (!next) return null;
    const share = this.share(accountId, next.id);
    const active = this.get<Scan>("SELECT id,share_id AS shareId,account_id AS accountId,revision,secret_ref AS secretRef FROM scans WHERE share_id=? AND status='active'", share.id);
    if (active && share.requestedRevision > active.revision) this.finishScan(active, false);
    return this.claimScan(accountId, next.id);
  }
  scanRetry(scan: Scan, now = Date.now()): void {
    this.activeScan(scan);
    const retries = this.get<{ retries: bigint }>("SELECT retries FROM scans WHERE id=?", scan.id)!.retries;
    if (retries >= 3n) this.finishScan(scan, false, "scan_retry_exhausted");
    else this.run("UPDATE scans SET retries=retries+1,cursor_json=? WHERE id=?", JSON.stringify({ retryAt: now + 1000 * 2 ** Number(retries) }), scan.id);
  }
  nextFile(accountId: string, now = Date.now()): FileRecord | null {
    const row = this.get<{ id: string }>(`SELECT f.id FROM files f JOIN shares s ON s.id=f.share_id WHERE f.account_id=? AND f.cancelled=0 AND s.cancelled=0
      AND f.state IN ('discovered','ready','saving','awaiting_remote','downloading','verifying','publishing','reconciling','retry_wait','waiting_space')
      AND (f.retry_at IS NULL OR f.retry_at<=?) ORDER BY CASE WHEN f.state IN ('publishing','reconciling') THEN 0 ELSE 1 END,f.rowid LIMIT 1`, accountId, now);
    return row ? this.file(accountId, row.id) : null;
  }
  waitForSpace(accountId: string, fileId: string, now = Date.now()): void {
    this.file(accountId, fileId); this.run("UPDATE files SET state='waiting_space',retry_at=?,last_error='cloud_space' WHERE id=?", now + 60000, fileId);
  }
  resaveMissing(accountId: string, fileId: string): boolean {
    const file = this.file(accountId, fileId);
    if (file.retries >= 3n) { this.fileError(accountId, fileId, "remote_copy_missing"); return false; }
    this.run("UPDATE files SET state='ready',retries=retries+1,last_error=NULL,retry_at=NULL WHERE id=?", fileId); return true;
  }
  bindRoot(accountId: string, shareId: string, identity: FileIdentity): void {
    this.share(accountId, shareId);
    const current = this.get<{ volume: string | null; identity: string | null }>("SELECT root_volume AS volume,root_identity AS identity FROM shares WHERE id=?", shareId)!;
    if (current.volume === null && current.identity === null) this.run("UPDATE shares SET root_volume=?,root_identity=? WHERE id=?", identity.volume, identity.file, shareId);
    else if (current.volume !== identity.volume || current.identity !== identity.file) throw new AppError("needs_reconciliation");
  }
  shareTitle(accountId: string, shareId: string): string | null {
    this.share(accountId, shareId); return this.get<{ title: string | null }>("SELECT title FROM shares WHERE id=?", shareId)?.title ?? null;
  }
  captureTitle(scan: Scan, title: string): void { this.activeScan(scan); this.run("UPDATE shares SET title=COALESCE(title,?) WHERE id=?", title, scan.shareId); }
  directory(accountId: string, shareId: string, nodeId: string): DirectoryRecord | null {
    this.share(accountId, shareId);
    return this.get("SELECT node_id AS nodeId,parent_id AS parentId,name,folded,volume,identity FROM directories WHERE share_id=? AND node_id=?", shareId, nodeId);
  }
  directoryNameTaken(shareId: string, parentId: string, folded: string): boolean {
    return !!this.get("SELECT node_id FROM directories WHERE share_id=? AND parent_id=? AND folded=?", shareId, parentId, folded);
  }
  recordDirectory(accountId: string, shareId: string, record: DirectoryRecord): void {
    this.share(accountId, shareId);
    this.run("INSERT INTO directories VALUES(?,?,?,?,?,?,?)", shareId, record.nodeId, record.parentId, record.name, record.folded, record.volume, record.identity);
  }
  pendingPublication(accountId: string, shareId: string): boolean {
    this.share(accountId, shareId);
    return !!this.get("SELECT f.id FROM files f JOIN deliveries d ON d.file_id=f.id WHERE f.share_id=? AND f.state<>'completed' AND d.sha256 IS NOT NULL LIMIT 1", shareId);
  }
  replaceDirectoryIdentity(accountId: string, shareId: string, record: DirectoryRecord, identity: FileIdentity): void {
    this.share(accountId, shareId);
    if (this.pendingPublication(accountId, shareId)) throw new AppError("needs_reconciliation");
    if (this.run("UPDATE directories SET volume=?,identity=? WHERE share_id=? AND node_id=? AND volume=? AND identity=?",
      identity.volume, identity.file, shareId, record.nodeId, record.volume, record.identity).changes !== 1) throw new AppError("needs_reconciliation");
  }
  reserveName(accountId: string, fileId: string, parentId: string, name: string, folded: string): boolean {
    const file = this.file(accountId, fileId);
    const old = this.get<{ fileId: string }>("SELECT file_id AS fileId FROM name_reservations WHERE share_id=? AND parent_id=? AND folded=?", file.shareId, parentId, folded);
    if (old) return old.fileId === fileId;
    this.run("INSERT INTO name_reservations VALUES(?,?,?,?,?)", file.shareId, parentId, folded, fileId, name); return true;
  }

  share(accountId: string, id: string): Share {
    const row = this.get<ShareRow>(`SELECT ${shareColumns} FROM shares WHERE id=? AND account_id=?`, id, accountId);
    if (!row) throw new AppError("account_mismatch");
    return { ...row, cancelled: row.cancelled === 1n };
  }
  shares(accountId: string): Share[] {
    return this.all<ShareRow>(`SELECT ${shareColumns} FROM shares WHERE account_id=? ORDER BY created_at,id`, accountId)
      .map(row => ({ ...row, cancelled: row.cancelled === 1n }));
  }
  findShare(accountId: string, remoteId: string): Share | null {
    const row = this.get<{ id: string }>("SELECT id FROM shares WHERE account_id=? AND remote_id=?", accountId, remoteId);
    return row ? this.share(accountId, row.id) : null;
  }
  accept(accountId: string, remoteId: string, outputRoot: string, secretRef: string): Share {
    if (!remoteId || !outputRoot || !secretRef) throw new AppError("invalid_input");
    return this.transaction(() => {
      this.run(`INSERT INTO shares(id,account_id,remote_id,output_root,secret_ref,created_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(account_id,remote_id) DO UPDATE SET secret_ref=excluded.secret_ref,
          requested_revision=shares.requested_revision+1,
          scan_status=CASE WHEN shares.scan_status='active' THEN 'active' ELSE 'pending' END,last_error=NULL`,
      identifier("s"), accountId, remoteId, outputRoot, secretRef, timestamp());
      const row = this.get<{ id: string }>("SELECT id FROM shares WHERE account_id=? AND remote_id=?", accountId, remoteId)!;
      this.run("UPDATE files SET state='ready',last_error=NULL WHERE share_id=? AND cancelled=0 AND state IN ('failed','needs_attention') AND last_error='access_required'", row.id);
      return this.share(accountId, row.id);
    });
  }
  claimScan(accountId: string, shareId: string): Scan | null {
    return this.transaction(() => {
      const share = this.share(accountId, shareId);
      if (share.cancelled) return null;
      const existing = this.get<Scan>("SELECT id, share_id AS shareId, account_id AS accountId, revision, secret_ref AS secretRef FROM scans WHERE share_id=? AND status='active'", shareId);
      if (existing) return existing;
      if (share.requestedRevision <= share.attemptedRevision) return null;
      const scan = { id: identifier("g"), shareId, accountId, revision: share.requestedRevision, secretRef: share.secretRef };
      this.run("INSERT INTO scans(id,share_id,account_id,revision,secret_ref,status) VALUES(?,?,?,?,?,'active')", scan.id, shareId, accountId, scan.revision, scan.secretRef);
      this.run("UPDATE shares SET attempted_revision=?,scan_status='active' WHERE id=?", scan.revision, shareId);
      return scan;
    });
  }
  finishScan(scan: Scan, complete: boolean, reason: string | null = null): void {
    if (reason !== null && !/^[a-z_]{1,64}$/.test(reason)) throw new AppError("invalid_input");
    this.transaction(() => {
      const match = this.get<{ id: string }>("SELECT id FROM scans WHERE id=? AND account_id=? AND share_id=? AND revision=? AND secret_ref=? AND status='active'", scan.id, scan.accountId, scan.shareId, scan.revision, scan.secretRef);
      if (!match) throw new AppError("invalid_transition");
      this.run("UPDATE scans SET status=? WHERE id=?", complete ? "complete" : "failed", scan.id);
      this.run("UPDATE shares SET scan_status=CASE WHEN requested_revision>? THEN 'pending' ELSE ? END,last_error=CASE WHEN requested_revision>? THEN NULL ELSE ? END WHERE id=?",
        scan.revision, complete ? "complete" : "failed", scan.revision, reason, scan.shareId);
    });
  }
  private activeScan(scan: Scan): void {
    if (!this.get("SELECT id FROM scans WHERE id=? AND share_id=? AND account_id=? AND status='active'", scan.id, scan.shareId, scan.accountId)) throw new AppError("invalid_transition");
  }
  queueDirectory(scan: Scan, remoteId: string, path: SourceComponent[]): void {
    this.activeScan(scan);
    this.run("INSERT OR IGNORE INTO scan_directories(scan_id,remote_id,path_json) VALUES(?,?,?)", scan.id, remoteId, JSON.stringify(path));
  }
  nextDirectory(scan: Scan): { remoteId: string; path: SourceComponent[] } | null {
    this.activeScan(scan);
    const row = this.get<{ remoteId: string; path: string }>("SELECT remote_id AS remoteId,path_json AS path FROM scan_directories WHERE scan_id=? AND done=0 ORDER BY rowid LIMIT 1", scan.id);
    return row ? { remoteId: row.remoteId, path: JSON.parse(row.path) as SourceComponent[] } : null;
  }
  startDirectory(scan: Scan, remoteId: string): void {
    this.activeScan(scan);
    this.run("DELETE FROM scan_pages WHERE scan_id=? AND directory_id=?", scan.id, remoteId);
  }
  observePage(scan: Scan, directoryId: string, page: string): boolean {
    this.activeScan(scan);
    const hash = createHash("sha256").update(page).digest("hex");
    return this.run("INSERT OR IGNORE INTO scan_pages VALUES(?,?,?)", scan.id, directoryId, hash).changes === 1;
  }
  finishDirectory(scan: Scan, directoryId: string): void {
    this.activeScan(scan);
    this.run("UPDATE scan_directories SET done=1 WHERE scan_id=? AND remote_id=?", scan.id, directoryId);
  }
  scanIssue(scan: Scan, sourceId: string, reason: string): void {
    this.activeScan(scan);
    if (!/^[a-z_]{1,64}$/.test(reason)) throw new AppError("invalid_input");
    this.run("INSERT OR IGNORE INTO scan_issues VALUES(?,?,?)", scan.id, sourceId, reason);
  }
  scanIssueCount(scan: Scan): number {
    return Number(this.get<{ count: bigint }>("SELECT count(*) AS count FROM scan_issues WHERE scan_id=?", scan.id)?.count ?? 0n);
  }
  scanFileCount(scan: Scan): number {
    return Number(this.get<{ count: bigint }>("SELECT count(*) AS count FROM scan_files WHERE scan_id=?", scan.id)?.count ?? 0n);
  }
  mergeFile(scan: Scan, input: { sourceId: string; gcid: string; size: bigint; relativePath: string }): FileRecord {
    if (input.size < 0n || !/^[a-f0-9]{40}$/.test(input.gcid)) throw new AppError("invalid_input");
    return this.transaction(() => {
      if (!this.get("SELECT id FROM scans WHERE id=? AND share_id=? AND account_id=? AND status='active'", scan.id, scan.shareId, scan.accountId)) throw new AppError("invalid_transition");
      this.run(`INSERT INTO files(id,share_id,account_id,source_id,gcid,size,relative_path) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(share_id,source_id,size,gcid) DO NOTHING`, identifier("f"), scan.shareId, scan.accountId, input.sourceId, input.gcid, input.size.toString(), input.relativePath);
      const row = this.get<FileRow>(`SELECT ${fileColumns} FROM files WHERE share_id=? AND source_id=? AND size=? AND gcid=?`, scan.shareId, input.sourceId, input.size.toString(), input.gcid)!;
      this.run("INSERT OR IGNORE INTO scan_files VALUES(?,?)", scan.id, row.id);
      return fileValue(row);
    });
  }
  file(accountId: string, id: string): FileRecord {
    const row = this.get<FileRow>(`SELECT ${fileColumns} FROM files WHERE id=? AND account_id=?`, id, accountId);
    if (!row) throw new AppError("account_mismatch");
    return fileValue(row);
  }
  files(accountId: string, shareId?: string): FileRecord[] {
    return this.all<FileRow>(`SELECT ${fileColumns} FROM files WHERE account_id=?${shareId ? " AND share_id=?" : ""} ORDER BY id`,
      ...[accountId, ...(shareId ? [shareId] : [])]).map(fileValue);
  }
  transition(accountId: string, fileId: string, next: FileState): void {
    this.transaction(() => {
      const file = this.file(accountId, fileId);
      if (file.cancelled && !["reconciling", "completed", "needs_attention"].includes(next)) throw new AppError("invalid_transition");
      assertTransition(file.state, next);
      this.run("UPDATE files SET state=? WHERE id=?", next, fileId);
    });
  }
  transientFailure(accountId: string, fileId: string, reason: string, now = Date.now()): void {
    if (!/^[a-z_]{1,64}$/.test(reason)) throw new AppError("invalid_input");
    this.transaction(() => {
      const file = this.file(accountId, fileId);
      if (!["ready", "downloading", "verifying", "awaiting_remote", "retry_wait"].includes(file.state)) throw new AppError("invalid_transition");
      const next = file.retries >= 3n ? "failed" : "retry_wait";
      this.run("UPDATE files SET state=?,retries=?,retry_at=?,last_error=? WHERE id=?", next, file.retries < 3n ? file.retries + 1n : 3n,
        next === "failed" ? null : BigInt(now + 1000 * 2 ** Number(file.retries)), reason, fileId);
    });
  }
  beginOperation(accountId: string, fileId: string, kind: "restore" | "delete" | "publish", payload: OperationPayload = {}): string {
    return this.transaction(() => {
      const file = this.file(accountId, fileId);
      if (this.get("SELECT id FROM operations WHERE file_id=? AND kind=? AND status<>'confirmed'", fileId, kind)) throw new AppError("needs_reconciliation");
      const id = identifier("o");
      this.run("INSERT INTO operations(id,account_id,file_id,kind,status,secret_ref,expected_version,created_at,payload_json) VALUES(?,?,?,?,'intent',?,?,?,?)", id, accountId, fileId, kind,
        this.share(accountId, file.shareId).secretRef, `${file.size}:${file.gcid}`, timestamp(), JSON.stringify(payload));
      return id;
    });
  }
  unresolved(accountId: string): Array<{ id: string; fileId: string; kind: string; status: string }> {
    return this.all("SELECT id, file_id AS fileId, kind, status FROM operations WHERE account_id=? AND status<>'confirmed' ORDER BY created_at,id", accountId);
  }
  operation(accountId: string, id: string): Operation {
    const row = this.get<Omit<Operation, "payload"> & { payload: string }>("SELECT id,account_id AS accountId,file_id AS fileId,kind,status,task_id AS taskId,result_id AS resultId,secret_ref AS secretRef,created_at AS createdAt,payload_json AS payload FROM operations WHERE id=? AND account_id=?", id, accountId);
    if (!row) throw new AppError("account_mismatch");
    return { ...row, payload: JSON.parse(row.payload) as OperationPayload };
  }
  operationFor(accountId: string, fileId: string, kind: Operation["kind"]): Operation | null {
    this.file(accountId, fileId);
    const row = this.get<{ id: string }>("SELECT id FROM operations WHERE file_id=? AND kind=? AND status<>'confirmed' ORDER BY created_at DESC LIMIT 1", fileId, kind);
    return row ? this.operation(accountId, row.id) : null;
  }
  updateOperation(accountId: string, id: string, patch: { status?: Operation["status"]; taskId?: string; resultId?: string; payload?: OperationPayload }): Operation {
    const old = this.operation(accountId, id);
    this.run("UPDATE operations SET status=?,task_id=?,result_id=?,payload_json=? WHERE id=?", patch.status ?? old.status, patch.taskId ?? old.taskId,
      patch.resultId ?? old.resultId, JSON.stringify({ ...old.payload, ...patch.payload }), id);
    return this.operation(accountId, id);
  }
  taskAlreadyRecorded(accountId: string, taskId: string, exceptOperation: string): boolean {
    return !!this.get("SELECT id FROM operations WHERE account_id=? AND task_id=? AND id<>? LIMIT 1", accountId, taskId, exceptOperation);
  }
  copy(accountId: string, copyId: string): CopyRecord {
    const row = this.get<Omit<CopyRecord, "size" | "evidence"> & { size: string; evidence: string | null }>("SELECT id,remote_id AS remoteId,parent_id AS parentId,size,gcid,ownership,state,operation_id AS operationId,evidence_json AS evidence FROM copies WHERE id=? AND account_id=?", copyId, accountId);
    if (!row) throw new AppError("account_mismatch");
    return { ...row, size: BigInt(row.size), evidence: row.evidence ? JSON.parse(row.evidence) as CreationEvidence : null };
  }
  copyForFile(accountId: string, fileId: string): CopyRecord | null {
    this.file(accountId, fileId);
    const row = this.get<{ id: string }>("SELECT c.id FROM copies c JOIN copy_references r ON r.copy_id=c.id JOIN operations o ON o.id=c.operation_id WHERE r.file_id=? AND c.account_id=? AND c.state='retained' ORDER BY o.created_at DESC,c.id DESC LIMIT 1", fileId, accountId);
    return row ? this.copy(accountId, row.id) : null;
  }
  copyState(accountId: string, copyId: string, state: CopyRecord["state"]): void { this.copy(accountId, copyId); this.run("UPDATE copies SET state=? WHERE id=?", state, copyId); }
  candidates(accountId: string, after?: { completedAt: bigint; remoteId: string }): ReclaimCandidate[] {
    const rows = this.all<{ id: string; fileId: string; completedAt: bigint; remoteId: string }>(`SELECT c.id,o.file_id AS fileId,MAX(d.completed_at) AS completedAt,c.remote_id AS remoteId
      FROM copies c JOIN operations o ON o.id=c.operation_id JOIN copy_references r ON r.copy_id=c.id
      JOIN files f ON f.id=r.file_id LEFT JOIN deliveries d ON d.file_id=f.id
      WHERE c.account_id=? AND c.ownership='created' AND c.evidence_json IS NOT NULL AND c.state='retained'
      GROUP BY c.id HAVING SUM(CASE WHEN f.state<>'completed' OR d.completed_at IS NULL THEN 1 ELSE 0 END)=0
      ${after ? "AND (MAX(d.completed_at)>? OR (MAX(d.completed_at)=? AND c.remote_id>?))" : ""}
      ORDER BY completedAt,c.remote_id LIMIT 100`, accountId, ...(after ? [after.completedAt, after.completedAt, after.remoteId] : []));
    return rows.map(row => ({ ...this.copy(accountId, row.id), fileId: row.fileId, completedAt: row.completedAt }));
  }
  canReclaim(accountId: string, copyId: string): boolean {
    return !!this.get(`SELECT c.id FROM copies c WHERE c.id=? AND c.account_id=? AND c.ownership='created' AND c.evidence_json IS NOT NULL
      AND c.state IN ('retained','deleting') AND EXISTS(SELECT 1 FROM copy_references WHERE copy_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM copy_references r JOIN files f ON f.id=r.file_id LEFT JOIN deliveries d ON d.file_id=f.id
        WHERE r.copy_id=c.id AND (f.state<>'completed' OR d.completed_at IS NULL))`, copyId, accountId);
  }
  submitted(accountId: string, operationId: string, taskId: string): void {
    const result = this.run("UPDATE operations SET status='submitted',task_id=? WHERE id=? AND account_id=? AND status='intent'", taskId, operationId, accountId);
    if (result.changes !== 1) throw new AppError("needs_reconciliation");
  }
  recordCopy(accountId: string, operationId: string, copy: { remoteId: string; parentId: string; size: bigint; gcid: string }): string {
    return this.transaction(() => {
      const operation = this.get<{ fileId: string }>("SELECT file_id AS fileId FROM operations WHERE id=? AND account_id=? AND kind='restore' AND status='submitted'", operationId, accountId);
      if (!operation) throw new AppError("needs_reconciliation");
      const file = this.file(accountId, operation.fileId);
      if (copy.size !== file.size || copy.gcid !== file.gcid) throw new AppError("needs_reconciliation");
      this.run("INSERT INTO copies(id,account_id,remote_id,parent_id,size,gcid,ownership,operation_id) VALUES(?,?,?,?,?,?,'unverified',?) ON CONFLICT(account_id,remote_id) DO NOTHING",
        identifier("c"), accountId, copy.remoteId, copy.parentId, copy.size.toString(), copy.gcid, operationId);
      const actual = this.get<{ id: string; parentId: string; size: string; gcid: string }>("SELECT id,parent_id AS parentId,size,gcid FROM copies WHERE account_id=? AND remote_id=?", accountId, copy.remoteId)!;
      if (actual.parentId !== copy.parentId || actual.size !== copy.size.toString() || actual.gcid !== copy.gcid) throw new AppError("needs_reconciliation");
      this.run("INSERT OR IGNORE INTO copy_references VALUES(?,?,?)", actual.id, file.id, accountId);
      this.run("UPDATE operations SET status='confirmed',result_id=? WHERE id=?", copy.remoteId, operationId);
      // 来源关联不自动赋予创建归属；回收模块必须另有已验证的创建证据。
      return actual.id;
    });
  }
  recordCreation(accountId: string, copyId: string, operationId: string, evidence: CreationEvidence): void {
    this.run("UPDATE copies SET ownership='created',evidence_json=? WHERE id=? AND account_id=? AND operation_id=? AND remote_id=? AND parent_id=? AND size=? AND gcid=?",
      JSON.stringify(evidence), copyId, accountId, operationId, evidence.copyId, evidence.parentId, evidence.size, evidence.gcid);
  }
  allocateDelivery(accountId: string, fileId: string, tempPath: string, targetPath: string): Delivery {
    this.file(accountId, fileId);
    this.run("INSERT INTO deliveries(file_id,account_id,temp_path,target_path) VALUES(?,?,?,?) ON CONFLICT(file_id) DO NOTHING", fileId, accountId, tempPath, targetPath);
    return this.delivery(accountId, fileId)!;
  }
  delivery(accountId: string, fileId: string): Delivery | null {
    const row = this.get<Omit<Delivery, "checkpoint" | "ranges"> & { checkpoint: string; rangesJson: string | null; size: string }>(`SELECT file_id AS fileId,
      temp_path AS tempPath,target_path AS targetPath,checkpoint,prefix_sha256 AS prefixSha256,publish_attempt AS publishAttempt,file_volume AS volume,
      file_identity AS identity,sha256,verification,completed_at AS completedAt,ranges_json AS rangesJson,(SELECT size FROM files WHERE id=file_id) AS size
      FROM deliveries WHERE file_id=? AND account_id=?`, fileId, accountId);
    if (!row) return null;
    const { rangesJson, size, ...delivery } = row, checkpoint = BigInt(row.checkpoint);
    // 区间无效时整体视为空，前缀照常使用。
    return { ...delivery, checkpoint, ranges: parseRanges(rangesJson, checkpoint, BigInt(size)) };
  }
  deliveryPlan(accountId: string, fileId: string): DeliveryPlan | null {
    this.file(accountId, fileId);
    const row = this.get<{ plan: string }>("SELECT plan_json AS plan FROM deliveries WHERE file_id=?", fileId);
    if (!row) return null;
    const plan = JSON.parse(row.plan) as Partial<DeliveryPlan>;
    return typeof plan.parent === "string" && typeof plan.name === "string" && typeof plan.tempParent === "string" && typeof plan.tempName === "string" && typeof plan.baseName === "string" ? plan as DeliveryPlan : null;
  }
  setDeliveryPlan(accountId: string, fileId: string, plan: DeliveryPlan): void {
    this.file(accountId, fileId); this.run("UPDATE deliveries SET plan_json=? WHERE file_id=?", JSON.stringify(plan), fileId);
  }
  bindTemporary(accountId: string, fileId: string, identity: FileIdentity): void {
    const delivery = this.delivery(accountId, fileId); if (!delivery) throw new AppError("invalid_transition");
    if (delivery.identity !== null && (delivery.identity !== identity.file || delivery.volume !== identity.volume)) throw new AppError("needs_reconciliation");
    this.run("UPDATE deliveries SET file_volume=?,file_identity=? WHERE file_id=?", identity.volume, identity.file, fileId);
  }
  replaceMissingTemporary(accountId: string, fileId: string, identity: FileIdentity): void {
    const file = this.file(accountId, fileId); const delivery = this.delivery(accountId, fileId);
    if (!delivery || delivery.sha256 !== null || ["publishing", "completed", "reconciling"].includes(file.state)) throw new AppError("needs_reconciliation");
    this.run("UPDATE deliveries SET file_volume=?,file_identity=?,checkpoint='0',prefix_sha256=NULL,ranges_json=? WHERE file_id=?",
      identity.volume, identity.file, this.keptMode(delivery.ranges), fileId);
  }
  planPublication(accountId: string, fileId: string, plan: DeliveryPlan, targetPath: string, sha256: string): void {
    this.transaction(() => {
      const file = this.file(accountId, fileId); const delivery = this.delivery(accountId, fileId);
      if (!delivery?.identity || !delivery.volume || !["verifying", "publishing", "reconciling"].includes(file.state) || !/^[a-f0-9]{64}$/.test(sha256)) throw new AppError("invalid_transition");
      const attempt = Number(delivery.publishAttempt + 1n);
      const operation = this.operationFor(accountId, fileId, "publish");
      if (operation) this.updateOperation(accountId, operation.id, { status: "intent", payload: { targetPath, attempt } });
      else this.beginOperation(accountId, fileId, "publish", { targetPath, attempt });
      this.run("UPDATE deliveries SET target_path=?,plan_json=?,publish_attempt=publish_attempt+1,sha256=?,verification='gcid+sha256' WHERE file_id=?", targetPath, JSON.stringify(plan), sha256, fileId);
      this.run("UPDATE files SET state='publishing' WHERE id=?", fileId);
    });
  }
  completePublication(accountId: string, fileId: string, identity: FileIdentity, sha256: string): void {
    this.transaction(() => {
      const file = this.file(accountId, fileId); const delivery = this.delivery(accountId, fileId);
      if (!delivery || !["publishing", "reconciling"].includes(file.state) || delivery.identity !== identity.file || delivery.volume !== identity.volume || delivery.sha256 !== sha256) throw new AppError("needs_reconciliation");
      this.run("UPDATE deliveries SET completed_at=? WHERE file_id=?", timestamp(), fileId);
      this.run("UPDATE files SET state='completed',last_error=NULL WHERE id=?", fileId);
      this.run("UPDATE operations SET status='confirmed' WHERE file_id=? AND kind='publish' AND status<>'confirmed'", fileId);
    });
  }
  fileError(accountId: string, fileId: string, reason: string, attention = false): void {
    const file = this.file(accountId, fileId);
    if (file.state === "completed" || !/^[a-z_]{1,64}$/.test(reason)) throw new AppError("invalid_transition");
    this.run("UPDATE files SET state=?,last_error=? WHERE id=?", attention ? "needs_attention" : "failed", reason, fileId);
  }
  // 前缀、前缀摘要与区间用同一条语句写入。省略 ranges 表示顺序路径的保存：清空区间，但保留已持久化的顺序模式。
  checkpoint(accountId: string, fileId: string, bytes: bigint, prefixSha256: string, ranges?: RangeCheckpoint): void {
    const file = this.file(accountId, fileId), delivery = this.delivery(accountId, fileId);
    if (["completed", "publishing"].includes(file.state) || delivery?.sha256 !== null
      || bytes < 0n || bytes > file.size || !/^[a-f0-9]{64}$/.test(prefixSha256)
      || (ranges !== undefined && !rangesValid(ranges, bytes, file.size))) throw new AppError("invalid_input");
    const json = ranges === undefined ? this.keptMode(delivery?.ranges ?? null) : serializeRanges(ranges);
    if (this.run("UPDATE deliveries SET checkpoint=?,prefix_sha256=?,ranges_json=? WHERE file_id=? AND account_id=? AND completed_at IS NULL",
      bytes.toString(), prefixSha256, json, fileId, accountId).changes !== 1) throw new AppError("invalid_transition");
  }
  private keptMode(ranges: RangeCheckpoint | null): string | null {
    return ranges?.mode === "sequential" ? serializeRanges({ mode: "sequential", chunk: CHUNK_SIZE, ranges: [] }) : null;
  }
  // 已持久化的字节数：连续前缀加已保存区间，供界面显示断点进度。
  persistedBytes(accountId: string, fileId: string): bigint {
    const delivery = this.delivery(accountId, fileId);
    return delivery ? persistedBytes(delivery.checkpoint, delivery.ranges) : 0n;
  }
  cancel(accountId: string, id: string): void {
    this.transaction(() => {
      if (id.startsWith("s_")) {
        this.share(accountId, id);
        this.run("UPDATE shares SET cancelled=1 WHERE id=?", id);
        this.run("UPDATE files SET cancelled=1 WHERE share_id=? AND state<>'completed'", id);
      } else { this.file(accountId, id); this.run("UPDATE files SET cancelled=1 WHERE id=? AND state<>'completed'", id); }
    });
  }
  retry(accountId: string, id: string): void {
    this.transaction(() => {
      const shareScope = id.startsWith("s_");
      if (shareScope) {
        this.share(accountId, id);
        this.run("UPDATE shares SET cancelled=0,requested_revision=requested_revision+1,scan_status=CASE WHEN scan_status='active' THEN 'active' ELSE 'pending' END WHERE id=?", id);
      } else { this.file(accountId, id); }
      const files = shareScope ? this.files(accountId, id) : [this.file(accountId, id)];
      for (const file of files) {
        if (file.state === "completed") continue;
        const unknown = this.get("SELECT id FROM operations WHERE file_id=? AND status<>'confirmed'", file.id);
        const next = unknown || ["saving", "publishing", "reconciling"].includes(file.state) ? "reconciling"
          : file.cancelled || ["failed", "needs_attention", "waiting_space", "retry_wait"].includes(file.state) ? "ready" : file.state;
        this.run("UPDATE files SET cancelled=0,state=?,retries=0,retry_at=NULL,last_error=NULL WHERE id=?", next, file.id);
        // 显式重试允许重新尝试并行下载（服务端行为可能已经变化）；自动重试保留顺序模式标记。
        if (this.delivery(accountId, file.id)?.ranges?.mode === "sequential") this.run("UPDATE deliveries SET ranges_json=NULL WHERE file_id=?", file.id);
      }
    });
  }
  summary(accountId: string, id: string): ShareSummary {
    const share = this.share(accountId, id);
    const groups = this.all<{ state: FileState; cancelled: bigint; count: bigint }>("SELECT state,cancelled,count(*) AS count FROM files WHERE account_id=? AND share_id=? GROUP BY state,cancelled", accountId, id);
    const counts: Counts = { total: 0, completed: 0, cancelled: 0, failed: 0, waiting: 0, active: 0 };
    for (const group of groups) {
      if (group.count > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError("state_unavailable");
      const count = Number(group.count); counts.total += count;
      if (group.state === "completed") counts.completed += count;
      else if (share.cancelled || group.cancelled === 1n) counts.cancelled += count;
      else if (["failed", "needs_attention"].includes(group.state)) counts.failed += count;
      else if (["waiting_space", "retry_wait", "reconciling"].includes(group.state)) counts.waiting += count;
      else counts.active += count;
    }
    return { ...aggregateCounts(counts, share.scanStatus, share.cancelled), reason: share.lastError };
  }
  // 界面只读视图：仅含 SELECT，只读连接也可调用。
  shareViews(accountId: string): ShareView[] {
    return this.all<ShareRow & { title: string | null }>(`SELECT ${shareColumns}, title FROM shares WHERE account_id=? ORDER BY created_at,id`, accountId)
      .map(row => ({ id: row.id, title: row.title, outputRoot: row.outputRoot, scanStatus: row.scanStatus, cancelled: row.cancelled === 1n,
        lastError: row.lastError, summary: this.summary(accountId, row.id) }));
  }
  fileViews(accountId: string, shareId: string): FileView[] {
    this.share(accountId, shareId);
    // 文件可能先后关联多份副本，显示最近一次转存产生的那份。
    return this.all<FileRow & { checkpoint: string; rangesJson: string | null; copyState: CopyRecord["state"] | null }>(`SELECT ${fileColumns},
      COALESCE((SELECT checkpoint FROM deliveries WHERE file_id=files.id),'0') AS checkpoint,
      (SELECT ranges_json FROM deliveries WHERE file_id=files.id) AS rangesJson,
      (SELECT c.state FROM copies c JOIN copy_references r ON r.copy_id=c.id JOIN operations o ON o.id=c.operation_id
        WHERE r.file_id=files.id ORDER BY o.created_at DESC,c.id DESC LIMIT 1) AS copyState
      FROM files WHERE account_id=? AND share_id=? ORDER BY rowid`, accountId, shareId)
      .map(row => {
        const file = fileValue(row), prefix = BigInt(row.checkpoint);
        return { id: file.id, shareId: file.shareId, relativePath: file.relativePath, size: file.size, state: file.state, retries: file.retries,
          cancelled: file.cancelled, lastError: file.lastError, checkpoint: persistedBytes(prefix, parseRanges(row.rangesJson, prefix, file.size)), copyState: row.copyState };
      });
  }
  pause(accountId: string, reason: PauseReason, fileId: string | null = null): void {
    if (fileId) this.file(accountId, fileId);
    this.run("INSERT INTO pauses VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET reason=excluded.reason,file_id=excluded.file_id", accountId, reason, fileId);
  }
  paused(accountId: string): Pause | null { return this.get("SELECT reason,file_id AS fileId FROM pauses WHERE account_id=?", accountId); }
  clearAuthenticationPause(accountId: string): void {
    this.run("DELETE FROM pauses WHERE account_id=? AND reason IN ('authentication','permission')", accountId);
  }
  recheckCancelledPause(accountId: string): void {
    const pause = this.paused(accountId);
    if (!pause?.fileId || !["local_space", "target_unavailable"].includes(pause.reason)) return;
    const blocked = this.file(accountId, pause.fileId);
    const share = this.share(accountId, blocked.shareId);
    if (!blocked.cancelled && !share.cancelled && blocked.state !== "completed") return;
    // 取消只解除与该项关联的路径暂停；执行器仍在每个后续文件开始前实际复检。
    this.run("DELETE FROM pauses WHERE account_id=?", accountId);
  }
  resume(accountId: string, conditions: Parameters<typeof canResume>[1]): boolean {
    const pause = this.paused(accountId);
    if (!pause) return true;
    if (!canResume(pause, conditions)) return false;
    this.run("DELETE FROM pauses WHERE account_id=?", accountId);
    return true;
  }
  secretReferenced(reference: string): boolean {
    return !!this.get("SELECT id FROM shares WHERE secret_ref=? UNION ALL SELECT id FROM scans WHERE secret_ref=? AND status='active' UNION ALL SELECT id FROM operations WHERE secret_ref=? AND status<>'confirmed' LIMIT 1", reference, reference, reference);
  }
}
