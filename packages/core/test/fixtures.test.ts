import { readFile } from "node:fs/promises";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { checkAttestation } from "../src/attestation.js";
import { WITHDRAW_MEMO_PREFIX } from "../src/constants.js";
import { hexToBytes } from "../src/hex.js";
import { computeBodyHash, computeLink, computeNonce, verifyEntrySignature } from "../src/ledger.js";
import type { AttestationEvidence, LedgerEntry, Snapshot } from "../src/types.js";
import { TEST_FORGED_KEY, TEST_LEDGER_KEY, TEST_ROTATED_KEY } from "./fixtures/keys.js";
import {
  FIXTURE_BASE_ADDRESS,
  FIXTURE_FACTORY_NOTES,
  FIXTURE_NEAR_PAYEE,
  FIXTURE_VAULT,
  LEDGER_FILE,
  makeFixtureSnapshot,
  SNAPSHOT_FILE,
  serializeFixtures,
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

function entryAt(s: Snapshot, seq: number): LedgerEntry {
  const found = s.ledger[seq];
  if (found === undefined) throw new Error(`fixture entry ${seq} missing`);
  return found;
}

/** The ids of the offline attestation checks (A1..A7) that fail for an entry. */
async function failedChecks(s: Snapshot, seq: number): Promise<string[]> {
  const entry = entryAt(s, seq);
  const result = await checkAttestation(
    evidenceOf(entry),
    expectedNonceOf(s.vault, entry),
    entry.body.proposal,
  );
  return result.checks.filter((c) => !c.pass).map((c) => c.id);
}

/**
 * Check a (v2), interfaces §10: the entries in each anchor's range (prev.count, count] must be signed by
 * that anchor's ledger_key and the entries after the last anchor by config.ledger_key. Returns the seqs
 * whose signer is not the required key.
 */
function signerMismatches(s: Snapshot): number[] {
  const bad: number[] = [];
  let from = 0;
  for (const anchor of s.chain.anchors) {
    for (let i = from; i < anchor.count; i++) {
      if (s.ledger[i]?.signer !== anchor.ledger_key) bad.push(i);
    }
    from = anchor.count;
  }
  for (let i = from; i < s.ledger.length; i++) {
    if (s.ledger[i]?.signer !== s.chain.config.ledger_key) bad.push(i);
  }
  return bad;
}

/** Public keys of the access keys that can call `anchor`. */
function anchorAccessKeys(s: Snapshot): string[] {
  return s.chain.access_keys.flatMap((k) =>
    typeof k.permission === "object" && k.permission.method_names.includes("anchor")
      ? [k.public_key]
      : [],
  );
}

const fixtureUrl = (name: string): URL => new URL(`./fixtures/${name}`, import.meta.url);

describe("TEST FIXTURE snapshot generator", () => {
  it("is deterministic", async () => {
    expect(await makeFixtureSnapshot()).toEqual(await makeFixtureSnapshot());
  });

  it("matches the committed JSON files", async () => {
    const generated = JSON.parse(JSON.stringify(await makeFixtureSnapshot())) as Snapshot;
    const committed = JSON.parse(await readFile(fixtureUrl(SNAPSHOT_FILE), "utf8")) as Snapshot;
    expect(generated).toEqual(committed);
    const lines = (await readFile(fixtureUrl(LEDGER_FILE), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LedgerEntry);
    expect(lines).toEqual(committed.ledger);
  });

  it("serializes byte for byte to the committed files (no formatter drift, LF only)", async () => {
    const { snapshotJson, ledgerJsonl } = serializeFixtures(await makeFixtureSnapshot());
    for (const [name, text] of [
      [SNAPSHOT_FILE, snapshotJson],
      [LEDGER_FILE, ledgerJsonl],
    ] as const) {
      const committed = await readFile(fixtureUrl(name));
      expect(committed.toString("utf8"), name).toBe(text);
      expect(committed.equals(Buffer.from(text, "utf8")), `${name} bytes`).toBe(true);
      expect(committed.includes(0x0d), `${name} has a CR`).toBe(false);
    }
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

  it("uses a vault account the factory can never create, and labels its factory version", async () => {
    const s = await makeFixtureSnapshot();
    expect(FIXTURE_VAULT).toBe("x.vaults.probarion.testnet");
    // factory valid_name: 2 to 31 characters, so a 1-character name cannot exist
    expect(FIXTURE_VAULT.split(".")[0]).toHaveLength(1);
    expect(s.ledger.every((e) => e.body.vault === FIXTURE_VAULT)).toBe(true);
    expect(s.chain.factory_versions[0]?.notes).toBe(FIXTURE_FACTORY_NOTES);
    expect(FIXTURE_FACTORY_NOTES).toContain("TEST FIXTURE");
  });
});

describe("TEST FIXTURE snapshot: internal consistency", () => {
  it("hashes, links and anchors agree (body_hash, link, prev_link, anchor roots)", async () => {
    const s = await makeFixtureSnapshot();
    s.ledger.forEach((entry, i) => {
      expect(entry.body.seq).toBe(i);
      expect(entry.body_hash).toBe(computeBodyHash(entry.body));
      expect(entry.link).toBe(computeLink(entry.body.prev_link, entry.body_hash, entry.sig));
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
    expect(signerMismatches(s)).toEqual([]);
    expect(anchorAccessKeys(s)).toEqual([TEST_LEDGER_KEY.publicKey]);
  });

  it("binds each attestation nonce to the vault and its position, and passes A1-A7", async () => {
    const s = await makeFixtureSnapshot();
    const attested = s.ledger.filter((e) => e.body.evidence !== null);
    expect(attested.map((e) => e.body.seq)).toEqual([0, 2]);
    for (const entry of attested) {
      const expected = expectedNonceOf(s.vault, entry);
      expect(evidenceOf(entry).nonce).toBe(expected);
      const result = await checkAttestation(evidenceOf(entry), expected, entry.body.proposal);
      expect(result.checks.map((c) => [c.id, c.pass])).toEqual(
        ["A1", "A2", "A3", "A4", "A5", "A6", "A7"].map((id) => [id, true]),
      );
      expect(result.ok).toBe(true);
      // ICR-1: the same ledger position in another vault needs a different nonce.
      expect(expectedNonceOf("other.vaults.probarion.testnet", entry)).not.toBe(expected);
    }
  });

  it("points every payment at its decision, and every spend at its payment and decision", async () => {
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
    for (const payment of s.ledger.filter((e) => e.body.kind === "payment")) {
      const spend = s.chain.spends.find((sp) => sp.id === payment.body.contract?.spend_id);
      const decision = s.ledger.find((e) => e.body_hash === payment.body.refs?.decision_body_hash);
      expect(spend, `spend of payment ${payment.body.seq}`).toBeDefined();
      expect(decision?.body.kind).toBe("decision");
      for (const field of ["invoice_hash", "amount", "mandate_id"] as const) {
        expect(spend?.[field], `spend.${field}`).toBe(payment.body[field]);
        expect(decision?.body[field], `decision.${field}`).toBe(payment.body[field]);
      }
      expect(spend?.status).toBe(payment.body.contract?.status);
      expect(spend?.decision_hash).toBe(decision?.body_hash);
    }
    expect(s.pre_ledger_decision_hashes).toEqual([]);
  });

  it("carries the rules the policy engine emits for the two allowed decisions", async () => {
    const s = await makeFixtureSnapshot();
    for (const [seq, mandate, amount] of [
      [0, 1, "25000000"],
      [2, 2, "40000000"],
    ] as const) {
      const body = entryAt(s, seq).body;
      expect(body.verdict).toBe("allow");
      expect(body.decided_by).toBe("model+rules");
      expect(body.mandate_id).toBe(mandate);
      expect(body.amount).toBe(amount);
      expect(body.rules.every((r) => r.outcome === "pass")).toBe(true);
      expect(body.rules[0]).toMatchObject({
        id: "vault.frozen",
        detail: "vault is not frozen",
      });
      expect(body.rules.find((r) => r.id === "mandate.none")?.detail).toBe(
        `mandate ${mandate} selected by proposal`,
      );
      expect(body.rules.map((r) => r.id)).toEqual(
        expect.arrayContaining(["mandate.payee_mismatch", "invoice.duplicate", "model.refused"]),
      );
    }
    expect(entryAt(s, 2).body.rules.find((r) => r.id === "intents.balance_low")?.detail).toBe(
      "POA balance 100000000",
    );
  });

  it("refuses the injected invoice by the rules alone (seq 4)", async () => {
    const s = await makeFixtureSnapshot();
    const refusal = entryAt(s, 4).body;
    expect(refusal.kind).toBe("decision");
    expect(refusal.verdict).toBe("refuse");
    expect(refusal.decided_by).toBe("rules-only");
    expect(refusal.proposal).toBeNull();
    expect(refusal.evidence).toBeNull();
    expect(refusal.mandate_id).toBe(1);
    expect(refusal.amount).toBe("25000000");
    expect(refusal.rules.filter((r) => r.outcome !== "pass").map((r) => r.id)).toEqual([
      "mandate.payee_mismatch",
    ]);
    const mismatch = refusal.rules.find((r) => r.id === "mandate.payee_mismatch");
    expect(mismatch?.detail).toContain("attacker.fixture.testnet");
    expect(mismatch?.detail).toContain(FIXTURE_NEAR_PAYEE);
    expect(refusal.rules.some((r) => r.id.startsWith("model."))).toBe(false);
    // refused: no payment follows and no spend exists for it
    expect(s.chain.spends).toHaveLength(2);
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

  it("records the settlement of the burned payment and none for the paid one", async () => {
    const s = await makeFixtureSnapshot();
    const [, paid, , burned] = s.ledger;
    expect(paid?.body.settlement).toBeNull();
    expect(burned?.body.settlement).toEqual({
      chain: "base",
      tx_hash: null,
      burn_tx_hash: burned?.body.contract?.tx_hash,
    });
    expect(burned?.body.settlement?.burn_tx_hash).toBe(s.chain.burns[0]?.tx_hash);
  });

  it("uses real 32-byte base58 transaction hashes", async () => {
    const s = await makeFixtureSnapshot();
    const hashes = [
      ...s.ledger.flatMap((e) => (e.body.contract?.tx_hash ? [e.body.contract.tx_hash] : [])),
      ...s.chain.burns.map((b) => b.tx_hash),
    ];
    expect(hashes).toHaveLength(3);
    for (const hash of hashes) expect(bs58.decode(hash)).toHaveLength(32);
    expect(new Set(hashes).size).toBe(2); // spend B's hash appears in its payment and in the burn
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
  it.each([0, 2])("wrongNonceAtSeq %i breaks A6 for that entry and nothing else", async (seq) => {
    const s = await makeFixtureSnapshot({ wrongNonceAtSeq: seq });
    for (const attestedSeq of [0, 2]) {
      expect(await failedChecks(s, attestedSeq), `seq ${attestedSeq}`).toEqual(
        attestedSeq === seq ? ["A6"] : [],
      );
    }
    // the ledger itself is still self-consistent
    expect(s.ledger.every(verifyEntrySignature)).toBe(true);
    expect(signerMismatches(s)).toEqual([]);
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
    expect(s.ledger.every(verifyEntrySignature)).toBe(true); // a valid signature by the wrong key
    // anchors 2 and 3 (and 1) and the config still name the honest key
    expect(s.chain.anchors.map((a) => a.ledger_key)).toEqual([
      TEST_LEDGER_KEY.publicKey,
      TEST_LEDGER_KEY.publicKey,
      TEST_LEDGER_KEY.publicKey,
    ]);
    expect(s.chain.config.ledger_key).toBe(TEST_LEDGER_KEY.publicKey);
    expect(anchorAccessKeys(s)).toEqual([TEST_LEDGER_KEY.publicKey]);
    expect(signerMismatches(s)).toEqual([3, 4]);
  });

  it("forgedSignerFromSeq 0 forges the whole ledger", async () => {
    const s = await makeFixtureSnapshot({ forgedSignerFromSeq: 0 });
    expect(s.ledger.every((e) => e.signer === TEST_FORGED_KEY.publicKey)).toBe(true);
    expect(signerMismatches(s)).toEqual([0, 1, 2, 3, 4]);
  });

  it.each([
    {
      at: 2,
      signers: ["L", "L", "R", "R", "R"],
      anchors: ["L", "R", "R"],
    },
    {
      at: 4,
      signers: ["L", "L", "L", "L", "R"],
      anchors: ["L", "L", "R"],
    },
  ])(
    "rotateLedgerKeyAtSeq $at rotates at an anchor boundary: check a (v2) holds",
    async ({ at, signers, anchors }) => {
      const key = { L: TEST_LEDGER_KEY.publicKey, R: TEST_ROTATED_KEY.publicKey } as const;
      const s = await makeFixtureSnapshot({ rotateLedgerKeyAtSeq: at });
      expect(s.ledger.map((e) => e.signer)).toEqual(signers.map((k) => key[k as "L" | "R"]));
      expect(s.chain.anchors.map((a) => a.ledger_key)).toEqual(
        anchors.map((k) => key[k as "L" | "R"]),
      );
      expect(s.chain.config.ledger_key).toBe(TEST_ROTATED_KEY.publicKey);
      expect(s.ledger.every(verifyEntrySignature)).toBe(true);
      // every anchor's ledger_key signs exactly the entries in its range
      expect(signerMismatches(s)).toEqual([]);
      // the rotated key can anchor, the old one was removed
      const accessKeys = s.chain.access_keys.map((k) => k.public_key);
      expect(anchorAccessKeys(s)).toEqual([TEST_ROTATED_KEY.publicKey]);
      expect(accessKeys).toContain(TEST_ROTATED_KEY.publicKey);
      expect(accessKeys).not.toContain(TEST_LEDGER_KEY.publicKey);
    },
  );

  it.each([
    { at: 2, bad: [0, 1] },
    { at: 4, bad: [0, 1, 2, 3] },
  ])(
    "signAllWithRotatedKey (rotation at $at) re-signs the older entries: check a (v2) fails for them",
    async ({ at, bad }) => {
      const s = await makeFixtureSnapshot({
        rotateLedgerKeyAtSeq: at,
        signAllWithRotatedKey: true,
      });
      expect(s.ledger.every((e) => e.signer === TEST_ROTATED_KEY.publicKey)).toBe(true);
      expect(s.chain.anchors[0]?.ledger_key).toBe(TEST_LEDGER_KEY.publicKey);
      expect(s.ledger.every(verifyEntrySignature)).toBe(true);
      expect(signerMismatches(s)).toEqual(bad);
    },
  );
});

describe("TEST FIXTURE snapshot: variant guards", () => {
  it.each([0, 1, 3, 5, 6, -1, 2.5, Number.NaN])(
    "rotateLedgerKeyAtSeq %s is refused: only an anchor boundary (2 or 4) is valid",
    async (at) => {
      await expect(makeFixtureSnapshot({ rotateLedgerKeyAtSeq: at })).rejects.toThrow(
        /not an anchor boundary.*seq 2 or 4/,
      );
    },
  );

  it.each([1, 3, 4, 5, -1, 0.5])(
    "wrongNonceAtSeq %s is refused: that seq has no attestation",
    async (seq) => {
      await expect(makeFixtureSnapshot({ wrongNonceAtSeq: seq })).rejects.toThrow(
        /has no attestation; the attested seqs are 0, 2/,
      );
    },
  );

  it.each([5, 9, -1, 1.5])(
    "forgedSignerFromSeq %s is refused: not a seq of the ledger",
    async (seq) => {
      await expect(makeFixtureSnapshot({ forgedSignerFromSeq: seq })).rejects.toThrow(
        /not a seq of the ledger \(0 to 4\)/,
      );
    },
  );

  it("signAllWithRotatedKey without a rotation is refused", async () => {
    await expect(makeFixtureSnapshot({ signAllWithRotatedKey: true })).rejects.toThrow(
      /needs rotateLedgerKeyAtSeq/,
    );
  });

  it("accepts signAllWithRotatedKey: false and an empty options object", async () => {
    const plain = await makeFixtureSnapshot();
    expect(await makeFixtureSnapshot({})).toEqual(plain);
    expect(await makeFixtureSnapshot({ signAllWithRotatedKey: false })).toEqual(plain);
  });
});
