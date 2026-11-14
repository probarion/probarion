import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDepositPlan } from "@/lib/near/runway";
import {
  BRIDGE,
  BRIDGE_FEES,
  buildMainnetRecord,
  GAS,
  gasCosts,
  MAINNET_RECORD,
  type ProofRecord,
  type ProofTx,
  RUN_OUTCOMES,
  repoFile,
  SOURCES,
  TESTNET_DEPOSIT,
  testnetVaultDeposit,
} from "./evidence";

// Every figure /usage takes from the committed evidence, held to the files it comes from. The files under
// docs/evidence are append-only, so a check names the rows it knows and counts the rest from the raw records: a new
// payment or refusal added to docs/mainnet-proof.json shows up on the page and does not break these.
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const json = <T>(path: string) => JSON.parse(read(path)) as T;
const PROOF = json<ProofRecord>(SOURCES.proof);
const mainnetTxs = Object.entries(PROOF.txs).filter(
  ([, t]) => t.network === "mainnet" && t.receiver_id === PROOF.accounts.v0_vault,
);
const row = (key: string) => MAINNET_RECORD.rows.find((r) => r.key === key);

describe("the mainnet record", () => {
  it("is the v0 vault's, as of the proof file's own update time", () => {
    expect(MAINNET_RECORD.vault).toBe("v0.probarion.near");
    expect(MAINNET_RECORD.updatedAt).toBe(PROOF.updated_at);
  });

  it("counts every payment, Base payout and refusal on chain the proof file records for the vault, and nothing else", () => {
    const kinds = (k: string[]) => mainnetTxs.filter(([, t]) => k.includes(t.kind)).length;
    expect(MAINNET_RECORD.payments).toBe(kinds(["near_payment", "base_payout"]));
    expect(MAINNET_RECORD.basePayouts).toBe(kinds(["base_payout"]));
    expect(MAINNET_RECORD.refusedOnChain).toBe(kinds(["refused_on_chain"]));
    expect(MAINNET_RECORD.rows).toHaveLength(
      kinds(["near_payment", "base_payout", "refused_on_chain"]),
    );
    // As of the 2026-11-13 record: spend 1 on NEAR, the two Base payouts and the NoMandate refusal.
    expect(MAINNET_RECORD.payments).toBeGreaterThanOrEqual(3);
    expect(MAINNET_RECORD.basePayouts).toBeGreaterThanOrEqual(2);
    expect(MAINNET_RECORD.refusedOnChain).toBeGreaterThanOrEqual(1);
  });

  it("lists them oldest first, each on the UTC day its block ran", () => {
    const keys = MAINNET_RECORD.rows.map((r) => r.key);
    expect(keys.slice(0, 4)).toEqual([
      "first_near_payment",
      "refused_no_mandate",
      "first_base_payout",
      "attested_base_payout",
    ]);
    // Block times: the v0 README (2026-11-11), and the txs.log of each Base payout run (2026-11-13).
    expect(read(SOURCES.v0).replace(/\s+/g, " ")).toContain(
      "On 2026-11-11, between 12:51 and 13:00 UTC (block times)",
    );
    const blockDay = (log: string, hash: string) =>
      read(log)
        .split("\n")
        .find((l) => l.includes(`\t${hash}\t`))
        ?.slice(0, 10);
    expect(row("first_near_payment")?.day).toBe("2026-11-11");
    expect(row("refused_no_mandate")?.day).toBe("2026-11-11");
    const s1 = row("first_base_payout");
    const s2 = row("attested_base_payout");
    expect(s1?.day).toBe(
      blockDay("docs/evidence/mainnet-v0/s1-2026-11-13/txs.log", s1?.nearTx ?? ""),
    );
    expect(s2?.day).toBe(
      blockDay("docs/evidence/mainnet-v0/s2-2026-11-13/txs.log", s2?.nearTx ?? ""),
    );
  });

  it("joins each Base payout to the bridge's release: what arrived, on the Base transaction the proof file links", () => {
    expect(row("first_base_payout")).toMatchObject({
      kind: "base_payout",
      spendId: 2,
      amount: "1.00",
      arrived: "0.9976",
      baseTx: "0xc2df8f8799467834cdaed0e8f23638af49334483387560fd34ef360939e1ea71",
      decidedBy: "rules-only",
      model: null,
    });
    expect(row("attested_base_payout")).toMatchObject({
      kind: "base_payout",
      spendId: 3,
      amount: "0.25",
      arrived: "0.2476",
      baseTx: "0xc6c4507e098b558bdff1b5836600f5e3365fee5a63037d399db58e1db4547ab7",
      decidedBy: "model+rules",
      model: "z-ai/glm-5.3-flash",
    });
    const links = (PROOF as unknown as { links: Record<string, string> }).links;
    expect(links.first_base_payout_base).toBe(
      `https://basescan.org/tx/${row("first_base_payout")?.baseTx}`,
    );
    expect(links.attested_base_payout_base).toBe(
      `https://basescan.org/tx/${row("attested_base_payout")?.baseTx}`,
    );
    // The S2 run's own Base receipt shows the same 247600 base units reaching the payee.
    const receipt = json<{ tx: string; transfers: { value: string }[]; match: boolean }>(
      "docs/evidence/mainnet-v0/s2-2026-11-13/base-receipt.json",
    );
    expect(receipt.tx).toBe(row("attested_base_payout")?.baseTx);
    expect(receipt.match).toBe(true);
    expect(receipt.transfers.map((t) => t.value)).toEqual(["247600"]);
  });

  it("says spend 1 came before the signed ledger, and the NoMandate refusal moved nothing", () => {
    expect(row("first_near_payment")).toMatchObject({
      kind: "near_payment",
      spendId: 1,
      amount: "1.00",
      arrived: null,
      baseTx: null,
      decidedBy: null,
      beforeLedger: true,
    });
    expect(row("refused_no_mandate")).toMatchObject({
      kind: "refused_on_chain",
      spendId: null,
      amount: null,
      errorCode: "NoMandate",
      beforeLedger: true,
    });
    expect(row("first_base_payout")?.beforeLedger).toBe(false);
    // verify's check d: one spend's decision is listed as pre-ledger.
    expect(read("docs/evidence/mainnet-v0/s2-2026-11-13/verify-2026-11-13.json")).toContain(
      "1 spend has a decision_hash listed as pre-ledger",
    );
  });

  it("counts the attested decisions verify counts, by ledger position", () => {
    const verified = json<{ invoices: { attested_seqs: number[] }[] }>(
      "docs/evidence/mainnet-v0/s2-2026-11-13/verify-2026-11-13.json",
    );
    const seqs = verified.invoices.flatMap((i) => i.attested_seqs).sort((a, b) => a - b);
    expect(MAINNET_RECORD.decisions.map((d) => d.seq)).toEqual(seqs);
    expect(seqs).toEqual([0, 1, 4]);
    expect(MAINNET_RECORD.decisionsPaid).toBe(1);
    expect(MAINNET_RECORD.decisionsRefused).toBe(2);
    expect(MAINNET_RECORD.decisions.find((d) => d.verdict === "allow")?.spendTx).toBe(
      row("attested_base_payout")?.nearTx,
    );
  });

  it("calls the two refused attested decisions false refusals only because the S1 record does", () => {
    const refused = MAINNET_RECORD.decisions.filter((d) => d.verdict === "refuse");
    expect(refused.map((d) => d.code)).toEqual([
      "mandate.payee_mismatch",
      "mandate.payee_mismatch",
    ]);
    // Both were S1's cycles: their anchors are S1's first two.
    expect(refused.map((d) => d.anchorTx)).toEqual([
      PROOF.txs.v0_anchor_1?.hash,
      PROOF.txs.v0_anchor_2?.hash,
    ]);
    expect(refused.every((d) => d.spendTx === null)).toBe(true);
    const s1 = read(SOURCES.s1);
    expect(s1).toContain("these were false refusals");
    expect(s1).toContain("PR #142");
    expect(s1).toContain("## Why the payout was decided rules-only");
  });

  it("states the online check only as its record says: O1 and O2 passed, the measurement not pinned", () => {
    const online = read(SOURCES.verifyOnline);
    expect(online).toContain("RESULT: PASS");
    expect(online).toContain(
      "A8 (request binding and mandate match) passes for 3 of 3 attested decisions (seq 0, 1, 4)",
    );
    expect(online).toContain("3 DCAP-genuine TDX quotes bound to this request (O1");
    expect(online).toContain("verified by NRAS (O2)");
    expect(online).toContain("measurement not pinned");
  });

  it("leaves out testnet, other vaults and setup steps, and sorts what is left by time", () => {
    const tx = (over: Partial<ProofTx>): ProofTx => ({
      amount_usdc: "1.00",
      base_tx: null,
      error_code: null,
      hash: "h",
      kind: "near_payment",
      network: "mainnet",
      receiver_id: "v.near",
      recorded_at: "2026-01-02T00:00:00Z",
      spend_id: 1,
      ...over,
    });
    const record = buildMainnetRecord(
      {
        accounts: { v0_vault: "v.near" },
        updated_at: "2026-01-03T00:00:00Z",
        txs: {
          later: tx({ hash: "b", spend_id: 2, recorded_at: "2026-01-02T10:00:00Z" }),
          earlier: tx({ hash: "a" }),
          testnet: tx({ hash: "t", network: "testnet" }),
          other: tx({ hash: "o", receiver_id: "w.near" }),
          setup: tx({ hash: "m", kind: "mandate_created", amount_usdc: null }),
          anchor: tx({ hash: "n", kind: "anchor", recorded_at: "2026-01-02T05:00:00Z" }),
        },
      },
      [],
      [],
    );
    expect(record.rows.map((r) => r.key)).toEqual(["earlier", "later"]);
    expect(record.rows.map((r) => r.beforeLedger)).toEqual([true, false]);
    expect(record.payments).toBe(2);
    expect(record.decisions).toEqual([]);
  });

  it("reads a run record of another vault or network as no record", () => {
    const [paid] = RUN_OUTCOMES.filter((o) => o.spend_tx !== null);
    if (!paid?.spend_tx) throw new Error("no paid run record");
    const record = buildMainnetRecord(PROOF, [{ ...paid, vault: "other.near" }], BRIDGE);
    expect(record.rows.find((r) => r.nearTx === paid.spend_tx)?.decidedBy).toBeNull();
    expect(record.decisions).toEqual([]);
  });
});

describe("what it costs", () => {
  type Reading = {
    txs: {
      tx_hash: string;
      sum_gas_burnt: string;
      sum_tokens_burnt: string;
      sum_tgas: string;
      sum_near: string;
      outcomes: { gas_burnt: string; tokens_burnt: string }[];
    }[];
  };
  const readings = [SOURCES.gasV0, SOURCES.gasSpend2, SOURCES.gasSpend3].map((p) =>
    json<Reading>(p),
  );

  it("has the gas of each spend that has a reading, in the record's order", () => {
    expect(GAS.map((g) => [g.row.key, g.near, g.tgas, g.source])).toEqual([
      ["first_near_payment", "0.000769", "8.3546", SOURCES.gasV0],
      ["refused_no_mandate", "0.000165", "1.8723", SOURCES.gasV0],
      ["first_base_payout", "0.001423", "15.3479", SOURCES.gasSpend2],
      ["attested_base_payout", "0.001424", "15.3563", SOURCES.gasSpend3],
    ]);
    expect(new Set(GAS.map((g) => g.readOn))).toEqual(new Set(["2026-11-13"]));
  });

  it("shows sums that add up: every outcome of the transaction, and its rounded NEAR and Tgas", () => {
    for (const reading of readings) {
      for (const t of reading.txs) {
        const gas = t.outcomes.reduce((a, o) => a + BigInt(o.gas_burnt), 0n);
        const tokens = t.outcomes.reduce((a, o) => a + BigInt(o.tokens_burnt), 0n);
        expect(gas.toString(), t.tx_hash).toBe(t.sum_gas_burnt);
        expect(tokens.toString(), t.tx_hash).toBe(t.sum_tokens_burnt);
        expect((Number(tokens) / 1e24).toFixed(6), t.tx_hash).toBe(t.sum_near);
        expect((Number(gas) / 1e12).toFixed(4), t.tx_hash).toBe(t.sum_tgas);
      }
    }
  });

  it("matches a reading to its row by transaction, and skips a row with none", () => {
    const rows = MAINNET_RECORD.rows.slice(0, 1);
    expect(gasCosts(rows, [])).toEqual([]);
    expect(gasCosts(rows, [{ source: "x", reading: { read_on: "d", txs: [] } }])).toEqual([]);
  });

  it("has the bridge's fee from both Base payouts' release records", () => {
    expect(BRIDGE_FEES).toEqual([{ usdc: "0.0024", payouts: 2 }]);
    for (const path of [SOURCES.poaS1, SOURCES.poaS2]) {
      const poa = json<{
        status: string;
        data: { amount: number; withdrawal_fee: string; withdraw_amount: string };
      }>(path);
      expect(poa.status).toBe("COMPLETED");
      expect(poa.data.withdrawal_fee).toBe("2400");
      expect(BigInt(poa.data.amount)).toBe(
        BigInt(poa.data.withdrawal_fee) + BigInt(poa.data.withdraw_amount),
      );
    }
  });

  it("says the contract has no fee path: spend sends the spend's own amount, and no vault source names a fee", () => {
    const spend = read(SOURCES.spend);
    expect(spend).toContain(
      ".ft_transfer(\n                    account_id,\n                    U128(spend.amount),",
    );
    expect(spend).toContain(".ft_withdraw(asset.clone(), asset, U128(spend.amount), memo, None)");
    const src = join(ROOT, "contracts", "vault", "src");
    const files = readdirSync(src).filter((f) => f.endsWith(".rs") && f !== "test_utils.rs");
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((f) => /fee/i.test(readFileSync(join(src, f), "utf8")))).toEqual([]);
  });

  it("derives the testnet vault deposit from the factory record, as the console and the owner quickstart do", () => {
    const record = json<{
      factory: { min_deposit: string; versions: { mode: "embedded" | "global" }[] };
    }>(SOURCES.testnetFactory);
    const mode = record.factory.versions.at(-1)?.mode ?? "global";
    const required = createDepositPlan(record.factory.min_deposit, mode, 0n).requiredYocto;
    expect(TESTNET_DEPOSIT).toEqual({ near: "3.23352", minDepositNear: "0.5" });
    expect(BigInt(Math.round(Number(TESTNET_DEPOSIT?.near) * 1e6)) * 10n ** 18n).toBe(required);
    expect(read("apps/web/content/docs/start/owner-quickstart.mdx")).toContain(
      "With today's testnet factory that is 3.23352 NEAR.",
    );
    expect(testnetVaultDeposit({ min_deposit: "1", versions: [] })).toBeNull();
  });

  it("gives no mainnet deposit, because the mainnet factory is not deployed", () => {
    const mainnet = json<{ factory: { deploy_tx: string | null; versions: unknown[] } }>(
      "contracts/deployments/mainnet.json",
    );
    expect(mainnet.factory.deploy_tx).toBeNull();
    expect(mainnet.factory.versions).toEqual([]);
  });
});

describe("the evidence links", () => {
  it("point at files of this repository, on main", () => {
    for (const path of Object.values(SOURCES)) {
      const file = path.split("#")[0] ?? "";
      expect(() => read(file), file).not.toThrow();
      expect(repoFile(path)).toBe(`https://github.com/probarion/probarion/blob/main/${path}`);
    }
  });
});
