import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSubkey, parseMasterKey } from "./sodium";

// 32 distinct bytes: a key that is one repeated byte is rejected.
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256)).toString("base64");
const BASE_ENV = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x",
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_x",
  KEY_ENCRYPTION_SECRET: KEY,
  CRON_SECRET: "c".repeat(40),
};

/** A fresh copy of the module (and of getEnv's cache) under the given environment. */
async function load(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [name, value] of Object.entries({ ...BASE_ENV, ...env })) vi.stubEnv(name, value);
  return import("./server");
}

beforeEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("crypto/server", () => {
  it("derives each subkey from KEY_ENCRYPTION_SECRET with deriveSubkey", async () => {
    const { subkey, masterKey } = await load();
    const master = parseMasterKey(KEY);
    expect(hex(masterKey())).toBe(hex(master));
    for (const purpose of [
      "session",
      "challenge",
      "agent_keys",
      "invoices",
      "telegram",
      "visitor",
    ] as const) {
      expect(hex(await subkey(purpose)), purpose).toBe(hex(await deriveSubkey(master, purpose)));
    }
  });

  it("keeps the challenge and the session subkeys apart", async () => {
    const { subkey } = await load();
    expect(hex(await subkey("challenge"))).not.toBe(hex(await subkey("session")));
  });

  it("derives a subkey once and hands every caller the same one", async () => {
    const { subkey } = await load();
    const first = subkey("session");
    expect(subkey("session")).toBe(first);
    expect(await first).toBe(await subkey("session"));
    expect(subkey("challenge")).not.toBe(first);
  });

  it("parses the master once", async () => {
    const { masterKey } = await load();
    expect(masterKey()).toBe(masterKey());
  });

  it("fails closed without a valid master key, and never says its value", async () => {
    const { subkey, masterKey } = await load({ KEY_ENCRYPTION_SECRET: "not-base64!" });
    expect(() => masterKey()).toThrow(/KEY_ENCRYPTION_SECRET/);
    await expect(subkey("session")).rejects.toThrow(/KEY_ENCRYPTION_SECRET/);
    try {
      masterKey();
    } catch (e) {
      expect(String(e)).not.toContain("not-base64");
    }
  });

  it("does not keep a failed derivation: the next call tries again", async () => {
    vi.resetModules();
    for (const [name, value] of Object.entries(BASE_ENV)) vi.stubEnv(name, value);
    let calls = 0;
    vi.doMock("./sodium", async (importOriginal) => {
      const real = await importOriginal<typeof import("./sodium")>();
      return {
        ...real,
        deriveSubkey: async (master: Uint8Array, purpose: Parameters<typeof deriveSubkey>[1]) => {
          calls += 1;
          if (calls === 1) throw new Error("libsodium is not ready");
          return real.deriveSubkey(master, purpose);
        },
      };
    });
    try {
      const { subkey } = await import("./server");
      await expect(subkey("visitor")).rejects.toThrow("libsodium is not ready");
      expect(hex(await subkey("visitor"))).toBe(
        hex(await deriveSubkey(parseMasterKey(KEY), "visitor")),
      );
      expect(calls).toBe(2);
    } finally {
      vi.doUnmock("./sodium");
    }
  });
});
