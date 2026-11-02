import { describe, expect, it } from "vitest";
import { EnvError, isAllowedServiceUrl, loadEnv } from "./env";

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

describe("isAllowedServiceUrl", () => {
  const allowed = [
    "https://rpc.example",
    "https://rpc.example:8443/path?x=1",
    "https://user:pw@rpc.example/path",
    "HTTPS://RPC.EXAMPLE",
    "https://localhost",
    "http://localhost",
    "http://localhost:3000",
    "http://LOCALHOST:3000",
    "http://app.localhost:8080/x",
    "http://a.b.localhost",
    "http://127.0.0.1",
    "http://127.0.0.1:54321/rest/v1",
    "http://[::1]",
    "http://[::1]:3030/",
  ];
  const rejected = [
    // Not loopback: the host is read after parsing, never by a prefix.
    "http://rpc.example",
    "http://localhost.evil.com",
    "http://localhost.evil.com:3000",
    "http://localhostevil.com",
    "http://evillocalhost",
    "http://notlocalhost",
    "http://evil.com/localhost",
    "http://evil.com?h=localhost",
    "http://localhost@evil.com",
    "http://localhost:3000@evil.com",
    "http://127.0.0.1.evil.com",
    "http://127.0.0.2",
    "http://0.0.0.0",
    "http://localhost.:3000",
    "http://[::2]",
    "http://[::1].evil.com",
    // A scheme other than http(s).
    "ftp://localhost",
    "ws://localhost",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "localhost:3000",
    "//localhost",
    // https without // or a host, which new URL() would repair.
    "https:foo",
    "https:/foo",
    "https:///foo",
    "https:\\foo",
    "https://",
    "https://:443",
    "https://user@/path",
    "http:localhost",
    "http:///localhost",
    // Not a URL at all.
    "",
    " ",
    "not a url",
    " https://rpc.example",
    "https://rpc example",
  ];

  it.each(allowed)("allows %s", (url) => {
    expect(isAllowedServiceUrl(url)).toBe(true);
  });

  it.each(rejected)("rejects %j", (url) => {
    expect(isAllowedServiceUrl(url)).toBe(false);
  });
});

describe("loadEnv: service URLs", () => {
  const HOSTILE = "http://localhost.evil.com";
  const LOCAL_FORMS = [
    "http://localhost:54321",
    "http://127.0.0.1:54321",
    "http://[::1]:54321",
    "http://app.localhost:54321",
  ];

  it("allows http on a loopback host for development", () => {
    for (const local of LOCAL_FORMS) {
      const env = loadEnv({
        ...base,
        SUPABASE_URL: local,
        NEXT_PUBLIC_SUPABASE_URL: local,
        BASE_RPC_URL: local,
        NEAR_RPC_URLS: local,
      });
      expect(env.SUPABASE_URL).toBe(local);
      expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(local);
      expect(env.BASE_RPC_URL).toBe(local);
      expect(env.NEAR_RPC_URLS).toEqual([local]);
    }
    expect(
      loadEnv({ ...base, NEAR_RPC_URLS: "http://localhost:3030, https://rpc.example" })
        .NEAR_RPC_URLS,
    ).toEqual(["http://localhost:3030", "https://rpc.example"]);
  });

  it("rejects a non-loopback http host and names the variable, never the value", () => {
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ["SUPABASE_URL", { SUPABASE_URL: HOSTILE }, /SUPABASE_URL must be https/],
      [
        "NEXT_PUBLIC_SUPABASE_URL",
        { NEXT_PUBLIC_SUPABASE_URL: HOSTILE },
        /NEXT_PUBLIC_SUPABASE_URL must be https/,
      ],
      ["BASE_RPC_URL", { BASE_RPC_URL: HOSTILE }, /BASE_RPC_URL must be https/],
      [
        "NEAR_RPC_URLS",
        { NEAR_RPC_URLS: `http://localhost:3030,${HOSTILE}` },
        /NEAR_RPC_URLS entry 2 must be https/,
      ],
    ];
    for (const [name, override, pattern] of cases) {
      let message = "";
      try {
        loadEnv({ ...base, ...override });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, name).toMatch(pattern);
      expect(message, name).not.toContain("evil.com");
    }
  });

  it("now checks NEXT_PUBLIC_SUPABASE_URL too", () => {
    expect(() => loadEnv({ ...base, NEXT_PUBLIC_SUPABASE_URL: "http://x.supabase.co" })).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL must be https/,
    );
    expect(() => loadEnv({ ...base, NEXT_PUBLIC_SUPABASE_URL: "not a url" })).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL must be https/,
    );
  });

  it("rejects https: without // or a host in every URL variable", () => {
    for (const bad of ["https:foo", "https:/foo", "https:///foo"]) {
      for (const name of [
        "SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_URL",
        "BASE_RPC_URL",
        "NEAR_RPC_URLS",
        "SENTRY_DSN",
        "BETTERSTACK_HEARTBEAT_URL",
      ]) {
        expect(() => loadEnv({ ...base, [name]: bad }), `${name}=${bad}`).toThrow(
          new RegExp(`${name}( entry 1)? must be https`),
        );
      }
    }
  });

  it("keeps SENTRY_DSN and BETTERSTACK_HEARTBEAT_URL strictly https, even on localhost", () => {
    for (const local of LOCAL_FORMS) {
      expect(() => loadEnv({ ...base, SENTRY_DSN: local })).toThrow(/SENTRY_DSN must be https/);
      expect(() => loadEnv({ ...base, BETTERSTACK_HEARTBEAT_URL: local })).toThrow(
        /BETTERSTACK_HEARTBEAT_URL must be https/,
      );
    }
    expect(() => loadEnv({ ...base, SENTRY_DSN: "http://k@o1.ingest.sentry.io/2" })).toThrow(
      /SENTRY_DSN must be https/,
    );
    expect(() => loadEnv({ ...base, SENTRY_DSN: "ftp://k@o1.ingest.sentry.io/2" })).toThrow(
      /SENTRY_DSN must be https/,
    );
    const ok = loadEnv({
      ...base,
      SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
      BETTERSTACK_HEARTBEAT_URL: "https://uptime.betterstack.com/api/v1/heartbeat/abc",
    });
    expect(ok.SENTRY_DSN).toBe("https://k@o1.ingest.sentry.io/2");
    expect(ok.BETTERSTACK_HEARTBEAT_URL).toBe(
      "https://uptime.betterstack.com/api/v1/heartbeat/abc",
    );
  });

  it("still requires https for the hosted services", () => {
    expect(() => loadEnv({ ...base, SUPABASE_URL: "http://x.supabase.co" })).toThrow(
      /SUPABASE_URL must be https/,
    );
    expect(() => loadEnv({ ...base, SUPABASE_URL: "not a url" })).toThrow(
      /SUPABASE_URL must be https/,
    );
    expect(() => loadEnv({ ...base, BASE_RPC_URL: "http://base.example" })).toThrow(
      /BASE_RPC_URL must be https/,
    );
    const ok = loadEnv({ ...base, BASE_RPC_URL: "https://mainnet.base.org" });
    expect(ok.BASE_RPC_URL).toBe("https://mainnet.base.org");
  });
});

describe("loadEnv: TEAM_VAULT_IDS (R11)", () => {
  it("is an empty list when unset, blank or only commas (R12)", () => {
    for (const v of [undefined, "", "   ", ",", " , ,"]) {
      expect(loadEnv({ ...base, TEAM_VAULT_IDS: v }).TEAM_VAULT_IDS, String(v)).toEqual([]);
    }
  });

  it("splits, trims and drops empty entries, like NEAR_RPC_URLS", () => {
    expect(
      loadEnv({ ...base, TEAM_VAULT_IDS: " demo.vaults.probarion.near ,, v0.probarion.near ," })
        .TEAM_VAULT_IDS,
    ).toEqual(["demo.vaults.probarion.near", "v0.probarion.near"]);
  });

  it("rejects an entry that is not a NEAR account id, by position and without its value", () => {
    let message = "";
    try {
      loadEnv({ ...base, TEAM_VAULT_IDS: "demo.vaults.probarion.near,SENTINEL Vault" });
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      message = (e as Error).message;
    }
    expect(message).toMatch(/TEAM_VAULT_IDS entry 2 is not a NEAR account id/);
    expect(message).not.toContain("SENTINEL");
  });
});
