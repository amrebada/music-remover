// Draws the extension icon (a voice waveform on a green tile) into public/icon/*.png.
//   node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 96, 128];
const OUT = join(import.meta.dirname, '..', 'public', 'icon');
const TILE = [21, 128, 61];
const BARS = [0.28, 0.52, 0.78, 0.52, 0.28]; // bar heights, as a share of the tile

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage of the shape at (x, y) in unit coordinates: 0 outside, 1 tile, 2 bar. */
function shape(x, y) {
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return 0;
  const barWidth = 0.1;
  const gap = 0.055;
  const total = BARS.length * barWidth + (BARS.length - 1) * gap;
  const left = (1 - total) / 2;
  for (let i = 0; i < BARS.length; i++) {
    const x0 = left + i * (barWidth + gap);
    const h = BARS[i];
    if (x >= x0 && x <= x0 + barWidth && Math.abs(y - 0.5) <= h / 2) return 2;
  }
  return 1;
}

for (const size of SIZES) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = 4; // supersampling for smooth edges
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0;
      let bar = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const s = shape((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
          if (s >= 1) tile++;
          if (s === 2) bar++;
        }
      }
      const n = ss * ss;
      const alpha = tile / n;
      const white = tile ? bar / tile : 0;
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(TILE[c] + (255 - TILE[c]) * white);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  writeFileSync(join(OUT, `${size}.png`), png(size, rgba));
}
console.log(`icons written to ${OUT}`);
