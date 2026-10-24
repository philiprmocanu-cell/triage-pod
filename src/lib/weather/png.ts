import { inflateSync } from "zlib";

// A small PNG reader for the NASA GIBS flood images (8-bit RGBA or RGB, optionally palette),
// enough to count which colour each pixel carries. No image library in the project, and the
// pictures are a few hundred kilobytes at most.

export type Rgba = { width: number; height: number; px: Uint8Array }; // 4 bytes per pixel

function paeth(a: number, b: number, c: number) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf: Buffer): Rgba {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette: Buffer | null = null, trns: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let i = 8; i + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(i), type = buf.toString("ascii", i + 4, i + 8), body = buf.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; colorType = body[9]; interlace = body[12];
    } else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "tRNS") trns = Buffer.from(body);
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    i += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1; // 0 grey, 3 palette
  if (![0, 2, 3, 4, 6].includes(colorType)) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(width * height * 4);
  let prev = Buffer.alloc(stride), p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0, b = prev[x], c = x >= channels ? prev[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) line[x] = (line[x] + paeth(a, b, c)) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * channels;
      if (colorType === 6) { px[o] = line[s]; px[o + 1] = line[s + 1]; px[o + 2] = line[s + 2]; px[o + 3] = line[s + 3]; }
      else if (colorType === 2) { px[o] = line[s]; px[o + 1] = line[s + 1]; px[o + 2] = line[s + 2]; px[o + 3] = 255; }
      else if (colorType === 3) {
        const idx = line[s];
        px[o] = palette?.[idx * 3] ?? 0; px[o + 1] = palette?.[idx * 3 + 1] ?? 0; px[o + 2] = palette?.[idx * 3 + 2] ?? 0;
        px[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 4) { px[o] = px[o + 1] = px[o + 2] = line[s]; px[o + 3] = line[s + 1]; }
      else { px[o] = px[o + 1] = px[o + 2] = line[s]; px[o + 3] = 255; }
    }
    prev = line;
  }
  return { width, height, px };
}
