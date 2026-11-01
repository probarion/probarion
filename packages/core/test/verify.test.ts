import bs58 from "bs58";
import { beforeAll, describe, expect, it } from "vitest";
import { NETWORKS, WITHDRAW_MEMO_PREFIX } from "../src/constants.js";
import { sha256Bytes, sha256Hex } from "../src/hash.js";
import { bytesToHex, utf8, ZERO_HEX32 } from "../src/hex.js";
import { createEd25519Signer } from "../src/keys.js";
import {
  buildEntry,
  computeBodyHash,
  computeLink,
  computeNonce,
  verifyEntrySignature,
} from "../src/ledger.js";
import type { CheckId, LedgerEntry, Snapshot, VerifyReport } from "../src/types.js";
import {
  CHECK_NAMES,
  checkAnchors,
  checkAttestations,
  checkBurnMemos,
  checkFactoryVersion,
  checkHashLinks,
  checkIntentsKeys,
  checkLedgerSignatures,
  checkSpendsHaveDecisions,
  checkVaultLocked,
  firstBrokenSeq,
  normalizeCodeHash,
  runChecks,
} from "../src/verify.js";
import { buildTestEvidence } from "./fixtures/evidence.js";
import { TEST_FORGED_KEY, TEST_LEDGER_KEY, TEST_ROTATED_KEY } from "./fixtures/keys.js";
import { FIXTURE_CODE_HASH, FIXTURE_VAULT, makeFixtureSnapshot } from "./fixtures/make-fixtures.js";
import { honestSigner, rebuildLedger } from "./helpers/rebuild-ledger.js";

const NOW = new Date("2026-11-05T12:30:00.000Z");
const OTHER_VAULT = "y.vaults.probarion.testnet";
/** The probarion-vault builds recorded in contracts/code-hashes.json (plan 02), and a probarion-factory build. */
const KNOWN_VAULT_HASH = "6tbERLAXWjaVKbSNzaivRDh7H9kCcjtmV1qGrgz7entR";
const FACTORY_BUILD_HASH = "91MDwdWx56fYh6rN3VWvnuk5fEv2bc58cv9inGEfnevd";
const ZERO_CODE_HASH = "1".repeat(32); // base58 of 32 zero bytes: an account with no contract code

const forgedSigner = createEd25519Signer(TEST_FORGED_KEY.secretKey);
const rotatedSigner = createEd25519Signer(TEST_ROTATED_KEY.secretKey);

let valid: Snapshot;

beforeAll(async () => {
  valid = await makeFixtureSnapshot();
});

function fresh(): Snapshot {
  return structuredClone(valid);
}

function check(report: VerifyReport, id: CheckId) {
  const found = report.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`check ${id} missing`);
  return found;
}

function onlyFailing(report: VerifyReport): CheckId[] {
  return report.checks.filter((c) => c.status === "fail").map((c) => c.id);
}

function entryOf(s: Snapshot, seq: number): LedgerEntry {
  const found = s.ledger[seq];
  if (found === undefined) throw new Error(`fixture entry ${seq} missing`);
  return found;
}

function spendOf(s: Snapshot, index: number) {
  const found = s.chain.spends[index];
  if (found === undefined) throw new Error(`fixture spend ${index} missing`);
  return found;
}

function burnOf(s: Snapshot) {
  const found = s.chain.burns[0];
  if (found === undefined) throw new Error("fixture burn missing");
  return found;
}

function anchorOf(s: Snapshot, index: number) {
  const found = s.chain.anchors[index];
  if (found === undefined) throw new Error(`fixture anchor ${index} missing`);
  return found;
}

function accessKeyOf(s: Snapshot, index: number) {
  const found = s.chain.access_keys[index];
  if (found === undefined || found.permission === "FullAccess") {
    throw new Error(`fixture function-call key ${index} missing`);
  }
  return { key: found, permission: found.permission };
}

/**
 * Changes exactly one character of the serialised entry: the first character of the first string value of
 * `field`. A digit becomes the next digit (9 becomes 8), any other character becomes "X".
 */
function tamperOneByte(entry: LedgerEntry, field: string = "amount"): LedgerEntry {
  const json = JSON.stringify(entry);
  const marker = `"${field}":"`;
  const at = json.indexOf(marker) + marker.length;
  const char = json.charAt(at);
  const replacement = /[0-9]/.test(char) ? (char === "9" ? "8" : String(Number(char) + 1)) : "X";
  return JSON.parse(`${json.slice(0, at)}${replacement}${json.slice(at + 1)}`) as LedgerEntry;
}

/** The same ledger moved to another vault: bodies, snapshot, access-key receivers and the burn owner all name `vault`. */
async function retargeted(s: Snapshot, vault: string): Promise<Snapshot> {
  const out = await rebuildLedger(s, {
    edit: (body) => {
      body.vault = vault;
    },
  });
  out.vault = vault;
  for (const key of out.chain.access_keys) {
    if (key.permission !== "FullAccess") key.permission.receiver_id = vault;
  }
  for (const burn of out.chain.burns) burn.intents_owner = vault;
  return out;
}

/**
 * A snapshot that is fully valid for ANOTHER vault: the ledger is moved to `vault` and the attestation evidence is
 * re-issued with the nonce of that vault (the test TEE signs whatever nonce it is given), so every check passes there.
 */
async function validFor(vault: string): Promise<Snapshot> {
  const s = await rebuildLedger(fresh(), {
    edit: (body) => {
      body.vault = vault;
    },
    finish: async (body, seq) => {
      if (body.evidence === null || body.proposal === null) return;
      body.evidence = await buildTestEvidence({
        nonce: computeNonce({
          vault,
          prev_link: body.prev_link,
          invoice_hash: body.invoice_hash,
          mandate_id: body.mandate_id,
          seq,
        }),
        requestBody: JSON.stringify({ fixture: "other vault", seq }),
        proposal: body.proposal,
        chatId: `chatcmpl-test-fixture-${seq}`,
        fetchedAt: body.at,
      });
    },
  });
  s.vault = vault;
  for (const key of s.chain.access_keys) {
    if (key.permission !== "FullAccess") key.permission.receiver_id = vault;
  }
  for (const burn of s.chain.burns) burn.intents_owner = vault;
  return s;
}

/** A ledger key rotation inside the anchor range (2, 4]: entries 2 stays with the old key, entries 3 and 4 use the new one. */
async function rotatedInsideRange(): Promise<Snapshot> {
  const s = await rebuildLedger(fresh(), {
    signer: (seq) => (seq >= 3 ? rotatedSigner : honestSigner),
  });
  s.chain.config.ledger_key = TEST_ROTATED_KEY.publicKey;
  accessKeyOf(s, 1).key.public_key = TEST_ROTATED_KEY.publicKey;
  anchorOf(s, 2).ledger_key = TEST_ROTATED_KEY.publicKey;
  return s;
}

describe("the TEST FIXTURE these tests assume (regenerated by Task 6)", () => {
  it("is vault x.vaults.probarion.testnet with 5 entries, 3 anchors and the pinned keys", () => {
    expect(valid.vault).toBe("x.vaults.probarion.testnet");
    expect(valid.vault).toBe(FIXTURE_VAULT);
    expect(valid.network).toBe("testnet");
    expect(valid.ledger.map((e) => [e.body.seq, e.body.kind])).toEqual([
      [0, "decision"],
      [1, "payment"],
      [2, "decision"],
      [3, "payment"],
      [4, "decision"],
    ]);
    expect(valid.chain.anchors.map((a) => [a.seq, a.count])).toEqual([
      [1, 2],
      [2, 4],
      [3, 5],
    ]);
    expect(TEST_LEDGER_KEY.publicKey).toBe("ed25519:7BPBxA6r525pdwRKzkKs6mNXMhEHj9SDSMBqffjYC3hP");
    expect(TEST_ROTATED_KEY.publicKey).toBe("ed25519:DGFjKJDsU9ixUkgXz3gwfusamDgzBkU5oYtxEfxnHMNy");
    expect(TEST_FORGED_KEY.publicKey).toBe("ed25519:8wjq8fTsmpUvSysYUMssR8iFm1KnEKrXa4eBeTZux7wJ");
    expect(FIXTURE_CODE_HASH).toBe("9xTTGSkSHPbw2DCumDxoraeR7uL8Pc2ANm5XKjhohnWL");
    expect(valid.chain.code_hash).toBe(FIXTURE_CODE_HASH);
    expect(valid.chain.factory_version).toBe(1);
    expect(valid.chain.config.factory).toBe(NETWORKS.testnet.factory);
    expect(valid.ledger.map((e) => e.body_hash.slice(0, 12))).toEqual([
      "149be958e282",
      "ca1dc330e863",
      "36ade9632c98",
      "a26591c78c26",
      "349f04dd64fa",
    ]);
  });
});

describe("runChecks on the valid TEST FIXTURE", () => {
  it("passes a–i in order with stable names", async () => {
    const report = await runChecks(fresh(), { now: NOW });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    expect(report.checks.map((c) => c.name)).toEqual(Object.values(CHECK_NAMES));
    expect(Object.values(CHECK_NAMES)).toEqual([
      "ledger-signatures",
      "hash-links",
      "anchors",
      "spends-have-decisions",
      "attestations",
      "vault-locked",
      "intents-keys",
      "burn-memos",
      "factory-version",
    ]);
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
    expect(report).toMatchObject({
      vault: FIXTURE_VAULT,
      entries: 5,
      anchors: 3,
      generated_at: NOW.toISOString(),
      network: "testnet",
    });
  });

  it("reports the attested decisions, the offline caveat, A8 and the rules-only decision in e", async () => {
    const report = await runChecks(fresh(), { now: NOW });
    const detail = check(report, "e").detail;
    expect(detail).toContain("2 attested decisions pass A1–A7");
    expect(detail).toContain("quote not verified offline (run --online for O1)");
    expect(detail).toContain("A8 not run");
    expect(detail).toContain("rules-only");
    expect(detail).toContain("seq 4");
    expect(detail).not.toContain("A1–A6");
  });

  it("does not modify the snapshot it checks, and is deterministic", async () => {
    const s = fresh();
    const before = JSON.stringify(s);
    const first = await runChecks(s, { now: NOW });
    expect(JSON.stringify(s)).toBe(before);
    expect(await runChecks(s, { now: NOW })).toEqual(first);
  });

  it("stamps generated_at with the clock when no now is given", async () => {
    const before = Date.now();
    const report = await runChecks(fresh());
    const stamped = Date.parse(report.generated_at);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it("passes the ledger-key rotations the fixture generates, at either anchor boundary", async () => {
    for (const at of [2, 4]) {
      const report = await runChecks(await makeFixtureSnapshot({ rotateLedgerKeyAtSeq: at }), {
        now: NOW,
      });
      expect(report.ok, `rotation at ${at}`).toBe(true);
      expect(check(report, "a").detail).toContain("2 ledger key(s)");
    }
  });

  it("passes a vault with no entries, no anchors and no spends", async () => {
    const s = fresh();
    s.ledger = [];
    s.chain.anchors = [];
    s.chain.spends = [];
    s.chain.burns = [];
    const report = await runChecks(s, { now: NOW });
    expect(report.ok).toBe(true);
    expect(report).toMatchObject({ entries: 0, anchors: 0 });
  });
});

describe("check a: every entry is signed by the ledger key the chain names for its range", () => {
  it("fails at the first entry signed by a forged signer", async () => {
    const report = await runChecks(await makeFixtureSnapshot({ forgedSignerFromSeq: 3 }), {
      now: NOW,
    });
    expect(onlyFailing(report)).toEqual(["a"]);
    expect(check(report, "a").firstBrokenSeq).toBe(3);
    expect(check(report, "a").detail).toContain("entry 3");
  });

  it("catches a fully self-consistent forged ledger only by comparing signer with the on-chain key", async () => {
    // Every body_hash, link, anchor root, nonce and spend decision_hash of this ledger recomputes, and every
    // signature verifies. `signer` is covered by no hash and no signature, so only check a can see it.
    const s = await makeFixtureSnapshot({ forgedSignerFromSeq: 0 });
    expect(s.ledger.every(verifyEntrySignature)).toBe(true);
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["a"]);
    expect(check(report, "a").firstBrokenSeq).toBe(0);
  });

  it("passes across a set_ledger_key rotation when each anchor range is signed by its anchor's key", async () => {
    const report = await runChecks(await makeFixtureSnapshot({ rotateLedgerKeyAtSeq: 2 }), {
      now: NOW,
    });
    expect(report.ok).toBe(true);
    expect(check(report, "a").detail).toContain("2 ledger key(s)");
  });

  it.each([2, 4])(
    "fails when entries from before a rotation at %i are re-signed with the new key",
    async (at) => {
      const report = await runChecks(
        await makeFixtureSnapshot({ rotateLedgerKeyAtSeq: at, signAllWithRotatedKey: true }),
        { now: NOW },
      );
      expect(onlyFailing(report)).toEqual(["a"]);
      expect(check(report, "a").firstBrokenSeq).toBe(0);
    },
  );

  it("fails a rotation INSIDE an anchor range, whichever key the anchor names", async () => {
    // The fixture generator only rotates at an anchor boundary, so this snapshot is assembled by hand:
    // anchor 2 covers entries 2 and 3, but entry 2 is signed by the old key and entry 3 by the new one.
    const named = await rotatedInsideRange();
    named.chain.anchors[1] = { ...anchorOf(named, 1), ledger_key: TEST_LEDGER_KEY.publicKey };
    const old = await runChecks(named, { now: NOW });
    expect(onlyFailing(old)).toEqual(["a"]);
    expect(check(old, "a").firstBrokenSeq).toBe(3);

    const renamed = await rotatedInsideRange();
    renamed.chain.anchors[1] = { ...anchorOf(renamed, 1), ledger_key: TEST_ROTATED_KEY.publicKey };
    const next = await runChecks(renamed, { now: NOW });
    expect(onlyFailing(next)).toEqual(["a"]);
    expect(check(next, "a").firstBrokenSeq).toBe(2);
  });

  it("fails an unanchored tail entry signed by a key other than config.ledger_key", async () => {
    const s = await rebuildLedger(fresh(), {
      signer: (seq) => (seq === 4 ? forgedSigner : honestSigner),
    });
    s.chain.anchors.pop(); // entry 4 is now past the last anchor
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["a"]);
    expect(check(report, "a").firstBrokenSeq).toBe(4);
    expect(check(report, "c").detail).toContain("not yet anchored");
  });

  it("passes an honestly signed unanchored tail", async () => {
    const s = fresh();
    s.chain.anchors.pop();
    expect((await runChecks(s, { now: NOW })).ok).toBe(true);
  });

  it("fails an unanchored tail when the vault has no ledger key at all", async () => {
    const s = fresh();
    s.chain.anchors.pop();
    s.chain.config.ledger_key = null;
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["a"]);
    expect(check(report, "a").firstBrokenSeq).toBe(4);
    expect(check(report, "a").detail).toContain("no ledger key");
  });

  it("fails when the ledger key is not anchor-only", async () => {
    const s = fresh();
    accessKeyOf(s, 1).permission.method_names = ["anchor", "spend"];
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["a"]);
  });

  it("fails when the ledger key's method list is empty (a function-call key with no methods may call any)", async () => {
    const s = fresh();
    accessKeyOf(s, 1).permission.method_names = [];
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["a"]);
  });

  it("fails when the ledger key's receiver is not the vault", async () => {
    const s = fresh();
    accessKeyOf(s, 1).permission.receiver_id = "intents-stub.probarion.testnet";
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["a"]);
  });

  it("fails when the ledger key is not on the vault at all", async () => {
    const s = fresh();
    s.chain.access_keys.splice(1, 1);
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["a"]);
  });

  it("fails when the ledger key is a FullAccess key (a and f both see it)", async () => {
    const s = fresh();
    const key = s.chain.access_keys[1];
    if (key === undefined) throw new Error("fixture key missing");
    key.permission = "FullAccess";
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["a", "f"]);
  });

  it("checks the current ledger key even when the ledger is empty", async () => {
    const s = fresh();
    s.ledger = [];
    s.chain.anchors = [];
    s.chain.spends = [];
    s.chain.burns = [];
    accessKeyOf(s, 1).permission.method_names = ["anchor", "spend"];
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["a"]);
  });

  it("accepts an anchor that repeats the previous count (the contract allows it)", async () => {
    const s = fresh();
    const last = anchorOf(s, 2);
    s.chain.anchors.push({ ...last, seq: 4, at_ns: "1793874002000000000" });
    const report = await runChecks(s, { now: NOW });
    expect(report.ok).toBe(true);
    expect(check(report, "c").detail).toContain("4 anchors");
  });

  // The forgery this test pins: every NEAR transaction carries an ed25519 signature by the signing key over
  // the 32-byte transaction hash, and both are public. For an anchor transaction the signing key is the
  // ledger key, so (tx hash, signature, ledger key) is a triple that passes verifyEntrySignature as
  // (body_hash, sig, signer) with no secret needed. verifyEntrySignature does not recompute body_hash from
  // the body, so check a cannot see that the body is something else: check b must, and the report must fail.
  it("fails an entry built from a public anchor-transaction (hash, signature, ledger key) triple", async () => {
    const anchorTxHash = sha256Bytes(utf8("TEST FIXTURE anchor transaction"));
    expect(bs58.encode(anchorTxHash)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/); // a real-looking 32-byte tx hash
    const { sig, signer } = await honestSigner(anchorTxHash); // what the chain already shows the world
    const s = fresh();
    s.chain.anchors.pop(); // entry 4 is an unanchored tail entry: no anchor root pins its link
    const real = entryOf(s, 4);
    const forgedBody = { ...real.body, verdict: "allow" as const, amount: "999999999999" };
    const bodyHash = bytesToHex(anchorTxHash);
    const forged: LedgerEntry = {
      body: forgedBody,
      body_hash: bodyHash,
      sig,
      signer,
      link: computeLink(forgedBody.prev_link, bodyHash, sig),
    };
    s.ledger[4] = forged;

    // the triple verifies on its own, and the body does not hash to it
    expect(verifyEntrySignature(forged)).toBe(true);
    expect(signer).toBe(s.chain.config.ledger_key);
    expect(computeBodyHash(forged.body)).not.toBe(forged.body_hash);

    const report = await runChecks(s, { now: NOW });
    expect(report.ok).toBe(false);
    expect(check(report, "b").status).toBe("fail");
    expect(check(report, "b").firstBrokenSeq).toBe(4);
    expect(check(report, "b").detail).toContain("body_hash");
    expect(firstBrokenSeq(report)).toBe(4);
    // Check a's pass says what it proved: a signature over the STORED body_hash, with check b the recompute.
    expect(check(report, "a").detail).toContain("check b");
  });

  it("never reports an entry as signed without saying that check b recomputes the body hash", async () => {
    expect(checkLedgerSignatures(fresh()).detail).toContain("stored body_hash");
    expect(checkLedgerSignatures(fresh()).detail).toContain("check b");
  });
});

describe("check b: body_hash and link recompute, and prev_link chains", () => {
  // probarion-claim: V-TAMPER
  it("fails at the tampered seq when one byte of an entry changes", async () => {
    const s = fresh();
    s.ledger[2] = tamperOneByte(entryOf(s, 2));
    const report = await runChecks(s, { now: NOW });
    // The byte is in the decision's amount: b catches it, and since ICR-4 d also sees that the spend no
    // longer matches the decision. The first broken seq is the tampered entry for both.
    expect(onlyFailing(report)).toEqual(["b", "d"]);
    expect(check(report, "b").firstBrokenSeq).toBe(2);
    expect(check(report, "d").firstBrokenSeq).toBe(2);
    expect(firstBrokenSeq(report)).toBe(2);
  });

  it("fails at the tampered seq when one byte changes that no spend refers to: only b sees it", async () => {
    const s = fresh();
    s.ledger[2] = tamperOneByte(entryOf(s, 2), "request_id");
    expect(entryOf(s, 2).body.request_id).toBe("Xixture-req-1");
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["b"]);
    expect(check(report, "b").firstBrokenSeq).toBe(2);
    expect(firstBrokenSeq(report)).toBe(2);
  });

  it("fails when a link does not recompute", async () => {
    const s = fresh();
    entryOf(s, 0).link = "e".repeat(64);
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["b"]);
    expect(check(report, "b").firstBrokenSeq).toBe(0);
  });

  it("fails a swapped body_hash at that seq in a and b (the signature no longer covers it)", async () => {
    const s = fresh();
    entryOf(s, 1).body_hash = "d".repeat(64);
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["a", "b"]);
    expect(check(report, "a").firstBrokenSeq).toBe(1);
    expect(check(report, "b").firstBrokenSeq).toBe(1);
  });

  it("fails a chain restarted from the zero link in the middle (hand-assembled: buildEntry refuses it)", async () => {
    const s = await rebuildLedger(fresh(), {
      handAssemble: true,
      position: (seq, head) => ({
        seq,
        prev_link: seq === 4 ? ZERO_HEX32 : (head?.link ?? ZERO_HEX32),
      }),
    });
    expect(entryOf(s, 4).body.seq).toBe(4);
    expect(entryOf(s, 4).body.prev_link).toBe(ZERO_HEX32);
    expect(entryOf(s, 4).link).toBe(
      computeLink(ZERO_HEX32, entryOf(s, 4).body_hash, entryOf(s, 4).sig),
    );
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["b"]);
    expect(check(report, "b").firstBrokenSeq).toBe(4);
    expect(check(report, "b").detail).toContain("prev_link");
  });

  it("fails a verbatim replay of entry 0 appended at the end (b by seq, e by position)", async () => {
    const s = fresh();
    s.ledger.push(structuredClone(entryOf(s, 0))); // seq 0, zero prev_link, a valid signature, attested
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["b", "e"]);
    expect(check(report, "b").firstBrokenSeq).toBe(5);
    expect(check(report, "b").detail).toContain("seq 0");
    expect(check(report, "e").firstBrokenSeq).toBe(5);
    expect(check(report, "e").detail).toContain("position");
  });

  it("fails a second chain, freshly signed from seq 0, appended to the first", async () => {
    const s = fresh();
    const restart = await buildEntry(
      {
        ...structuredClone(entryOf(s, 0).body),
        kind: "note",
        request_id: "restart",
        mandate_id: null,
        invoice_hash: null,
        amount: null,
        proposal: null,
        evidence: null,
        rules: [],
        verdict: null,
        decided_by: null,
      },
      honestSigner,
    );
    s.ledger.push(restart); // buildEntry allows seq 0 with the zero link: it is the other chain's first entry
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["b"]);
    expect(check(report, "b").firstBrokenSeq).toBe(5);
  });

  it("fails an entry whose seq skips ahead", async () => {
    const s = await rebuildLedger(fresh(), {
      position: (seq, head) => ({
        seq: seq === 3 ? 7 : seq,
        prev_link: head?.link ?? ZERO_HEX32,
      }),
    });
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["b"]);
    expect(check(report, "b").firstBrokenSeq).toBe(3);
  });

  it("fails an entry that names another vault", async () => {
    const s = await rebuildLedger(fresh(), {
      edit: (body, seq) => {
        if (seq === 3) body.vault = OTHER_VAULT;
      },
    });
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["b"]);
    expect(check(report, "b").firstBrokenSeq).toBe(3);
    expect(check(report, "b").detail).toContain(OTHER_VAULT);
  });

  it("fails a ledger version this verifier does not know", async () => {
    const s = await rebuildLedger(fresh(), {
      edit: (body, seq) => {
        if (seq === 3) (body as { v: number }).v = 2;
      },
    });
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["b"]);
    expect(check(report, "b").firstBrokenSeq).toBe(3);
  });

  it("fails a malformed signature in a and b, naming the seq, without throwing", async () => {
    const s = fresh();
    entryOf(s, 1).sig = "ed25519:abc";
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["a", "b"]);
    expect(check(report, "b").firstBrokenSeq).toBe(1);
  });

  it("fails a body that is not canonical JSON", async () => {
    const s = fresh();
    (entryOf(s, 3).body as unknown as { amount: unknown }).amount = undefined;
    const report = await runChecks(s, { now: NOW });
    expect(check(report, "b").status).toBe("fail");
    expect(check(report, "b").firstBrokenSeq).toBe(3);
  });
});

describe("check c: anchors", () => {
  it("fails when an anchor root does not match", async () => {
    const s = fresh();
    anchorOf(s, 1).root = "f".repeat(64);
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["c"]);
    expect(check(report, "c").firstBrokenSeq).toBe(2);
  });

  it("fails when the ledger is truncated below an anchored count", async () => {
    const s = fresh();
    s.ledger = s.ledger.slice(0, 3);
    const report = await runChecks(s, { now: NOW });
    expect(check(report, "c").status).toBe("fail");
    expect(check(report, "c").firstBrokenSeq).toBe(3);
  });

  it("fails entries with no anchor on chain, and passes none with none", async () => {
    const s = fresh();
    s.chain.anchors = [];
    const report = await runChecks(s, { now: NOW });
    expect(check(report, "c").status).toBe("fail");
    expect(check(report, "c").firstBrokenSeq).toBe(0);
    s.ledger = [];
    s.chain.spends = [];
    s.chain.burns = [];
    expect(checkAnchors(s).status).toBe("pass");
  });

  it("fails an anchor sequence with a gap", async () => {
    const s = fresh();
    s.chain.anchors.splice(1, 1); // seqs 1 and 3
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["c"]);
    expect(check(report, "c").firstBrokenSeq).toBe(2);
  });

  it("fails an anchor whose count goes backwards", async () => {
    const s = fresh();
    anchorOf(s, 2).count = 3;
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["c"]);
  });

  it("fails a count that is not a whole number, without throwing", async () => {
    const s = fresh();
    anchorOf(s, 1).count = 2.5;
    expect(check(await runChecks(s, { now: NOW }), "c").status).toBe("fail");
  });

  it("orders anchors by seq, whatever order the snapshot lists them in", async () => {
    const s = fresh();
    s.chain.anchors.reverse();
    expect((await runChecks(s, { now: NOW })).ok).toBe(true);
  });
});

describe("check d: every on-chain spend is bound to exactly one allow decision in the ledger", () => {
  it("fails for a spend with an unknown decision_hash", async () => {
    const s = fresh();
    spendOf(s, 0).decision_hash = "a".repeat(64);
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["d"]);
  });

  it("reports a spend whose decision hash is documented as pre-ledger", async () => {
    const s = fresh();
    const v0Decision = sha256Hex('{"kind":"v0-manual-decision","mandate_id":1}');
    spendOf(s, 0).decision_hash = v0Decision;
    s.pre_ledger_decision_hashes = [v0Decision];
    const report = await runChecks(s, { now: NOW });
    expect(report.ok).toBe(true);
    expect(check(report, "d").detail).toContain("pre-ledger (documented)");
  });

  it("does not excuse a spend whose decision hash is not the documented one", async () => {
    const s = fresh();
    spendOf(s, 0).decision_hash = sha256Hex("an undocumented decision");
    s.pre_ledger_decision_hashes = [sha256Hex("some other documented decision")];
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["d"]);
  });

  it("fails for a spend pointing at a refused decision", async () => {
    const s = fresh();
    spendOf(s, 0).decision_hash = entryOf(s, 4).body_hash;
    const report = await runChecks(s, { now: NOW });
    expect(check(report, "d").status).toBe("fail");
    expect(check(report, "d").firstBrokenSeq).toBe(4);
  });

  it("fails for a spend pointing at a payment entry, which is not a decision", async () => {
    const s = fresh();
    spendOf(s, 0).decision_hash = entryOf(s, 1).body_hash;
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["d"]);
  });

  it("fails a spend pointing at a payment entry even when that entry carries an allow verdict", async () => {
    // Only entries of kind "decision" count: a payment that merely says verdict "allow" is not a decision.
    const s = await rebuildLedger(fresh(), {
      edit: (body, seq) => {
        if (seq === 3) body.verdict = "allow";
      },
    });
    spendOf(s, 0).decision_hash = entryOf(s, 3).body_hash;
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["d"]);
    expect(check(report, "d").detail).toContain("not a decision in the ledger");
  });

  describe("ICR-4: a spend is bound to its decision, and a decision to one spend", () => {
    /** The time a held spend's hold runs out: the contract sets held_until_ns when it holds a spend. */
    const HELD_UNTIL_NS = "1793873420000000000";

    function withHoldDecision(): Promise<Snapshot> {
      return rebuildLedger(fresh(), {
        edit: (body, seq) => {
          if (seq === 2) body.verdict = "hold";
        },
      });
    }

    it("accepts a hold decision for a spend that went through held (approved, then burned)", async () => {
      const s = await withHoldDecision();
      spendOf(s, 1).held_until_ns = HELD_UNTIL_NS; // status stays "burned": held, approved, paid out
      const report = await runChecks(s, { now: NOW });
      expect(report.ok).toBe(true);
      expect(check(report, "d").status).toBe("pass");
    });

    it("accepts a hold decision for a spend that is still held, rejected or expired", async () => {
      for (const status of ["held", "rejected", "expired"] as const) {
        const s = await withHoldDecision();
        spendOf(s, 1).held_until_ns = HELD_UNTIL_NS;
        spendOf(s, 1).status = status;
        s.chain.burns = []; // only a burned spend needs a burn pair (check h)
        expect(check(await runChecks(s, { now: NOW }), "d").status, status).toBe("pass");
      }
    });

    it("fails a hold decision for a spend that never went through held: no approver was involved", async () => {
      const s = await withHoldDecision();
      expect(spendOf(s, 1).held_until_ns).toBeNull();
      const report = await runChecks(s, { now: NOW });
      expect(onlyFailing(report)).toEqual(["d"]);
      expect(check(report, "d").firstBrokenSeq).toBe(2);
      expect(check(report, "d").detail).toContain("never went through held");
    });

    it("accepts an allow decision for a spend the contract held (the threshold is the contract's own)", async () => {
      const s = fresh();
      spendOf(s, 0).held_until_ns = HELD_UNTIL_NS;
      expect((await runChecks(s, { now: NOW })).ok).toBe(true);
    });

    it("fails a spend whose decision was a refuse, even when invoice, mandate and amount match", async () => {
      const s = await rebuildLedger(fresh(), {
        edit: (body, seq) => {
          if (seq === 2) body.verdict = "refuse";
        },
      });
      const report = await runChecks(s, { now: NOW });
      expect(onlyFailing(report)).toEqual(["d"]);
      expect(check(report, "d").firstBrokenSeq).toBe(2);
      expect(check(report, "d").detail).toContain("verdict refuse");
    });

    it("fails a spend whose amount differs from its decision's", async () => {
      const s = fresh();
      spendOf(s, 0).amount = "25000001";
      const report = await runChecks(s, { now: NOW });
      expect(onlyFailing(report)).toEqual(["d"]);
      expect(check(report, "d").firstBrokenSeq).toBe(0);
      expect(check(report, "d").detail).toContain("amount 25000001 vs 25000000");
    });

    it("fails a spend whose invoice_hash differs from its decision's", async () => {
      const s = fresh();
      spendOf(s, 0).invoice_hash = sha256Hex("another invoice");
      const report = await runChecks(s, { now: NOW });
      expect(onlyFailing(report)).toEqual(["d"]);
      expect(check(report, "d").firstBrokenSeq).toBe(0);
      expect(check(report, "d").detail).toContain("invoice_hash");
    });

    it("fails a spend whose mandate_id differs from its decision's", async () => {
      const s = fresh();
      spendOf(s, 0).mandate_id = 2;
      const report = await runChecks(s, { now: NOW });
      expect(onlyFailing(report)).toEqual(["d"]);
      expect(check(report, "d").firstBrokenSeq).toBe(0);
      expect(check(report, "d").detail).toContain("mandate_id 2 vs 1");
    });

    it("names every field that differs", async () => {
      const s = fresh();
      Object.assign(spendOf(s, 0), { amount: "1", mandate_id: 2, invoice_hash: "c".repeat(64) });
      const detail = check(await runChecks(s, { now: NOW }), "d").detail;
      for (const field of ["invoice_hash", "mandate_id", "amount"]) expect(detail).toContain(field);
    });

    it("fails a spend sent for a decision that recorded no amount", async () => {
      const s = await rebuildLedger(fresh(), {
        edit: (body, seq) => {
          if (seq === 2) body.amount = null;
        },
      });
      const report = await runChecks(s, { now: NOW });
      expect(onlyFailing(report)).toEqual(["d"]);
      expect(check(report, "d").firstBrokenSeq).toBe(2);
      expect(check(report, "d").detail).toContain("amount 40000000 vs null");
    });

    it("fails two spends that reference one decision, naming both", async () => {
      // The contract does not de-duplicate decision_hash. This second spend equals the first in invoice,
      // mandate and amount, so only the one-spend-per-decision rule can stop it.
      const s = fresh();
      s.chain.spends.push({ ...structuredClone(spendOf(s, 0)), id: 3 });
      const report = await runChecks(s, { now: NOW });
      expect(onlyFailing(report)).toEqual(["d"]);
      expect(check(report, "d").firstBrokenSeq).toBe(0);
      expect(check(report, "d").detail).toContain("spends 1 and 3");
      expect(check(report, "d").detail).toContain("exactly one spend");
    });

    it("fails a second spend for another invoice that reuses an allow decision", async () => {
      const s = fresh();
      s.chain.spends.push({
        ...structuredClone(spendOf(s, 0)),
        id: 3,
        invoice_hash: sha256Hex("a different invoice"),
        ref: "FIX-REUSE",
      });
      const report = await runChecks(s, { now: NOW });
      expect(onlyFailing(report)).toEqual(["d"]);
      expect(check(report, "d").detail).toContain("spend 3");
      expect(check(report, "d").detail).toContain("invoice_hash");
    });

    it("judges spends in id order, whatever order the snapshot lists them in", async () => {
      const s = fresh();
      s.chain.spends.push({ ...structuredClone(spendOf(s, 0)), id: 3 });
      s.chain.spends.reverse();
      expect(check(await runChecks(s, { now: NOW }), "d").detail).toContain("spends 1 and 3");
    });

    it("keeps the pre-ledger exemption: documented spends need no decision, binding or uniqueness", async () => {
      const s = fresh();
      const v0Decision = sha256Hex('{"kind":"v0-manual-decision","mandate_id":1}');
      spendOf(s, 0).decision_hash = v0Decision;
      s.chain.spends.push({
        ...structuredClone(spendOf(s, 0)),
        id: 3,
        amount: "7",
        invoice_hash: sha256Hex("another v0 invoice"),
      });
      s.pre_ledger_decision_hashes = [v0Decision];
      const report = await runChecks(s, { now: NOW });
      expect(report.ok).toBe(true);
      expect(check(report, "d").detail).toContain("2 pre-ledger (documented)");
    });

    it("applies the rules to a spend whose hash is both in the ledger and documented as pre-ledger", async () => {
      const s = fresh();
      spendOf(s, 0).amount = "25000001";
      s.pre_ledger_decision_hashes = [spendOf(s, 0).decision_hash];
      expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["d"]);
    });
  });
});

describe("check e: attestations", () => {
  it("fails at the seq whose attestation carries a wrong nonce", async () => {
    const report = await runChecks(await makeFixtureSnapshot({ wrongNonceAtSeq: 2 }), { now: NOW });
    expect(onlyFailing(report)).toEqual(["e"]);
    expect(check(report, "e").firstBrokenSeq).toBe(2);
    expect(check(report, "e").detail).toContain("A6");
  });

  it("fails for a model+rules decision without evidence", async () => {
    const s = await rebuildLedger(fresh(), {
      edit: (body, seq) => {
        if (seq === 4) body.decided_by = "model+rules";
      },
    });
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["e"]);
    expect(check(report, "e").firstBrokenSeq).toBe(4);
    expect(check(report, "e").detail).toContain("no evidence");
  });

  it("fails a decision whose decided_by is neither model+rules nor rules-only", async () => {
    const s = await rebuildLedger(fresh(), {
      edit: (body, seq) => {
        if (seq === 4) body.decided_by = null;
      },
    });
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["e"]);
    expect(check(report, "e").firstBrokenSeq).toBe(4);
  });

  it("fails A7 when the recorded proposal differs from the one the model signed", async () => {
    const s = await rebuildLedger(fresh(), {
      edit: (body, seq) => {
        if (seq === 2 && body.proposal !== null) body.proposal.action = "refuse";
      },
    });
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["e"]);
    expect(check(report, "e").firstBrokenSeq).toBe(2);
    expect(check(report, "e").detail).toContain("A7");
    expect(check(report, "e").detail).not.toContain("A6");
  });

  it("fails A7 when an entry with evidence has no recorded proposal", async () => {
    const s = await rebuildLedger(fresh(), {
      edit: (body, seq) => {
        if (seq === 2) body.proposal = null;
      },
    });
    const report = await runChecks(s, { now: NOW });
    expect(check(report, "e").status).toBe("fail");
    expect(check(report, "e").detail).toContain("no recorded proposal");
  });

  it("fails evidence copied from another vault's decision at the same position (A6: the nonce binds the vault)", async () => {
    // Same invoice, mandate, prev_link and seq as vault x's seq 0 decision, with x's evidence copied in. Every
    // hash, signature, link, anchor and spend of the new vault is consistent: only the nonce differs.
    const s = await retargeted(fresh(), OTHER_VAULT);
    expect(entryOf(s, 0).body.evidence?.nonce).toBe(entryOf(valid, 0).body.evidence?.nonce);
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["e"]);
    expect(check(report, "e").firstBrokenSeq).toBe(0);
    expect(check(report, "e").detail).toContain("A6");
  });

  it("passes the same ledger when it is genuinely issued for the other vault (the positive control)", async () => {
    const other = await validFor(OTHER_VAULT);
    const report = await runChecks(other, { now: NOW });
    expect(report.ok).toBe(true);
    expect(report.vault).toBe(OTHER_VAULT);
  });

  it("fails an attested entry whose body names a vault other than the snapshot's, even with that vault's own nonce", async () => {
    // Every entry, signature, link and nonce is valid for OTHER_VAULT; the snapshot presents them as vault x.
    const s = await validFor(OTHER_VAULT);
    s.vault = FIXTURE_VAULT;
    for (const key of s.chain.access_keys) {
      if (key.permission !== "FullAccess") key.permission.receiver_id = FIXTURE_VAULT;
    }
    burnOf(s).intents_owner = FIXTURE_VAULT;
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["b", "e"]);
    expect(check(report, "e").firstBrokenSeq).toBe(0);
    expect(check(report, "e").detail).toContain(OTHER_VAULT);
    expect(check(report, "e").detail).toContain("wrong vault");
  });

  it("fails evidence on a payment entry (it has no proposal to bind)", async () => {
    const s = await rebuildLedger(fresh(), {
      edit: (body, seq) => {
        if (seq === 1) body.evidence = structuredClone(entryOf(valid, 0).body.evidence);
      },
    });
    const report = await runChecks(s, { now: NOW });
    expect(check(report, "e").status).toBe("fail");
    expect(check(report, "e").firstBrokenSeq).toBe(1);
  });

  it("reports, and does not fail, a rules-only decision whose evidence does not verify", async () => {
    const wrong = await makeFixtureSnapshot({ wrongNonceAtSeq: 2 });
    const s = await rebuildLedger(wrong, {
      edit: (body, seq) => {
        if (seq === 2) body.decided_by = "rules-only";
      },
    });
    const report = await runChecks(s, { now: NOW });
    expect(report.ok).toBe(true);
    expect(check(report, "e").detail).toContain("1 attested decisions pass A1–A7");
    expect(check(report, "e").detail).toContain("unattested: A6");
  });

  it("fails evidence that is not an object, without throwing", async () => {
    const s = fresh();
    (entryOf(s, 2).body as unknown as { evidence: unknown }).evidence = "garbage";
    const report = await runChecks(s, { now: NOW });
    expect(check(report, "e").status).toBe("fail");
    expect(check(report, "e").firstBrokenSeq).toBe(2);
  });

  it("states what it did not prove even when no decision is attested", async () => {
    const s = fresh();
    s.ledger = [];
    s.chain.anchors = [];
    s.chain.spends = [];
    s.chain.burns = [];
    const detail = (await checkAttestations(s)).detail;
    expect(detail).toContain("0 attested decisions pass A1–A7");
    expect(detail).toContain("quote not verified offline");
    expect(detail).toContain("A8 not run");
  });
});

describe("check f: vault locked to a reproducible build", () => {
  it("fails when a FullAccess key is present", async () => {
    const s = fresh();
    s.chain.access_keys.push({ public_key: TEST_FORGED_KEY.publicKey, permission: "FullAccess" });
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["f"]);
  });

  it("fails when the code hash is not an expected build", async () => {
    const s = fresh();
    s.chain.code_hash = "11111111111111111111111111111111";
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["f"]);
  });

  it("fails an account with no contract code even if the snapshot lists the zero hash as expected", async () => {
    const s = fresh();
    s.chain.code_hash = ZERO_CODE_HASH;
    s.expected_code_hashes = [ZERO_CODE_HASH, ZERO_HEX32];
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["f"]);
    expect(check(report, "f").detail).toContain("no contract code");
  });

  it("accepts a recorded reproducible vault build with an empty expected list (KNOWN_VAULT_CODE_HASHES)", async () => {
    const s = fresh();
    s.chain.code_hash = KNOWN_VAULT_HASH;
    s.expected_code_hashes = [];
    const report = await runChecks(s, { now: NOW });
    expect(report.ok).toBe(true);
    expect(check(report, "f").detail).toContain("recorded reproducible build");
  });

  it("accepts the hex spelling of the same hash", async () => {
    const s = fresh();
    s.chain.code_hash = bytesToHex(bs58.decode(KNOWN_VAULT_HASH)).toUpperCase();
    s.expected_code_hashes = [];
    expect(check(await runChecks(s, { now: NOW }), "f").status).toBe("pass");
  });

  it("rejects a factory build: the factory wasm is not a vault", async () => {
    const s = fresh();
    s.chain.code_hash = FACTORY_BUILD_HASH;
    s.expected_code_hashes = [];
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["f"]);
  });

  it("says when a build is accepted only because the snapshot listed it", async () => {
    const report = await runChecks(fresh(), { now: NOW });
    expect(check(report, "f").status).toBe("pass");
    expect(check(report, "f").detail).toContain("supplied by the snapshot");
  });

  it("ignores expected entries that are not sha256 hashes, and fails a code hash that is not one", async () => {
    const s = fresh();
    s.expected_code_hashes = ["not-a-hash", "", FIXTURE_CODE_HASH];
    expect(check(await runChecks(s, { now: NOW }), "f").status).toBe("pass");
    s.chain.code_hash = "not-a-hash";
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["f"]);
    expect(check(report, "f").detail).toContain("not a sha256 hash");
  });

  it("needs no special case for global-mode vaults: the snapshot carries the global contract hash", async () => {
    // R6: the SDK puts global_contract_hash into chain.code_hash, so a global-mode vault's hash is just a hash.
    const s = fresh();
    s.chain.code_hash = KNOWN_VAULT_HASH;
    s.chain.factory_versions = [
      { index: 1, code_hash: KNOWN_VAULT_HASH, mode: "global", notes: "", at_ns: "1" },
    ];
    s.expected_code_hashes = [KNOWN_VAULT_HASH];
    expect((await runChecks(s, { now: NOW })).ok).toBe(true);
  });
});

describe("check g: intents keys", () => {
  it("fails when a key is registered for the vault in intents", async () => {
    const s = fresh();
    s.chain.intents_public_keys = [TEST_FORGED_KEY.publicKey];
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["g"]);
  });

  it("fails when predecessor auth is disabled", async () => {
    const s = fresh();
    s.chain.intents_predecessor_auth = false;
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["g"]);
  });

  it("fails when predecessor auth is anything but the boolean true", async () => {
    const s = fresh();
    (s.chain as unknown as { intents_predecessor_auth: unknown }).intents_predecessor_auth =
      "false";
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["g"]);
  });
});

describe("check h: burn memos (Snapshot.burns is the matched-pair summary)", () => {
  it("fails for a burn with a wrong memo", async () => {
    const s = fresh();
    burnOf(s).memo = `${WITHDRAW_MEMO_PREFIX}0x000000000000000000000000000000000000dEaD`;
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["h"]);
    expect(check(report, "h").firstBrokenSeq).toBe(2);
  });

  it("fails when the intents mt_burn owner is not the vault", async () => {
    const s = fresh();
    burnOf(s).intents_owner = "someone-else.testnet";
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["h"]);
  });

  it("fails when the intents mt_burn amount differs from the spend", async () => {
    const s = fresh();
    burnOf(s).amount = "39999999";
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["h"]);
  });

  it("fails when a burned spend has no observed burn", async () => {
    const s = fresh();
    s.chain.burns = [];
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["h"]);
  });

  it("fails when the burn is recorded as missing", async () => {
    const s = fresh();
    burnOf(s).status = "missing";
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["h"]);
  });

  it("fails when the spend's own memo is not the withdraw memo", async () => {
    const s = fresh();
    spendOf(s, 1).memo = `${WITHDRAW_MEMO_PREFIX}0x000000000000000000000000000000000000dEaD`;
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["h"]);
    expect(check(report, "h").firstBrokenSeq).toBe(2);
  });

  it("compares the memo exactly: a trailing space is a different memo", async () => {
    const s = fresh();
    burnOf(s).memo = `${burnOf(s).memo} `;
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["h"]);
  });

  it("fails a burned spend that pays a NEAR account", async () => {
    const s = fresh();
    spendOf(s, 1).destination = { type: "near", account_id: "vendor.fixture.testnet" };
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["h"]);
    expect(check(report, "h").detail).toContain("NEAR account");
  });

  it("fails an ambiguous burn record: two burns for one spend", async () => {
    const s = fresh();
    s.chain.burns.push({
      ...burnOf(s),
      memo: `${WITHDRAW_MEMO_PREFIX}0x2222222222222222222222222222222222222222`,
    });
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["h"]);
  });

  it("passes when no spend was burned", async () => {
    const s = fresh();
    spendOf(s, 1).status = "paid";
    s.chain.burns = [];
    const report = await runChecks(s, { now: NOW });
    expect(check(report, "h").status).toBe("pass");
    expect(check(report, "h").detail).toContain("0 burns");
  });
});

describe("check i: factory version (ids are 1-based, R14)", () => {
  it("fails for an unknown factory version and skips non-factory vaults", async () => {
    const s = fresh();
    s.chain.factory_version = 7;
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["i"]);
    const plain = fresh();
    plain.chain.config.factory = null;
    const report = await runChecks(plain, { now: NOW });
    expect(check(report, "i").status).toBe("skip");
    expect(report.ok).toBe(true);
  });

  it("fails factory_version 0: ids start at 1, so 0 is no version", async () => {
    const s = fresh();
    s.chain.factory_version = 0;
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["i"]);
    expect(check(report, "i").detail).toContain("1-based");
  });

  it("fails factory_version 0 even if the list holds an index 0 (a falsy-zero bug must not hide)", async () => {
    const s = fresh();
    s.chain.factory_version = 0;
    s.chain.factory_versions = [
      { index: 0, code_hash: FIXTURE_CODE_HASH, mode: "global", notes: "", at_ns: "1" },
      ...s.chain.factory_versions,
    ];
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["i"]);
  });

  it.each([-1, 1.5, Number.NaN])("fails factory_version %s", async (version) => {
    const s = fresh();
    s.chain.factory_version = version;
    expect(onlyFailing(await runChecks(s, { now: NOW }))).toEqual(["i"]);
  });

  it("fails a factory vault the factory has no version record for", async () => {
    const s = fresh();
    s.chain.factory_version = null;
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["i"]);
    expect(check(report, "i").detail).toContain("no version record");
  });

  it("passes factory_version 1, the first version the factory registers", async () => {
    const report = await runChecks(fresh(), { now: NOW });
    expect(check(report, "i").status).toBe("pass");
    expect(check(report, "i").detail).toContain("version 1");
  });

  it("fails a vault whose factory is not the Probarion factory of the network (the vault records its deployer)", async () => {
    const s = fresh();
    s.chain.config.factory = "factory.evil.testnet";
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["i"]);
    expect(check(report, "i").detail).toContain(NETWORKS.testnet.factory);
    const wrongNetwork = fresh();
    wrongNetwork.network = "mainnet";
    expect(onlyFailing(await runChecks(wrongNetwork, { now: NOW }))).toEqual(["i"]);
  });
});

describe("runChecks never throws and never passes a malformed snapshot", () => {
  it("fails on an empty entry, naming its seq", async () => {
    const s = fresh();
    s.ledger[1] = {} as LedgerEntry;
    const report = await runChecks(s, { now: NOW });
    expect(report.ok).toBe(false);
    expect(check(report, "b").firstBrokenSeq).toBe(1);
  });

  const DELETE = Symbol("delete");
  type Path = (string | number)[];
  const mutations: [string, Path, unknown][] = [
    ["ledger is an object", ["ledger"], {}],
    ["ledger is a string", ["ledger"], "x"],
    ["ledger is missing", ["ledger"], DELETE],
    ["chain is null", ["chain"], null],
    ["access_keys is missing", ["chain", "access_keys"], DELETE],
    ["anchors is an object", ["chain", "anchors"], {}],
    ["spends is null", ["chain", "spends"], null],
    ["burns is a string", ["chain", "burns"], "x"],
    ["config is null", ["chain", "config"], null],
    ["factory_versions is null", ["chain", "factory_versions"], null],
    ["intents_public_keys is missing", ["chain", "intents_public_keys"], DELETE],
    ["code_hash is a number", ["chain", "code_hash"], 7],
    ["expected_code_hashes is missing", ["expected_code_hashes"], DELETE],
    ["pre_ledger_decision_hashes is a string", ["pre_ledger_decision_hashes"], "x"],
    ["network is unknown", ["network"], "devnet"],
    ["version is 2", ["v"], 2],
    ["vault is empty", ["vault"], ""],
    ["an entry is null", ["ledger", 0], null],
    ["an entry body is null", ["ledger", 2, "body"], null],
    ["an entry body_hash is a number", ["ledger", 2, "body_hash"], 7],
    ["an entry sig is null", ["ledger", 3, "sig"], null],
    ["an entry signer is missing", ["ledger", 3, "signer"], DELETE],
    ["evidence is a string", ["ledger", 2, "body", "evidence"], "garbage"],
    ["evidence has no signature", ["ledger", 2, "body", "evidence", "signature"], DELETE],
    ["an anchor is null", ["chain", "anchors", 0], null],
    ["a spend is null", ["chain", "spends", 0], null],
    ["a burn is null", ["chain", "burns", 0], null],
    ["an access key is null", ["chain", "access_keys", 0], null],
    ["a spend destination is null", ["chain", "spends", 1, "destination"], null],
  ];

  function mutate(snapshot: Snapshot, path: Path, value: unknown): void {
    let node: unknown = snapshot;
    for (const step of path.slice(0, -1)) node = (node as Record<string | number, unknown>)[step];
    const last = path.at(-1);
    if (last === undefined) throw new Error("empty path");
    if (value === DELETE) delete (node as Record<string | number, unknown>)[last];
    else (node as Record<string | number, unknown>)[last] = value;
  }

  it.each(mutations)("fails, and does not throw, when %s", async (_name, path, value) => {
    const s = fresh();
    mutate(s, path, value);
    const report = await runChecks(s, { now: NOW });
    expect(report.ok).toBe(false);
    expect(report.checks.map((c) => c.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
  });

  it.each([null, undefined, 7, "x", [], {}])(
    "fails, and does not throw, for the snapshot %j",
    async (garbage) => {
      const report = await runChecks(garbage as unknown as Snapshot, { now: NOW });
      expect(report.ok).toBe(false);
      expect(report.checks).toHaveLength(9);
      expect(report.checks.every((c) => c.status === "fail")).toBe(true);
    },
  );

  it("tolerates a snapshot without pre_ledger_decision_hashes (nothing is documented, nothing is excused)", async () => {
    const s = fresh() as unknown as Record<string, unknown>;
    delete s.pre_ledger_decision_hashes;
    expect((await runChecks(s as unknown as Snapshot, { now: NOW })).ok).toBe(true);
  });
});

describe("firstBrokenSeq", () => {
  it("is null for a report with no failure that names a seq", async () => {
    expect(firstBrokenSeq(await runChecks(fresh(), { now: NOW }))).toBeNull();
    const s = fresh();
    s.chain.intents_predecessor_auth = false;
    expect(firstBrokenSeq(await runChecks(s, { now: NOW }))).toBeNull();
  });

  it("is the lowest seq over all failing checks", async () => {
    const s = await makeFixtureSnapshot({ forgedSignerFromSeq: 3 });
    burnOf(s).memo = `${WITHDRAW_MEMO_PREFIX}0x000000000000000000000000000000000000dEaD`;
    const report = await runChecks(s, { now: NOW });
    expect(onlyFailing(report)).toEqual(["a", "h"]);
    expect(check(report, "a").firstBrokenSeq).toBe(3);
    expect(check(report, "h").firstBrokenSeq).toBe(2);
    expect(firstBrokenSeq(report)).toBe(2);
  });
});

describe("the single checks can be called on their own", () => {
  it("each returns its own id and name for the valid snapshot", async () => {
    const s = fresh();
    const results = [
      checkLedgerSignatures(s),
      checkHashLinks(s),
      checkAnchors(s),
      checkSpendsHaveDecisions(s),
      await checkAttestations(s),
      checkVaultLocked(s),
      checkIntentsKeys(s),
      checkBurnMemos(s),
      checkFactoryVersion(s),
    ];
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    expect(results.map((r) => r.name)).toEqual(Object.values(CHECK_NAMES));
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });
});

describe("normalizeCodeHash", () => {
  it("maps base58 and hex forms of the same sha256 to one value", () => {
    const hex = "ab".repeat(32);
    const fromHex = normalizeCodeHash(hex);
    expect(fromHex).toBe(hex);
    expect(normalizeCodeHash(valid.chain.code_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(normalizeCodeHash("not-a-hash")).toBeNull();
  });

  it("agrees on base58 and hex, lowercases hex, and refuses anything that is not 32 bytes", () => {
    const raw = bs58.decode(KNOWN_VAULT_HASH);
    expect(normalizeCodeHash(KNOWN_VAULT_HASH)).toBe(bytesToHex(raw));
    expect(normalizeCodeHash(bytesToHex(raw).toUpperCase())).toBe(bytesToHex(raw));
    expect(normalizeCodeHash(bs58.encode(raw.slice(0, 31)))).toBeNull();
    expect(normalizeCodeHash(bs58.encode(new Uint8Array(33)))).toBeNull();
    expect(normalizeCodeHash("ab".repeat(31))).toBeNull();
    expect(normalizeCodeHash("")).toBeNull();
    expect(normalizeCodeHash(7 as unknown as string)).toBeNull();
    expect(normalizeCodeHash(ZERO_CODE_HASH)).toBe(ZERO_HEX32);
  });
});
