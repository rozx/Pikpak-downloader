import { identity, ProbeError } from "./protocol";
import type { SelectedFile } from "./share-probe";
import { MacSecrets } from "../../src/auth/secrets";
import { SessionManager } from "../../src/auth/session";

export const VERIFICATION_SERVICE = "com.rozx.pikpak-downloader.verification";
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProbeError("fixture", "invalid-record");
  return value as Record<string, unknown>;
};
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export async function loadFixtureSession(): Promise<{
  accountId: string; accessToken: string; shareId: string; passCode: string; selected: SelectedFile;
}> {
  const [sessionRaw, fixtureRaw, selectionRaw] = await Promise.all([
    Bun.secrets.get({ service: VERIFICATION_SERVICE, name: "session.current" }),
    Bun.secrets.get({ service: VERIFICATION_SERVICE, name: "share-fixture.v1" }),
    Bun.secrets.get({ service: VERIFICATION_SERVICE, name: "share-selection.v1" }),
  ]);
  if (!sessionRaw || !fixtureRaw || !selectionRaw) throw new ProbeError("fixture", "local-input-or-inspection-required");
  const session = object(JSON.parse(sessionRaw));
  const fixture = object(JSON.parse(fixtureRaw));
  const selection = object(JSON.parse(selectionRaw));
  const file = object(selection.selected);
  if (typeof session.accountId !== "string" || typeof session.accessKey !== "string"
    || !/^session\.[0-9a-f-]{36}\.access$/.test(session.accessKey) || fixture.accountId !== session.accountId
    || selection.accountId !== session.accountId || selection.shareId !== fixture.shareId
    || !id(fixture.shareId) || typeof fixture.passCode !== "string"
    || !id(file.id) || typeof file.parentId !== "string" || typeof file.name !== "string"
    || typeof file.size !== "string" || !/^\d+$/.test(file.size)
    || (file.hash !== null && typeof file.hash !== "string") || typeof file.depth !== "number") {
    throw new ProbeError("fixture", "account-or-selection-mismatch");
  }
  // 业务会话验收后，以业务凭据代次为准，避免两个命名空间并发轮换同一授权。
  const productionSecrets = new MacSecrets();
  const productionSession = await productionSecrets.get("session.current");
  const accessToken = productionSession
    ? await new SessionManager(productionSecrets).access(session.accountId)
    : await Bun.secrets.get({ service: VERIFICATION_SERVICE, name: session.accessKey });
  if (!accessToken || await identity(accessToken) !== session.accountId) throw new ProbeError("identity", "account-mismatch");
  return { accountId: session.accountId, accessToken, shareId: fixture.shareId, passCode: fixture.passCode,
    selected: file as SelectedFile };
}
