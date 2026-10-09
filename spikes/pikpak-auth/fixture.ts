import { ProbeError } from "./protocol";

export type ShareFixture = { shareId: string; passCode: string };

export function parseFixture(text: string, separateCode = ""): ShareFixture {
  if (text.length > 16_384 || separateCode.length > 128) throw new ProbeError("fixture", "input-too-large");
  const urls = text.match(/https:\/\/[^\s<>"']+/g) ?? [];
  if (urls.length !== 1) throw new ProbeError("fixture", "one-share-required");
  let url: URL;
  try { url = new URL(urls[0]!); }
  catch { throw new ProbeError("fixture", "invalid-share-format"); }
  const match = /^\/s\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname);
  if (url.origin !== "https://mypikpak.com" || url.username || url.password || !match?.[1]) {
    throw new ProbeError("fixture", "unsupported-share-format");
  }
  const codes = [separateCode.trim()];
  for (const name of ["pwd", "password", "passcode", "pass_code"]) codes.push(...url.searchParams.getAll(name));
  const withoutUrl = text.replace(urls[0]!, " ");
  for (const code of withoutUrl.matchAll(/(?:提取码|密码|passcode|password)\s*[:：]?\s*([A-Za-z0-9]{1,32})/gi)) {
    codes.push(code[1]!);
  }
  const unique = [...new Set(codes.filter(Boolean))];
  if (unique.length > 1 || unique.some(code => !/^[A-Za-z0-9]{1,32}$/.test(code))) {
    throw new ProbeError("fixture", "ambiguous-access-code");
  }
  return { shareId: match[1], passCode: unique[0] ?? "" };
}
