import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { filesOf, makeZip } from "../scripts/zip.mjs";

/** A zip's entries, read back through its central directory, each checked against its CRC-32. */
function unzip(zip: Buffer): Array<[string, Buffer]> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: Array<[string, Buffer]> = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const packed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = inflateRawSync(zip.subarray(start, start + packed));
    expect(crc32(data)).toBe(crc);
    out.push([name, data]);
    at += 46 + nameLength;
  }
  return out;
}

describe("the store zip", () => {
  const files: Array<[string, Buffer]> = [
    ["icons/16.png", Buffer.alloc(1000, 7)],
    ["manifest.json", Buffer.from('{"manifest_version":3}\n')],
  ];

  it("holds each file, deflated, and reads back the same", () => {
    expect(unzip(makeZip(files))).toEqual(files);
  });

  it("is the same bytes for the same files", () => {
    expect(makeZip(files).equals(makeZip(files))).toBe(true);
  });

  it("lists a folder's files sorted, with forward slashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "probarion-zip-"));
    try {
      mkdirSync(join(dir, "icons"));
      writeFileSync(join(dir, "manifest.json"), "{}");
      writeFileSync(join(dir, "icons", "16.png"), "x");
      expect(filesOf(dir).map(([name]) => name)).toEqual(["icons/16.png", "manifest.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
