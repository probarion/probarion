import type { Hex32 } from "./types.js";

export const ZERO_HEX32: Hex32 = "0".repeat(64);

const HEX32_RE = /^[0-9a-f]{64}$/;
const HEX_RE = /^[0-9a-fA-F]*$/;
const U64_MAX = (1n << 64n) - 1n;

export function isHex32(value: unknown): value is Hex32 {
  return typeof value === "string" && HEX32_RE.test(value);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !HEX_RE.test(clean)) {
    throw new TypeError(`invalid hex string: ${JSON.stringify(hex.slice(0, 80))}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function u64be(value: number | bigint): Uint8Array {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(`u64 must be a safe integer, got ${value}`);
  }
  const big = BigInt(value);
  if (big < 0n || big > U64_MAX) throw new RangeError(`u64 out of range: ${big}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, big, false);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
