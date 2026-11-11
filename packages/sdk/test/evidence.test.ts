import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@probarion/core";
import { describe, expect, it } from "vitest";
import {
  isPreLedgerVault,
  loadBurnTxHints,
  PRE_LEDGER_VAULTS,
  readPreLedgerDecisionHashes,
} from "../src/evidence.js";

describe("readPreLedgerDecisionHashes", () => {
  it("hashes the exact bytes of each docs/evidence/v0-decision-*.json file, in name order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probarion-evidence-"));
    await writeFile(join(dir, "v0-decision-2.json"), '{"b":2}\n');
    await writeFile(join(dir, "v0-decision-1.json"), '{"a":1}\n');
    await writeFile(join(dir, "v0-invoice-1.txt"), "not a decision");
    expect(await readPreLedgerDecisionHashes(dir)).toEqual([
      sha256Hex('{"a":1}\n'),
      sha256Hex('{"b":2}\n'),
    ]);
  });

  it("returns an empty list when the directory does not exist", async () => {
    expect(
      await readPreLedgerDecisionHashes(join(tmpdir(), "probarion-missing-evidence-dir")),
    ).toEqual([]);
  });

  it("reads the repo's own v0 decision files: three for Day 4, one for the 2026-11 demo run", async () => {
    const dir = fileURLToPath(new URL("../../../docs/evidence/", import.meta.url));
    expect(await readPreLedgerDecisionHashes(dir)).toHaveLength(4);
  });
});

describe("pre-ledger vaults (carries A): mainnet v0 only", () => {
  it("lists v0.probarion.near on mainnet and nothing else", () => {
    expect(PRE_LEDGER_VAULTS).toEqual({ mainnet: ["v0.probarion.near"], testnet: [] });
    expect(isPreLedgerVault("mainnet", "v0.probarion.near")).toBe(true);
    expect(isPreLedgerVault("testnet", "v0.probarion.near")).toBe(false);
    expect(isPreLedgerVault("testnet", "v0.probarion.testnet")).toBe(false);
    expect(isPreLedgerVault("mainnet", "acme.vaults.probarion.near")).toBe(false);
  });
});

describe("loadBurnTxHints (R7 source 1: docs/mainnet-proof.json)", () => {
  const entry = (over: Record<string, unknown>) => ({
    hash: "H1",
    network: "mainnet",
    signer_id: "v0.probarion.near",
    receiver_id: "v0.probarion.near",
    kind: "base_payout",
    what: "Day-4 Base payout",
    signed_by: "agent_key",
    expect: "success",
    error_code: null,
    spend_id: 2,
    amount_usdc: "2.00",
    base_tx: null,
    recorded_at: "2026-11-04T10:00:00.000Z",
    ...over,
  });

  it("maps each spend id to the vault's successful txs on that network", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probarion-proof-"));
    const file = join(dir, "mainnet-proof.json");
    await writeFile(
      file,
      JSON.stringify({
        v: 1,
        txs: {
          base_payout: entry({}),
          approved: entry({ hash: "H2", kind: "approved", signer_id: "owner.near" }),
          again: entry({}),
          other_vault: entry({ hash: "X1", receiver_id: "other.near" }),
          testnet: entry({ hash: "X2", network: "testnet" }),
          refusal: entry({ hash: "X3", expect: "failure", error_code: "NoMandate" }),
          no_spend: entry({ hash: "X4", spend_id: null }),
          paid: entry({ hash: "H3", spend_id: 1, kind: "near_payment" }),
        },
      }),
    );
    const hints = await loadBurnTxHints(file, { vault: "v0.probarion.near", network: "mainnet" });
    // Each hint carries the entry's signer_id, so the lookup asks the right account first.
    expect([...hints.entries()]).toEqual([
      [
        2,
        [
          { hash: "H1", signer: "v0.probarion.near" },
          { hash: "H2", signer: "owner.near" },
        ],
      ],
      [1, [{ hash: "H3", signer: "v0.probarion.near" }]],
    ]);
  });

  it("gives no hints for a missing file and throws on a file that is not JSON", async () => {
    const none = await loadBurnTxHints(join(tmpdir(), "probarion-no-proof.json"), {
      vault: "v",
      network: "mainnet",
    });
    expect(none.size).toBe(0);
    const dir = await mkdtemp(join(tmpdir(), "probarion-proof-"));
    await writeFile(join(dir, "bad.json"), "not json");
    await expect(
      loadBurnTxHints(join(dir, "bad.json"), { vault: "v", network: "mainnet" }),
    ).rejects.toThrow();
  });

  it("reads the repo's own evidence file: the mainnet v0 run's one paid spend, not its refusal", async () => {
    const file = fileURLToPath(new URL("../../../docs/mainnet-proof.json", import.meta.url));
    const hints = await loadBurnTxHints(file, { vault: "v0.probarion.near", network: "mainnet" });
    expect([...hints]).toEqual([
      [1, [{ hash: "22oqhgruo7JqdpPg5Cb2ts25mLK2fto8y1YAxNA56ieE", signer: "v0.probarion.near" }]],
    ]);
    const testnet = await loadBurnTxHints(file, { vault: "v0.probarion.near", network: "testnet" });
    expect(testnet.size).toBe(0);
  });
});
