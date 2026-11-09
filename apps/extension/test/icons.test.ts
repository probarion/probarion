import { readFileSync } from "node:fs";
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

describe("the rendered images", () => {
  it.each([16, 32, 48, 128])("icon %i is a PNG of that size", (size) => {
    const png = read(`static/icons/${size}.png`);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
  });

  it.each<[string, number, number]>([
    ["popup", 1280, 800],
    ["menu", 1280, 800],
    ["connect", 1280, 800],
    ["tile", 440, 280],
  ])("the store image %s is a %i x %i JPEG", (name, width, height) => {
    const jpeg = read(`store/screenshots/${name}.jpg`);
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    expect(jpegSize(jpeg)).toEqual([width, height]);
  });
});
