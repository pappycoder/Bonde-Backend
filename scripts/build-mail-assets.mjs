#!/usr/bin/env node
/**
 * Regenerates the mail footer social glyphs in
 * `src/common/mail/templates/assets/social.ts`.
 *
 * Draws the three marks (LinkedIn, X, Instagram) at 4x and box-downsamples to
 * 56x56 — 2x of the 28px footer circles — then writes each as an RGBA PNG
 * encoded with nothing but `node:zlib`. No image library, no new dependency.
 *
 *   node scripts/build-mail-assets.mjs
 *   node scripts/build-mail-assets.mjs --out dist/mail-assets
 *
 * `--out` also writes the decoded .png files (filenames matching
 * `templates/assets/index.ts`) so they can be uploaded to whatever
 * `MAIL_ASSET_BASE_URL` points at.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 56; // output px (2x of the 28px display size)
const SS = 4; // supersample factor
const DATA_URI_PREFIX = 'data:image/png;base64,';
const W = SIZE * SS;

// --- tiny RGBA canvas -------------------------------------------------------

function createCanvas(w, h) {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

function setPixel(canvas, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h) return;
  const i = (y * canvas.w + x) * 4;
  const src = a / 255;
  const dst = canvas.data[i + 3] / 255;
  const out = src + dst * (1 - src);
  if (out === 0) return;
  canvas.data[i] = (r * src + canvas.data[i] * dst * (1 - src)) / out;
  canvas.data[i + 1] = (g * src + canvas.data[i + 1] * dst * (1 - src)) / out;
  canvas.data[i + 2] = (b * src + canvas.data[i + 2] * dst * (1 - src)) / out;
  canvas.data[i + 3] = out * 255;
}

/** Fills every pixel whose centre falls inside `inside` with opaque white. */
function fill(canvas, inside) {
  for (let y = 0; y < canvas.h; y++) {
    for (let x = 0; x < canvas.w; x++) {
      if (inside(x + 0.5, y + 0.5)) setPixel(canvas, x, y, 255, 255, 255, 255);
    }
  }
}

/** Clears every pixel whose centre falls inside `inside`. */
function erase(canvas, inside) {
  for (let y = 0; y < canvas.h; y++) {
    for (let x = 0; x < canvas.w; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      const i = (y * canvas.w + x) * 4;
      canvas.data[i] = canvas.data[i + 1] = canvas.data[i + 2] = canvas.data[i + 3] = 0;
    }
  }
}

/** Box-downsamples by `factor`, which is what turns the 4x edges smooth. */
function downsample(canvas, factor) {
  const out = createCanvas(canvas.w / factor, canvas.h / factor);
  const n = factor * factor;
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * canvas.w + x * factor + dx) * 4;
          const alpha = canvas.data[i + 3] / 255;
          r += canvas.data[i] * alpha;
          g += canvas.data[i + 1] * alpha;
          b += canvas.data[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * out.w + x) * 4;
      out.data[o] = a > 0 ? r / a : 0;
      out.data[o + 1] = a > 0 ? g / a : 0;
      out.data[o + 2] = a > 0 ? b / a : 0;
      out.data[o + 3] = (a / n) * 255;
    }
  }
  return out;
}

// --- shape predicates (all in supersampled space) ---------------------------

const roundRect = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

/** A stroked segment of the given half-width. */
const stroke = (x0, y0, x1, y1, half) => (x, y) => {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((x - x0) * dx + (y - y0) * dy) / len2;
  t = Math.min(Math.max(t, 0), 1);
  const px = x0 + t * dx;
  const py = y0 + t * dy;
  return (x - px) ** 2 + (y - py) ** 2 <= half * half;
};

const union =
  (...shapes) =>
  (x, y) =>
    shapes.some((s) => s(x, y));

/** `shape` minus `hole` — used to knock the glyph out of the badge. */
const minus = (shape, hole) => (x, y) => shape(x, y) && !hole(x, y);

// --- glyph definitions ------------------------------------------------------

function linkedin() {
  const canvas = createCanvas(W, W);
  const pad = 2 * SS;
  fill(canvas, roundRect(pad, pad, W - pad, W - pad, 11 * SS));

  const sw = 3.4 * SS;
  const baseline = W * 0.755;
  const top = W * 0.345;
  const dotR = 1.9 * SS;
  const cx = W * 0.315;
  const nx0 = cx + sw * 1.75;
  const nx1 = W * 0.725;

  erase(
    canvas,
    union(
      circle(cx, W * 0.24, dotR),
      rect(cx - sw / 2, top, cx + sw / 2, baseline),
      union(
        roundRect(nx0, top, nx1, top + (baseline - top) * 0.44, sw / 2),
        rect(nx0, top, nx0 + sw, baseline),
        rect(nx1 - sw, top, nx1, baseline),
      ),
    ),
  );
  return downsample(canvas, SS);
}

function xmark() {
  const canvas = createCanvas(W, W);
  const c = W / 2;
  const span = W * 0.315;
  const half = 2.7 * SS;
  fill(
    canvas,
    union(
      stroke(c - span, c - span, c + span, c + span, half),
      stroke(c + span, c - span, c - span, c + span, half),
    ),
  );
  return downsample(canvas, SS);
}

function instagram() {
  const canvas = createCanvas(W, W);
  const pad = 5 * SS;
  const strokeW = 4.0 * SS;
  const radius = 14 * SS;
  const lensR = W * 0.158;
  // The corner dot needs clear air on both sides or it fuses with the frame at
  // 28px, so it sits well inside the top-right corner.
  const dotX = W / 2 + 10 * SS;
  const dotY = W / 2 - 13 * SS;

  // `roundRect`/`circle` describe filled areas, so every outline is the shape
  // minus the same shape inset by the stroke width.
  fill(
    canvas,
    minus(
      roundRect(pad, pad, W - pad, W - pad, radius),
      roundRect(pad + strokeW, pad + strokeW, W - pad - strokeW, W - pad - strokeW, radius - strokeW),
    ),
  );
  fill(canvas, minus(circle(W / 2, W / 2, lensR), circle(W / 2, W / 2, lensR - strokeW)));
  fill(canvas, circle(dotX, dotY, 2.2 * SS));
  return downsample(canvas, SS);
}

// --- minimal PNG encoder ----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(canvas) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.w, 0);
  ihdr.writeUInt32BE(canvas.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  const raw = Buffer.alloc((canvas.w * 4 + 1) * canvas.h);
  for (let y = 0; y < canvas.h; y++) {
    raw[y * (canvas.w * 4 + 1)] = 0; // filter: none
    Buffer.from(canvas.data.buffer, y * canvas.w * 4, canvas.w * 4).copy(
      raw,
      y * (canvas.w * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- emit the TypeScript module --------------------------------------------

const GLYPHS = [
  ['linkedInDataUri', linkedin, 'linkedin.png'],
  ['xDataUri', xmark, 'x.png'],
  ['instagramDataUri', instagram, 'instagram.png'],
];

const banner = `/**
 * Footer social glyphs: white marks on a transparent background, rendered at
 * 2x (56x56) for the 28px circles in the footer. Committed as base64 data URIs
 * so the footer works with zero external requests out of the box — Gmail and
 * Outlook strip \`data:\` images, so \`MailService\` rewrites them to
 * \`\${MAIL_ASSET_BASE_URL}/<file>\` when that base URL is configured.
 *
 * Regenerate with \`scripts/build-mail-assets.mjs\` (no extra dependencies).
 */
`;

const parts = [banner];
const pngFiles = new Map();
for (const [name, draw, file] of GLYPHS) {
  pngFiles.set(file, encodePng(draw()));
  const b64 = pngFiles.get(file).toString('base64');
  const chunks = b64.match(/.{1,96}/g) ?? [];
  parts.push(`const ${name} =\n`);
  chunks.forEach((chunk, i) => {
    // The prefix has to ride along on the first chunk, otherwise the constants
    // are bare base64 and every <img src> renders as a broken image.
    const value = i === 0 ? `${DATA_URI_PREFIX}${chunk}` : chunk;
    parts.push(`  '${value}'${i === chunks.length - 1 ? ';' : ' +'}\n`);
  });
  parts.push('\n');
}
parts.push(
  'export const socialDataUris = {\n' +
    '  linkedin: linkedInDataUri,\n' +
    '  x: xDataUri,\n' +
    '  instagram: instagramDataUri,\n' +
    '} as const;\n',
);

const target = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'common',
  'mail',
  'templates',
  'assets',
  'social.ts',
);
writeFileSync(target, parts.join(''));
console.log(`wrote ${target}`);

const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1) {
  const dir = process.argv[outIndex + 1];
  if (!dir) {
    console.error('--out needs a directory argument');
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  for (const [file, png] of pngFiles) {
    const path = join(dir, file);
    writeFileSync(path, png);
    console.log(`wrote ${path} (${png.length} bytes)`);
  }
}
