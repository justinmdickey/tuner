/*
 * make-icons.js — generates the PWA icons as real PNGs, no dependencies.
 * Run: bun tools/make-icons.js   (from /root/projects/tuner)
 *
 * Build-time tool only; not part of the served app.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

// --- minimal PNG encoder ------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, rowStart + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- icon artwork: dark tile, tick arc, green needle -------------------------------

const BG = [0x0e, 0x12, 0x17];
const GRAY = [0x93, 0xa4, 0xb5];
const GREEN = [0x3f, 0xd6, 0x8f];
const WHITE = [0xf2, 0xf6, 0xfa];

function draw(size, glyphScale) {
  const px = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = BG[0]; px[i * 4 + 1] = BG[1]; px[i * 4 + 2] = BG[2]; px[i * 4 + 3] = 255;
  }
  const S = size * glyphScale;
  const cx = size / 2;
  const cy = size / 2 + 0.14 * S;
  const R = 0.36 * S;                  // tick-arc radius
  const arcHalf = 0.022 * S;           // arc half-thickness
  const needleLen = 0.42 * S;
  const needleW = 0.030 * S;
  const needleAngle = (16 * Math.PI) / 180; // slightly right of centre
  const tipX = cx + needleLen * Math.sin(needleAngle);
  const tipY = cy - needleLen * Math.cos(needleAngle);
  const pivotR = 0.055 * S;

  const blend = (x, y, rgb, alpha) => {
    if (alpha <= 0 || x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const a = Math.min(1, alpha);
    px[i] = px[i] * (1 - a) + rgb[0] * a;
    px[i + 1] = px[i + 1] * (1 - a) + rgb[1] * a;
    px[i + 2] = px[i + 2] * (1 - a) + rgb[2] * a;
  };

  const segDist = (x, y, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const r = Math.hypot(dx, dy);
      const angDeg = (Math.atan2(dx, -dy) * 180) / Math.PI; // 0 = straight up

      // tick arc: gray band from -60 to +60 degrees, green near zero
      if (Math.abs(angDeg) <= 62) {
        const radialDist = Math.abs(r - R);
        const aa = arcHalf - radialDist; // >0 inside, soft edge
        if (aa > -1) {
          const color = Math.abs(angDeg) <= 6 ? GREEN : GRAY;
          blend(x, y, color, Math.min(1, aa + 1) * (Math.abs(angDeg) > 58 ? (62 - Math.abs(angDeg)) / 4 : 1));
        }
      }

      // needle
      const nd = segDist(x + 0.5, y + 0.5, cx, cy, tipX, tipY);
      const na = needleW / 2 - nd;
      if (na > -1) blend(x, y, WHITE, Math.min(1, na + 1));

      // pivot dot
      const pa = pivotR - r;
      if (pa > -1) blend(x, y, GREEN, Math.min(1, pa + 1));
    }
  }
  return new Uint8Array(px.buffer);
}

const jobs = [
  ['icon-192.png', 192, 0.98],
  ['icon-512.png', 512, 0.98],
  ['icon-maskable-192.png', 192, 0.76], // glyph inside the maskable safe zone
  ['icon-maskable-512.png', 512, 0.76],
];

for (const [name, size, scale] of jobs) {
  const png = encodePNG(size, size, draw(size, scale));
  writeFileSync(join(OUT, name), png);
  console.log(`${name}  ${size}x${size}  ${png.length} bytes`);
}
