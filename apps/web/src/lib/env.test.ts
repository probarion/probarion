import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "./env";

// 32 distinct bytes: a key that is one repeated byte is rejected.
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256)).toString("base64");
const base = {
  NEAR_NETWORK: "mainnet",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x",
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_x",
  KEY_ENCRYPTION_SECRET: KEY,
  CRON_SECRET: "c".repeat(40),
};

describe("loadEnv", () => {
  it("applies network defaults from NETWORKS", () => {
    const env = loadEnv(base);
    expect(env.NEAR_NETWORK).toBe("mainnet");
    expect(env.NEAR_RPC_URLS[0]).toBe("https://rpc.mainnet.fastnear.com");
    expect(env.PROBARION_FACTORY_ID).toBe("vaults.probarion.near");
    expect(env.CANARY_MODE).toBe("code-only");
    expect(env.NEARAI_API_KEY).toBeNull();
    expect(env.CANARY_VAULT_ID).toBeNull();
    expect(env.PROBARION_VAULT_ID).toBeNull();
    expect(env.BETTERSTACK_HEARTBEAT_URL).toBeNull();
  });

  it("splits NEAR_RPC_URLS in failover order", () => {
    const env = loadEnv({ ...base, NEAR_RPC_URLS: "https://a.example, https://b.example" });
    expect(env.NEAR_RPC_URLS).toEqual(["https://a.example", "https://b.example"]);
  });

  it("rejects a master key that is not 32 bytes", () => {
    expect(() =>
      loadEnv({ ...base, KEY_ENCRYPTION_SECRET: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/KEY_ENCRYPTION_SECRET/);
  });

  it("lists every missing required variable at once", () => {
    try {
      loadEnv({ NEAR_NETWORK: "testnet" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect(String(e)).toMatch(/SUPABASE_URL/);
      expect(String(e)).toMatch(/CRON_SECRET/);
      expect(String(e)).toMatch(/KEY_ENCRYPTION_SECRET/);
    }
  });

  it("rejects an unknown CANARY_MODE and a non-https RPC", () => {
    expect(() => loadEnv({ ...base, CANARY_MODE: "yolo" })).toThrow(/CANARY_MODE/);
    expect(() => loadEnv({ ...base, NEAR_RPC_URLS: "http://insecure" })).toThrow(/https/);
    expect(() => loadEnv({ ...base, BETTERSTACK_HEARTBEAT_URL: "http://beat" })).toThrow(
      /BETTERSTACK_HEARTBEAT_URL/,
    );
  });
});

describe("loadEnv: empty means unset (R12)", () => {
  for (const blank of ["", "   ", "\t\n"]) {
    it(`treats ${JSON.stringify(blank)} as unset`, () => {
      const env = loadEnv({
        ...base,
        NEAR_NETWORK: blank,
        CANARY_MODE: blank,
        NEARAI_API_KEY: blank,
        NEAR_RPC_URLS: blank,
        PROBARION_VAULT_ID: blank,
        BETTERSTACK_HEARTBEAT_URL: blank,
        BASE_RPC_URL: blank,
        SENTRY_DSN: blank,
      });
      expect(env.NEAR_NETWORK).toBe("testnet");
      expect(env.CANARY_MODE).toBe("code-only");
      expect(env.NEARAI_API_KEY).toBeNull();
      expect(env.NEAR_RPC_URLS).toEqual(["https://rpc.testnet.fastnear.com"]);
      expect(env.PROBARION_FACTORY_ID).toBe("vaults.probarion.testnet");
      expect(env.PROBARION_VAULT_ID).toBeNull();
      expect(env.BETTERSTACK_HEARTBEAT_URL).toBeNull();
      expect(env.BASE_RPC_URL).toBeNull();
      expect(env.SENTRY_DSN).toBeNull();
    });
  }

  it("still requires the required variables when they are blank", () => {
    expect(() => loadEnv({ ...base, CRON_SECRET: "  ", SUPABASE_URL: "" })).toThrow(
      /CRON_SECRET is required.*SUPABASE_URL is required|SUPABASE_URL is required.*CRON_SECRET is required/,
    );
  });

  it("falls back to the network default when NEAR_RPC_URLS lists no entry", () => {
    for (const listed of [",", " , ,", ",,"]) {
      expect(loadEnv({ ...base, NEAR_RPC_URLS: listed }).NEAR_RPC_URLS).toEqual([
        "https://rpc.mainnet.fastnear.com",
        "https://rpc.intea.rs",
      ]);
    }
  });

  it("trims values and drops empty entries between commas", () => {
    const env = loadEnv({ ...base, NEAR_RPC_URLS: " https://a.example ,, https://b.example ," });
    expect(env.NEAR_RPC_URLS).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe("loadEnv: errors never echo a value", () => {
  const SENTINEL = "SENTINEL";

  function messageFor(src: Record<string, string>): string {
    try {
      loadEnv({ ...base, ...src });
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      return String((e as Error).message);
    }
    return expect.unreachable("loadEnv should have thrown");
  }

  it("names the RPC entry by position", () => {
    const message = messageFor({
      NEAR_RPC_URLS: `https://ok.example,http://${SENTINEL}-rpc.example`,
    });
    expect(message).toMatch(/NEAR_RPC_URLS entry 2 must be https/);
    expect(message).not.toContain(SENTINEL);
    expect(message).not.toContain("ok.example");
  });

  it("leaves every rejected value out of the message", () => {
    const message = messageFor({
      NEAR_NETWORK: `${SENTINEL}-net`,
      NEAR_RPC_URLS: `http://${SENTINEL}-rpc.example`,
      KEY_ENCRYPTION_SECRET: `${SENTINEL}-key`,
      CRON_SECRET: `${SENTINEL}-cron`,
      CANARY_MODE: `${SENTINEL}-mode`,
      SUPABASE_URL: `http://${SENTINEL}-supabase.example`,
      BASE_RPC_URL: `http://${SENTINEL}-base.example`,
      SENTRY_DSN: `${SENTINEL}-dsn`,
      BETTERSTACK_HEARTBEAT_URL: `http://${SENTINEL}-beat.example`,
    });
    for (const name of [
      "NEAR_NETWORK",
      "NEAR_RPC_URLS",
      "KEY_ENCRYPTION_SECRET",
      "CRON_SECRET",
      "CANARY_MODE",
      "SUPABASE_URL",
      "BASE_RPC_URL",
      "SENTRY_DSN",
      "BETTERSTACK_HEARTBEAT_URL",
    ]) {
      expect(message, name).toContain(name);
    }
    expect(message).not.toContain(SENTINEL);
  });

  it("does not echo the master key even when it is valid base64 of the wrong size", () => {
    const short = Buffer.from(Array.from({ length: 16 }, (_, i) => i + 1)).toString("base64");
    const message = messageFor({ KEY_ENCRYPTION_SECRET: short });
    expect(message).toMatch(/KEY_ENCRYPTION_SECRET/);
    expect(message).not.toContain(short);
  });
});

describe("loadEnv: KEY_ENCRYPTION_SECRET", () => {
  const bytes = (fill: (i: number) => number) =>
    Buffer.from(Array.from({ length: 32 }, (_, i) => fill(i)));

  it("accepts 32 distinct bytes as standard base64", () => {
    expect(loadEnv(base).KEY_ENCRYPTION_SECRET).toBe(KEY);
  });

  it("rejects all-zero and single repeated byte keys", () => {
    for (const key of [Buffer.alloc(32, 0), Buffer.alloc(32, 7), Buffer.alloc(32, 255)]) {
      expect(() => loadEnv({ ...base, KEY_ENCRYPTION_SECRET: key.toString("base64") })).toThrow(
        /KEY_ENCRYPTION_SECRET must not be one repeated byte/,
      );
    }
  });

  it("rejects anything that is not strict standard base64 of 32 bytes", () => {
    const good = bytes((i) => (i * 11 + 5) % 256).toString("base64");
    expect(loadEnv({ ...base, KEY_ENCRYPTION_SECRET: good }).KEY_ENCRYPTION_SECRET).toBe(good);
    const bad = [
      good.slice(0, -1), // padding removed
      `${good}=`, // one character too long
      good.replace("=", ""), // unpadded
      `${good.slice(0, 10)}!${good.slice(11)}`, // not in the base64 alphabet
      `${good.slice(0, 20)}\n${good.slice(21)}`, // an embedded newline
      bytes((i) => (i * 11 + 5) % 256).toString("base64url"), // url-safe alphabet or padding
      Buffer.alloc(33, 1).fill(2, 5).toString("base64"), // 33 bytes
    ];
    for (const key of bad) {
      expect(() => loadEnv({ ...base, KEY_ENCRYPTION_SECRET: key }), key).toThrow(
        /KEY_ENCRYPTION_SECRET/,
      );
    }
  });

  it("rejects a non-canonical encoding of a 32-byte key", () => {
    const good = bytes((i) => (i * 11 + 5) % 256).toString("base64");
    // The last character before "=" carries 4 bits; setting a spare low bit decodes to the same bytes.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const last = alphabet.indexOf(good[42] as string);
    const tampered = `${good.slice(0, 42)}${alphabet[last ^ 1]}=`;
    expect(Buffer.from(tampered, "base64").equals(Buffer.from(good, "base64"))).toBe(true);
    expect(() => loadEnv({ ...base, KEY_ENCRYPTION_SECRET: tampered })).toThrow(
      /KEY_ENCRYPTION_SECRET/,
    );
  });
});

describe("loadEnv: https URLs", () => {
  it("requires https for SUPABASE_URL, BASE_RPC_URL, SENTRY_DSN and the heartbeat", () => {
    expect(() => loadEnv({ ...base, SUPABASE_URL: "http://x.supabase.co" })).toThrow(
      /SUPABASE_URL must be https/,
    );
    expect(() => loadEnv({ ...base, SUPABASE_URL: "not a url" })).toThrow(
      /SUPABASE_URL must be https/,
    );
    expect(() => loadEnv({ ...base, BASE_RPC_URL: "http://base.example" })).toThrow(
      /BASE_RPC_URL must be https/,
    );
    expect(() => loadEnv({ ...base, SENTRY_DSN: "http://k@o1.ingest.sentry.io/2" })).toThrow(
      /SENTRY_DSN must be https/,
    );
    expect(() => loadEnv({ ...base, SENTRY_DSN: "ftp://k@o1.ingest.sentry.io/2" })).toThrow(
      /SENTRY_DSN must be https/,
    );
    const ok = loadEnv({
      ...base,
      BASE_RPC_URL: "https://mainnet.base.org",
      SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
    });
    expect(ok.BASE_RPC_URL).toBe("https://mainnet.base.org");
    expect(ok.SENTRY_DSN).toBe("https://k@o1.ingest.sentry.io/2");
  });
});
