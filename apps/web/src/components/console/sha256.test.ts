import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256HexOf } from "./sha256";

// R15: the purpose_hash is the sha256 of the PO / purpose document, computed in the browser with WebCrypto
// (Node has the same `crypto.subtle`). node:crypto is the independent oracle.
const oracle = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

describe("sha256HexOf", () => {
  it("hashes text as UTF-8, to 64 lowercase hex", async () => {
    for (const text of ["", "abc", "PO-2026-0042\n", "Công ty Acme — 設計"]) {
      const h = await sha256HexOf(text);
      expect(h).toBe(oracle(text));
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("hashes the bytes of a file, the same as the text it holds", async () => {
    const bytes = new TextEncoder().encode("PO-2026-0042\n");
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(await sha256HexOf(buffer)).toBe(await sha256HexOf("PO-2026-0042\n"));
  });

  it("hashes every byte value, not text: binary data keeps its bytes", async () => {
    const all = new Uint8Array(256).map((_, i) => i);
    const buffer = all.buffer.slice(0);
    expect(await sha256HexOf(buffer)).toBe(oracle(all));
  });

  it("gives a different hash for a different document", async () => {
    expect(await sha256HexOf("PO-1")).not.toBe(await sha256HexOf("PO-2"));
  });

  it("is what the mandate form accepts as a purpose hash (64 lowercase hex)", async () => {
    expect(await sha256HexOf("any document")).toMatch(/^[0-9a-f]{64}$/);
  });
});
