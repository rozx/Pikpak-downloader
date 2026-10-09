export function originalLink(file: Record<string, unknown>): { url: string; source: "octet-stream" | "legacy" } | null {
  const links = file.links;
  if (links && typeof links === "object" && !Array.isArray(links)) {
    const entry = (links as Record<string, unknown>)["application/octet-stream"];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const url = (entry as Record<string, unknown>).url;
      if (typeof url === "string" && url) return { url, source: "octet-stream" };
    }
  }
  if (typeof file.web_content_link === "string" && file.web_content_link) {
    return { url: file.web_content_link, source: "legacy" };
  }
  return null;
}

export function secureDownloadUrl(address: string): { url: URL; upgraded: boolean } | null {
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.username || url.password || url.port || !["http:", "https:"].includes(url.protocol)
    || !["mypikpak.com", "mypikpak.net"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
  const upgraded = url.protocol === "http:";
  if (upgraded) url.protocol = "https:";
  return { url, upgraded };
}
