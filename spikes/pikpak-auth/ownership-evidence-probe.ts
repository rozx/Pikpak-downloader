import { loadFixtureSession, VERIFICATION_SERVICE } from "./fixture-session";
import { requestJson } from "./protocol";
import { MacSecrets } from "../../src/auth/secrets";
import { SessionManager } from "../../src/auth/session";

const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fieldNames = (value: unknown) => Object.keys(obj(value)).filter(key => /^[a-z_]{3,48}$/.test(key)
  && /(creat|client|parent|source|trace|restore|file|overwrite|exist|duplicate|origin|new|copy|save)/.test(key));
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

try {
  const input = await loadFixtureSession();
  const client = await new SessionManager(new MacSecrets()).client();
  const read = async (name: string) => {
    const raw = await Bun.secrets.get({ service: VERIFICATION_SERVICE, name });
    if (!raw) throw Error("journal-required");
    const journal = obj(JSON.parse(raw));
    if (journal.accountId !== input.accountId || journal.shareId !== input.shareId || journal.sourceId !== input.selected.id
      || typeof journal.taskId !== "string" || typeof journal.destinationId !== "string"
      || !/^[A-Za-z0-9_-]{1,128}$/.test(journal.taskId) || !/^[A-Za-z0-9_-]{1,128}$/.test(journal.destinationId)) throw Error("journal-mismatch");
    const headers = { Authorization: `Bearer ${input.accessToken}` };
    const base = "https://api-drive.mypikpak.com/drive/v1";
    const taskRaw = await requestJson("ownership-task", `${base}/tasks/${encodeURIComponent(journal.taskId)}`, { headers });
    const fileRaw = await requestJson("ownership-file", `${base}/files/${encodeURIComponent(journal.destinationId)}`, { headers });
    return { journal, task: obj(taskRaw.task ?? taskRaw), file: obj(fileRaw.file ?? fileRaw) };
  };
  const first = await read("share-restore-probe.v1");
  const second = await read("isolated-restore-via-restore.v1");
  console.log(JSON.stringify({ taskWasReused: first.journal.taskId === second.journal.taskId,
    destinationWasReused: first.journal.destinationId === second.journal.destinationId,
    actualParentSameAsEarlierCopy: first.file.parent_id === second.file.parent_id,
    evidence: [first, second].map(({ task, file }) => ({ taskFields: fieldNames(task), taskParameterFields: fieldNames(task.params),
      fileFields: fieldNames(file), fileParameterFields: fieldNames(file.params),
      fileClientMatches: file.client_id === undefined ? null : file.client_id === client.clientId,
      taskClientMatches: task.client_id === undefined ? null : task.client_id === client.clientId,
      fileCreatedAtOrAfterTask: date(file.created_time) === null || date(task.created_time) === null ? null : date(file.created_time)! >= date(task.created_time)!,
      fileCreatedStrictlyAfterTask: date(file.created_time) === null || date(task.created_time) === null ? null : date(file.created_time)! > date(task.created_time)!,
      sourceProvenanceMatches: obj(file.params).original_file_id === input.selected.id,
      shareProvenanceMatches: obj(file.params).original_share_id === input.shareId,
      taskType: typeof task.type === "string" && /^[a-z_#]{2,64}$/.test(task.type) && /restore|share|task|copy/.test(task.type) ? task.type : null,
      taskFileIdIsCopy: task.file_id === file.id, contentMatches: String(file.size) === input.selected.size && file.hash === input.selected.hash,
    })) }));
} catch { console.log(JSON.stringify({ ownershipEvidenceRead: false })); process.exitCode = 1; }
