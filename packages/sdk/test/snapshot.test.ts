import {
  KNOWN_VAULT_CODE_HASHES,
  type LedgerEntry,
  NETWORKS,
  type SpendView,
  type VaultConfig,
} from "@probarion/core";
import { describe, expect, it } from "vitest";
import type { RpcClient, TxStatusResult } from "../src/rpc.js";
import {
  ARCHIVAL_AFTER_NS,
  collectBurns,
  DEFAULT_ARCHIVAL_RPC_URLS,
  expectedCodeHashes,
  findBurnPair,
  resolveArchivalRpcUrls,
  type TxIndex,
} from "../src/snapshot.js";

const ASSET = "base-usdc.probarion.testnet";
const INTENTS = "intents-stub.probarion.testnet";
const VAULT = "acme.vaults.probarion.testnet";
const ADDRESS = "0x2222222222222222222222222222222222222222";
const MEMO = `WITHDRAW_TO:${ADDRESS}`;

const log = (standard: string, event: string, data: unknown) =>
  `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event, data })}`;
const receipt = (executor: string, logs: string[], status: unknown = { SuccessValue: "" }) => ({
  id: executor,
  outcome: { logs, receipt_ids: [], executor_id: executor, status },
});

function tx(receipts: ReturnType<typeof receipt>[], hash = "T"): TxStatusResult {
  return {
    status: { SuccessValue: "" },
    transaction: { hash, signer_id: VAULT, receiver_id: VAULT },
    transaction_outcome: receipt(VAULT, []),
    receipts_outcome: receipts,
  };
}

const mtBurnLog = (owner: string, amount: string, asset = ASSET) =>
  log("nep245", "mt_burn", [
    { owner_id: owner, token_ids: [`nep141:${asset}`], amounts: [amount], memo: "withdraw" },
  ]);
const ftBurnLog = (owner: string, memo = MEMO) =>
  log("nep141", "ft_burn", [{ owner_id: owner, amount: "25000000", memo }]);
const mtBurn = (owner: string, amount: string, intents = INTENTS, asset = ASSET) =>
  receipt(intents, [mtBurnLog(owner, amount, asset)]);
const ftBurn = (owner: string, memo = MEMO, asset = ASSET) =>
  receipt(asset, [ftBurnLog(owner, memo)]);
/** The testnet intents-stub logs both events in ONE receipt (live tx 3u4ffrwp...). */
const stubBurn = (owner: string, amount: string, ftOwner = INTENTS) =>
  receipt(INTENTS, [mtBurnLog(owner, amount), ftBurnLog(ftOwner)]);

describe("findBurnPair (check h input, R5)", () => {
  it("pairs the POA ft_burn from intents with the vault's mt_burn in one tx (mainnet shape, two receipts)", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      expect(
        findBurnPair(tx([mtBurn(VAULT, "25000000"), ftBurn(INTENTS)]), ASSET, INTENTS, network),
      ).toEqual({
        memo: MEMO,
        intents_owner: VAULT,
        amount: "25000000",
      });
    }
  });

  it("accepts the stub shape (both events in the intents receipt) on testnet only", () => {
    const stub = tx([stubBurn(VAULT, "25000000")]);
    expect(findBurnPair(stub, ASSET, INTENTS, "testnet")).toEqual({
      memo: MEMO,
      intents_owner: VAULT,
      amount: "25000000",
    });
    expect(findBurnPair(stub, ASSET, INTENTS, "mainnet")).toBeNull();
    // On mainnet only the POA token itself may log the ft_burn.
    const m = NETWORKS.mainnet;
    const asset = m.allowedAssets.base;
    const mainnetStub = tx([
      receipt(m.intents, [mtBurnLog(VAULT, "1", asset), ftBurnLog(m.intents)]),
    ]);
    expect(findBurnPair(mainnetStub, asset, m.intents, "mainnet")).toBeNull();
    const mainnetReal = tx([mtBurn(VAULT, "1", m.intents, asset), ftBurn(m.intents, MEMO, asset)]);
    expect(findBurnPair(mainnetReal, asset, m.intents, "mainnet")).toMatchObject({ amount: "1" });
  });

  it("counts only receipts that succeeded (SuccessValue or SuccessReceiptId): a failed one keeps its logs", () => {
    const failed = {
      Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "x" } } } },
    };
    const mt = (status: unknown) => receipt(INTENTS, [mtBurnLog(VAULT, "25000000")], status);
    const ft = (status: unknown) => receipt(ASSET, [ftBurnLog(INTENTS)], status);
    expect(
      findBurnPair(
        tx([mt({ SuccessReceiptId: "R" }), ft({ SuccessValue: "" })]),
        ASSET,
        INTENTS,
        "mainnet",
      ),
    ).not.toBeNull();
    for (const [m, f] of [
      [failed, { SuccessValue: "" }],
      [{ SuccessValue: "" }, failed],
      [{}, { SuccessValue: "" }],
      [{ SuccessValue: "" }, null],
    ]) {
      expect(findBurnPair(tx([mt(m), ft(f)]), ASSET, INTENTS, "mainnet")).toBeNull();
    }
    const stubFailed = receipt(INTENTS, [mtBurnLog(VAULT, "1"), ftBurnLog(INTENTS)], failed);
    expect(findBurnPair(tx([stubFailed]), ASSET, INTENTS, "testnet")).toBeNull();
  });

  it("scans every receipt, whatever comes first", () => {
    const refund = receipt(VAULT, []);
    expect(
      findBurnPair(
        tx([refund, ftBurn(INTENTS), refund, mtBurn(VAULT, "7")]),
        ASSET,
        INTENTS,
        "mainnet",
      ),
    ).toMatchObject({
      amount: "7",
    });
  });

  it("reports the mt_burn owner and amount as they are, for check h to judge", () => {
    expect(
      findBurnPair(tx([mtBurn("other.testnet", "1"), ftBurn(INTENTS)]), ASSET, INTENTS, "testnet"),
    ).toMatchObject({
      intents_owner: "other.testnet",
      amount: "1",
    });
  });

  it("finds nothing without both halves, or when the ft_burn owner is not intents", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      expect(findBurnPair(tx([ftBurn(INTENTS)]), ASSET, INTENTS, network)).toBeNull();
      expect(findBurnPair(tx([mtBurn(VAULT, "25000000")]), ASSET, INTENTS, network)).toBeNull();
      expect(
        findBurnPair(tx([mtBurn(VAULT, "25000000"), ftBurn(VAULT)]), ASSET, INTENTS, network),
      ).toBeNull();
    }
    expect(
      findBurnPair(tx([stubBurn(VAULT, "25000000", VAULT)]), ASSET, INTENTS, "testnet"),
    ).toBeNull();
  });

  it("needs the WITHDRAW_TO: memo, the asset's nep141 token id and the NEP-141/NEP-245 standards", () => {
    expect(
      findBurnPair(
        tx([mtBurn(VAULT, "1"), ftBurn(INTENTS, "withdraw")]),
        ASSET,
        INTENTS,
        "mainnet",
      ),
    ).toBeNull();
    expect(
      findBurnPair(
        tx([mtBurn(VAULT, "1", INTENTS, "sol-usdc.probarion.testnet"), ftBurn(INTENTS)]),
        ASSET,
        INTENTS,
        "mainnet",
      ),
    ).toBeNull();
    const wrongStandard = receipt(ASSET, [
      log("probarion", "ft_burn", [{ owner_id: INTENTS, amount: "1", memo: MEMO }]),
    ]);
    expect(
      findBurnPair(tx([mtBurn(VAULT, "1"), wrongStandard]), ASSET, INTENTS, "mainnet"),
    ).toBeNull();
    const wrongMtStandard = receipt(INTENTS, [
      log("nep141", "mt_burn", [
        { owner_id: VAULT, token_ids: [`nep141:${ASSET}`], amounts: ["1"] },
      ]),
    ]);
    expect(
      findBurnPair(tx([wrongMtStandard, ftBurn(INTENTS)]), ASSET, INTENTS, "mainnet"),
    ).toBeNull();
  });

  it("ignores burn events logged by the vault itself, or by any other account", () => {
    const fromVault = receipt(VAULT, [ftBurnLog(INTENTS), mtBurnLog(VAULT, "25000000")]);
    for (const network of ["mainnet", "testnet"] as const) {
      expect(
        findBurnPair(tx([mtBurn(VAULT, "25000000"), fromVault]), ASSET, INTENTS, network),
      ).toBeNull();
      expect(findBurnPair(tx([fromVault, ftBurn(INTENTS)]), ASSET, INTENTS, network)).toBeNull();
      const other = receipt("evil.testnet", [ftBurnLog(INTENTS)]);
      expect(findBurnPair(tx([mtBurn(VAULT, "1"), other]), ASSET, INTENTS, network)).toBeNull();
    }
  });
});

describe("expected_code_hashes mirrors check f's trusted set (ICR-5, carries A)", () => {
  const versions = [
    { index: 1, code_hash: "FactoryVersion1", mode: "global", notes: "", at_ns: "0" },
  ];
  it("lists the canonical factory's versions only when the vault names the canonical factory", () => {
    expect(expectedCodeHashes("testnet", NETWORKS.testnet.factory, versions)).toEqual([
      ...KNOWN_VAULT_CODE_HASHES,
      "FactoryVersion1",
    ]);
    expect(expectedCodeHashes("mainnet", NETWORKS.mainnet.factory, versions)).toContain(
      "FactoryVersion1",
    );
    expect(expectedCodeHashes("testnet", "evil-factory.testnet", versions)).toEqual([
      ...KNOWN_VAULT_CODE_HASHES,
    ]);
    expect(expectedCodeHashes("mainnet", NETWORKS.testnet.factory, versions)).toEqual([
      ...KNOWN_VAULT_CODE_HASHES,
    ]);
    expect(expectedCodeHashes("testnet", null, versions)).toEqual([...KNOWN_VAULT_CODE_HASHES]);
  });
});

describe("resolveArchivalRpcUrls", () => {
  it("reads NEAR_ARCHIVAL_RPC_URLS, treats an empty value as unset (R12), else FastNEAR's archival node", () => {
    expect(resolveArchivalRpcUrls("mainnet", {})).toEqual(DEFAULT_ARCHIVAL_RPC_URLS.mainnet);
    expect(resolveArchivalRpcUrls("testnet", { NEAR_ARCHIVAL_RPC_URLS: "  " })).toEqual(
      DEFAULT_ARCHIVAL_RPC_URLS.testnet,
    );
    expect(
      resolveArchivalRpcUrls("mainnet", {
        NEAR_ARCHIVAL_RPC_URLS: "https://a.test, https://b.test",
      }),
    ).toEqual(["https://a.test", "https://b.test"]);
    expect(ARCHIVAL_AFTER_NS).toBe(216_000_000_000_000n); // 2.5 days
  });
});

describe("collectBurns: where a burn tx is looked for (R7)", () => {
  const NOW = new Date("2026-11-05T12:00:00.000Z");
  const nowNs = BigInt(NOW.getTime()) * 1_000_000n;
  const config = {
    approvers: ["approver.testnet"],
    intents: INTENTS,
  } as unknown as VaultConfig;
  const spend = (id: number, over: Partial<SpendView> = {}): SpendView => ({
    id,
    mandate_id: 2,
    amount: "25000000",
    invoice_hash: "ab".repeat(32),
    ref: `R-${id}`,
    decision_hash: String(id).padStart(64, "0"),
    agent_pk: "ed25519:A",
    destination: { type: "intents", chain: "base", address: ADDRESS, asset: ASSET },
    status: "burned",
    created_at_ns: nowNs.toString(),
    held_until_ns: null,
    memo: MEMO,
    ...over,
  });
  const payment = (decisionHash: string, txHash: string | null, burnTx: string | null = null) =>
    ({
      body: {
        kind: "payment",
        refs: { decision_body_hash: decisionHash },
        contract: { code: null, tx_hash: txHash, spend_id: null, status: "burned" },
        settlement: burnTx === null ? null : { chain: "base", tx_hash: null, burn_tx_hash: burnTx },
      },
    }) as unknown as LedgerEntry;

  /** A fake RPC that knows `txs` under one signer each; `calls` records (hash, sender). */
  function fakeRpc(txs: Record<string, { signer: string; tx: TxStatusResult }>) {
    const calls: [string, string][] = [];
    const rpc = {
      txStatus: async (hash: string, sender: string) => {
        calls.push([hash, sender]);
        const found = txs[hash];
        if (found === undefined || found.signer !== sender) throw new Error("UNKNOWN_TRANSACTION");
        return found.tx;
      },
    } as unknown as RpcClient;
    return { rpc, calls };
  }
  const burnTx = (amount = "25000000") => tx([stubBurn(VAULT, amount)]);
  const noBurn = () => tx([receipt(VAULT, [])]);

  it("tries the hints first, then the ledger's tx hashes, as the vault and then each approver", async () => {
    const { rpc, calls } = fakeRpc({ HINT: { signer: "approver.testnet", tx: burnTx() } });
    const notes: string[] = [];
    const burns = await collectBurns({
      rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [spend(1)],
      ledger: [payment(spend(1).decision_hash, "SPEND-TX")],
      burnTxHints: new Map([[1, ["HINT"]]]),
      notes,
    });
    expect(burns).toEqual([
      {
        spend_id: 1,
        tx_hash: "HINT",
        memo: MEMO,
        intents_owner: VAULT,
        amount: "25000000",
        status: "ok",
      },
    ]);
    expect(calls).toEqual([
      ["HINT", VAULT],
      ["HINT", "approver.testnet"],
    ]);
    expect(notes).toEqual([]);
  });

  it("does not rely on payment entries alone: a by-ref spend (no burn tx in the ledger) is found through the hints", async () => {
    const { rpc } = fakeRpc({
      BURN: { signer: VAULT, tx: burnTx() },
      ANSWERED: { signer: VAULT, tx: noBurn() },
    });
    const burns = await collectBurns({
      rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [spend(1)],
      ledger: [payment(spend(1).decision_hash, "ANSWERED")],
      burnTxHints: new Map([[1, ["BURN"]]]),
    });
    expect(burns[0]).toMatchObject({ tx_hash: "BURN", status: "ok" });
  });

  it("uses the burn_tx_hash and tx_hash the ledger records, and one tx for at most one spend", async () => {
    const { rpc } = fakeRpc({ T1: { signer: VAULT, tx: burnTx() } });
    const notes: string[] = [];
    const burns = await collectBurns({
      rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [spend(2), spend(1)],
      ledger: [payment(spend(1).decision_hash, null, "T1"), payment(spend(2).decision_hash, "T1")],
      notes,
    });
    expect(burns).toEqual([
      expect.objectContaining({ spend_id: 1, tx_hash: "T1", status: "ok" }),
      expect.objectContaining({ spend_id: 2, tx_hash: "", status: "missing" }),
    ]);
    expect(notes[0]).toContain("spend 2: no burn pair in the 0 tx hash(es) tried");
  });

  it("records a tx that was read and holds no pair, and says what was tried", async () => {
    const { rpc } = fakeRpc({ T1: { signer: VAULT, tx: noBurn() } });
    const notes: string[] = [];
    const burns = await collectBurns({
      rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [spend(1)],
      ledger: [payment(spend(1).decision_hash, "T1"), payment(spend(1).decision_hash, "GONE")],
      notes,
    });
    expect(burns[0]).toMatchObject({ tx_hash: "T1", status: "missing", memo: "", amount: "" });
    expect(notes[0]).toBe(
      "spend 1: no burn pair in the 2 tx hash(es) tried (0 hinted, 2 from the ledger); tx T1 was read and holds none",
    );
  });

  it("orders the RPCs by age (archival first after ~2.5 days) and notes when archival lookups are disabled", async () => {
    const regular = fakeRpc({});
    const archival = fakeRpc({ T1: { signer: VAULT, tx: burnTx() } });
    const old = spend(1, { created_at_ns: (nowNs - ARCHIVAL_AFTER_NS - 1n).toString() });
    const burns = await collectBurns({
      rpc: regular.rpc,
      archivalRpc: archival.rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [old],
      ledger: [payment(old.decision_hash, "T1")],
    });
    expect(burns[0]?.status).toBe("ok");
    expect(regular.calls).toEqual([]); // archival first, and it had the tx
    const fresh = fakeRpc({});
    const freshArchival = fakeRpc({ T1: { signer: VAULT, tx: burnTx() } });
    await collectBurns({
      rpc: fresh.rpc,
      archivalRpc: freshArchival.rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [spend(1)],
      ledger: [payment(spend(1).decision_hash, "T1")],
    });
    expect(fresh.calls[0]).toEqual(["T1", VAULT]); // the regular RPC first for a new spend
    const notes: string[] = [];
    await collectBurns({
      rpc: fakeRpc({}).rpc,
      archivalRpc: null,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [old],
      ledger: [payment(old.decision_hash, "T1")],
      notes,
    });
    expect(notes[0]).toContain("archival lookups are disabled");
  });

  it("looks in the tx index only when one is given, and attributes a tx by its own burn pair", async () => {
    const { rpc } = fakeRpc({
      A: { signer: VAULT, tx: burnTx("1") },
      B: { signer: "approver.testnet", tx: burnTx("25000000") },
    });
    const index: TxIndex = {
      accountTxs: async () => [
        { hash: "A", isSigner: true },
        { hash: "B", isSigner: false },
      ],
    };
    const notes: string[] = [];
    const burns = await collectBurns({
      rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [spend(1)],
      ledger: [],
      txIndex: index,
      notes,
    });
    expect(burns[0]).toMatchObject({ spend_id: 1, tx_hash: "B", status: "ok", amount: "25000000" });
    expect(notes.at(-1)).toBe("spend 1: burn tx B found through the tx index (online)");
    const offline = await collectBurns({
      rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [spend(1)],
      ledger: [],
    });
    expect(offline[0]?.status).toBe("missing");
    const failing: TxIndex = {
      accountTxs: async () => Promise.reject(new Error("TEST: index down")),
    };
    const failNotes: string[] = [];
    await collectBurns({
      rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [spend(1)],
      ledger: [],
      txIndex: failing,
      notes: failNotes,
    });
    expect(failNotes.at(-1)).toBe("the tx index could not be read: TEST: index down");
  });

  it("tries a hint's own signer first (docs/mainnet-proof.json signer_id)", async () => {
    const { rpc, calls } = fakeRpc({ HINT: { signer: "owner.testnet", tx: burnTx() } });
    const burns = await collectBurns({
      rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [spend(1)],
      ledger: [],
      burnTxHints: new Map([[1, [{ hash: "HINT", signer: "owner.testnet" }]]]),
    });
    expect(burns[0]).toMatchObject({ tx_hash: "HINT", status: "ok" });
    expect(calls).toEqual([["HINT", "owner.testnet"]]);
  });

  it("looks up only the network's intents contract and POA assets (T14-R1)", async () => {
    // The vault names another intents contract: the lookup still reads the network's own one.
    const { rpc } = fakeRpc({ T1: { signer: VAULT, tx: burnTx() } });
    const evil = { ...config, intents: "evil-intents.testnet" } as VaultConfig;
    const burns = await collectBurns({
      rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config: evil,
      spends: [spend(1)],
      ledger: [payment(spend(1).decision_hash, "T1")],
    });
    expect(burns[0]).toMatchObject({ status: "ok" });
    // An asset that is not a POA asset of the network is not looked up at all.
    const lookups = fakeRpc({ T1: { signer: VAULT, tx: burnTx() } });
    const notes: string[] = [];
    const foreign = spend(1, {
      destination: { type: "intents", chain: "base", address: ADDRESS, asset: "base-evil.near" },
    });
    const none = await collectBurns({
      rpc: lookups.rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [foreign],
      ledger: [payment(foreign.decision_hash, "T1")],
      notes,
    });
    expect(none[0]).toMatchObject({ status: "missing", tx_hash: "" });
    expect(lookups.calls).toEqual([]);
    expect(notes).toEqual([
      "spend 1: asset base-evil.near is not a POA asset of testnet: not looked up",
    ]);
  });

  it("T14-R2: never counts a held spend's reservation tx as read, but does count a hinted one", async () => {
    const { rpc } = fakeRpc({ RESERVE: { signer: VAULT, tx: noBurn() } });
    const held = spend(1, { held_until_ns: "1793900000000000000" });
    const fromLedger = await collectBurns({
      rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [held],
      ledger: [payment(held.decision_hash, "RESERVE")],
    });
    expect(fromLedger[0]).toMatchObject({ status: "missing", tx_hash: "" }); // unproven in check h, not failed
    const hinted = await collectBurns({
      rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [held],
      ledger: [],
      burnTxHints: new Map([[1, ["RESERVE"]]]),
    });
    expect(hinted[0]).toMatchObject({ status: "missing", tx_hash: "RESERVE" }); // read and holds no pair: fails
    const notHeld = await collectBurns({
      rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [spend(1)],
      ledger: [payment(spend(1).decision_hash, "RESERVE")],
    });
    expect(notHeld[0]).toMatchObject({ status: "missing", tx_hash: "RESERVE" });
  });

  it("records a burned spend to a NEAR account as missing without any lookup", async () => {
    const { rpc, calls } = fakeRpc({});
    const near = spend(1, { destination: { type: "near", account_id: "vendor.testnet" } });
    const burns = await collectBurns({
      rpc,
      now: NOW,
      vaultId: VAULT,
      network: "testnet",
      config,
      spends: [near],
      ledger: [payment(near.decision_hash, "T1")],
    });
    expect(burns[0]).toMatchObject({ status: "missing", tx_hash: "" });
    expect(calls).toEqual([]);
  });
});
