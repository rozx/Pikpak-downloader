export const SCHEMA_VERSION = 4;
export const APPLICATION_ID = 0x504b444c;
const scanProgressSchema = `
CREATE TABLE scan_directories(scan_id TEXT NOT NULL REFERENCES scans(id), remote_id TEXT NOT NULL, path_json TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)), PRIMARY KEY(scan_id,remote_id)) STRICT;
CREATE TABLE scan_pages(scan_id TEXT NOT NULL REFERENCES scans(id), directory_id TEXT NOT NULL, token_hash TEXT NOT NULL,
  PRIMARY KEY(scan_id,directory_id,token_hash)) STRICT;
CREATE TABLE scan_issues(scan_id TEXT NOT NULL REFERENCES scans(id), source_id TEXT NOT NULL, reason TEXT NOT NULL,
  PRIMARY KEY(scan_id,source_id,reason)) STRICT;
`;
export const migrationFrom1 = `ALTER TABLE shares ADD COLUMN last_error TEXT; ${scanProgressSchema}`;
const localPathSchema = `
CREATE TABLE directories(share_id TEXT NOT NULL REFERENCES shares(id), node_id TEXT NOT NULL, parent_id TEXT NOT NULL,
 name TEXT NOT NULL, folded TEXT NOT NULL, volume TEXT NOT NULL, identity TEXT NOT NULL,
 PRIMARY KEY(share_id,node_id), UNIQUE(share_id,parent_id,folded)) STRICT;
CREATE UNIQUE INDEX file_share_identity ON files(id,share_id);
CREATE TABLE name_reservations(share_id TEXT NOT NULL, parent_id TEXT NOT NULL, folded TEXT NOT NULL,
 file_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(share_id,parent_id,folded),
 FOREIGN KEY(file_id,share_id) REFERENCES files(id,share_id)) STRICT;
`;
export const migrationFrom2 = `
ALTER TABLE shares ADD COLUMN root_volume TEXT;
ALTER TABLE shares ADD COLUMN root_identity TEXT;
ALTER TABLE shares ADD COLUMN title TEXT;
ALTER TABLE operations ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE copies ADD COLUMN evidence_json TEXT;
ALTER TABLE deliveries ADD COLUMN plan_json TEXT NOT NULL DEFAULT '{}';
${localPathSchema}`;
// 版本 4：分段下载检查点的区间与下载模式，见 src/state/ranges.ts。
export const migrationFrom3 = "ALTER TABLE deliveries ADD COLUMN ranges_json TEXT;";
export const schema = `
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT INTO metadata VALUES('backup_review_required', '0');
CREATE TABLE accounts(id TEXT PRIMARY KEY, session_ref TEXT, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE config(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE shares(
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), remote_id TEXT NOT NULL,
  output_root TEXT NOT NULL, directory TEXT, secret_ref TEXT NOT NULL,
  requested_revision INTEGER NOT NULL DEFAULT 1 CHECK(requested_revision > 0),
  attempted_revision INTEGER NOT NULL DEFAULT 0 CHECK(attempted_revision >= 0 AND attempted_revision <= requested_revision),
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)),
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK(scan_status IN ('pending','active','complete','failed')),
  created_at INTEGER NOT NULL, last_error TEXT, root_volume TEXT, root_identity TEXT, title TEXT,
  UNIQUE(account_id,remote_id), UNIQUE(id,account_id)
) STRICT;
CREATE TABLE scans(
  id TEXT PRIMARY KEY, share_id TEXT NOT NULL, account_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0), secret_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','complete','failed')),
  retries INTEGER NOT NULL DEFAULT 0 CHECK(retries >= 0), cursor_json TEXT,
  UNIQUE(share_id,revision), FOREIGN KEY(share_id,account_id) REFERENCES shares(id,account_id)
) STRICT;
CREATE UNIQUE INDEX single_scan ON scans(share_id) WHERE status='active';
${scanProgressSchema}
CREATE TABLE files(
  id TEXT PRIMARY KEY, share_id TEXT NOT NULL, account_id TEXT NOT NULL,
  source_id TEXT NOT NULL, gcid TEXT NOT NULL CHECK(length(gcid)=40 AND gcid NOT GLOB '*[^a-f0-9]*'),
  size TEXT NOT NULL CHECK(size<>'' AND size NOT GLOB '*[^0-9]*'), relative_path TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'discovered' CHECK(state IN ('discovered','ready','saving','awaiting_remote','downloading','verifying','publishing','completed','waiting_space','retry_wait','failed','reconciling','needs_attention')),
  retries INTEGER NOT NULL DEFAULT 0 CHECK(retries >= 0), retry_at INTEGER,
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)), last_error TEXT,
  FOREIGN KEY(share_id,account_id) REFERENCES shares(id,account_id), UNIQUE(id,account_id), UNIQUE(share_id,source_id,size,gcid)
) STRICT;
CREATE TABLE scan_files(scan_id TEXT NOT NULL REFERENCES scans(id), file_id TEXT NOT NULL REFERENCES files(id), PRIMARY KEY(scan_id,file_id)) STRICT;
CREATE TABLE operations(
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, file_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('restore','delete','publish')),
  status TEXT NOT NULL CHECK(status IN ('intent','submitted','confirmed','attention')),
  task_id TEXT, result_id TEXT, secret_ref TEXT NOT NULL, expected_version TEXT NOT NULL, created_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(file_id,account_id) REFERENCES files(id,account_id), UNIQUE(id,account_id)
) STRICT;
CREATE UNIQUE INDEX unresolved_operation ON operations(file_id,kind) WHERE status<>'confirmed';
CREATE TABLE copies(
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), remote_id TEXT NOT NULL,
  parent_id TEXT NOT NULL, size TEXT NOT NULL, gcid TEXT NOT NULL,
  ownership TEXT NOT NULL CHECK(ownership IN ('unverified','created')),
  operation_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'retained' CHECK(state IN ('retained','deleting','deleted','protected')),
  evidence_json TEXT, FOREIGN KEY(operation_id,account_id) REFERENCES operations(id,account_id), UNIQUE(account_id,remote_id), UNIQUE(id,account_id)
) STRICT;
CREATE TABLE copy_references(
  copy_id TEXT NOT NULL, file_id TEXT NOT NULL, account_id TEXT NOT NULL,
  PRIMARY KEY(copy_id,file_id), FOREIGN KEY(copy_id,account_id) REFERENCES copies(id,account_id),
  FOREIGN KEY(file_id,account_id) REFERENCES files(id,account_id)
) STRICT;
CREATE TABLE deliveries(
  file_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, temp_path TEXT NOT NULL,
  target_path TEXT NOT NULL, publish_attempt INTEGER NOT NULL DEFAULT 0 CHECK(publish_attempt >= 0),
  file_volume TEXT, file_identity TEXT, checkpoint TEXT NOT NULL DEFAULT '0', prefix_sha256 TEXT,
  sha256 TEXT, verification TEXT, completed_at INTEGER, plan_json TEXT NOT NULL DEFAULT '{}', ranges_json TEXT,
  FOREIGN KEY(file_id,account_id) REFERENCES files(id,account_id)
) STRICT;
CREATE TABLE pauses(
  account_id TEXT PRIMARY KEY REFERENCES accounts(id), reason TEXT NOT NULL,
  file_id TEXT, FOREIGN KEY(file_id,account_id) REFERENCES files(id,account_id)
) STRICT;
${localPathSchema}
CREATE TRIGGER completed_is_final BEFORE UPDATE OF state ON files
WHEN OLD.state='completed' AND NEW.state<>'completed' BEGIN SELECT RAISE(ABORT,'completed-is-final'); END;
CREATE TRIGGER completion_requires_delivery BEFORE UPDATE OF state ON files
WHEN NEW.state='completed' AND NOT EXISTS(SELECT 1 FROM deliveries WHERE file_id=NEW.id AND completed_at IS NOT NULL
 AND sha256 IS NOT NULL AND file_identity IS NOT NULL AND file_volume IS NOT NULL AND verification IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'delivery-required'); END;
`;
