import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "./env";

const KEY = Buffer.alloc(32, 7).toString("base64");
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
