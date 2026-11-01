import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { checkAttestation } from "../src/attestation.js";
import { WITHDRAW_MEMO_PREFIX } from "../src/constants.js";
import { hexToBytes } from "../src/hex.js";
import { computeBodyHash, computeNonce, verifyEntrySignature } from "../src/ledger.js";
import type { AttestationEvidence, LedgerEntry, Snapshot } from "../src/types.js";
import { TEST_FORGED_KEY, TEST_LEDGER_KEY, TEST_ROTATED_KEY } from "./fixtures/keys.js";
import {
  FIXTURE_BASE_ADDRESS,
  FIXTURE_VAULT,
  makeFixtureSnapshot,
} from "./fixtures/make-fixtures.js";

/** The nonce the verifier recomputes from an entry's ledger context (ICR-1: it binds the vault). */
function expectedNonceOf(vault: string, entry: LedgerEntry): string {
  const { prev_link, invoice_hash, mandate_id, seq } = entry.body;
  return computeNonce({ vault, prev_link, invoice_hash, mandate_id, seq });
}

function evidenceOf(entry: LedgerEntry): AttestationEvidence {
  if (entry.body.evidence === null) throw new Error(`entry ${entry.body.seq} has no evidence`);
  return entry.body.evidence;
}

describe("TEST FIXTURE snapshot generator", () => {
  it("is deterministic", async () => {
    expect(await makeFixtureSnapshot()).toEqual(await makeFixtureSnapshot());
  });

  it("matches the committed JSON files", async () => {
    const generated = JSON.parse(JSON.stringify(await makeFixtureSnapshot())) as Snapshot;
    const committed = JSON.parse(
      await readFile(new URL("./fixtures/valid-snapshot.json", import.meta.url), "utf8"),
    ) as Snapshot;
    expect(generated).toEqual(committed);
    const lines = (
      await readFile(new URL("./fixtures/valid-ledger.jsonl", import.meta.url), "utf8")
    )
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LedgerEntry);
    expect(lines).toEqual(committed.ledger);
  });

  it("produces a 5-entry signed ledger with 3 anchors", async () => {
    const s = await makeFixtureSnapshot();
    expect(s.vault).toBe(FIXTURE_VAULT);
    expect(s.ledger.map((e) => e.body.kind)).toEqual([
      "decision",
      "payment",
      "decision",
      "payment",
      "decision",
    ]);
    expect(s.ledger.every(verifyEntrySignature)).toBe(true);
    expect(s.chain.anchors.map((a) => a.count)).toEqual([2, 4, 5]);
  });

  it("labels every fixture attestation as a TEST FIXTURE", async () => {
    const s = await makeFixtureSnapshot();
    const attested = s.ledger.filter((e) => e.body.evidence !== null);
    expect(attested).toHaveLength(2);
    for (const entry of attested) {
      const ev = entry.body.evidence;
      expect(ev?.model).toContain("test-fixture");
      expect(ev?.chat_id).toContain("test-fixture");
      const quoteStart = new TextDecoder().decode(
        hexToBytes(ev?.report?.intel_quote ?? "").slice(0, 40),
      );
      expect(quoteStart).toContain("TEST FIXTURE");
    }
  });
});

describe("TEST FIXTURE snapshot: internal consistency", () => {
  it("hashes, links and anchors agree (body_hash, prev_link, anchor roots)", async () => {
    const s = await makeFixtureSnapshot();
    s.ledger.forEach((entry, i) => {
      expect(entry.body.seq).toBe(i);
      expect(entry.body_hash).toBe(computeBodyHash(entry.body));
      expect(entry.signer).toBe(TEST_LEDGER_KEY.publicKey);
      expect(entry.body.prev_link).toBe(i === 0 ? "0".repeat(64) : s.ledger[i - 1]?.link);
    });
    expect(s.chain.anchors.map((a) => [a.seq, a.count, a.root])).toEqual([
      [1, 2, s.ledger[1]?.link],
      [2, 4, s.ledger[3]?.link],
      [3, 5, s.ledger[4]?.link],
    ]);
    expect(s.chain.anchors.every((a) => a.ledger_key === TEST_LEDGER_KEY.publicKey)).toBe(true);
    expect(s.chain.config.ledger_key).toBe(TEST_LEDGER_KEY.publicKey);
  });

  it("binds each attestation nonce to the vault and its ledger position (A1-A6 pass)", async () => {
    const s = await makeFixtureSnapshot();
    const attested = s.ledger.filter((e) => e.body.evidence !== null);
    expect(attested.map((e) => e.body.seq)).toEqual([0, 2]);
    for (const entry of attested) {
      const expected = expectedNonceOf(s.vault, entry);
      expect(evidenceOf(entry).nonce).toBe(expected);
      const result = await checkAttestation(evidenceOf(entry), expected);
      expect(result.ok).toBe(true);
      // ICR-1: the same ledger position in another vault needs a different nonce.
      expect(expectedNonceOf("other.vaults.probarion.testnet", entry)).not.toBe(expected);
    }
  });

  it("points every payment at its decision and every spend at the decision body hash", async () => {
    const s = await makeFixtureSnapshot();
    const [d0, p0, d1, p1] = s.ledger;
    expect(p0?.body.refs).toEqual({ decision_body_hash: d0?.body_hash });
    expect(p1?.body.refs).toEqual({ decision_body_hash: d1?.body_hash });
    expect(s.chain.spends.map((sp) => [sp.id, sp.mandate_id, sp.status, sp.decision_hash])).toEqual(
      [
        [1, 1, "paid", d0?.body_hash],
        [2, 2, "burned", d1?.body_hash],
      ],
    );
    expect(s.ledger[4]?.body.rules.map((r) => [r.id, r.outcome])).toEqual([
      ["mandate.payee_mismatch", "refuse"],
    ]);
    expect(s.pre_ledger_decision_hashes).toEqual([]);
  });

  it("holds one burn pair for the burned spend, memo WITHDRAW_TO:<address>", async () => {
    const s = await makeFixtureSnapshot();
    const burned = s.chain.spends.find((sp) => sp.status === "burned");
    expect(burned?.memo).toBe(`${WITHDRAW_MEMO_PREFIX}${FIXTURE_BASE_ADDRESS}`);
    expect(s.chain.burns).toEqual([
      {
        spend_id: burned?.id,
        tx_hash: s.ledger[3]?.body.contract?.tx_hash,
        memo: burned?.memo,
        intents_owner: FIXTURE_VAULT,
        amount: burned?.amount,
        status: "ok",
      },
    ]);
  });

  it("uses 1-based factory version ids, as the contract does (R14)", async () => {
    const s = await makeFixtureSnapshot();
    expect(s.chain.factory_version).toBe(1);
    expect(s.chain.factory_versions.map((v) => v.index)).toEqual([1]);
    expect(s.chain.factory_versions[0]?.code_hash).toBe(s.chain.code_hash);
    expect(s.expected_code_hashes).toEqual([s.chain.code_hash]);
  });
});

describe("TEST FIXTURE snapshot: tampered variants", () => {
  it("wrongNonceAtSeq builds evidence whose nonce does not match its ledger context (A6)", async () => {
    const s = await makeFixtureSnapshot({ wrongNonceAtSeq: 2 });
    const [d0, , d1] = s.ledger;
    for (const [entry, ok] of [
      [d0, true],
      [d1, false],
    ] as const) {
      if (entry === undefined) throw new Error("fixture entry missing");
      const result = await checkAttestation(evidenceOf(entry), expectedNonceOf(s.vault, entry));
      expect(result.ok).toBe(ok);
      expect(result.checks.find((c) => c.id === "A6")?.pass).toBe(ok);
    }
    // the rest of the ledger is still self-consistent
    expect(s.ledger.every(verifyEntrySignature)).toBe(true);
  });

  it("forgedSignerFromSeq signs later entries with a key that is not the vault's ledger key", async () => {
    const s = await makeFixtureSnapshot({ forgedSignerFromSeq: 3 });
    expect(s.ledger.map((e) => e.signer)).toEqual([
      TEST_LEDGER_KEY.publicKey,
      TEST_LEDGER_KEY.publicKey,
      TEST_LEDGER_KEY.publicKey,
      TEST_FORGED_KEY.publicKey,
      TEST_FORGED_KEY.publicKey,
    ]);
    expect(s.ledger.every(verifyEntrySignature)).toBe(true);
    expect(s.chain.config.ledger_key).toBe(TEST_LEDGER_KEY.publicKey);
  });

  it("rotateLedgerKeyAtSeq moves later entries, covering anchors and config to the rotated key", async () => {
    const s = await makeFixtureSnapshot({ rotateLedgerKeyAtSeq: 3 });
    expect(s.ledger.map((e) => e.signer)).toEqual([
      TEST_LEDGER_KEY.publicKey,
      TEST_LEDGER_KEY.publicKey,
      TEST_LEDGER_KEY.publicKey,
      TEST_ROTATED_KEY.publicKey,
      TEST_ROTATED_KEY.publicKey,
    ]);
    expect(s.chain.anchors.map((a) => a.ledger_key)).toEqual([
      TEST_LEDGER_KEY.publicKey,
      TEST_ROTATED_KEY.publicKey,
      TEST_ROTATED_KEY.publicKey,
    ]);
    expect(s.chain.config.ledger_key).toBe(TEST_ROTATED_KEY.publicKey);
    expect(s.ledger.every(verifyEntrySignature)).toBe(true);
  });

  it("signAllWithRotatedKey re-signs the older entries with the rotated key", async () => {
    const s = await makeFixtureSnapshot({ rotateLedgerKeyAtSeq: 3, signAllWithRotatedKey: true });
    expect(s.ledger.every((e) => e.signer === TEST_ROTATED_KEY.publicKey)).toBe(true);
    expect(s.chain.anchors[0]?.ledger_key).toBe(TEST_LEDGER_KEY.publicKey);
    expect(s.ledger.every(verifyEntrySignature)).toBe(true);
  });
});
