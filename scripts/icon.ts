import { deflateSync } from "node:zlib";

// Windows 产物图标：参照 PikPak 的蓝底纸箱形象，改成像素风（呼应 README 的字符标志），
// 箱面换成终端提示符 >_，右下角加 README 标志青色的下载角标。
// 图案画在 24×24 网格上，按各尺寸超采样绘制后封装为内嵌 PNG 的 ICO，不依赖外部栅格化工具。
const art = [
  "........................",
  "........................",
  "........................",
  "...........WW...........",
  "..........WWWW..........",
  "...WWWWWWWWWWWWWWWWWW...",
  "...WWWWWWWWWWWWWWWWWW...",
  "...WWWWWWWWWWWWWWWWWW...",
  "...ssssssssssssssssss...",
  "...WWWWWWWWWWWWWWWWWW...",
  "...WWWWWWWWWWWWWWWWWW...",
  "...WWWWFFWWWWWWWWWWWW...",
  "...WWWWWFFWWWWWWWWWWW...",
  "...WWWWWWFFWWWWWWWWWW...",
  "...WWWWWFFWWWWWWWWWWW...",
  "...WWWWFFWWWFFFFWWWWW...",
  "...WWWWWWWWWWWWWWDDDDD..",
  "...WWWWWWWWWWWWWDDCCCDD.",
  "...WWWWWWWWWWWWWDDCCCDD.",
  "...WWWWWWWWWWWWWDCCCCCD.",
  "...WWWWWWWWWWWWWDDCCCDD.",
  "................DDDCDDD.",
  ".................DDDDD..",
  "........................",
];
const palette: Record<string, readonly [number, number, number]> = {
  ".": [0x30, 0x6e, 0xff], F: [0x30, 0x6e, 0xff], W: [0xff, 0xff, 0xff], s: [0xc8, 0xd8, 0xff],
  D: [0x16, 0x17, 0x1f], C: [0x5c, 0xcf, 0xe6],
};
const grid = art.length;
const sizes = [16, 24, 32, 48, 64, 128, 256];

function render(size: number): Uint8Array {
  const radius = size * 0.2;
  const samples = 4;
  const pixels = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const u = px + (sx + 0.5) / samples, v = py + (sy + 0.5) / samples;
      const dx = Math.max(radius - u, 0, u - (size - radius)), dy = Math.max(radius - v, 0, v - (size - radius));
      if (dx * dx + dy * dy > radius * radius) continue;
      const [cr, cg, cb] = palette[art[Math.floor(v / size * grid)]![Math.floor(u / size * grid)]!]!;
      r += cr; g += cg; b += cb; a++;
    }
    const at = (py * size + px) * 4;
    if (a) pixels.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / samples ** 2 * 255)], at);
  }
  return pixels;
}

function png(size: number, pixels: Uint8Array): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rows.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  return Buffer.concat([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]);
}

export const iconPng = (size: number) => png(size, render(size));

export function iconIco(): Uint8Array {
  const images = sizes.map(iconPng);
  const directory = new Uint8Array(6 + 16 * images.length);
  const view = new DataView(directory.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, images.length, true);
  let offset = directory.length;
  images.forEach((image, index) => {
    const at = 6 + 16 * index, size = sizes[index]!;
    directory.set([size % 256, size % 256, 0, 0], at);
    view.setUint16(at + 4, 1, true);
    view.setUint16(at + 6, 32, true);
    view.setUint32(at + 8, image.length, true);
    view.setUint32(at + 12, offset, true);
    offset += image.length;
  });
  return Buffer.concat([directory, ...images]);
}
