import type { FunctionCallTx } from "@probarion/sdk";
import { ProbarionError, TxOutcomeUnknownError, TxRejectedError } from "@probarion/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@/lib/ratelimit";
import { faucetCapText, faucetCopy, faucetUsedText } from "@/lib/topup/copy";
import { faucetMintTx } from "@/lib/topup/faucet";
import { quietLogs } from "../../../../../test/fixtures/quiet-logs";
import { ORIGIN, OWNER, post, vaultConfig } from "../../../../../test/fixtures/topup";

const VAULT = "acme.vaults.probarion.testnet";
/** Base58 text of a secret key's length: the fake sender takes it, and it must never show up anywhere. */
const KEY = `ed25519:${"k".repeat(86)}`;
const TX = "9".repeat(44);

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
  memberCalls: [] as { vault: string; account: string; roles: unknown }[],
  key: null as string | null,
  config: null as unknown,
  configError: null as Error | null,
  reads: [] as string[],
  limiterDown: false,
  buckets: new Map<string, number>(),
  limits: [] as { bucket: string; max: number; window: number }[],
  senders: [] as { accountId: string; secretKey: string }[],
  calls: [] as FunctionCallTx[],
  answer: null as null | ((tx: FunctionCallTx) => Promise<unknown>),
}));

vi.mock("@/lib/network", () => ({ requestNetwork: async () => h.network }));
vi.mock("@/lib/auth/guard", () => ({
  getSession: async () => h.session,
  membership: async (vault: string, account: string, roles: string[]) => {
    h.memberCalls.push({ vault, account, roles });
    if (h.role === null || !roles.includes(h.role)) return null;
    return {
      vault_id: h.rowVault ?? vault,
      role: h.role,
      network: h.vaultNetwork,
      tenant_id: "t-1",
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
      if (h.configError) throw h.configError;
      return h.config;
    },
  }),
  getRpc: () => ({ currentUrl: "https://rpc.testnet.example" }),
}));
// The real sender would sign and send; this one records what it was built with and asked to send.
vi.mock("@probarion/sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@probarion/sdk")>();
  class FakeSender {
    readonly accountId: string;
    readonly publicKey = "ed25519:FakePublicKey";
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
  expect(h.limits).toEqual([]);
  expect(h.calls).toEqual([]);
}

beforeEach(() => {
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
  h.limiterDown = false;
  h.buckets.clear();
  h.limits = [];
  h.senders = [];
  h.calls = [];
  h.answer = minted;
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

  it("answers 401 without a session, and looks up no membership", async () => {
    h.session = null;
    expect((await send()).status).toBe(401);
    expect(h.memberCalls).toEqual([]);
    nothingDone();
  });

  it("answers 404 to a stranger, an approver and a viewer: only the owner's membership counts", async () => {
    for (const role of [null, "approver", "viewer"] as const) {
      h.role = role;
      const r = await send();
      expect(r.status).toBe(404);
      expect(await answer(r)).toEqual({ error: "not_found" });
    }
    expect(h.memberCalls.map((c) => c.roles)).toEqual([["owner"], ["owner"], ["owner"]]);
    expect(h.memberCalls.every((c) => c.account === OWNER)).toBe(true);
    nothingDone();
  });

  it("answers 404 for a vault registered on mainnet, even to its owner", async () => {
    h.vaultNetwork = "mainnet";
    expect((await send()).status).toBe(404);
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
    expect(h.limits).toEqual([]);
    expect(h.calls).toEqual([]);
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
    expect(h.limits).toEqual([]);
    expect(h.calls).toEqual([]);
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
    expect(h.limits).toEqual([
      { bucket: `faucet:testnet:${VAULT}`, max: LIMITS.faucetVault[0], window: 86_400 },
      { bucket: "faucet:testnet", max: LIMITS.faucetGlobal[0], window: 86_400 },
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
    expect(h.limits[0]?.bucket).toBe("faucet:testnet:row.vaults.probarion.testnet");
  });

  it("mints once a day per vault: the second click is a 429 and does not touch the cap for all vaults", async () => {
    expect(LIMITS.faucetVault).toEqual([1, 86_400]);
    expect((await send()).status).toBe(200);
    const r = await send();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    const retry = Number(r.headers.get("retry-after"));
    expect(await answer(r)).toEqual({ error: "rate_limited", detail: faucetUsedText(retry) });
    expect(faucetUsedText(retry)).toContain("about 5 h");
    expect(h.calls).toHaveLength(1);
    expect(h.limits.map((l) => l.bucket)).toEqual([
      `faucet:testnet:${VAULT}`,
      "faucet:testnet",
      `faucet:testnet:${VAULT}`,
    ]);
  });

  it("stops every vault once the daily cap for all of them is reached", async () => {
    expect(LIMITS.faucetGlobal).toEqual([50, 86_400]);
    h.buckets.set("faucet:testnet", LIMITS.faucetGlobal[0]);
    const r = await send();
    expect(r.status).toBe(429);
    const retry = Number(r.headers.get("retry-after"));
    expect(await answer(r)).toEqual({ error: "rate_limited", detail: faucetCapText(retry) });
    expect(h.calls).toEqual([]);
  });

  it("mints nothing when the limiter cannot be reached", async () => {
    h.limiterDown = true;
    expect((await send()).status).toBe(503);
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
    for (const text of [...bodies, ...logs.lines]) {
      expect(text).not.toContain(KEY.slice(8));
      expect(text).not.toContain("not-a-key");
    }
  });
});
