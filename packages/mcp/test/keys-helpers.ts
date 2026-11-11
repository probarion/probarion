// Shared set-up for the keys file tests: key pairs made when the tests run (no secret sits in the repository),
// a keys file's text, captured output streams, and the check that a text holds no secret key.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { type Ed25519KeyPair, generateKeyPair } from "@probarion/core";
import { expect } from "vitest";
import { KEYS_FILE_FORMAT } from "../src/keys-file.js";

export const AGENT = generateKeyPair(new Uint8Array(32).fill(21));
export const LEDGER = generateKeyPair(new Uint8Array(32).fill(22));
export const OTHER = generateKeyPair(new Uint8Array(32).fill(23));

/** A NEAR secret key: `ed25519:` and the base58 of 64 bytes, 86 to 88 characters. A public key has 43 or 44. */
export const SECRET_SHAPED = /ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/;
/** The same body without its prefix, as a value cut or re-encoded on its way into a message could carry it. */
const BARE_SECRET_SHAPED = /[1-9A-HJ-NP-Za-km-z]{80,}/;

/** The text of a keys file, with `over` merged on top (a field set to undefined is left out). */
export function keysFileText(
  vault: string,
  network: "mainnet" | "testnet",
  over: Record<string, unknown> = {},
  agent: Ed25519KeyPair = AGENT,
  ledger: Ed25519KeyPair = LEDGER,
): string {
  return `${JSON.stringify(
    {
      format: KEYS_FILE_FORMAT,
      vault,
      network,
      agent: { public_key: agent.publicKey, secret_key: agent.secretKey },
      ledger: { public_key: ledger.publicKey, secret_key: ledger.secretKey },
      created_at: "2026-11-11T00:00:00.000Z",
      ...over,
    },
    null,
    2,
  )}\n`;
}

/** Fails when `text` holds any of the secrets, the base58 body of one, or anything shaped like a secret key. */
export function expectNoSecret(text: string, secrets: readonly string[], label = "output"): void {
  for (const secret of secrets) {
    expect(text.includes(secret), `${label} holds a secret key`).toBe(false);
    expect(text.includes(secret.slice("ed25519:".length)), `${label} holds a secret's body`).toBe(
      false,
    );
    // A run of 20 characters from the middle: a secret cut short is still a leak.
    expect(text.includes(secret.slice(30, 50)), `${label} holds part of a secret`).toBe(false);
  }
  expect(SECRET_SHAPED.test(text), `${label} holds a secret-shaped string`).toBe(false);
  expect(BARE_SECRET_SHAPED.test(text), `${label} holds a long base58 run`).toBe(false);
}

export interface Captured {
  stream: Writable;
  text(): string;
}

export function capture(): Captured {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return { stream, text: () => text };
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
