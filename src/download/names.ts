import { createHash } from "node:crypto";
export const shortId = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 10);
export const nodeId = (value: string): string => createHash("sha256").update(value).digest("hex");
export const foldedName = (name: string): string => name.normalize("NFC").toLowerCase();

export function safeName(input: string, suffix = "", maximum = 240): string {
  if (maximum < 16) throw Error("path-unrepresentable");
  let name = Buffer.from(input, "utf8").toString("utf8").normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").replace(/[. ]+$/g, "");
  if (!name || name === "." || name === "..") name = "item";
  if (/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(name.split(".")[0]!.trimEnd())) name = `_${name}`;
  const match = /^(.+)(\.[^.]{1,20})$/.exec(name);
  let stem = match?.[1] ?? name; const extension = match?.[2] ?? "";
  const budget = maximum - Buffer.byteLength(suffix + extension, "utf8");
  let kept = "", bytes = 0;
  for (const character of stem) { const length = Buffer.byteLength(character, "utf8"); if (bytes + length > budget) break; kept += character; bytes += length; }
  stem = kept;
  if (!stem || Buffer.byteLength(`${stem}${suffix}${extension}`, "utf8") > maximum) throw Error("path-unrepresentable");
  return `${stem}${suffix}${extension}`;
}
