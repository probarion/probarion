import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPair } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { ConfigError, ContractError, TxOutcomeUnknownError, ViewError } from "../src/errors.js";
import { FactoryClient } from "../src/factory-client.js";
import { IntentsClient } from "../src/intents-client.js";
import { MAX_PAGES } from "../src/paging.js";
import { NearApiJsSender, parseTxOutcome, type TxOutcome, type TxSender } from "../src/tx.js";
import { ANCHOR_GAS, isSpendResult, pageAll, SPEND_GAS, VaultClient } from "../src/vault-client.js";
import {
  fakeSender,
  okOutcome,
  ROOT,
  request,
  TGAS,
  VAULT,
  viewRpc,
} from "./helpers/client-fakes.js";
import { fakeProvider } from "./helpers/fake-provider.js";

describe("VaultClient views", () => {
  it("pages list views until a short page", async () => {
    const all = Array.from({ length: 120 }, (_, id) => ({ id }));
    const { rpc, calls } = viewRpc((_c, _m, args) => {
      const from = Number(args.from_index);
      return all.slice(from, from + Number(args.limit));
    });
    const vault = new VaultClient(VAULT, rpc);
    expect(await vault.listAllMandates()).toHaveLength(120);
    expect(calls.map((c) => c.args)).toEqual([
      { from_index: 0, limit: 50 },
      { from_index: 50, limit: 50 },
      { from_index: 100, limit: 50 },
    ]);
    expect(calls.every((c) => c.method === "list_mandates")).toBe(true);
    expect(calls.every((c) => c.contract === VAULT)).toBe(true);
  });

  it("pages spends and anchors with their own list methods", async () => {
    const { rpc, calls } = viewRpc(() => []);
    const vault = new VaultClient(VAULT, rpc);
    expect(await vault.listAllSpends()).toEqual([]);
    expect(await vault.listAllAnchors()).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(["list_spends", "list_anchors"]);
  });

  it("caps limit at 100 (interfaces v2)", async () => {
    const { rpc, calls } = viewRpc(() => []);
    await new VaultClient(VAULT, rpc).listSpends(0, 500);
    expect(calls[0]?.args).toEqual({ from_index: 0, limit: 100 });
  });

  it("clamps pageAll's own page size so a huge limit cannot truncate the result", async () => {
    const all = Array.from({ length: 250 }, (_, id) => id);
    const seen: number[] = [];
    const got = await pageAll(async (from, limit) => {
      seen.push(limit);
      return all.slice(from, from + Math.min(limit, 100));
    }, 1000);
    expect(got).toHaveLength(250);
    expect(seen).toEqual([100, 100, 100]);
  });

  it("rejects a bad index or limit before any request", async () => {
    const { rpc, calls } = viewRpc(() => []);
    const vault = new VaultClient(VAULT, rpc);
    await expect(vault.listMandates(-1, 10)).rejects.toThrow(ConfigError);
    await expect(vault.listMandates(1.5, 10)).rejects.toThrow(ConfigError);
    await expect(vault.listMandates(0, Number.NaN)).rejects.toThrow(ConfigError);
    await expect(vault.getMandate(-3)).rejects.toThrow(ConfigError);
    await expect(vault.getSpend(0.5)).rejects.toThrow(ConfigError);
    expect(calls).toHaveLength(0);
  });

  it("sends check_spend with request and signer_pk and normalises the code", async () => {
    const { rpc, calls } = viewRpc(() => ({
      ok: false,
      code: "PROBARION:OverPerPayment",
      would_hold: false,
    }));
    const vault = new VaultClient(VAULT, rpc);
    expect(await vault.checkSpend(request, "ed25519:Agent")).toEqual({
      ok: false,
      code: "OverPerPayment",
      would_hold: false,
    });
    expect(calls[0]).toMatchObject({
      method: "check_spend",
      args: { request, signer_pk: "ed25519:Agent" },
    });
  });

  it("reads the bare codes the contract really sends", async () => {
    const { rpc } = viewRpc(() => ({ ok: true, code: null, would_hold: true }));
    expect(await new VaultClient(VAULT, rpc).checkSpend(request, "ed25519:Agent")).toEqual({
      ok: true,
      code: null,
      would_hold: true,
    });
  });

  it("refuses a check_spend answer that is not a verdict", async () => {
    const { rpc } = viewRpc(() => null);
    await expect(new VaultClient(VAULT, rpc).checkSpend(request, "ed25519:Agent")).rejects.toThrow(
      ViewError,
    );
  });

  it("reads single items by id", async () => {
    const { rpc, calls } = viewRpc((_c, method) => (method === "get_mandate" ? null : { id: 4 }));
    const vault = new VaultClient(VAULT, rpc);
    expect(await vault.getMandate(9)).toBeNull();
    expect(await vault.getSpend(4)).toEqual({ id: 4 });
    expect(calls.map((c) => [c.method, c.args])).toEqual([
      ["get_mandate", { mandate_id: 9 }],
      ["get_spend", { spend_id: 4 }],
    ]);
  });

  it("reads the config and the agent list without arguments", async () => {
    const { rpc, calls } = viewRpc((_c, method) => (method === "get_config" ? { owner: "o" } : []));
    const vault = new VaultClient(VAULT, rpc);
    expect(await vault.getConfig()).toEqual({ owner: "o" });
    expect(await vault.listAgents()).toEqual([]);
    expect(calls.map((c) => [c.method, c.args])).toEqual([
      ["get_config", {}],
      ["list_agents", {}],
    ]);
  });
});

describe("VaultClient change calls", () => {
  it("sends spend with the agent sender, 200 Tgas and no deposit", async () => {
    const { rpc } = viewRpc(() => null);
    const { sender, sent } = fakeSender(okOutcome({ spend_id: 1, status: "paid" }));
    const vault = new VaultClient(VAULT, rpc, { agent: sender });
    const r = await vault.spend(request);
    expect(r.result).toEqual({ spend_id: 1, status: "paid" });
    expect(r.tx.ok).toBe(true);
    expect(sent[0]).toEqual({
      receiverId: VAULT,
      methodName: "spend",
      args: { request },
      gas: SPEND_GAS,
      deposit: 0n,
    });
    expect(SPEND_GAS).toBe(200n * TGAS);
  });

  it("refuses to spend without an agent key", async () => {
    const { rpc } = viewRpc(() => null);
    const vault = new VaultClient("v.testnet", rpc);
    expect(vault.canSpend).toBe(false);
    await expect(vault.spend(request)).rejects.toThrow(ConfigError);
  });

  it("sends anchor with the ledger sender, 30 Tgas and no deposit", async () => {
    const { rpc } = viewRpc(() => null);
    const { sender, sent } = fakeSender(okOutcome(null));
    const vault = new VaultClient(VAULT, rpc, { ledger: sender });
    expect(vault.canAnchor).toBe(true);
    expect(vault.canSpend).toBe(false);
    const tx = await vault.anchor(2, ROOT, 3);
    expect(tx.ok).toBe(true);
    expect(sent[0]).toEqual({
      receiverId: VAULT,
      methodName: "anchor",
      args: { seq: 2, root: ROOT, count: 3 },
      gas: ANCHOR_GAS,
      deposit: 0n,
    });
    expect(ANCHOR_GAS).toBe(30n * TGAS);
  });

  it("throws ContractError when anchoring fails", async () => {
    const { rpc } = viewRpc(() => null);
    const { sender } = fakeSender({
      txHash: "T",
      ok: false,
      value: null,
      code: "BadSeq",
      failure: "BadSeq",
      raw: null,
    });
    const vault = new VaultClient(VAULT, rpc, { ledger: sender });
    const error = await vault.anchor(2, ROOT, 3).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).vaultCode).toBe("BadSeq");
    expect((error as ContractError).txHash).toBe("T");
  });

  it("explains an out-of-NEAR anchor failure instead of hiding it", async () => {
    const { rpc } = viewRpc(() => null);
    const { sender } = fakeSender({
      txHash: null,
      ok: false,
      value: null,
      code: "LackBalanceForState",
      failure: "vault is out of free NEAR; top up with a plain transfer (x)",
      raw: null,
    });
    const error = await new VaultClient(VAULT, rpc, { ledger: sender })
      .anchor(1, ROOT, 1)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).vaultCode).toBeNull();
    expect((error as ContractError).message).toContain("out of free NEAR");
  });

  it("refuses to anchor without a ledger key", async () => {
    const { rpc } = viewRpc(() => null);
    await expect(new VaultClient(VAULT, rpc).anchor(1, ROOT, 1)).rejects.toThrow(ConfigError);
  });

  it("refuses anchor arguments the contract would refuse, before spending gas", async () => {
    const { rpc } = viewRpc(() => null);
    const { sender, sent } = fakeSender(okOutcome(null));
    const vault = new VaultClient(VAULT, rpc, { ledger: sender });
    await expect(vault.anchor(0, ROOT, 1)).rejects.toThrow(ConfigError);
    await expect(vault.anchor(1, ROOT, 0)).rejects.toThrow(ConfigError);
    await expect(vault.anchor(1.5, ROOT, 1)).rejects.toThrow(ConfigError);
    await expect(vault.anchor(1, ROOT.toUpperCase(), 1)).rejects.toThrow(ConfigError);
    await expect(vault.anchor(1, ROOT.slice(1), 1)).rejects.toThrow(ConfigError);
    expect(sent).toHaveLength(0);
  });

  it("refuses a sender that signs as another account than the vault", async () => {
    const { rpc } = viewRpc(() => null);
    const { sender, sent } = fakeSender(okOutcome(null));
    const vault = new VaultClient("other.vaults.probarion.testnet", rpc, {
      agent: sender,
      ledger: sender,
    });
    await expect(vault.spend(request)).rejects.toThrow(/agent key signs as .* but this vault is/);
    await expect(vault.anchor(1, ROOT, 1)).rejects.toThrow(
      /ledger key signs as .* but this vault is/,
    );
    await expect(vault.spend(request)).rejects.toThrow(ConfigError);
    expect(sent).toHaveLength(0);
  });

  it("pageAll stops on an empty first page", async () => {
    expect(await pageAll(async () => [] as number[])).toEqual([]);
  });

  it("isSpendResult accepts only the contract's result shape", () => {
    expect(isSpendResult({ spend_id: 1, status: "held" })).toBe(true);
    expect(isSpendResult({ spend_id: 1, status: "mystery" })).toBe(false);
    expect(isSpendResult({ spend_id: "1", status: "paid" })).toBe(false);
    expect(isSpendResult(null)).toBe(false);
  });
});

/** A finished transaction whose first receipt is the spend call and whose second is its callback. */
const finished = (spendStatus: unknown, callbackStatus: unknown, status: unknown) => ({
  status,
  transaction: { hash: "SpendTx" },
  transaction_outcome: {
    id: "SpendTx",
    outcome: { receipt_ids: ["r1"], status: { SuccessReceiptId: "r1" } },
  },
  receipts_outcome: [
    { id: "r1", outcome: { status: spendStatus } },
    { id: "r2", outcome: { status: callbackStatus } },
  ],
});
const failure = (message: string) => ({
  Failure: {
    ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: message } } },
  },
});
const lackBalance = {
  Failure: {
    ActionError: {
      index: null,
      kind: { LackBalanceForState: { account_id: VAULT, amount: "1" } },
    },
  },
};
const spendWith = async (outcome: TxOutcome) => {
  const { rpc } = viewRpc(() => null);
  const { sender } = fakeSender(outcome);
  return new VaultClient(VAULT, rpc, { agent: sender }).spend(request);
};

describe("VaultClient.spend verdict", () => {
  it.each(["paid", "burned", "held"])("%s is ok", async (status) => {
    const r = await spendWith(okOutcome({ spend_id: 1, status }));
    expect(r).toMatchObject({ ok: true, unconfirmed: null, result: { spend_id: 1, status } });
  });

  it.each(["failed", "rejected", "expired"])(
    "%s is not ok, although the transaction succeeded, and is not unconfirmed",
    async (status) => {
      const r = await spendWith(okOutcome({ spend_id: 1, status }));
      expect(r.tx.ok).toBe(true);
      expect(r).toMatchObject({ ok: false, unconfirmed: null, result: { spend_id: 1, status } });
    },
  );

  it("pending is not ok, and unconfirmed: the payout is still in flight", async () => {
    const r = await spendWith(okOutcome({ spend_id: 1, status: "pending" }));
    expect(r.ok).toBe(false);
    expect(r.result).toEqual({ spend_id: 1, status: "pending" });
    expect(r.unconfirmed?.kind).toBe("pending");
  });

  it.each([
    ["a string", "paid"],
    ["null", null],
    ["a wrong shape", { spend_id: "1", status: "paid" }],
    ["an unknown status", { spend_id: 1, status: "mystery" }],
  ])("an unreadable value (%s) is unconfirmed, never failed", async (_name, value) => {
    const r = await spendWith(okOutcome(value));
    expect(r.tx.ok).toBe(true);
    expect(r).toMatchObject({ ok: false, result: null });
    expect(r.unconfirmed?.kind).toBe("unreadable_value");
    expect(r.unconfirmed?.reason).toContain("not a spend result");
  });

  it("a refusal by the contract (the spend receipt failed) is a definite failure", async () => {
    const f = failure("Smart contract panicked: PROBARION:NoMandate");
    const r = await spendWith(parseTxOutcome(finished(f, "Unknown", f)));
    expect(r.tx.code).toBe("NoMandate");
    expect(r).toMatchObject({ ok: false, result: null, unconfirmed: null });
  });

  it("a refusal before execution (no raw result) is a definite failure", async () => {
    const r = await spendWith({
      txHash: null,
      ok: false,
      value: null,
      code: "NotEnoughBalance",
      failure: "x",
      raw: null,
    });
    expect(r).toMatchObject({ ok: false, result: null, unconfirmed: null });
  });

  it("a callback that failed after the spend receipt ran is unconfirmed: the payout may have gone out", async () => {
    const f = failure("Smart contract panicked: something in the callback");
    const out = parseTxOutcome(finished({ SuccessReceiptId: "r2" }, f, f));
    expect(out.ok).toBe(false);
    const r = await spendWith(out);
    expect(r).toMatchObject({ ok: false, result: null });
    expect(r.unconfirmed?.kind).toBe("callback_failed");
    expect(r.unconfirmed?.reason).toContain("payout may have gone out");
  });

  it("an out-of-NEAR failure in the callback is unconfirmed too (its state was rolled back)", async () => {
    const out = parseTxOutcome(finished({ SuccessReceiptId: "r2" }, lackBalance, lackBalance));
    expect(out.code).toBe("LackBalanceForState");
    expect((await spendWith(out)).unconfirmed?.kind).toBe("callback_failed");
  });

  it("a failed result that cannot say which receipt failed is unconfirmed, not failed", async () => {
    const out = parseTxOutcome({
      status: failure("Smart contract panicked: x"),
      transaction: { hash: "T" },
      receipts_outcome: [],
    });
    expect((await spendWith(out)).unconfirmed?.kind).toBe("callback_failed");
  });

  it("lets a TxOutcomeUnknownError through, with its hash", async () => {
    const { rpc } = viewRpc(() => null);
    const sender: TxSender = {
      accountId: VAULT,
      publicKey: "ed25519:Agent",
      functionCall: async () => {
        throw new TxOutcomeUnknownError("unknown", "HASH", VAULT);
      },
    };
    const error = await new VaultClient(VAULT, rpc, { agent: sender })
      .spend(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TxOutcomeUnknownError);
    expect((error as TxOutcomeUnknownError).txHash).toBe("HASH");
  });
});

describe("VaultClient.resolveSpend (recovering an unknown outcome)", () => {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

  const resolveWith = async (found: TxOutcome) => {
    const { rpc } = viewRpc(() => null);
    const { sender, looked, sent } = fakeSender(okOutcome(null), () => found);
    const result = await new VaultClient(VAULT, rpc, { agent: sender }).resolveSpend("Recovered");
    expect(looked).toEqual(["Recovered"]);
    expect(sent).toHaveLength(0); // recovery never sends anything
    return result;
  };

  it.each(["paid", "burned", "held"])("a recovered %s spend is ok", async (status) => {
    expect(await resolveWith(okOutcome({ spend_id: 1, status }))).toMatchObject({
      ok: true,
      unconfirmed: null,
    });
  });

  it.each(["failed", "rejected", "expired"])(
    "a recovered %s spend is ok:false although the transaction succeeded",
    async (status) => {
      const r = await resolveWith(okOutcome({ spend_id: 1, status }));
      expect(r.tx.ok).toBe(true);
      expect(r).toMatchObject({ ok: false, unconfirmed: null, result: { spend_id: 1, status } });
    },
  );

  it("a recovered pending spend or unreadable value is unconfirmed, never failed", async () => {
    const pending = await resolveWith(okOutcome({ spend_id: 1, status: "pending" }));
    expect(pending.unconfirmed?.kind).toBe("pending");
    const garbage = await resolveWith(okOutcome("???"));
    expect(garbage.unconfirmed?.kind).toBe("unreadable_value");
  });

  it("a recovered callback failure is unconfirmed; a recovered contract refusal is definite", async () => {
    const callback = failure("Smart contract panicked: in the callback");
    const late = parseTxOutcome(finished({ SuccessReceiptId: "r2" }, callback, callback));
    expect((await resolveWith(late)).unconfirmed?.kind).toBe("callback_failed");
    const refusal = failure("Smart contract panicked: PROBARION:NoMandate");
    const refused = parseTxOutcome(finished(refusal, "Unknown", refusal));
    expect(await resolveWith(refused)).toMatchObject({ ok: false, unconfirmed: null });
  });

  it("a lookup that is still unknown propagates TxOutcomeUnknownError with the hash", async () => {
    const { rpc } = viewRpc(() => null);
    const { sender } = fakeSender(okOutcome(null), (txHash) => {
      throw new TxOutcomeUnknownError("the node cannot say yet", txHash, VAULT);
    });
    const error = await new VaultClient(VAULT, rpc, { agent: sender })
      .resolveSpend("StillUnknown")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TxOutcomeUnknownError);
    expect((error as TxOutcomeUnknownError).txHash).toBe("StillUnknown");
  });

  it("needs an agent sender that can look a transaction up, and that signs as the vault", async () => {
    const { rpc } = viewRpc(() => null);
    await expect(new VaultClient(VAULT, rpc).resolveSpend("H")).rejects.toThrow(ConfigError);
    const noLookup = fakeSender(okOutcome(null)).sender;
    await expect(
      new VaultClient(VAULT, rpc, { agent: noLookup }).resolveSpend("H"),
    ).rejects.toThrow(/no lookup/);
    const { sender, looked } = fakeSender(okOutcome(null), () => okOutcome(null));
    await expect(
      new VaultClient("other.vaults.probarion.testnet", rpc, { agent: sender }).resolveSpend("H"),
    ).rejects.toThrow(/agent key signs as/);
    expect(looked).toEqual([]);
  });

  describe("end to end with the real sender", () => {
    const agentKey = generateKeyPair(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    const make = (status: () => unknown) => {
      const fake = fakeProvider({
        send: () => {
          throw new TypeError("fetch failed");
        },
        status,
      });
      const sender = new NearApiJsSender({
        accountId: VAULT,
        secretKey: agentKey.secretKey,
        rpcUrl: "https://rpc.test",
        createProvider: () => fake.provider,
      });
      const { rpc } = viewRpc(() => null);
      return { vault: new VaultClient(VAULT, rpc, { agent: sender }), fake };
    };

    it("a lost answer, then a recovered failed payout, gives ok:false for that hash", async () => {
      const { vault, fake } = make(() => ({
        status: { SuccessValue: b64({ spend_id: 1, status: "failed" }) },
      }));
      const error = await vault.spend(request).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TxOutcomeUnknownError);
      const hash = (error as TxOutcomeUnknownError).txHash;
      const resolved = await vault.resolveSpend(hash);
      expect(resolved).toMatchObject({ ok: false, unconfirmed: null, tx: { txHash: hash } });
      expect(resolved.result).toEqual({ spend_id: 1, status: "failed" });
      expect(fake.statusCalls).toEqual([{ txHash: hash, accountId: VAULT, waitUntil: "FINAL" }]);
    });

    it("a lost answer, then a lookup that still cannot say, keeps the same hash", async () => {
      const { vault } = make(() => {
        throw new Error("fetch failed again");
      });
      const first = (await vault.spend(request).catch((e: unknown) => e)) as TxOutcomeUnknownError;
      const second = (await vault
        .resolveSpend(first.txHash)
        .catch((e: unknown) => e)) as TxOutcomeUnknownError;
      expect(second).toBeInstanceOf(TxOutcomeUnknownError);
      expect(second.txHash).toBe(first.txHash);
    });
  });
});

describe("pageAll walks that cannot be trusted", () => {
  const source = { contractId: "v.testnet", methodName: "list_mandates" };

  it("throws within a few calls when the node keeps returning the same full page", async () => {
    let calls = 0;
    const stuck = async (_from: number, limit: number) => {
      calls += 1;
      return Array.from({ length: limit }, (_, i) => ({ id: i }));
    };
    const error = await pageAll(stuck, 50, source).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViewError);
    expect((error as ViewError).message).toContain("v.testnet.list_mandates");
    expect((error as ViewError).message).toContain("repeats");
    expect(calls).toBe(2);
  });

  it("throws when a page is longer than asked for", async () => {
    const error = await pageAll(async () => [1, 2, 3], 2, source).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViewError);
    expect((error as ViewError).message).toContain("at most 2");
  });

  it("throws when a page is not a list", async () => {
    const error = await pageAll(async () => null as unknown as number[], 2, source).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ViewError);
  });

  it("throws after the page cap, with distinct pages forever", async () => {
    let calls = 0;
    const endless = async (from: number) => {
      calls += 1;
      return [from];
    };
    const error = await pageAll(endless, 1, source).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViewError);
    expect((error as ViewError).message).toContain(`more than ${MAX_PAGES} pages`);
    expect(calls).toBe(MAX_PAGES);
    expect(MAX_PAGES).toBe(1000);
  });

  it("still reads a legitimate walk, including one that ends on an exact multiple", async () => {
    const all = Array.from({ length: 100 }, (_, id) => ({ id }));
    const got = await pageAll(async (from, limit) => all.slice(from, from + limit), 50, source);
    expect(got).toHaveLength(100);
  });

  it("does not take two different pages that share an end for a repeat", async () => {
    const pages = [[{ id: 1 }, { id: 2 }], [{ id: 1 }, { id: 3 }], [{ id: 4 }]];
    let n = 0;
    const got = await pageAll(async () => pages[n++] ?? [], 2, source);
    expect(got).toHaveLength(5);
  });
});

// R18. Every change call the vault client builds, pinned to docs/runbooks/testnet.md section 5
// (and, for anchor, to the ruling that gives the ledger key the same 30 Tgas as the owner's calls).
describe("gas and deposit table", () => {
  const cases: {
    method: string;
    gasTgas: number;
    deposit: bigint;
    signer: "agent" | "ledger";
    run: (vault: VaultClient) => Promise<unknown>;
  }[] = [
    {
      method: "spend",
      gasTgas: 200,
      deposit: 0n,
      signer: "agent",
      run: (vault) => vault.spend(request),
    },
    {
      method: "anchor",
      gasTgas: 30,
      deposit: 0n,
      signer: "ledger",
      run: (vault) => vault.anchor(1, ROOT, 1),
    },
  ];

  it.each(cases)("$method attaches $gasTgas Tgas and no deposit", async (c) => {
    const { rpc } = viewRpc(() => null);
    const { sender, sent } = fakeSender(okOutcome({ spend_id: 1, status: "paid" }));
    const vault = new VaultClient(
      VAULT,
      rpc,
      c.signer === "agent" ? { agent: sender } : { ledger: sender },
    );
    await c.run(vault);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.methodName).toBe(c.method);
    expect(sent[0]?.receiverId).toBe(VAULT);
    expect(sent[0]?.gas).toBe(BigInt(c.gasTgas) * TGAS);
    expect(sent[0]?.deposit).toBe(c.deposit);
  });

  it("agrees with the runbook table for every row whose method the client builds", () => {
    const runbook = fileURLToPath(new URL("../../../docs/runbooks/testnet.md", import.meta.url));
    const text = readFileSync(runbook, "utf8");
    const section = text.split(/^## 5\. Gas and deposits$/m)[1]?.split(/^## 6\./m)[0] ?? "";
    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("|") && /Tgas/.test(line))
      .map((line) => {
        const cells = line.split("|").map((cell) => cell.trim());
        return {
          methods: [...(cells[1] ?? "").matchAll(/`([a-z_]+)`/g)].map((m) => m[1] ?? ""),
          signer: cells[2] ?? "",
          deposit: cells[3] ?? "",
          gas: cells[4] ?? "",
        };
      });
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const built = new Map(cases.map((c) => [c.method, c]));
    let checked = 0;
    for (const row of rows) {
      const tgas = /'(\d+) Tgas'/.exec(row.gas)?.[1];
      for (const method of row.methods) {
        const c = built.get(method);
        if (c === undefined) continue;
        checked += 1;
        expect(`${method}: ${tgas} Tgas`).toBe(`${method}: ${c.gasTgas} Tgas`);
        expect(row.signer).toContain(`the ${c.signer} key`);
        expect(row.deposit).toContain(c.deposit === 0n ? "0 NEAR" : "yocto");
      }
    }
    // Both change calls the vault client builds have a row: spend (agent key), anchor (ledger key).
    expect(checked).toBe(2);
  });
});

describe("IntentsClient and FactoryClient", () => {
  it("calls the intents views with the vault account", async () => {
    const { rpc, calls } = viewRpc((_c, method) => {
      if (method === "public_keys_of") return [];
      if (method === "is_auth_by_predecessor_id_enabled") return true;
      return "40000000";
    });
    const intents = new IntentsClient("intents.near", rpc);
    expect(await intents.publicKeysOf("acme.vaults.probarion.near")).toEqual([]);
    expect(await intents.isAuthByPredecessorIdEnabled("acme.vaults.probarion.near")).toBe(true);
    expect(await intents.poaBalance("acme.vaults.probarion.near", "base-0xabc.omft.near")).toBe(
      40_000_000n,
    );
    expect(calls[0]).toMatchObject({
      contract: "intents.near",
      method: "public_keys_of",
      args: { account_id: "acme.vaults.probarion.near" },
    });
    expect(calls[1]).toMatchObject({
      method: "is_auth_by_predecessor_id_enabled",
      args: { account_id: "acme.vaults.probarion.near" },
    });
    expect(calls[2]).toMatchObject({
      contract: "intents.near",
      method: "mt_balance_of",
      args: {
        account_id: "acme.vaults.probarion.near",
        token_id: "nep141:base-0xabc.omft.near",
      },
    });
  });

  it("reads keys, a missing key list and a missing balance defensively", async () => {
    const { rpc } = viewRpc((_c, method) => {
      if (method === "public_keys_of") return ["ed25519:K"];
      return null;
    });
    const intents = new IntentsClient("intents.near", rpc);
    expect(await intents.publicKeysOf("a.near")).toEqual(["ed25519:K"]);
    expect(await intents.poaBalance("a.near", "x.near")).toBe(0n);
    expect(await intents.isAuthByPredecessorIdEnabled("a.near")).toBe(false);
  });

  it("refuses an intents answer that is not what the verifier returns", async () => {
    const { rpc } = viewRpc((_c, method) => (method === "public_keys_of" ? "oops" : "12x"));
    const intents = new IntentsClient("intents.near", rpc);
    await expect(intents.publicKeysOf("a.near")).rejects.toThrow(ViewError);
    await expect(intents.poaBalance("a.near", "x.near")).rejects.toThrow(ViewError);
  });

  it("reads factory versions and a vault's version (1-based, R14)", async () => {
    const { rpc, calls } = viewRpc((_c, method) =>
      method === "versions"
        ? [{ index: 1, code_hash: "H", mode: "global", notes: "", at_ns: "0" }]
        : 1,
    );
    const factory = new FactoryClient("vaults.probarion.near", rpc);
    const versions = await factory.versions();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.index).toBe(1);
    expect(await factory.vaultVersion("acme.vaults.probarion.near")).toBe(1);
    expect(calls[1]).toMatchObject({
      method: "vault_version",
      args: { account_id: "acme.vaults.probarion.near" },
    });
  });

  it("returns null for a vault the factory did not create", async () => {
    const { rpc } = viewRpc(() => null);
    expect(await new FactoryClient("f.near", rpc).vaultVersion("x.near")).toBeNull();
  });

  it("passes a factory version of 0 through, so the verifier's check i can fail it", async () => {
    const { rpc } = viewRpc(() => 0);
    expect(await new FactoryClient("f.near", rpc).vaultVersion("x.near")).toBe(0);
  });

  it("reads the factory config and a capped page of vaults", async () => {
    const { rpc, calls } = viewRpc((_c, method) =>
      method === "get_config" ? { owner: "o", current_version: 1 } : [],
    );
    const factory = new FactoryClient("f.near", rpc);
    expect(await factory.getConfig()).toEqual({ owner: "o", current_version: 1 });
    expect(await factory.listVaults(5, 1000)).toEqual([]);
    expect(calls[0]).toMatchObject({ contract: "f.near", method: "get_config", args: {} });
    expect(calls[1]).toMatchObject({
      contract: "f.near",
      method: "list_vaults",
      args: { from_index: 5, limit: 100 },
    });
    await expect(factory.listVaults(-1, 10)).rejects.toThrow(ConfigError);
  });
});
