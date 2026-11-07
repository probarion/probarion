import { NETWORKS } from "@probarion/core";
import type { FunctionCallTx } from "@probarion/sdk";
import { ProbarionError, TxOutcomeUnknownError, TxRejectedError } from "@probarion/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrubText } from "@/lib/log";
import { LIMITS } from "@/lib/ratelimit";
import { faucetAccountText, faucetCapText, faucetCopy, faucetUsedText } from "@/lib/topup/copy";
import { FAUCET_BUCKETS, faucetMintTx } from "@/lib/topup/faucet";
import { quietLogs } from "../../../../../test/fixtures/quiet-logs";
import { ORIGIN, OWNER, post, vaultConfig } from "../../../../../test/fixtures/topup";

const VAULT = "acme.vaults.probarion.testnet";
/**
 * The fake sender takes any "ed25519:" text. This one is shorter than the log scrubber's ed25519 pattern and is not in
 * process.env, so nothing but the code itself keeps it out of the answers and the logs.
 */
const KEY = `ed25519:${"k".repeat(40)}`;
const TX = "9".repeat(44);
/** 19:00 UTC: 5 hours before the day's counters start again. */
const NOW = new Date("2026-11-07T19:00:00.000Z");
const DAY = "2026-11-07";
const PUBLIC = "ed25519:FakePublicKey";
const MINT_KEY = {
  public_key: PUBLIC,
  permission: {
    receiver_id: "usdc.probarion.testnet",
    method_names: ["mint"],
    allowance: "2000000000000000000000000",
  },
};

type Answer = (tx: FunctionCallTx) => Promise<unknown>;

const h = vi.hoisted(() => ({
  /** The network of the address the request was opened at. */
  network: "testnet" as "mainnet" | "testnet",
  session: null as { accountId: string } | null,
  /** The signed-in account's role in the vault, or null for a stranger. */
  role: "owner" as "owner" | "approver" | "viewer" | null,
  /** The network the vault is registered on. */
  vaultNetwork: "testnet" as "mainnet" | "testnet",
  /** The vault id the membership row holds, when a test wants it to differ from the request's. */
  rowVault: null as string | null,
  memberCalls: [] as { vault: string; roles: unknown }[],
  key: null as string | null,
  config: null as unknown,
  configError: null as Error | null,
  reads: [] as string[],
  /** The faucet key as the chain holds it (view_access_key), or null when it is not there. */
  accessKey: null as unknown,
  accessKeyError: null as Error | null,
  keyReads: [] as { account: string; publicKey: string }[],
  /** Milliseconds the vault's config read takes, on the faked clock. */
  readMs: 0,
  limiterDown: false,
  buckets: new Map<string, number>(),
  limits: [] as { bucket: string; max: number; window: number }[],
  senders: [] as { accountId: string; secretKey: string }[],
  calls: [] as FunctionCallTx[],
  answer: null as null | ((tx: FunctionCallTx) => Promise<unknown>),
}));

vi.mock("@/lib/network", () => ({ requestNetwork: async () => h.network }));
// The guard's own answers (lib/auth/guard.ts memberForApi): 401 without a session, 403 for a stranger or a role not
// allowed, 409 for a vault registered on another network than the request's.
const refusal = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status });
vi.mock("@/lib/auth/guard", () => ({
  memberForApi: async (vault: string, roles: string[]) => {
    h.memberCalls.push({ vault, roles });
    if (h.session === null) return refusal(401, "unauthenticated");
    if (h.role === null || !roles.includes(h.role)) return refusal(403, "forbidden");
    if (h.vaultNetwork !== h.network) return refusal(409, "wrong_network");
    return {
      session: h.session,
      member: {
        vault_id: h.rowVault ?? vault,
        role: h.role,
        network: h.vaultNetwork,
        tenant_id: "t-1",
      },
    };
  },
}));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ TESTNET_FAUCET_KEY: h.key }) }));
vi.mock("@/lib/db/clients", () => ({
  serviceDb: () => ({
    rpc: async (fn: string, p: { bucket: string; max: number; window_seconds: number }) => {
      if (fn !== "rate_limit_take") throw new Error(`unexpected rpc ${fn}`);
      if (h.limiterDown) throw new Error("db down");
      h.limits.push({ bucket: p.bucket, max: p.max, window: p.window_seconds });
      const n = (h.buckets.get(p.bucket) ?? 0) + 1;
      h.buckets.set(p.bucket, n);
      return {
        allowed: n <= p.max,
        remaining: Math.max(0, p.max - n),
        reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
      };
    },
  }),
}));
vi.mock("@/lib/near/server", () => ({
  getReader: () => ({
    getConfig: async (vault: string) => {
      h.reads.push(vault);
      if (h.readMs > 0) vi.setSystemTime(Date.now() + h.readMs);
      if (h.configError) throw h.configError;
      return h.config;
    },
  }),
  getRpc: () => ({
    currentUrl: "https://rpc.testnet.example",
    viewAccessKey: async (account: string, publicKey: string) => {
      h.keyReads.push({ account, publicKey });
      if (h.accessKeyError) throw h.accessKeyError;
      return h.accessKey;
    },
  }),
  chainConsts: (network: "mainnet" | "testnet") => NETWORKS[network],
}));
// The real sender would sign and send; this one records what it was built with and asked to send.
vi.mock("@probarion/sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@probarion/sdk")>();
  const PUBLIC_KEY = "ed25519:FakePublicKey";
  class FakeSender {
    readonly accountId: string;
    readonly publicKey = PUBLIC_KEY;
    constructor(opts: { accountId: string; secretKey: string }) {
      if (!opts.secretKey.startsWith("ed25519:")) throw new real.ConfigError("invalid secret key");
      h.senders.push({ accountId: opts.accountId, secretKey: opts.secretKey });
      this.accountId = opts.accountId;
    }
    async functionCall(tx: FunctionCallTx) {
      h.calls.push(tx);
      if (!h.answer) throw new Error("no answer set");
      return h.answer(tx);
    }
  }
  return { ...real, NearApiJsSender: FakeSender };
});

const { POST, maxDuration } = await import("./route");

const URL_ = `${ORIGIN}/api/topup/faucet`;
const COPY = faucetCopy("25");
const logs = quietLogs();
const send = (body: unknown = { vault: VAULT }, headers: Record<string, string> = {}) =>
  POST(post(URL_, body, headers));
const answer = async (r: Response) => (await r.json()) as Record<string, unknown>;
const minted: Answer = async () => ({
  txHash: TX,
  ok: true,
  value: null,
  code: null,
  failure: null,
  raw: {},
});

/** Nothing was read from the chain, counted or signed. */
function nothingDone() {
  expect(h.reads).toEqual([]);
  expect(h.keyReads).toEqual([]);
  expect(h.limits).toEqual([]);
  expect(h.calls).toEqual([]);
}

/** The day's counters taken: every hit but the ones on the account's presses. */
const dayLimits = () => h.limits.filter((l) => !l.bucket.startsWith("faucet:testnet:tries:"));

/** Nothing of the day was counted, and nothing was signed. */
function nothingCounted() {
  expect(dayLimits()).toEqual([]);
  expect(h.calls).toEqual([]);
}

const triesOf = (account = OWNER) => ({
  bucket: FAUCET_BUCKETS.tries(account),
  max: LIMITS.faucetTries[0],
  window: LIMITS.faucetTries[1],
});

const bucketsOf = (vault: string, account = OWNER, day = DAY) => [
  { bucket: FAUCET_BUCKETS.vault(vault, day), max: LIMITS.faucetVault[0], window: 86_400 },
  { bucket: FAUCET_BUCKETS.account(account, day), max: LIMITS.faucetAccount[0], window: 86_400 },
  { bucket: FAUCET_BUCKETS.global(day), max: LIMITS.faucetGlobal[0], window: 86_400 },
];

beforeEach(() => {
  // Only Date is faked: the clock stands still at NOW unless a test moves it.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.network = "testnet";
  h.session = { accountId: OWNER };
  h.role = "owner";
  h.vaultNetwork = "testnet";
  h.rowVault = null;
  h.memberCalls = [];
  h.key = KEY;
  h.config = vaultConfig("testnet");
  h.configError = null;
  h.reads = [];
  h.accessKey = structuredClone(MINT_KEY);
  h.accessKeyError = null;
  h.keyReads = [];
  h.readMs = 0;
  h.limiterDown = false;
  h.buckets.clear();
  h.limits = [];
  h.senders = [];
  h.calls = [];
  h.answer = minted;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/topup/faucet", () => {
  it("allows 60 s, for a mint that waits for FINAL", () => {
    expect(maxDuration).toBe(60);
  });

  it("does not exist at mainnet's address: 404 before the origin, the body or the session is looked at", async () => {
    h.network = "mainnet";
    for (const r of [
      await send(),
      await send({ vault: VAULT }, { origin: "https://evil.example" }),
      await send("not json"),
    ]) {
      expect(r.status).toBe(404);
      expect(await answer(r)).toEqual({ error: "not_found" });
    }
    expect(h.memberCalls).toEqual([]);
    expect(h.senders).toEqual([]);
    nothingDone();
  });

  it("refuses another origin and a request with no origin with 403", async () => {
    expect((await send({ vault: VAULT }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await POST(new Request(URL_, { method: "POST", body: "{}" }))).status).toBe(403);
    expect(h.memberCalls).toEqual([]);
    nothingDone();
  });

  it("answers 400 to a body without a vault", async () => {
    for (const body of [{}, { vault: 7 }, null, []]) {
      expect((await send(body)).status).toBe(400);
    }
    expect(h.memberCalls).toEqual([]);
    nothingDone();
  });

  it("answers 401 without a session", async () => {
    h.session = null;
    const r = await send();
    expect(r.status).toBe(401);
    expect(await answer(r)).toEqual({ error: "unauthenticated" });
    nothingDone();
  });

  it("answers 404 to a stranger, an approver and a viewer: only the owner's membership counts", async () => {
    for (const role of [null, "approver", "viewer"] as const) {
      h.role = role;
      const r = await send();
      expect(r.status).toBe(404);
      expect(await answer(r)).toEqual({ error: "not_found" });
    }
    expect(h.memberCalls).toEqual([
      { vault: VAULT, roles: ["owner"] },
      { vault: VAULT, roles: ["owner"] },
      { vault: VAULT, roles: ["owner"] },
    ]);
    nothingDone();
  });

  it("answers 404 for a vault registered on mainnet, even to its owner (the guard's 409 is not passed on)", async () => {
    h.vaultNetwork = "mainnet";
    const r = await send();
    expect(r.status).toBe(404);
    expect(await answer(r)).toEqual({ error: "not_found" });
    nothingDone();
  });

  it("answers 503 when this server has no faucet key, or a key that is not one, before reading or counting", async () => {
    for (const key of [null, "not-a-key"]) {
      h.key = key;
      const r = await send();
      expect(r.status).toBe(503);
      expect(await answer(r)).toEqual({ error: "not_configured", detail: COPY.unavailable });
    }
    nothingDone();
  });

  it("mints nothing and counts nothing when the vault cannot be read", async () => {
    h.configError = new Error("all RPC endpoints failed");
    expect((await send()).status).toBe(503);
    h.configError = null;
    h.config = { owner: OWNER };
    expect((await send()).status).toBe(503);
    nothingCounted();
  });

  it("answers 409 when the chain names another owner, or the vault holds another token", async () => {
    h.config = { ...vaultConfig("testnet"), owner: "someone-else.testnet" };
    let r = await send();
    expect(r.status).toBe(409);
    expect(String((await answer(r)).detail)).toContain("someone-else.testnet");
    h.config = { ...vaultConfig("testnet"), usdc: "other-usdc.testnet" };
    r = await send();
    expect(r.status).toBe(409);
    expect(String((await answer(r)).detail)).toContain("other-usdc.testnet");
    nothingCounted();
  });

  it("signs with no key but a mint-only one: full access, more methods, another contract or a deleted key stop it", async () => {
    const fc = MINT_KEY.permission;
    for (const [accessKey, found] of [
      [{ public_key: PUBLIC, permission: "FullAccess" }, "full_access"],
      [
        { public_key: PUBLIC, permission: { ...fc, method_names: ["mint", "ft_transfer"] } },
        "other",
      ],
      [{ public_key: PUBLIC, permission: { ...fc, method_names: [] } }, "other"],
      [{ public_key: PUBLIC, permission: { ...fc, receiver_id: "other-usdc.testnet" } }, "other"],
      [null, "missing"],
    ] as const) {
      h.accessKey = accessKey;
      logs.lines.length = 0;
      const r = await send();
      expect(r.status).toBe(503);
      expect(await answer(r)).toEqual({ error: "not_configured", detail: COPY.unavailable });
      const line = logs.lines.join("\n");
      expect(line).toContain("faucet.key_not_mint_only");
      expect(line).toContain(found);
    }
    expect(h.keyReads).toHaveLength(5);
    expect(h.keyReads[0]).toEqual({ account: "probarion.testnet", publicKey: PUBLIC });
    nothingCounted();
  });

  it("stops before counting when the key's allowance is nearly gone, or the key cannot be read", async () => {
    h.accessKey = {
      public_key: PUBLIC,
      permission: { ...MINT_KEY.permission, allowance: "9999999999999999999999" },
    };
    let r = await send();
    expect(r.status).toBe(503);
    expect(await answer(r)).toEqual({ error: "unavailable", detail: COPY.unavailable });
    expect(logs.lines.join("\n")).toContain("faucet.allowance_low");
    h.accessKey = null;
    h.accessKeyError = new Error("all RPC endpoints failed");
    r = await send();
    expect(r.status).toBe(503);
    expect(await answer(r)).toEqual({ error: "unavailable", detail: COPY.unavailable });
    nothingCounted();
  });

  it("mints with a key whose allowance is unlimited, or exactly the least it may have", async () => {
    h.accessKey = { public_key: PUBLIC, permission: { ...MINT_KEY.permission, allowance: null } };
    expect((await send()).status).toBe(200);
    h.accessKey = {
      public_key: PUBLIC,
      permission: { ...MINT_KEY.permission, allowance: "10000000000000000000000" },
    };
    expect((await send({ vault: "b.vaults.probarion.testnet" })).status).toBe(200);
  });

  it("stops before counting when the reads left the send too little time, and says the day is not used", async () => {
    h.readMs = 16_000;
    const r = await send();
    expect(r.status).toBe(503);
    expect(await answer(r)).toEqual({ error: "unavailable", detail: COPY.slow });
    expect(COPY.slow).toContain("this vault's day is not used");
    nothingCounted();
    h.readMs = 15_000;
    expect((await send()).status).toBe(200);
  });

  it("mints the fixed 25 test USDC into the vault, signed by probarion.testnet with the faucet key", async () => {
    const r = await send();
    expect(r.status).toBe(200);
    expect(await answer(r)).toEqual({ status: "minted", txHash: TX, amount: "25" });
    expect(h.senders).toEqual([{ accountId: "probarion.testnet", secretKey: KEY }]);
    expect(h.calls).toEqual([faucetMintTx(VAULT)]);
    expect(h.calls[0]).toMatchObject({
      receiverId: "usdc.probarion.testnet",
      methodName: "mint",
      args: { account_id: VAULT, amount: "25000000" },
      deposit: 0n,
    });
    expect(h.reads).toEqual([VAULT]);
    expect(h.keyReads).toEqual([{ account: "probarion.testnet", publicKey: PUBLIC }]);
    expect(h.limits).toEqual([triesOf(), ...bucketsOf(VAULT)]);
    expect(bucketsOf(VAULT).map((b) => b.bucket)).toEqual([
      `faucet:testnet:vault:${VAULT}:2026-11-07`,
      `faucet:testnet:account:${OWNER}:2026-11-07`,
      "faucet:testnet:all:2026-11-07",
    ]);
  });

  it("takes no amount and no target from the body: the vault is the membership row's", async () => {
    h.rowVault = "row.vaults.probarion.testnet";
    const r = await send({
      vault: VAULT,
      amount: "1000000000000",
      account_id: "attacker.testnet",
      receiverId: "other-token.testnet",
    });
    expect(r.status).toBe(200);
    expect(h.calls).toEqual([faucetMintTx("row.vaults.probarion.testnet")]);
    expect(h.reads).toEqual(["row.vaults.probarion.testnet"]);
    expect(dayLimits()[0]?.bucket).toBe(FAUCET_BUCKETS.vault("row.vaults.probarion.testnet", DAY));
  });

  it("mints once a UTC day per vault: the second click is a 429 until midnight and touches no other counter", async () => {
    expect(LIMITS.faucetVault).toEqual([1, 86_400]);
    expect((await send()).status).toBe(200);
    const r = await send();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe(String(5 * 3600));
    expect(await answer(r)).toEqual({ error: "rate_limited", detail: faucetUsedText(5 * 3600) });
    expect(faucetUsedText(5 * 3600)).toBe(
      "This vault already got its test USDC today. Try again in about 5 h.",
    );
    expect(h.calls).toHaveLength(1);
    expect(dayLimits().map((l) => l.bucket)).toEqual([
      ...bucketsOf(VAULT).map((b) => b.bucket),
      FAUCET_BUCKETS.vault(VAULT, DAY),
    ]);
    // After midnight UTC the day's counters are new ones.
    vi.setSystemTime(new Date("2026-11-08T00:00:01.000Z"));
    expect((await send()).status).toBe(200);
    expect(h.calls).toHaveLength(2);
    expect(dayLimits().slice(-3)).toEqual(bucketsOf(VAULT, OWNER, "2026-11-08"));
  });

  it("counts an account's presses before it reads the chain: the 11th in 10 minutes is a 429 with no read", async () => {
    expect(LIMITS.faucetTries).toEqual([10, 600]);
    h.buckets.set(FAUCET_BUCKETS.tries(OWNER), LIMITS.faucetTries[0]);
    const r = await send();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(h.limits).toEqual([triesOf()]);
    expect(h.reads).toEqual([]);
    expect(h.keyReads).toEqual([]);
    nothingCounted();
  });

  it("mints into 3 vaults a day per owner account: the 4th is a 429 that leaves the cap for all vaults alone", async () => {
    expect(LIMITS.faucetAccount).toEqual([3, 86_400]);
    for (const v of ["a", "b", "c"]) {
      expect((await send({ vault: `${v}.vaults.probarion.testnet` })).status).toBe(200);
    }
    const r = await send({ vault: "d.vaults.probarion.testnet" });
    expect(r.status).toBe(429);
    expect(await answer(r)).toEqual({
      error: "rate_limited",
      detail: faucetAccountText(5 * 3600, 3),
    });
    expect(faucetAccountText(5 * 3600, 3)).toBe(
      "Your account already added test USDC to 3 vaults today. Try again in about 5 h.",
    );
    expect(h.calls).toHaveLength(3);
    expect(h.buckets.get(FAUCET_BUCKETS.global(DAY))).toBe(3);
    // Another owner's vault still gets its mint.
    h.session = { accountId: "other-owner.testnet" };
    h.config = { ...vaultConfig("testnet"), owner: "other-owner.testnet" };
    expect((await send({ vault: "e.vaults.probarion.testnet" })).status).toBe(200);
  });

  it("stops every vault once the daily cap for all of them is reached, until midnight UTC", async () => {
    expect(LIMITS.faucetGlobal).toEqual([50, 86_400]);
    h.buckets.set(FAUCET_BUCKETS.global(DAY), LIMITS.faucetGlobal[0]);
    const r = await send();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe(String(5 * 3600));
    expect(await answer(r)).toEqual({ error: "rate_limited", detail: faucetCapText(5 * 3600) });
    expect(h.calls).toEqual([]);
    vi.setSystemTime(new Date("2026-11-08T00:00:01.000Z"));
    expect((await send()).status).toBe(200);
  });

  it("mints nothing, and reads nothing, when the limiter cannot be reached", async () => {
    h.limiterDown = true;
    expect((await send()).status).toBe(503);
    expect(h.reads).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("says the faucet is not working when the token refuses the mint, and logs why", async () => {
    h.answer = async () => ({
      txHash: TX,
      ok: false,
      value: null,
      code: "LackBalanceForState",
      failure: "LackBalanceForState",
      raw: {},
    });
    const r = await send();
    expect(r.status).toBe(502);
    expect(await answer(r)).toEqual({ error: "mint_failed", detail: COPY.unavailable, txHash: TX });
    expect(logs.lines.join("\n")).toContain("faucet.mint_failed");
    expect(logs.lines.join("\n")).toContain("LackBalanceForState");
  });

  it("says the faucet is not working when the node refuses the key (gone, or out of allowance)", async () => {
    h.answer = async () => {
      throw new TxRejectedError("mint transaction refused", "NotEnoughAllowance");
    };
    const r = await send();
    expect(r.status).toBe(503);
    expect(await answer(r)).toEqual({ error: "unavailable", detail: COPY.unavailable });
    expect(logs.lines.join("\n")).toContain("NotEnoughAllowance");
    h.answer = async () => {
      throw new ProbarionError("could not be sent (nothing was sent)", "TxSendFailed");
    };
    expect((await send({ vault: "b.vaults.probarion.testnet" })).status).toBe(503);
  });

  it("answers 202 with the hash, and sends nothing again, when the mint's outcome is unknown", async () => {
    h.answer = async () => {
      throw new TxOutcomeUnknownError("unknown", TX, "probarion.testnet");
    };
    const r = await send();
    expect(r.status).toBe(202);
    expect(await answer(r)).toEqual({ status: "unknown", txHash: TX, detail: COPY.unknown });
    expect(h.calls).toHaveLength(1);
    // The vault's day is used: a second click is refused, not a second mint.
    expect((await send()).status).toBe(429);
    expect(h.calls).toHaveLength(1);
  });

  it("puts the key in no answer and no log line", async () => {
    // The scrubbers would not hide this key: only the code keeps it out.
    expect(scrubText(KEY, [])).toBe(KEY);
    const bodies: string[] = [];
    for (const setup of [
      () => {},
      () => {
        h.answer = async () => {
          throw new Error(`boom ${KEY}`);
        };
      },
      () => {
        h.key = "not-a-key";
      },
    ]) {
      h.buckets.clear();
      setup();
      bodies.push(await (await send()).text());
    }
    expect(logs.lines.length).toBeGreaterThan(0);
    for (const text of [...bodies, ...logs.lines]) {
      expect(text).not.toContain(KEY.slice(8));
      expect(text).not.toContain("not-a-key");
    }
  });
});
