export type ClipboardSnapshot = { sequence: string; text: string | null };
export type FileIdentity = { volume: string; file: string };
export interface SecretStore {
  get(reference: string): Promise<string | null>;
  set(reference: string, value: string): Promise<void>;
  delete(reference: string): Promise<void>;
}
export interface Platform {
  secrets: SecretStore;
  clipboard(): Promise<ClipboardSnapshot | null>;
  acquireLock(path: string): { release(): void };
  identity(path: string): FileIdentity;
  publishNoReplace(source: string, destination: string): boolean;
  openBrowser(url: string): Promise<void>;
}
