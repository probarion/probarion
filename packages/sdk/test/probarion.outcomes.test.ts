// The money path's outcome model (task-13 carries C2, C3): every SpendOutcomeStatus, the sender errors, the
// never-retry rule for unknown outcomes, the by-ref lookup after DuplicateRef/DuplicateInvoice, dedupe of a
// double call, and anchoring that fails and is retried.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAttestations,
  computeNonce,
  createEd25519Signer,
  type Snapshot,
  type SpendRequest,
  type SpendView,
  sha256Hex,
} from "@probarion/core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  ProbarionError,
  TxOutcomeUnknownError,
  TxRejectedError,
} from "../src/errors.js";
import {
  FileLedgerStore,
  InMemoryLedgerStore,
  LedgerConflictError,
  type LedgerStore,
} from "../src/ledger-store.js";
import type { SpendOutcome } from "../src/probarion.js";
import {
  createScenarioChain,
  type FakeRpcServer,
  SCENARIO_NEAR_PAYEE,
  SCENARIO_NOW,
  SCENARIO_VAULT,
  startFakeRpcServer,
  TEST_KEYS,
} from "../src/testing/index.js";
import {
  type FunctionCallTx,
  OUT_OF_GAS_NEAR_DETAIL,
  OUT_OF_NEAR_DETAIL,
  type TxOutcome,
} from "../src/tx.js";
import {
  baseInvoice,
  FailingLedgerStore,
  nearInvoice,
  nonceContextOf,
  scriptedSender,
  setup,
  spendTxs,
} from "./support/probarion-harness.js";

let server: FakeRpcServer;

beforeEach(async () => {
  server = await startFakeRpcServer(createScenarioChain());
});

afterEach(async () => {
  await server.close();
});

const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function tempLedgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "probarion-race-"));
  tempDirs.push(dir);
  return join(dir, "ledger.jsonl");
}

const failedTx = (fields: Partial<TxOutcome>): TxOutcome => ({
  txHash: null,
  ok: false,
  value: null,
  code: null,
  failure: null,
  raw: null,
  ...fields,
});

const INVOICE = () => nearInvoice("Invoice INV-1: 25.00 USDC for PO-1001", "INV-1");

describe("spend outcomes", () => {
  it("failed: a payout that fails is released, and a retry writes a new decision and nonce (C3)", async () => {
    server.chain.hooks.payoutFailure = "ft_transfer_failed";
    const { pb, ledger } = setup(server);
    const first = await pb.process(INVOICE());
    expect(first).toMatchObject({ status: "failed", spendId: 1, code: "failed", ledgerSeq: 1 });
    expect(typeof first.txHash).toBe("string");
    expect(server.chain.spends[0]?.status).toBe("failed");
    expect((await ledger.all())[1]?.body.contract).toEqual({
      code: null,
      tx_hash: first.txHash,
      spend_id: 1,
      status: "failed",
    });

    server.chain.hooks.payoutFailure = null;
    // The ref is consumed forever, even by a failed spend.
    const sameRef = await pb.process(INVOICE());
    expect(sameRef).toMatchObject({ status: "refused_by_code", code: "invoice.duplicate" });
    // A released spend frees its invoice: the same invoice under a new ref is a new decision.
    const retry = await pb.process({ ...INVOICE(), ref: "INV-1-retry" });
    expect(retry).toMatchObject({ status: "paid", spendId: 2 });
    const entries = await ledger.all();
    const decisions = entries.filter((e) => e.body.kind === "decision");
    expect(decisions).toHaveLength(3);
    expect(new Set(decisions.map((d) => d.body_hash)).size).toBe(3);
    expect(new Set(decisions.map((d) => d.body.evidence?.nonce)).size).toBe(3);
    expect(retry.decisionHash).not.toBe(first.decisionHash);
    expect(server.chain.spends.map((s) => s.decision_hash)).toEqual([
      first.decisionHash,
      retry.decisionHash,
    ]);
    const retryDecision = decisions[2];
    if (retryDecision === undefined) throw new Error("retry decision missing");
    expect(retryDecision.body.evidence?.nonce).toBe(computeNonce(nonceContextOf(retryDecision)));
  });

  it("settled is never claimed at spend time: a burn is burned, with no settlement tx yet", async () => {
    const { pb, ledger } = setup(server);
    const out = await pb.process(baseInvoice("Invoice B-1: 25.00 USDC for PO-2002", "B-1"));
    expect(out.status).toBe("burned");
    expect(out.status).not.toBe("settled");
    expect((await ledger.all())[1]?.body.settlement).toMatchObject({ tx_hash: null });
  });

  const unknownCases: {
    name: string;
    answer: () => Promise<TxOutcome>;
    txHash: string | null;
    spendId: number | null;
    code: string;
  }[] = [
    {
      name: "a TxOutcomeUnknownError",
      answer: () =>
        Promise.reject(
          new TxOutcomeUnknownError("TEST DOUBLE: the answer was lost", "LOST-TX", SCENARIO_VAULT),
        ),
      txHash: "LOST-TX",
      spendId: null,
      code: "TxOutcomeUnknown",
    },
    {
      name: "a payout still pending",
      answer: async () => ({
        ...failedTx({ txHash: "PENDING-TX" }),
        ok: true,
        value: { spend_id: 7, status: "pending" },
      }),
      txHash: "PENDING-TX",
      spendId: 7,
      code: "pending",
    },
    {
      name: "an unreadable return value",
      answer: async () => ({ ...failedTx({ txHash: "ODD-TX" }), ok: true, value: "not a spend" }),
      txHash: "ODD-TX",
      spendId: null,
      code: "unreadable_value",
    },
    {
      name: "a failed callback after the payout",
      answer: async () =>
        failedTx({
          txHash: "CB-TX",
          failure: "TEST DOUBLE: the callback failed",
          raw: {
            transaction_outcome: { outcome: { receipt_ids: ["r1"] } },
            receipts_outcome: [{ id: "r1", outcome: { status: { SuccessReceiptId: "r2" } } }],
          },
        }),
      txHash: "CB-TX",
      spendId: null,
      code: "callback_failed",
    },
    {
      name: "an error from a sender this SDK does not know",
      answer: () => Promise.reject(new Error("TEST DOUBLE: socket hang up")),
      txHash: null,
      spendId: null,
      code: "TxOutcomeUnknown",
    },
  ];

  it.each(unknownCases)(
    "unconfirmed: $name is recorded as unknown and never sent again",
    async ({ answer, txHash, spendId, code }) => {
      let calls: unknown[] = [];
      const { pb, ledger, warnings } = setup(server, {
        agentSender: (real) => {
          const scripted = scriptedSender(real, answer);
          calls = scripted.calls;
          return scripted.sender;
        },
      });
      const out = await pb.process(INVOICE());
      expect(out).toMatchObject({ status: "unconfirmed", txHash, spendId, code, ledgerSeq: 1 });
      expect(calls).toHaveLength(1);
      const payment = (await ledger.all())[1];
      expect(payment?.body.contract).toMatchObject({
        tx_hash: txHash,
        spend_id: spendId,
        status: "unknown",
      });
      expect(payment?.body.refs).toEqual({ decision_body_hash: out.decisionHash });
      expect(warnings.join(" ")).toMatch(/never send it again/i);
      // The anchor still covers the unknown entry.
      expect(server.chain.anchors.at(-1)).toMatchObject({ count: 2 });
      expect(typeof out.anchorTxHash).toBe("string");
    },
  );

  const definite: {
    name: string;
    answer: () => Promise<TxOutcome>;
    code: string;
    txHash: string | null;
    warning: RegExp | null;
  }[] = [
    {
      name: "TxRejectedError NotEnoughAllowance",
      answer: () =>
        Promise.reject(
          new TxRejectedError(
            "spend transaction refused by the node before it ran (nothing changed): NotEnoughAllowance: the agent key's allowance is used up; the owner must re-add the key with a new allowance (remove_agent, then add_agent).",
            "NotEnoughAllowance",
          ),
        ),
      code: "NotEnoughAllowance",
      txHash: null,
      warning: /re-add the key/,
    },
    {
      name: "TxSendFailed",
      answer: () =>
        Promise.reject(
          new ProbarionError(
            "spend transaction could not be sent (nothing was sent): TEST DOUBLE",
            "TxSendFailed",
          ),
        ),
      code: "TxSendFailed",
      txHash: null,
      warning: /nothing was sent/,
    },
    {
      name: "LackBalanceForState",
      answer: async () =>
        failedTx({ txHash: "LB-TX", code: "LackBalanceForState", failure: OUT_OF_NEAR_DETAIL }),
      code: "LackBalanceForState",
      txHash: "LB-TX",
      warning: /top up/,
    },
    {
      name: "NotEnoughBalance",
      answer: async () => failedTx({ code: "NotEnoughBalance", failure: OUT_OF_GAS_NEAR_DETAIL }),
      code: "NotEnoughBalance",
      txHash: null,
      warning: /top up/,
    },
    {
      name: "a definite failure without a code",
      answer: async () => failedTx({ txHash: "GAS-TX", failure: "Exceeded the prepaid gas." }),
      code: "TxFailed",
      txHash: "GAS-TX",
      warning: null,
    },
  ];

  it.each(definite)(
    "failed: $name is a definite failure",
    async ({ answer, code, txHash, warning }) => {
      const { pb, ledger, warnings } = setup(server, {
        agentSender: (real) => scriptedSender(real, answer).sender,
      });
      const out = await pb.process(INVOICE());
      expect(out).toMatchObject({ status: "failed", code, txHash, spendId: null, ledgerSeq: 1 });
      const payment = (await ledger.all())[1];
      expect(payment?.body.contract).toEqual({
        code,
        tx_hash: txHash,
        spend_id: null,
        status: "failed",
      });
      expect(payment?.body.rules).toEqual([
        expect.objectContaining({ id: "contract.check_failed", outcome: "refuse" }),
      ]);
      if (warning !== null) expect(warnings.join(" ")).toMatch(warning);
    },
  );
});

describe("DuplicateRef / DuplicateInvoice: look the spend up by ref (C2 d, T13-R1 items 1 and 8)", () => {
  /** Puts a spend for `request` on the fake chain, as the first copy of a re-signed spend would have. */
  function landCopy(request: SpendRequest, status: SpendView["status"], ref = request.ref): number {
    const id = server.chain.spends.length + 1;
    server.chain.spends.push({
      id,
      mandate_id: request.mandate_id,
      amount: request.amount,
      invoice_hash: request.invoice_hash,
      ref,
      decision_hash: request.decision_hash,
      agent_pk: TEST_KEYS.agent.publicKey,
      destination: { type: "near", account_id: SCENARIO_NEAR_PAYEE },
      status,
      created_at_ns: SCENARIO_NOW.toString(),
      held_until_ns: null,
      memo: null,
    });
    return id;
  }

  const duplicate = (code: "DuplicateRef" | "DuplicateInvoice", txHash = "DUP-TX") =>
    failedTx({ txHash, code, failure: `PROBARION:${code}` });

  const requestOf = (tx: FunctionCallTx) => tx.args.request as SpendRequest;

  it("DuplicateInvoice on a re-signed copy of our own spend is that paid spend", async () => {
    let answered: string | null = null;
    const { pb, ledger } = setup(server, {
      agentSender: (real) => ({
        accountId: real.accountId,
        publicKey: real.publicKey,
        // The InvalidNonce re-sign corner: the first copy landed, its answer was lost, and the copy
        // signed again with a fresh nonce is refused because the first one already holds the invoice.
        functionCall: async (tx) => {
          await real.functionCall(tx);
          const second = await real.functionCall(tx);
          answered = second.txHash;
          return second;
        },
      }),
    });
    const out = await pb.process(INVOICE());
    expect(out).toMatchObject({ status: "paid", spendId: 1, code: null, txHash: null });
    expect(server.chain.spends).toHaveLength(1);
    expect(spendTxs(server)).toHaveLength(2);
    const payment = (await ledger.all())[1];
    // Item 8: a success records no contract code; the duplicate answer goes into a rule detail.
    expect(payment?.body.contract).toEqual({
      code: null,
      tx_hash: answered,
      spend_id: 1,
      status: "paid",
    });
    expect(payment?.body.rules).toEqual([
      {
        id: "invoice.duplicate",
        outcome: "pass",
        detail: expect.stringContaining("PROBARION:DuplicateInvoice"),
      },
    ]);
  });

  it("DuplicateRef on our own first send is our spend; a burn found this way has no burn tx hash", async () => {
    const { pb, ledger } = setup(server, {
      agentSender: (real) =>
        scriptedSender(real, async (tx) => {
          await real.functionCall(tx);
          return duplicate("DuplicateRef", "RESIGNED-TX");
        }).sender,
    });
    const out = await pb.process(baseInvoice("Invoice B-1: 25.00 USDC for PO-2002", "B-1"));
    expect(out).toMatchObject({ status: "burned", spendId: 1, txHash: null, code: null });
    const payment = (await ledger.all())[1];
    expect(payment?.body.contract).toEqual({
      code: null,
      tx_hash: "RESIGNED-TX",
      spend_id: 1,
      status: "burned",
    });
    expect(payment?.body.rules[0]?.detail).toContain("PROBARION:DuplicateRef");
    expect(payment?.body.settlement).toEqual({ chain: "base", tx_hash: null, burn_tx_hash: null });
  });

  it("a pending spend of ours found by ref is unconfirmed", async () => {
    let id = 0;
    const { pb, ledger } = setup(server, {
      agentSender: (real) =>
        scriptedSender(real, async (tx) => {
          id = landCopy(requestOf(tx), "pending");
          return duplicate("DuplicateInvoice");
        }).sender,
    });
    const out = await pb.process(INVOICE());
    expect(out).toMatchObject({ status: "unconfirmed", spendId: id, code: "pending" });
    expect((await ledger.all())[1]?.body.contract).toEqual({
      code: "DuplicateInvoice",
      tx_hash: "DUP-TX",
      spend_id: id,
      status: "unknown",
    });
  });

  it("a released spend of ours found by ref is failed", async () => {
    let id = 0;
    const { pb, ledger } = setup(server, {
      agentSender: (real) =>
        scriptedSender(real, async (tx) => {
          id = landCopy(requestOf(tx), "failed");
          return duplicate("DuplicateRef");
        }).sender,
    });
    const out = await pb.process(INVOICE());
    expect(out).toMatchObject({ status: "failed", spendId: id, code: "failed", txHash: null });
    expect((await ledger.all())[1]?.body.contract).toEqual({
      code: "DuplicateRef",
      tx_hash: "DUP-TX",
      spend_id: id,
      status: "failed",
    });
  });

  it.each(["DuplicateRef", "DuplicateInvoice"] as const)(
    "%s with nothing holding it (the RPC is a block behind) is unconfirmed, not a refusal",
    async (code) => {
      const { pb, ledger } = setup(server, {
        agentSender: (real) => scriptedSender(real, async () => duplicate(code)).sender,
      });
      const out = await pb.process(INVOICE());
      expect(out).toMatchObject({ status: "unconfirmed", code, txHash: "DUP-TX", spendId: null });
      expect((await ledger.all())[1]?.body.contract).toEqual({
        code,
        tx_hash: "DUP-TX",
        spend_id: null,
        status: "unknown",
      });
    },
  );

  it("the contract's own DuplicateRef panic with nothing holding the ref is unconfirmed too", async () => {
    server.chain.hooks.spendPanic = "DuplicateRef";
    const { pb } = setup(server);
    const out = await pb.process(INVOICE());
    expect(out).toMatchObject({ status: "unconfirmed", code: "DuplicateRef" });
    expect(spendTxs(server)).toEqual([out.txHash]);
  });

  it("DuplicateInvoice whose only holder is released is unconfirmed (a released spend frees its invoice)", async () => {
    const { pb } = setup(server, {
      agentSender: (real) =>
        scriptedSender(real, async (tx) => {
          const other = { ...requestOf(tx), decision_hash: "ee".repeat(32) };
          landCopy(other, "failed", "OTHER-REF");
          return duplicate("DuplicateInvoice");
        }).sender,
    });
    expect(await pb.process(INVOICE())).toMatchObject({
      status: "unconfirmed",
      code: "DuplicateInvoice",
    });
  });

  it("DuplicateRef held by another decision's spend is the contract's refusal", async () => {
    const { pb, ledger } = setup(server, {
      agentSender: (real) =>
        scriptedSender(real, async (tx) => {
          // Another writer's spend uses the same ref for another invoice.
          const other = {
            ...requestOf(tx),
            decision_hash: "ee".repeat(32),
            invoice_hash: "dd".repeat(32),
          };
          landCopy(other, "paid");
          return duplicate("DuplicateRef");
        }).sender,
    });
    const out = await pb.process(INVOICE());
    expect(out).toMatchObject({
      status: "refused_by_contract",
      code: "DuplicateRef",
      txHash: "DUP-TX",
    });
    expect((await ledger.all())[1]?.body.contract).toEqual({
      code: "DuplicateRef",
      tx_hash: "DUP-TX",
      spend_id: null,
      status: "refused",
    });
  });

  it("DuplicateInvoice held live by another decision's spend is the contract's refusal", async () => {
    const { pb } = setup(server, {
      agentSender: (real) =>
        scriptedSender(real, async (tx) => {
          landCopy({ ...requestOf(tx), decision_hash: "ee".repeat(32) }, "held", "OTHER-REF");
          return duplicate("DuplicateInvoice");
        }).sender,
    });
    expect(await pb.process(INVOICE())).toMatchObject({
      status: "refused_by_contract",
      code: "DuplicateInvoice",
    });
  });

  it("stays unconfirmed when the spend cannot be looked up by ref", async () => {
    const { pb, ledger } = setup(server, {
      agentSender: (real) =>
        scriptedSender(real, async () => {
          server.failNext([503, 503, 503]); // the by-ref lookup that follows gets no answer
          return duplicate("DuplicateRef");
        }).sender,
    });
    const out = await pb.process(INVOICE());
    expect(out).toMatchObject({ status: "unconfirmed", code: "DuplicateRef", txHash: "DUP-TX" });
    expect((await ledger.all())[1]?.body.contract).toMatchObject({
      status: "unknown",
      code: "DuplicateRef",
    });
  });
});

describe("dedupe of a double call (C3)", () => {
  const paid = (outs: SpendOutcome[]) => outs.filter((o) => o.status === "paid");

  it("in one instance the second identical call is refused by code: one payment", async () => {
    const { pb } = setup(server);
    const outs = [await pb.process(INVOICE()), await pb.process(INVOICE())];
    expect(outs.map((o) => o.status)).toEqual(["paid", "refused_by_code"]);
    expect(outs[1]?.code).toBe("invoice.duplicate");
    expect(server.chain.spends).toHaveLength(1);
  });

  /** Two writers race: B read the chain before A paid, then B's spend goes out after A's. */
  async function race(requestId: string | undefined): Promise<SpendOutcome[]> {
    let reached = () => {};
    const atSender = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release = () => {};
    const aDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = setup(server, { model: false, requestId });
    const b = setup(server, {
      model: false,
      requestId,
      agentSender: (real) => ({
        accountId: real.accountId,
        publicKey: real.publicKey,
        functionCall: async (tx) => {
          reached();
          await aDone;
          return real.functionCall(tx);
        },
      }),
    });
    const bOut = b.pb.process(INVOICE());
    await atSender;
    const aOut = await a.pb.process(INVOICE());
    release();
    return [aOut, await bOut];
  }

  it("across instances with different decisions the loser is refused by the contract", async () => {
    const [a, b] = await race(undefined);
    expect(a).toMatchObject({ status: "paid", spendId: 1 });
    expect(b).toMatchObject({
      status: "refused_by_contract",
      code: "DuplicateInvoice",
      spendId: null,
    });
    expect(server.chain.spends).toHaveLength(1);
  });

  it("identical decisions see the same spend: one payment, deduped by spend id", async () => {
    const outs = await race("req-same");
    expect(outs.map((o) => o.status)).toEqual(["paid", "paid"]);
    expect(outs[0]?.decisionHash).toBe(outs[1]?.decisionHash);
    expect(new Set(paid(outs).map((o) => o.spendId))).toEqual(new Set([1]));
    expect(server.chain.spends).toHaveLength(1);
  });
});

describe("anchoring", () => {
  it("logs a failed anchor and anchors the whole tail on the next cycle", async () => {
    const { pb, ledger, warnings } = setup(server, {
      ledgerSender: (real) =>
        scriptedSender(real, async (tx, n) =>
          n === 1
            ? failedTx({ txHash: "ANCHOR-LOST", failure: "TEST DOUBLE: dropped" })
            : real.functionCall(tx),
        ).sender,
    });
    const first = await pb.process(INVOICE());
    expect(first).toMatchObject({ status: "paid", anchorTxHash: null });
    expect(server.chain.anchors).toEqual([]);
    expect(warnings.join(" ")).toContain("anchoring failed");

    const second = await pb.process(nearInvoice("Invoice INV-2 for PO-1001", "INV-2"));
    expect(second.status).toBe("paid");
    const entries = await ledger.all();
    expect(server.chain.anchors).toEqual([
      expect.objectContaining({ seq: 1, count: 4, root: entries[3]?.link }),
    ]);
    expect(server.chain.txs.has(second.anchorTxHash ?? "")).toBe(true);
  });

  it("re-reads the anchors after BadSeq (another writer anchored) and anchors next", async () => {
    const { pb, ledger } = setup(server);
    await pb.process(INVOICE());
    const entries = await ledger.all();
    server.chain.anchors.push({
      seq: 2,
      root: entries[1]?.link ?? "",
      count: 2,
      at_ns: "1",
      ledger_key: TEST_KEYS.ledger.publicKey,
    });
    const out = await pb.process(nearInvoice("Invoice INV-2 for PO-1001", "INV-2"));
    expect(server.chain.anchors.at(-1)).toMatchObject({ seq: 3, count: 4 });
    expect(typeof out.anchorTxHash).toBe("string");
  });

  it("after BadSeq, a chain anchored past this ledger is the fork warning, not an anchor", async () => {
    const { pb, ledger, warnings } = setup(server);
    await pb.process(INVOICE());
    const entries = await ledger.all();
    server.chain.anchors.push({
      seq: 2,
      root: entries[1]?.link ?? "",
      count: 10, // another writer's ledger, longer than this one
      at_ns: "1",
      ledger_key: TEST_KEYS.ledger.publicKey,
    });
    const out = await pb.process(nearInvoice("Invoice INV-2 for PO-1001", "INV-2"));
    expect(out.anchorTxHash).toBeNull();
    expect(server.chain.anchors).toHaveLength(2);
    expect(warnings.join(" ")).toMatch(
      /covers 10 entries but this ledger holds 4.*LEDGER_FORK_RISK/,
    );
  });
});

describe("ledger safety", () => {
  it("a payment entry that cannot be written does not hide a spend that went through (ledgerComplete: false)", async () => {
    const { pb, warnings } = setup(server, { ledger: new FailingLedgerStore(2) });
    const out = await pb.process(INVOICE());
    expect(out).toMatchObject({ status: "paid", spendId: 1, ledgerSeq: 0, ledgerComplete: false });
    expect(warnings.join(" ")).toMatch(/payment entry could not be written/);
  });

  it("a complete cycle carries no ledgerComplete field", async () => {
    const { pb } = setup(server);
    expect("ledgerComplete" in (await pb.process(INVOICE()))).toBe(false);
  });

  it("warns as one structured JSON line on console.warn when no logger is given", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { pb } = setup(server, { ledger: new FailingLedgerStore(2), consoleLogger: true });
      expect((await pb.process(INVOICE())).ledgerComplete).toBe(false);
      const lines = spy.mock.calls.map(
        (call) => JSON.parse(String(call[0])) as Record<string, unknown>,
      );
      expect(lines).toContainEqual(
        expect.objectContaining({
          level: "warn",
          source: "@probarion/sdk",
          vault: SCENARIO_VAULT,
          message: expect.stringContaining("payment entry could not be written"),
        }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to write entries the vault's ledger key would not cover", async () => {
    server.chain.config.ledger_key = TEST_KEYS.other.publicKey;
    const ledger = new InMemoryLedgerStore();
    const { pb } = setup(server, { ledger });
    await expect(pb.process(INVOICE())).rejects.toThrow(ConfigError);
    expect(await ledger.all()).toEqual([]);
    expect(spendTxs(server)).toEqual([]);
  });

  it("a lost compare-and-append race writes nothing and sends nothing", async () => {
    const ledger = new InMemoryLedgerStore();
    const { pb: other } = setup(server, { model: false, ledger });
    let first = true;
    const racing: LedgerStore = {
      head: () => ledger.head(),
      // Another writer appends right after this cycle read the ledger.
      all: async () => {
        const entries = await ledger.all();
        if (first) {
          first = false;
          await other.process(nearInvoice("Invoice INV-9 for PO-1001", "INV-9"));
        }
        return entries;
      },
      append: (body, sign, opts) => ledger.append(body, sign, opts),
    };
    const { pb } = setup(server, { model: false, ledger: racing });
    const error = await pb.process(INVOICE()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LedgerConflictError);
    expect(String((error as Error).message)).toMatch(
      /ledger moved since this decision was attested; retry/,
    );
    expect((await ledger.all()).map((e) => e.body.invoice_hash)).toEqual([
      sha256Hex("Invoice INV-9 for PO-1001"),
      sha256Hex("Invoice INV-9 for PO-1001"),
    ]);
    expect(server.chain.spends.map((s) => s.ref)).toEqual(["INV-9"]);
  });

  it("a store that ignores expect is caught after the append: no spend is sent", async () => {
    const ledger = new InMemoryLedgerStore();
    const { pb: other } = setup(server, { model: false, ledger });
    let raced = false;
    const ignoring: LedgerStore = {
      head: () => ledger.head(),
      all: () => ledger.all(),
      append: async (body, sign) => {
        if (!raced) {
          raced = true;
          await other.process(nearInvoice("Invoice INV-9 for PO-1001", "INV-9"));
        }
        return ledger.append(body, sign); // drops `expect`, as a store written before it existed would
      },
    };
    const { pb } = setup(server, { model: false, ledger: ignoring });
    await expect(pb.process(INVOICE())).rejects.toThrow(/did not compare-and-append/);
    expect(server.chain.spends.map((s) => s.ref)).toEqual(["INV-9"]);
    expect((await ledger.all()).map((e) => e.body.seq)).toEqual([0, 1, 2]);
  });

  it("two model-enabled writers on one ledger file: the loser leaves no entry and check e passes", async () => {
    const path = await tempLedgerPath();
    const a = setup(server, { ledger: new FileLedgerStore(path) });
    const fileB = new FileLedgerStore(path);
    let raced = false;
    const racingB: LedgerStore = {
      head: () => fileB.head(),
      all: () => fileB.all(),
      append: async (body, sign, opts) => {
        if (!raced) {
          raced = true;
          // A wins the file lock: its whole cycle lands while B's attested decision waits.
          await a.pb.process(nearInvoice("Invoice INV-A for PO-1001", "INV-A"));
        }
        return fileB.append(body, sign, opts);
      },
    };
    const b = setup(server, { ledger: racingB });
    await expect(
      b.pb.process(nearInvoice("Invoice INV-B for PO-1001", "INV-B")),
    ).rejects.toBeInstanceOf(LedgerConflictError);
    expect(b.nearai.calls.some((c) => c.method === "POST")).toBe(true); // B's decision was attested

    const entries = await new FileLedgerStore(path).all();
    expect(entries.map((e) => [e.body.seq, e.body.kind])).toEqual([
      [0, "decision"],
      [1, "payment"],
    ]);
    expect(
      entries.every((e) => e.body.invoice_hash === sha256Hex("Invoice INV-A for PO-1001")),
    ).toBe(true);
    const decision = entries[0];
    if (decision === undefined || decision.body.evidence === null) throw new Error("no evidence");
    expect(decision.body.evidence.nonce).toBe(computeNonce(nonceContextOf(decision)));
    const checkE = await checkAttestations({
      vault: SCENARIO_VAULT,
      ledger: entries,
    } as unknown as Snapshot);
    expect(checkE).toMatchObject({ id: "e", status: "pass" });
    expect(checkE.detail).toMatch(/^1 attested decisions pass/);
    expect(server.chain.spends.map((s) => s.ref)).toEqual(["INV-A"]);
  });
});

describe("unknown outcomes block the same invoice until resolved (T13-R1 items 5 and 6)", () => {
  const lost = () =>
    new TxOutcomeUnknownError("TEST DOUBLE: the answer was lost", "LOST-TX", SCENARIO_VAULT);

  it("a lost tx that actually landed: the same invoice is then refused by the chain's state, never sent again", async () => {
    let calls: unknown[] = [];
    const { pb } = setup(server, {
      agentSender: (real) => {
        const scripted = scriptedSender(real, async (tx, n) => {
          if (n > 1) return real.functionCall(tx);
          const landed = await real.functionCall(tx);
          throw new TxOutcomeUnknownError(
            "TEST DOUBLE: lost after landing",
            landed.txHash ?? "",
            SCENARIO_VAULT,
          );
        });
        calls = scripted.calls;
        return scripted.sender;
      },
    });
    const first = await pb.process(INVOICE());
    expect(first).toMatchObject({ status: "unconfirmed", code: "TxOutcomeUnknown" });
    expect(server.chain.spends).toMatchObject([
      { status: "paid", decision_hash: first.decisionHash },
    ]);
    for (const ref of ["INV-1", "INV-1-again"]) {
      const again = await pb.process({ ...INVOICE(), ref });
      expect(again).toMatchObject({ status: "refused_by_code", code: "invoice.duplicate" });
    }
    expect(calls).toHaveLength(1);
    expect(server.chain.spends).toHaveLength(1);
  });

  it("an unknown payment that never landed refuses the same invoice by code until the chain shows it", async () => {
    let calls: unknown[] = [];
    const { pb, ledger, nearai } = setup(server, {
      agentSender: (real) => {
        const scripted = scriptedSender(real, (tx, n) =>
          n === 1 ? Promise.reject(lost()) : real.functionCall(tx),
        );
        calls = scripted.calls;
        return scripted.sender;
      },
    });
    const first = await pb.process(INVOICE());
    expect(first.status).toBe("unconfirmed");
    const chats = () => nearai.calls.filter((c) => c.method === "POST").length;
    expect(chats()).toBe(1);

    const viaProcess = await pb.process({ ...INVOICE(), ref: "INV-1-b" });
    expect(viaProcess).toMatchObject({ status: "refused_by_code", code: "invoice.duplicate" });
    const decision = (await ledger.all()).at(-1);
    expect(decision?.body.rules.find((r) => r.outcome === "refuse")?.detail).toMatch(
      /unknown outcome .*tx LOST-TX.*resolve it first/,
    );
    expect(chats()).toBe(1); // no model tokens for a cycle that is refused anyway

    const spend = { mandateId: 1, amount: "25000000", invoiceHash: INVOICE().facts.invoice_hash };
    for (const extra of [{ ref: "INV-1-c" }, { ref: "INV-1-d", skipPreflight: true }]) {
      const out = await pb.requestSpend({ ...spend, ...extra });
      expect(out).toMatchObject({ status: "refused_by_code", code: "invoice.duplicate" });
    }
    expect(calls).toHaveLength(1);

    // Another invoice is not blocked.
    expect((await pb.process(nearInvoice("Invoice INV-2 for PO-1001", "INV-2"))).status).toBe(
      "paid",
    );
    // Once the chain shows the first spend (here: released), the invoice is decided from the chain again.
    server.chain.spends.push({
      ...(server.chain.spends[0] as SpendView),
      id: 2,
      ref: "INV-1",
      invoice_hash: INVOICE().facts.invoice_hash,
      decision_hash: first.decisionHash,
      status: "failed",
    });
    expect((await pb.process({ ...INVOICE(), ref: "INV-1-e" })).status).toBe("paid");
  });

  it("a later payment entry of the same decision with a known status resolves the unknown one", async () => {
    const ledger = new InMemoryLedgerStore();
    const { pb } = setup(server, {
      ledger,
      agentSender: (real) =>
        scriptedSender(real, (tx, n) => (n === 1 ? Promise.reject(lost()) : real.functionCall(tx)))
          .sender,
    });
    expect((await pb.process(INVOICE())).status).toBe("unconfirmed");
    const unknown = (await ledger.all())[1];
    if (unknown === undefined || unknown.body.contract === null)
      throw new Error("no payment entry");
    // What a resolver writes once it learns the transaction never ran.
    await ledger.append(
      {
        v: 1,
        vault: unknown.body.vault,
        kind: "payment",
        at: unknown.body.at,
        request_id: unknown.body.request_id,
        mandate_id: unknown.body.mandate_id,
        invoice_hash: unknown.body.invoice_hash,
        amount: unknown.body.amount,
        proposal: null,
        evidence: null,
        rules: [],
        verdict: null,
        decided_by: null,
        contract: { ...unknown.body.contract, status: "failed" },
        settlement: null,
        refs: unknown.body.refs,
      },
      createEd25519Signer(TEST_KEYS.ledger.secretKey),
    );
    expect((await pb.process({ ...INVOICE(), ref: "INV-1-r" })).status).toBe("paid");
  });

  it("a ConfigError at spend time leaves the decision written, no payment entry and nothing anchored", async () => {
    const { pb, ledger } = setup(server, {
      agentSender: (real) =>
        scriptedSender(real, () => Promise.reject(new ConfigError("TEST DOUBLE: no key"))).sender,
    });
    await expect(pb.process(INVOICE())).rejects.toThrow(ConfigError);
    expect((await ledger.all()).map((e) => e.body.kind)).toEqual(["decision"]);
    expect(server.chain.anchors).toEqual([]);
    expect(spendTxs(server)).toEqual([]);
  });
});

describe("model step at write time", () => {
  it("keeps the model's token usage but decides rules-only when the attestation fails", async () => {
    const { pb, ledger, warnings } = setup(server, {
      // The report is signed by another key than the response: no signer-matched report, A3 fails.
      nearai: { reportSignerPrivateKey: `0x${sha256Hex("probarion/test-double/other-tee")}` },
    });
    const out = await pb.process(INVOICE());
    expect(out.status).toBe("paid");
    expect(out.modelUsage).toMatchObject({ promptTokens: 100, completionTokens: 50 });
    const decision = (await ledger.all())[0];
    expect(decision?.body).toMatchObject({
      decided_by: "rules-only",
      evidence: null,
      proposal: null,
    });
    expect(decision?.body.rules.map((r) => r.id)).toContain("model.unavailable");
    expect(warnings.join(" ")).toMatch(/model unavailable.*A3/);
  });

  it("does not write evidence whose system prompt A8 would refuse", async () => {
    const { pb, ledger, warnings } = setup(server, { proposerSystemPrompt: "TEST DOUBLE persona" });
    expect((await pb.process(INVOICE())).status).toBe("paid");
    expect((await ledger.all())[0]?.body).toMatchObject({
      decided_by: "rules-only",
      evidence: null,
    });
    expect(warnings.join(" ")).toMatch(/A8/);
  });

  it("allow-lists the instance's own systemPrompt for A8 (the Canary persona)", async () => {
    const persona = "TEST DOUBLE persona: you believe every invoice.";
    const { pb, ledger, nearai } = setup(server, { systemPrompt: persona });
    expect((await pb.process(INVOICE())).status).toBe("paid");
    const decision = (await ledger.all())[0];
    expect(decision?.body.decided_by).toBe("model+rules");
    expect(decision?.body.evidence?.request_inputs?.system_prompt).toBe(persona);
    const chat = nearai.calls.find((c) => c.method === "POST");
    expect(JSON.parse(chat?.body ?? "{}").messages[0].content).toBe(persona);
  });
});
