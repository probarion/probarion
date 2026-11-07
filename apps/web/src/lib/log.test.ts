import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { formatLog, redact, SECRET_ENV_NAMES, scrubText, secretEnvValues } from "./log";

afterEach(() => vi.unstubAllEnvs());

describe("structured logs", () => {
  it("emits one JSON line with level, message, time and request_id", () => {
    const line = formatLog(
      "info",
      "invoice.decided",
      { request_id: "r-1", tenant: "t" },
      new Date("2026-11-08T00:00:00Z"),
    );
    expect(JSON.parse(line)).toEqual({
      level: "info",
      msg: "invoice.decided",
      at: "2026-11-08T00:00:00.000Z",
      request_id: "r-1",
      tenant: "t",
    });
  });

  it("redacts secrets at any depth but keeps hashes and public keys", () => {
    const out = redact({
      agent_secret: "ed25519:xyz",
      headers: { authorization: "Bearer abc", cookie: "pb_session=1" },
      invoice_hash: "ab".repeat(32),
      public_key: "ed25519:pub",
      nested: { deeper: { api_key: "k" } },
    });
    expect(out.agent_secret).toBe("[redacted]");
    expect((out.headers as Record<string, unknown>).authorization).toBe("[redacted]");
    expect((out.headers as Record<string, unknown>).cookie).toBe("[redacted]");
    expect(out.invoice_hash).toBe("ab".repeat(32));
    expect(out.public_key).toBe("ed25519:pub");
    expect(
      ((out.nested as Record<string, unknown>).deeper as Record<string, unknown>).api_key,
    ).toBe("[redacted]");
  });
});

describe("redaction: the denylist", () => {
  const SECRET_NAMES = [
    "service_role",
    "SUPABASE_SERVICE_ROLE_KEY",
    "serviceRole",
    "jwt",
    "ONECLICK_JWT",
    "heartbeat",
    "BETTERSTACK_HEARTBEAT_URL",
    "rpc_url",
    "rpc_urls",
    "rpcUrl",
    "NEAR_RPC_URLS",
    "BASE_RPC_URL",
    "passphrase",
    "mnemonic",
    "seed",
    "seed_phrase",
    "bearer",
    "dsn",
    "SENTRY_DSN",
    "cookie",
    "set_cookie",
    "authorization",
    "Authorization",
    "secret",
    "password",
    "api_key",
    "apiKey",
    "private_key",
    "agent_key",
    "ledger_key",
    "faucet_key",
    "faucetKey",
    "TESTNET_FAUCET_KEY",
    "telegram_bot_token",
    "access_token",
  ];

  it.each(SECRET_NAMES)("redacts %s", (name) => {
    const out = redact({ [name]: "SENTINEL" });
    expect(out[name]).toBe("[redacted]");
  });

  it("keeps hashes of secrets, but not a password hash", () => {
    const out = redact({
      token_hash: "h1",
      cookie_hash: "h2",
      session_tokenHash: "h3",
      invoice_hash: "h4",
      password_hash: "SENTINEL",
      passwordHash: "SENTINEL",
    });
    expect(out).toEqual({
      token_hash: "h1",
      cookie_hash: "h2",
      session_tokenHash: "h3",
      invoice_hash: "h4",
      password_hash: "[redacted]",
      passwordHash: "[redacted]",
    });
  });

  it("keeps numeric usage counters but redacts a token-named string", () => {
    const out = redact({
      token_count: 12,
      tokens_in: 5,
      tokens_out: 7,
      tokens_total: 12,
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
      max_tokens: 1024n,
      bot_token: 123456,
      telegram_bot_token: "SENTINEL",
      access_token: "SENTINEL",
      token_count_note: "SENTINEL",
    });
    expect(out).toMatchObject({
      token_count: 12,
      tokens_in: 5,
      tokens_out: 7,
      tokens_total: 12,
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
      max_tokens: 1024n,
    });
    expect(out.bot_token).toBe("[redacted]");
    expect(out.telegram_bot_token).toBe("[redacted]");
    expect(out.access_token).toBe("[redacted]");
    expect(out.token_count_note).toBe("[redacted]");
    // A counter name with a string value is still treated as a credential.
    expect(redact({ token_count: "SENTINEL" }).token_count).toBe("[redacted]");
  });
});

describe("redaction: an Env-shaped object", () => {
  const sentinel = (name: string) => `SENTINEL_${name}_VALUE`;

  // Typed on Env: adding a variable there fails to compile until it is listed here.
  const envLike: Record<keyof Env, unknown> = {
    defaultNetwork: sentinel("defaultNetwork"),
    enabledNetworks: [sentinel("enabledNetworks")],
    // The per-network settings (W-NET-R1): the lists of RPC URLs carry keys, the rest is public configuration.
    networks: {
      mainnet: {
        enabled: sentinel("mainnet.enabled"),
        origin: sentinel("mainnet.origin"),
        rpcUrls: [sentinel("NEAR_RPC_URLS_MAINNET_1"), sentinel("NEAR_RPC_URLS_MAINNET_2")],
        archivalRpcUrls: [sentinel("NEAR_ARCHIVAL_RPC_URLS_MAINNET_1")],
        factoryId: sentinel("PROBARION_FACTORY_ID_MAINNET"),
        demoVaultId: sentinel("PROBARION_VAULT_ID_MAINNET"),
        canaryVaultId: sentinel("CANARY_VAULT_ID_MAINNET"),
        teamVaultIds: [sentinel("TEAM_VAULT_IDS_MAINNET")],
      },
      testnet: {
        enabled: sentinel("testnet.enabled"),
        origin: sentinel("testnet.origin"),
        rpcUrls: [sentinel("NEAR_RPC_URLS_TESTNET_1")],
        archivalRpcUrls: [sentinel("NEAR_ARCHIVAL_RPC_URLS_TESTNET_1")],
        factoryId: sentinel("PROBARION_FACTORY_ID_TESTNET"),
        demoVaultId: sentinel("PROBARION_VAULT_ID_TESTNET"),
        canaryVaultId: sentinel("CANARY_VAULT_ID_TESTNET"),
        teamVaultIds: [sentinel("TEAM_VAULT_IDS_TESTNET")],
      },
    },
    NEARAI_API_KEY: sentinel("NEARAI_API_KEY"),
    NEARAI_MODEL: sentinel("NEARAI_MODEL"),
    ONECLICK_JWT: sentinel("ONECLICK_JWT"),
    TESTNET_FAUCET_KEY: sentinel("TESTNET_FAUCET_KEY"),
    SUPABASE_URL: sentinel("SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: sentinel("SUPABASE_SERVICE_ROLE_KEY"),
    NEXT_PUBLIC_SUPABASE_URL: sentinel("NEXT_PUBLIC_SUPABASE_URL"),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: sentinel("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    KEY_ENCRYPTION_SECRET: sentinel("KEY_ENCRYPTION_SECRET"),
    SENTRY_DSN: sentinel("SENTRY_DSN"),
    TELEGRAM_BOT_TOKEN: sentinel("TELEGRAM_BOT_TOKEN"),
    RESEND_API_KEY: sentinel("RESEND_API_KEY"),
    BASE_RPC_URL: sentinel("BASE_RPC_URL"),
    CRON_SECRET: sentinel("CRON_SECRET"),
    CANARY_MODE: sentinel("CANARY_MODE"),
    BETTERSTACK_HEARTBEAT_URL: sentinel("BETTERSTACK_HEARTBEAT_URL"),
  };
  // Other IF §14 / runbook names the web never parses but could log.
  const otherSecrets = {
    PROBARION_AGENT_KEY: sentinel("PROBARION_AGENT_KEY"),
    PROBARION_LEDGER_KEY: sentinel("PROBARION_LEDGER_KEY"),
    OLD_KEY_ENCRYPTION_SECRET: sentinel("OLD_KEY_ENCRYPTION_SECRET"),
    NEW_KEY_ENCRYPTION_SECRET: sentinel("NEW_KEY_ENCRYPTION_SECRET"),
  };
  // Public configuration, kept on purpose: the network, ids, model name and mode, and the
  // NEXT_PUBLIC_* values and the Supabase project URL, which ship to the browser anyway.
  const PUBLIC_CONFIG: ReadonlyArray<keyof Env> = [
    "defaultNetwork",
    "enabledNetworks",
    "NEARAI_MODEL",
    "CANARY_MODE",
    "SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ];

  const flat = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(flat) : [String(v)]);

  it("leaves no secret variable's sentinel anywhere in the JSON line", () => {
    const all = { ...envLike, ...otherSecrets };
    // As the object itself, spread into the fields, and inside an array of objects.
    const line = formatLog("error", "env.dump", { env: all, ...all, history: [{ env: all }] });
    for (const [name, value] of Object.entries(all)) {
      if (PUBLIC_CONFIG.includes(name as keyof Env)) continue;
      for (const sentinel of flat(value)) expect(line, name).not.toContain(sentinel);
    }
  });

  it("keeps the public configuration, so the list above is a decision, not an accident", () => {
    const line = formatLog("info", "env.public", { env: envLike });
    for (const name of PUBLIC_CONFIG) expect(line, name).toContain(sentinel(name));
  });

  // The per-network settings are one object in Env, and four variables in the environment: the RPC lists carry keys.
  const PER_NETWORK_SECRETS = [
    "NEAR_RPC_URLS_MAINNET",
    "NEAR_RPC_URLS_TESTNET",
    "NEAR_ARCHIVAL_RPC_URLS_MAINNET",
    "NEAR_ARCHIVAL_RPC_URLS_TESTNET",
  ];

  it("lists every non-public variable in SECRET_ENV_NAMES, so its value is masked in text", () => {
    const listed: ReadonlySet<string> = new Set(SECRET_ENV_NAMES);
    for (const name of [...Object.keys(envLike), ...Object.keys(otherSecrets)]) {
      if (name === "networks") continue; // below
      if (PUBLIC_CONFIG.includes(name as keyof Env)) expect(listed.has(name), name).toBe(false);
      else expect(listed.has(name), name).toBe(true);
    }
    for (const name of PER_NETWORK_SECRETS) expect(listed.has(name), name).toBe(true);
  });

  it("masks the RPC lists of each network wherever the settings are logged, and keeps the rest", () => {
    const networks = envLike.networks as Record<string, Record<string, unknown>>;
    const line = formatLog("info", "env.networks", { networks });
    for (const settings of Object.values(networks)) {
      for (const key of ["rpcUrls", "archivalRpcUrls"]) {
        for (const value of flat(settings[key])) expect(line, key).not.toContain(value);
      }
      for (const key of ["factoryId", "demoVaultId", "canaryVaultId", "origin"]) {
        expect(line, key).toContain(String(settings[key]));
      }
    }
  });

  it("masks the value of a suffixed RPC variable in a message", () => {
    vi.stubEnv("NEAR_RPC_URLS_MAINNET", "https://m.example/KEY-MAINNET-SECRET");
    vi.stubEnv("NEAR_ARCHIVAL_RPC_URLS_TESTNET", "https://t.example/KEY-TESTNET-SECRET");
    const text = scrubText(
      "failed https://m.example/KEY-MAINNET-SECRET and https://t.example/KEY-TESTNET-SECRET",
    );
    expect(text).not.toContain("KEY-MAINNET-SECRET");
    expect(text).not.toContain("KEY-TESTNET-SECRET");
    vi.unstubAllEnvs();
  });
});

describe("redaction: arrays and depth", () => {
  it("recurses into arrays, including arrays of arrays", () => {
    const out = redact({
      items: [{ id: 1, api_key: "SENTINEL" }, [{ cookie: "SENTINEL" }, "plain", 3, null]],
      tags: ["a", "b"],
    });
    expect(out).toEqual({
      items: [{ id: 1, api_key: "[redacted]" }, [{ cookie: "[redacted]" }, "plain", 3, null]],
      tags: ["a", "b"],
    });
  });

  it("redacts a whole array under a secret key", () => {
    expect(redact({ NEAR_RPC_URLS: ["https://a.example/KEY", "https://b.example/KEY"] })).toEqual({
      NEAR_RPC_URLS: "[redacted]",
    });
  });

  it("replaces anything below the depth limit with [truncated], never the raw value", () => {
    let deep: Record<string, unknown> = { api_key: "SENTINEL", note: "SENTINEL" };
    for (let i = 0; i < 6; i++) deep = { child: deep };
    const line = formatLog("info", "deep", { deep });
    expect(line).not.toContain("SENTINEL");
    expect(line).toContain("[truncated]");
    // Four levels of nested objects are still visible; the fifth is cut.
    expect(redact({ a: { b: { c: { d: { e: { f: "SENTINEL" } } } } } })).toEqual({
      a: { b: { c: { d: { e: "[truncated]" } } } },
    });
    expect(redact({ a: { b: { c: { d: { e: "kept" } } } } })).toEqual({
      a: { b: { c: { d: { e: "kept" } } } },
    });
  });

  it("truncates arrays nested past the limit and survives a cycle", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => formatLog("info", "cycle", { cyclic })).not.toThrow();
    expect(formatLog("info", "cycle", { cyclic })).toContain("[truncated]");
    const nested = [[[[[["SENTINEL"]]]]]];
    expect(formatLog("info", "arrays", { nested })).not.toContain("SENTINEL");
  });
});

describe("formatLog: values and failure", () => {
  const at = new Date("2026-11-08T00:00:00Z");

  it("writes a bigint as a string", () => {
    const line = formatLog("info", "amount", { yocto: 10n ** 30n, nested: { n: 5n } }, at);
    expect(JSON.parse(line)).toMatchObject({
      yocto: "1000000000000000000000000000000",
      nested: { n: "5" },
    });
  });

  it("logs an Error as name and message only, with the message scrubbed", () => {
    const secretKey = `ed25519:${"Ab3".repeat(30)}`;
    const publicKey = `ed25519:${"6".repeat(44)}`;
    vi.stubEnv("CRON_SECRET", "env-secret-value-1234");
    const err = new TypeError(
      [
        "boom Bearer abc.def-ghi",
        `key ${secretKey}`,
        `pub ${publicKey}`,
        "url https://user:hunter2@rpc.example/path?api_key=SENTINEL&x=1",
        "env env-secret-value-1234",
      ].join(" | "),
    );
    const line = formatLog("error", "pipeline.failed", { err, nested: { cause: err } }, at);
    const parsed = JSON.parse(line);
    expect(Object.keys(parsed.err).sort()).toEqual(["message", "name"]);
    expect(parsed.err.name).toBe("TypeError");
    expect(parsed.err.message).toContain("Bearer [redacted]");
    expect(parsed.err.message).toContain(publicKey);
    expect(parsed.nested.cause.message).toBe(parsed.err.message);
    for (const leaked of [
      "abc.def-ghi",
      secretKey,
      "hunter2",
      "SENTINEL",
      "env-secret-value-1234",
      "at Object",
    ]) {
      expect(line, leaked).not.toContain(leaked);
    }
    expect(line).not.toContain("stack");
  });

  it("scrubs the message line too", () => {
    const line = formatLog("error", "failed with Bearer abc123", {}, at);
    expect(JSON.parse(line).msg).toBe("failed with Bearer [redacted]");
  });

  it("lets no field replace level, msg or at", () => {
    const line = formatLog("warn", "real", { level: "x", msg: "y", at: "z", kept: 1 }, at);
    expect(JSON.parse(line)).toEqual({
      level: "warn",
      msg: "real",
      at: "2026-11-08T00:00:00.000Z",
      kept: 1,
    });
  });

  it("logs only the type of a Buffer, Map or class instance, and the origin of a URL", () => {
    class Holder {
      secret_value = "SENTINEL";
      value = "SENTINEL";
    }
    const line = formatLog(
      "info",
      "types",
      {
        buf: Buffer.from("SENTINEL"),
        map: new Map([["k", "SENTINEL"]]),
        holder: new Holder(),
        url: new URL("https://rpc.example/SENTINEL?x=1"),
        when: at,
        fn: () => "SENTINEL",
      },
      at,
    );
    expect(line).not.toContain("SENTINEL");
    expect(JSON.parse(line)).toMatchObject({
      buf: "[Buffer]",
      map: "[Map]",
      holder: "[Holder]",
      url: "https://rpc.example",
      when: "2026-11-08T00:00:00.000Z",
      fn: "[function]",
    });
  });

  it("never throws: it writes a fallback line when the fields cannot be serialised", () => {
    const hostile = {
      get boom(): string {
        throw new Error("getter exploded");
      },
    };
    const line = formatLog("error", "bad.fields", { hostile }, at);
    expect(JSON.parse(line)).toEqual({
      level: "error",
      msg: "log.fields_unserialisable",
      at: "2026-11-08T00:00:00.000Z",
    });
    expect(JSON.parse(formatLog("info", "bad.date", {}, new Date(Number.NaN))).at).toBe(
      "invalid-date",
    );
  });
});

describe("redaction: values that cannot be secrets", () => {
  it("keeps a boolean, null or undefined under a secret-looking name", () => {
    const out = redact({
      heartbeat: true,
      is_private: false,
      cookie: true,
      password: null,
      token: undefined,
      nested: { heartbeat: false, api_key: null },
    });
    expect(out).toStrictEqual({
      heartbeat: true,
      is_private: false,
      cookie: true,
      password: null,
      token: undefined,
      nested: { heartbeat: false, api_key: null },
    });
    const line = formatLog("info", "watch.run", { heartbeat: true, is_private: false });
    expect(JSON.parse(line)).toMatchObject({ heartbeat: true, is_private: false });
  });

  it("still redacts a string or a number under the same names", () => {
    expect(
      redact({ heartbeat: "https://beat.example/abc", is_private: 1, password: "x", token: 0 }),
    ).toEqual({
      heartbeat: "[redacted]",
      is_private: "[redacted]",
      password: "[redacted]",
      token: "[redacted]",
    });
  });
});

describe("redaction: string values are scrubbed", () => {
  // Built at run time, so no token-shaped literal sits in the source for a secret scanner.
  const TELEGRAM_TOKEN = `123456789:AAH${"x".repeat(32)}`;
  const RPC_KEY_A = ["KEYA", "0123456789"].join("");
  const RPC_KEY_B = ["KEYB", "0123456789"].join("");

  it("masks a Telegram bot token in an error string, wherever the string sits", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TELEGRAM_TOKEN);
    const line = formatLog("error", `send failed for ${TELEGRAM_TOKEN}`, {
      error: `fetch https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage failed`,
      result: { error: `Unauthorized (${TELEGRAM_TOKEN})` },
      errors: [`first ${TELEGRAM_TOKEN}`, "second"],
    });
    expect(line).not.toContain(TELEGRAM_TOKEN);
    expect(line).not.toContain("xxxxxxxx");
    expect(JSON.parse(line).errors[1]).toBe("second");
    expect(JSON.parse(line).error).toContain("api.telegram.org");
  });

  it("masks every entry of NEAR_RPC_URLS and the BASE_RPC_URL in a string", () => {
    vi.stubEnv("NEAR_RPC_URLS", `https://rpc.example/${RPC_KEY_A}, https://b.example/${RPC_KEY_B}`);
    vi.stubEnv("BASE_RPC_URL", "https://base.example/v2/BASEKEY0123456789");
    const line = formatLog("warn", "rpc.failover", {
      error: `503 from https://rpc.example/${RPC_KEY_A}, then https://b.example/${RPC_KEY_B}`,
      base: "timeout https://base.example/v2/BASEKEY0123456789",
    });
    for (const key of [RPC_KEY_A, RPC_KEY_B, "BASEKEY0123456789"]) {
      expect(line, key).not.toContain(key);
    }
    expect(JSON.parse(line).error).toBe("503 from [redacted], then [redacted]");
  });

  it("masks a Telegram token and a Bearer header by shape when the environment does not hold them", () => {
    const line = formatLog("error", "telegram.failed", {
      error: `getUpdates https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`,
      header: "Bearer abc.def-ghi",
      url: "https://rpc.example/status?api_key=SENTINEL&x=1",
    });
    expect(line).not.toContain(TELEGRAM_TOKEN);
    expect(line).not.toContain("abc.def-ghi");
    expect(line).not.toContain("SENTINEL");
  });

  it("masks a browser extension token by its shape, in the message, a field and an error", () => {
    // Built at run time, like the other fakes here: pbx_ and 43 base64url characters, as lib/ext/token.ts makes them.
    const PBX = `pbx_${"Ab3-_9".repeat(8).slice(0, 43)}`;
    const line = formatLog("error", `ext.pair_failed ${PBX}`, {
      note: `refused ${PBX}`,
      error: new Error(`bad ${PBX}`),
    });
    expect(line).not.toContain(PBX.slice(4));
    expect(line.split("pbx_[redacted]")).toHaveLength(4);
    // A name that starts with pbx_ is not a token.
    expect(redact({ name: "pbx_token" })).toEqual({ name: "pbx_token" });
  });

  it("leaves ordinary strings alone", () => {
    const strings = {
      request_id: "6f1c3a52-0f7d-4d0a-9d55-3a1b2c4d5e6f",
      invoice_hash: "ab".repeat(32),
      public_key: `ed25519:${"6".repeat(44)}`,
      vault: "acme.vaults.probarion.near",
      when: "2026-11-08T00:00:00.000Z",
      next: "http://localhost:3000/console?tab=keys",
      note: "payment of 12.50 USDC to 1234567:8",
    };
    expect(redact(strings)).toEqual(strings);
  });

  it("masks only the listed variables, not anything whose name looks secret", () => {
    vi.stubEnv("__NEXT_PRIVATE_ORIGIN", "http://localhost:3000");
    vi.stubEnv("MY_APP_TOKEN", "not-a-listed-variable-1234");
    expect(secretEnvValues()).not.toContain("http://localhost:3000");
    expect(secretEnvValues()).not.toContain("not-a-listed-variable-1234");
    const line = formatLog("info", "dev.origin", {
      origin: "http://localhost:3000",
      note: "not-a-listed-variable-1234",
    });
    expect(JSON.parse(line)).toMatchObject({
      origin: "http://localhost:3000",
      note: "not-a-listed-variable-1234",
    });
  });

  it("masks the longest value first, so an entry that contains another is fully hidden", () => {
    vi.stubEnv("NEAR_RPC_URLS", "https://rpc.example/key-abc,https://rpc.example/key-abc-longer");
    const line = formatLog("error", "x", { error: "https://rpc.example/key-abc-longer failed" });
    expect(JSON.parse(line).error).toBe("[redacted] failed");
  });

  it("ignores values shorter than 8 characters, which would mask ordinary text", () => {
    vi.stubEnv("CRON_SECRET", "short");
    expect(secretEnvValues()).toEqual([]);
  });

  it("reads the environment once per log line, however many strings it holds", () => {
    const real = process.env;
    let reads = 0;
    const counted = new Proxy(real, {
      get(target, key) {
        if (key === "TELEGRAM_BOT_TOKEN") reads += 1;
        return Reflect.get(target, key);
      },
    });
    Object.defineProperty(process, "env", { value: counted, configurable: true, writable: true });
    try {
      formatLog("info", "many", {
        a: "x",
        b: ["y", "z"],
        c: { d: "w", e: ["v"] },
        err: new Error("boom"),
      });
    } finally {
      Object.defineProperty(process, "env", { value: real, configurable: true, writable: true });
    }
    expect(reads).toBe(1);
  });
});
