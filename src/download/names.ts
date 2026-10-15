import { createHash } from "node:crypto";
export const shortId = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 10);
export const nodeId = (value: string): string => createHash("sha256").update(value).digest("hex");
export const foldedName = (name: string): string => name.normalize("NFC").toLowerCase();

// 任务名称（add-task-controls 决策 9）：分享标题去掉文件后缀，用作分享目录名与界面显示。
// 依次去掉分卷后缀（.part1.rar、.7z.001、.zip.002）、.tar.gz 这类双后缀与普通后缀（至少含一个字母，如 .rar、.mkv、.r00）。
export function taskName(title: string): string {
  const name = title.trim()
    .replace(/\.part\d+\.rar$/i, "")
    .replace(/\.(7z|zip|rar|tar|gz|bz2|xz)\.\d{1,4}$/i, "")
    .replace(/\.tar\.(gz|bz2|xz|zst)$/i, "")
    .replace(/\.(?=[0-9]*[a-z])[a-z0-9]{1,10}$/i, "")
    .trim();
  return name || title.trim() || title;
}

// splitExtension：文件名把后缀放在冲突后缀之后（a~x.mkv）；目录名不拆后缀（标题里的点不是后缀）。
export function safeName(input: string, suffix = "", maximum = 240, splitExtension = true): string {
  if (maximum < 16) throw Error("path-unrepresentable");
  let name = Buffer.from(input, "utf8").toString("utf8").normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").replace(/[. ]+$/g, "");
  if (!name || name === "." || name === "..") name = "item";
  if (/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(name.split(".")[0]!.trimEnd())) name = `_${name}`;
  const match = splitExtension ? /^(.+)(\.[^.]{1,20})$/.exec(name) : null;
  let stem = match?.[1] ?? name; const extension = match?.[2] ?? "";
  const budget = maximum - Buffer.byteLength(suffix + extension, "utf8");
  let kept = "", bytes = 0;
  for (const character of stem) { const length = Buffer.byteLength(character, "utf8"); if (bytes + length > budget) break; kept += character; bytes += length; }
  stem = kept;
  if (!stem || Buffer.byteLength(`${stem}${suffix}${extension}`, "utf8") > maximum) throw Error("path-unrepresentable");
  return `${stem}${suffix}${extension}`;
}
