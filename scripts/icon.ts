import { deflateSync } from "node:zlib";

// Windows 产物图标：参照 PikPak 的蓝底纸箱形象，改成像素风（呼应 README 的字符标志），
// 箱面换成终端提示符 >_，右下角加 README 标志青色的下载角标。
// 小尺寸用 16×16 的简化图，大尺寸用 24×24 的图；每个尺寸选整数倍放大后余量最小的那张，
// 网格对齐到整像素、余量用底色补齐，像素边缘保持锐利，只有圆角做抗锯齿。不依赖外部栅格化工具。
const arts = [[
  "................",
  "................",
  ".......WW.......",
  "..WWWWWWWWWWWW..",
  "..ssssssssssss..",
  "..WWWWWWWWWWWW..",
  "..WWFWWWWWWWWW..",
  "..WWWFWWWWWWWW..",
  "..WWWWFWWWWWWW..",
  "..WWWFWWWWWDDD..",
  "..WWFWWFFFDDCDD.",
  "..WWWWWWWWDDCDD.",
  "..WWWWWWWWDCCCD.",
  "..WWWWWWWWDDCDD.",
  "...........DDD..",
  "................",
], [
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
]];
const palette: Record<string, readonly [number, number, number]> = {
  ".": [0x30, 0x6e, 0xff], F: [0x30, 0x6e, 0xff], W: [0xff, 0xff, 0xff], s: [0xc8, 0xd8, 0xff],
  D: [0x16, 0x17, 0x1f], C: [0x5c, 0xcf, 0xe6],
};
// 含 Windows 在 100%–200% 缩放下用到的小图标、大图标与超大图标尺寸。
const sizes = [16, 20, 24, 32, 40, 48, 64, 72, 96, 128, 256];

function layout(size: number) {
  const fits = arts.map(art => {
    const cell = Math.floor(size / art.length);
    return { art, cell, offset: Math.floor((size - cell * art.length) / 2), spare: (size - cell * art.length) / size };
  }).filter(fit => fit.cell > 0);
  // 余量不超过 1/8 时优先用细节更多的大图，否则取余量最小的。
  return fits.filter(fit => fit.spare <= 0.125).at(-1) ?? fits.reduce((best, fit) => fit.spare < best.spare ? fit : best);
}

function render(size: number): Uint8Array {
  const { art, cell, offset } = layout(size);
  const radius = size * 0.2;
  const samples = 4;
  const pixels = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const row = art[Math.floor((py - offset) / cell)], key = row?.[Math.floor((px - offset) / cell)] ?? ".";
    const [r, g, b] = palette[key]!;
    let covered = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const u = px + (sx + 0.5) / samples, v = py + (sy + 0.5) / samples;
      const dx = Math.max(radius - u, 0, u - (size - radius)), dy = Math.max(radius - v, 0, v - (size - radius));
      if (dx * dx + dy * dy <= radius * radius) covered++;
    }
    if (covered) pixels.set([r, g, b, Math.round(covered / samples ** 2 * 255)], (py * size + px) * 4);
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

// 小于 256px 的尺寸用传统的 32 位 BMP（自下而上的 BGRA 加 1 位透明掩码），兼容所有读取图标的系统接口；
// 只有 256px 用 PNG，这是 Windows 对图标格式的通行做法。
function bitmap(size: number, pixels: Uint8Array): Uint8Array {
  const stride = Math.ceil(size / 32) * 4;
  const out = new Uint8Array(40 + size * size * 4 + stride * size);
  const view = new DataView(out.buffer);
  view.setUint32(0, 40, true);
  view.setInt32(4, size, true);
  view.setInt32(8, size * 2, true);
  view.setUint16(12, 1, true);
  view.setUint16(14, 32, true);
  view.setUint32(20, size * size * 4 + stride * size, true);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const from = ((size - 1 - y) * size + x) * 4, to = 40 + (y * size + x) * 4;
    out.set([pixels[from + 2]!, pixels[from + 1]!, pixels[from]!, pixels[from + 3]!], to);
    if (pixels[from + 3] === 0) out[40 + size * size * 4 + y * stride + (x >> 3)]! |= 0x80 >> (x & 7);
  }
  return out;
}

export const iconImage = (size: number) => (size >= 256 ? png : bitmap)(size, render(size));

export function iconIco(): Uint8Array {
  const images = sizes.map(iconImage);
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

// Bun 1.4.2 写入图标时只替换 RT_ICON 并新增编号为 0 的图标组，原有的命名图标组 IDI_MYICON 仍在且排在前面，
// 资源管理器优先读它：它只声明一个 256px 条目，指向现在的 16px 图像，于是大图标被拉伸发糊、小图标沿用缓存。
// 把每个图标组的数据项都指向本工具写入的完整图标组；只改资源目录中的 RVA 与长度，不改变节的大小与布局。
export function repointIconGroups(exe: Uint8Array): number {
  const view = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
  const pe = view.getUint32(0x3c, true);
  const optional = pe + 24, optionalSize = view.getUint16(pe + 20, true);
  const directories = optional + (view.getUint16(optional, true) === 0x20b ? 112 : 96);
  const resourceRva = view.getUint32(directories + 2 * 8, true);
  let base = -1, delta = 0;
  for (let index = 0; index < view.getUint16(pe + 6, true); index++) {
    const section = optional + optionalSize + index * 40;
    const va = view.getUint32(section + 12, true), raw = view.getUint32(section + 20, true);
    if (resourceRva >= va && resourceRva < va + Math.max(view.getUint32(section + 8, true), view.getUint32(section + 16, true))) {
      base = raw + resourceRva - va;
      delta = va - raw;
    }
  }
  if (base < 0) throw Error("产物中找不到资源节");
  const entries = (at: number) => Array.from({ length: view.getUint16(at + 12, true) + view.getUint16(at + 14, true) }, (_, index) => ({
    id: view.getUint32(at + 16 + index * 8, true), target: base + (view.getUint32(at + 20 + index * 8, true) & 0x7fffffff),
  }));
  const groupType = entries(base).find(entry => entry.id === 14);
  if (!groupType) throw Error("产物中找不到图标组");
  const leaves = entries(groupType.target).flatMap(name => entries(name.target).map(language => language.target));
  const ours = leaves.find(leaf => view.getUint16(view.getUint32(leaf, true) - delta + 4, true) === sizes.length);
  if (ours === undefined) throw Error("产物中找不到本工具写入的图标组");
  for (const leaf of leaves) {
    view.setUint32(leaf, view.getUint32(ours, true), true);
    view.setUint32(leaf + 4, view.getUint32(ours + 4, true), true);
  }
  return leaves.length;
}
