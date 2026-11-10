import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));

/** A JPEG's size, from its first start-of-frame marker. */
function jpegSize(b: Buffer): [number, number] {
  let at = 2;
  while (at < b.length) {
    const marker = b[at + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc3) return [b.readUInt16BE(at + 7), b.readUInt16BE(at + 5)];
    at += 2 + b.readUInt16BE(at + 2);
  }
  throw new Error("no start-of-frame marker");
}

/** The pixels of an 8-bit RGBA PNG that is not interlaced (what the render writes). */
function decodePng(b: Buffer): { width: number; height: number; rgba: Uint8Array } {
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  expect([b[24], b[25], b[28]], "8-bit RGBA, not interlaced").toEqual([8, 6, 0]);
  const parts: Buffer[] = [];
  for (let at = 8; at < b.length; ) {
    const length = b.readUInt32BE(at);
    if (b.toString("ascii", at + 4, at + 8) === "IDAT")
      parts.push(b.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * 4;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? (out[y * stride + x - 4] ?? 0) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const corner = x >= 4 && y > 0 ? (out[(y - 1) * stride + x - 4] ?? 0) : 0;
      const paeth = () => {
        const p = left + up - corner;
        const [dl, du, dc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        return dl <= du && dl <= dc ? left : du <= dc ? up : corner;
      };
      const predictor = [0, left, up, (left + up) >> 1, paeth()][filter] ?? 0;
      out[y * stride + x] = ((raw[y * (stride + 1) + 1 + x] ?? 0) + predictor) & 255;
    }
  }
  return { width, height, rgba: out };
}

describe("the rendered images", () => {
  it.each([16, 32, 48, 128])("icon %i is a PNG of that size", (size) => {
    const png = read(`static/icons/${size}.png`);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
  });

  // The store asks for a 128 px icon with 96 px of artwork inside 16 px of transparent padding. The toolbar sizes keep
  // less padding (render/icon.html), and every size shows its dark bar on a light plate, since a dark toolbar swallows
  // a dark bar that has only transparency around it.
  it.each<[number, number]>([
    [16, 1],
    [32, 2],
    [48, 4],
    [128, 16],
  ])("icon %i has its artwork inside %i px of transparent padding", (size, pad) => {
    const { width, height, rgba } = decodePng(read(`static/icons/${size}.png`));
    const alpha = (x: number, y: number) => rgba[(y * width + x) * 4 + 3] ?? 0;
    let [minX, maxX, minY, maxY] = [width, -1, height, -1];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (alpha(x, y) === 0) continue;
        [minX, maxX, minY, maxY] = [
          Math.min(minX, x),
          Math.max(maxX, x),
          Math.min(minY, y),
          Math.max(maxY, y),
        ];
      }
    }
    // The artwork starts at the padding, within a pixel of anti-aliasing, and is centred.
    expect(minX).toBeGreaterThanOrEqual(pad - 1);
    expect(minY).toBeGreaterThanOrEqual(pad - 1);
    expect(width - 1 - maxX).toBeGreaterThanOrEqual(pad - 1);
    expect(height - 1 - maxY).toBeGreaterThanOrEqual(pad - 1);
    expect(Math.abs(minX - (width - 1 - maxX))).toBeLessThanOrEqual(1);
    if (size === 128) expect([maxX - minX + 1, maxY - minY + 1]).toEqual([96, 96]);
  });

  it.each([16, 32, 48, 128])("icon %i keeps its dark bar on a light plate", (size) => {
    const { width, height, rgba } = decodePng(read(`static/icons/${size}.png`));
    const at = (x: number, y: number) => (y * width + x) * 4;
    const dark = (x: number, y: number) => {
      const i = at(x, y);
      const lum = 0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0);
      return (rgba[i + 3] ?? 0) > 200 && lum < 100;
    };
    let bar = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!dark(x, y)) continue;
        bar += 1;
        // A dark pixel with transparency beside it would vanish on a dark toolbar.
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const [nx, ny] = [x + dx, y + dy];
            const inside = nx >= 0 && ny >= 0 && nx < width && ny < height;
            expect(
              inside && (rgba[at(nx, ny) + 3] ?? 0) >= 50,
              `${size}: dark pixel ${x},${y}`,
            ).toBe(true);
          }
        }
      }
    }
    expect(bar).toBeGreaterThanOrEqual(size === 16 ? 5 : 20);
  });

  it.each<[string, number, number]>([
    ["popup", 1280, 800],
    ["menu", 1280, 800],
    ["connect", 1280, 800],
    ["tile", 440, 280],
    ["marquee", 1400, 560],
  ])("the store image %s is a %i x %i JPEG", (name, width, height) => {
    const jpeg = read(`store/screenshots/${name}.jpg`);
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    expect(jpegSize(jpeg)).toEqual([width, height]);
  });
});
