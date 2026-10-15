export type ShareInput = { shareId: string; passCode: string };
export type ParseResult = { shares: ShareInput[]; issues: Array<"input_too_large" | "ambiguous_code" | "unsupported_link"> };
type Link = { start: number; end: number; raw: string; shareId: string; codes: string[] };
const trimPresentation = (value: string) => value.replace(/[，。；、）】》」\]),.;!]+$/u, "");

function codes(text: string): string[] {
  return [...text.matchAll(/(?:提取码|密码|pass\s*code|password)(?:\s*[:：=]\s*|\s+)([^\s，。,；;<>]+)/gi)]
    .map(match => trimPresentation(match[1]!));
}
const urls = /https?:\/\/[^\s<>"'，。；、）】》」]+/gi;
// 官方复制的分享文本以空行隔开链接与提取码；只含码的块并入紧邻的、尚无任何码的链接块，其余块仍互相隔离。
function blocks(text: string): string[] {
  const result: string[] = [];
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    if (!block.trim()) continue;
    const previous = result.at(-1);
    if (previous !== undefined && !/https?:\/\//i.test(block) && codes(block).length && /https?:\/\//i.test(previous)
      && !codes(previous.replace(urls, " ")).length && !/https?:\/\/\S*[?&](?:pwd|password|passcode|pass_code)=/i.test(previous)) {
      result[result.length - 1] = `${previous}\n${block}`;
    } else result.push(block);
  }
  return result;
}
function uniqueCode(values: string[]): string | null {
  const unique = [...new Set(values.filter(Boolean))];
  return unique.length <= 1 && unique.every(value => /^[A-Za-z0-9]{1,32}$/.test(value)) ? unique[0] ?? "" : null;
}

export function parseShares(text: string): ParseResult {
  if (text.length > 65536) return { shares: [], issues: text.includes("https://mypikpak.com/s/") ? ["input_too_large"] : [] };
  const result: ParseResult = { shares: [], issues: [] };
  for (const block of blocks(text)) {
    const links: Link[] = [];
    const urlMatches = [...block.matchAll(/https?:\/\/[^\s<>"'，。；、）】》」]+/gi)];
    for (const match of urlMatches) {
      const raw = trimPresentation(match[0]);
      let url: URL;
      try { url = new URL(raw); } catch { continue; }
      const path = /^\/s\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname);
      if (url.origin !== "https://mypikpak.com" || url.username || url.password || !path?.[1]) {
        if (url.hostname === "mypikpak.com") result.issues.push("unsupported_link");
        continue;
      }
      const queryCodes = ["pwd", "password", "passcode", "pass_code"].flatMap(key => url.searchParams.getAll(key));
      links.push({ start: match.index, end: match.index + match[0].length, raw: match[0], shareId: path[1], codes: queryCodes });
    }
    if (!links.length) continue;
    const withoutUrls = block.replace(/https?:\/\/[^\s<>"'，。；、）】》」]+/gi, " ");
    if (urlMatches.length !== links.length && codes(withoutUrls).length) {
      result.issues.push("ambiguous_code"); continue;
    }
    if (links.length === 1) {
      const link = links[0]!;
      const passCode = uniqueCode([...link.codes, ...codes(withoutUrls)]);
      if (passCode === null) result.issues.push("ambiguous_code");
      else result.shares.push({ shareId: link.shareId, passCode });
      continue;
    }
    const externalCodes = codes(withoutUrls);
    const prefixCodes = codes(block.slice(0, links[0]!.start));
    const segments = links.map((link, index) => codes(block.slice(link.end, links[index + 1]?.start ?? block.length)));
    // 每行单独完整配对，或每个链接后均有明确标记，或码直接嵌在链接里。
    const lines = block.split(/\r?\n/);
    const ownLineCodes = links.map(link => {
      const start = block.lastIndexOf("\n", link.start - 1) + 1;
      const next = block.indexOf("\n", link.end);
      const end = next < 0 ? block.length : next;
      if (links.filter(other => other.start >= start && other.start < end).length !== 1) return null;
      return codes(block.slice(start, end).replace(/https?:\/\/[^\s<>"'，。；、）】》」]+/gi, " "));
    });
    const codesOutsideLinkLines = lines.some(line => !/https?:\/\//i.test(line) && codes(line).length > 0);
    const linePairs = ownLineCodes.every(value => value !== null) && !codesOutsideLinkLines;
    if (externalCodes.length && !linePairs && (prefixCodes.length || segments.some((values, index) => !values.length && !links[index]!.codes.length))) {
      result.issues.push("ambiguous_code"); continue;
    }
    const paired = links.map((link, index) => ({ shareId: link.shareId,
      passCode: uniqueCode([...link.codes, ...(linePairs ? ownLineCodes[index]! : segments[index]!)]) }));
    if (paired.some(value => value.passCode === null)) { result.issues.push("ambiguous_code"); continue; }
    for (const item of paired) result.shares.push({ shareId: item.shareId, passCode: item.passCode! });
  }
  // 同一份输入中同一分享出现矛盾访问码时不按文本顺序猜测。
  const grouped = new Map<string, Set<string>>();
  for (const item of result.shares) {
    const group = grouped.get(item.shareId) ?? new Set(); group.add(item.passCode); grouped.set(item.shareId, group);
  }
  result.shares = [...grouped].flatMap(([shareId, values]) => {
    if (values.size > 1) { result.issues.push("ambiguous_code"); return []; }
    return [{ shareId, passCode: [...values][0]! }];
  });
  result.issues = [...new Set(result.issues)];
  return result;
}
