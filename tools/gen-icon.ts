/**
 * Renders the home-screen icon: a loop of Hot Wheels track on a garage-dark
 * ground, drawn with the same cross-section the bracket connectors use — a
 * darker bed between two lighter raised rails.
 *
 * Self-contained: analytic anti-aliasing plus a hand-rolled PNG encoder, no
 * native deps. `deflateSync` from node:zlib, NOT Bun.deflateSync — the latter
 * emits raw deflate, which iOS rejects, silently breaking "Add to Home Screen".
 *
 *   bun run tools/gen-icon.ts
 */
import { deflateSync } from "node:zlib";

const SIZE = 180;
const OUT = new URL("../public/icon-180.png", import.meta.url);

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

type RGB = [number, number, number];
const hex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

// Straight from the app's tokens.
const GROUND_TOP = hex("#241c15");
const GROUND_BOT = hex("#0f0b08");
const TRACK = hex("#c9410f"); // bed, deliberately darker than the token so the
const RAIL = hex("#ffab74"); // rails still read as raised at 180px
const GLOW = hex("#ff6b2c");

const CX = SIZE / 2;

/** Coverage of a band at radius `r` of half-width `w` around the loop centre. */
function ring(px: number, py: number, r: number, w: number): number {
  const d = Math.hypot(px - CX, py - LOOP_CY);
  return 1 - smoothstep(w - 1.2, w + 1.2, Math.abs(d - r));
}

/** Coverage of a horizontal bar — the straightaway running through the loop. */
function bar(py: number, y: number, w: number): number {
  return 1 - smoothstep(w - 1.2, w + 1.2, Math.abs(py - y));
}

const buf = Buffer.alloc(SIZE * SIZE * 4);

const LOOP_R = 42;
const LOOP_CY = 72; // loop sits above the straightaway, tangent to it
const HALF = 14; // half-width of the whole track incl. rails
const BED = 8; // half-width of the darker bed
const STRAIGHT_Y = 142;

for (let py = 0; py < SIZE; py += 1) {
  for (let px = 0; px < SIZE; px += 1) {
    // Ground: vertical gradient with a warm bloom behind the loop.
    const t = py / (SIZE - 1);
    const col: RGB = [
      mix(GROUND_TOP[0], GROUND_BOT[0], t),
      mix(GROUND_TOP[1], GROUND_BOT[1], t),
      mix(GROUND_TOP[2], GROUND_BOT[2], t),
    ];

    const bloom = (1 - smoothstep(0, LOOP_R + 40, Math.hypot(px - CX, py - LOOP_CY))) * 0.24;
    for (let i = 0; i < 3; i += 1) {
      col[i] = mix(col[i], GLOW[i], bloom);
    }

    // Track = a loop sitting on a straightaway that runs off both edges. Rails
    // first, then the bed painted over the middle, which leaves the rail colour
    // showing along both edges — the same cross-section as the bracket connectors.
    const railCov = Math.max(ring(px, py, LOOP_R, HALF), bar(py, STRAIGHT_Y, HALF));
    const bedCov = Math.max(ring(px, py, LOOP_R, BED), bar(py, STRAIGHT_Y, BED));

    for (let i = 0; i < 3; i += 1) {
      col[i] = mix(col[i], RAIL[i], railCov);
      col[i] = mix(col[i], TRACK[i], bedCov);
    }

    const o = (py * SIZE + px) * 4;
    buf[o] = Math.round(clamp(col[0], 0, 255));
    buf[o + 1] = Math.round(clamp(col[1], 0, 255));
    buf[o + 2] = Math.round(clamp(col[2], 0, 255));
    buf[o + 3] = 255;
  }
}

// ---- minimal PNG (truecolour + alpha) ----
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i += 1) {
    c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

await Bun.write(OUT, png);
console.log(`wrote ${OUT.pathname} (${png.length} bytes, ${SIZE}x${SIZE})`);
