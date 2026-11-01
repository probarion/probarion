// TEST FIXTURES ONLY. Deterministic generator of a valid Snapshot, built from fixed test keys and a
// local secp256k1 "TEE" key. Nothing here is a real vault, a real payment or a real attestation.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import bs58 from "bs58";
import { NETWORKS, WITHDRAW_MEMO_PREFIX } from "../../src/constants.js";
import { sha256Bytes, sha256Hex } from "../../src/hash.js";
import { utf8 } from "../../src/hex.js";
import { createEd25519Signer, type LedgerSigner } from "../../src/keys.js";
import { buildEntry, computeNonce, nextBodyFields } from "../../src/ledger.js";
import { DEFAULT_CONFIDENCE_FLOOR, decide } from "../../src/policy.js";
import type {
  AttestationEvidence,
  InvoiceFacts,
  LedgerEntry,
  LedgerEntryBody,
  MandateView,
  ModelProposal,
  Payee,
  Snapshot,
  SpendView,
  Verdict,
} from "../../src/types.js";
import { buildTestEvidence, FIXTURE_LABEL } from "./evidence.js";
import { TEST_AGENT_KEY, TEST_FORGED_KEY, TEST_LEDGER_KEY, TEST_ROTATED_KEY } from "./keys.js";

/**
 * A one-character name: the factory's `valid_name` needs 2 to 31 characters, so this account can
 * never be created on a real testnet and the fixture can never be mistaken for a real vault.
 */
export const FIXTURE_VAULT = "x.vaults.probarion.testnet";
export const FIXTURE_TAKEN_AT = "2026-11-05T12:00:00.000Z";
export const FIXTURE_CODE_HASH = bs58.encode(
  sha256Bytes(utf8("probarion/test-fixture/vault-wasm")),
);
export const FIXTURE_NEAR_PAYEE = "vendor.fixture.testnet";
export const FIXTURE_BASE_ADDRESS = "0x1111111111111111111111111111111111111111";
export const FIXTURE_PURPOSE_NEAR = sha256Hex("TEST FIXTURE PO-1001");
export const FIXTURE_PURPOSE_BASE = sha256Hex("TEST FIXTURE PO-2002");
export const FIXTURE_FACTORY_NOTES = "TEST FIXTURE factory version";

const INVOICE_A = sha256Hex("TEST FIXTURE invoice A");
const INVOICE_B = sha256Hex("TEST FIXTURE invoice B");
const INVOICE_INJECTED = sha256Hex("TEST FIXTURE injected invoice");
const BASE_ASSET = NETWORKS.testnet.allowedAssets.base;
const BURN_MEMO = `${WITHDRAW_MEMO_PREFIX}${FIXTURE_BASE_ADDRESS}`;
/** A NEAR transaction hash is 32 bytes in base58. */
const txHash = (label: string): string => bs58.encode(sha256Bytes(utf8(label)));
const TX_A = txHash("TEST FIXTURE spend tx A");
const TX_B = txHash("TEST FIXTURE spend tx B");

const NEAR_PAYEE: Payee = { type: "near", account_id: FIXTURE_NEAR_PAYEE };
const BASE_PAYEE: Payee = {
  type: "intents",
  chain: "base",
  address: FIXTURE_BASE_ADDRESS,
  asset: BASE_ASSET,
};

/** The ledger holds seqs 0..4. Anchors cover (previous count, count]: seqs 0-1, 2-3 and 4. */
const LEDGER_LENGTH = 5;
const ANCHORS = [
  { count: 2, at_ns: "1793872806000000000" },
  { count: 4, at_ns: "1793873421000000000" },
  { count: 5, at_ns: "1793874001000000000" },
] as const;
/** A ledger-key rotation can only happen between two anchors: at the first seq of an anchor range. */
const ROTATION_SEQS: readonly number[] = ANCHORS.map((a) => a.count).filter(
  (count) => count < LEDGER_LENGTH,
);

export interface FixtureOptions {
  /** Build the evidence at this seq with a nonce that does not match its ledger context (A6 fails). Must be an attested seq (0 or 2). */
  wrongNonceAtSeq?: number;
  /** Sign entries from this seq on with a key that is not the vault's ledger key (check a fails). Any seq of the ledger (0 to 4). */
  forgedSignerFromSeq?: number;
  /**
   * set_ledger_key rotation before this seq: later entries, the anchors covering them and config.ledger_key
   * use TEST_ROTATED_KEY, and the rotated key replaces the old one in access_keys. Only at an anchor
   * boundary (2 or 4): check a (v2) expects the entries of an anchor range to be signed by that anchor's
   * ledger_key, so a rotation inside a range could never be valid.
   */
  rotateLedgerKeyAtSeq?: number;
  /** With a rotation, also sign the older entries with the rotated key (an old entry re-signed with the new key: check a fails). */
  signAllWithRotatedKey?: boolean;
}

type DraftBody = Omit<LedgerEntryBody, "seq" | "prev_link" | "evidence">;
interface Draft {
  body: DraftBody;
  attested: boolean;
  decisionOf?: number;
}

/** One on-chain spend of the fixture: everything but `decision_hash`, which is its decision's body_hash. */
interface FixtureSpend {
  view: Omit<SpendView, "decision_hash">;
  tx_hash: string;
}

const SPEND_A: FixtureSpend = {
  tx_hash: TX_A,
  view: {
    id: 1,
    mandate_id: 1,
    amount: "25000000",
    invoice_hash: INVOICE_A,
    ref: "FIX-INV-A",
    agent_pk: TEST_AGENT_KEY.publicKey,
    destination: NEAR_PAYEE,
    status: "paid",
    created_at_ns: "1793872805000000000",
    held_until_ns: null,
    memo: null,
  },
};
const SPEND_B: FixtureSpend = {
  tx_hash: TX_B,
  view: {
    id: 2,
    mandate_id: 2,
    amount: "40000000",
    invoice_hash: INVOICE_B,
    ref: "FIX-INV-B",
    agent_pk: TEST_AGENT_KEY.publicKey,
    destination: BASE_PAYEE,
    status: "burned",
    created_at_ns: "1793873420000000000",
    held_until_ns: null,
    memo: BURN_MEMO,
  },
};

const MANDATE_EXPIRES_NS = "1825408800000000000"; // 2027-11-05
const DAILY_BACKSTOP = "500000000";
const INTENTS_BALANCE = 100_000_000n;

const sumAmounts = (spends: readonly FixtureSpend[]): bigint =>
  spends.reduce((sum, s) => sum + BigInt(s.view.amount), 0n);

/** The two mandates as the contract holds them once `spent` has been applied to them. */
function mandatesAfter(spent: readonly FixtureSpend[]): MandateView[] {
  const used = (mandateId: number): { spent: string; uses: number } => {
    const mine = spent.filter((s) => s.view.mandate_id === mandateId);
    return { spent: sumAmounts(mine).toString(), uses: mine.length };
  };
  const common = {
    reserved: "0",
    max_uses: 4,
    expires_at_ns: MANDATE_EXPIRES_NS,
    agent_pk: TEST_AGENT_KEY.publicKey,
    status: "active" as const,
    created_at_ns: "1793754000000000000",
  };
  return [
    {
      ...common,
      ...used(1),
      id: 1,
      payee: NEAR_PAYEE,
      purpose_hash: FIXTURE_PURPOSE_NEAR,
      max_per_payment: "25000000",
      max_total: "100000000",
      approval_above: "50000000",
      label: "TEST FIXTURE mandate 1 (NEAR vendor)",
    },
    {
      ...common,
      ...used(2),
      id: 2,
      payee: BASE_PAYEE,
      purpose_hash: FIXTURE_PURPOSE_BASE,
      max_per_payment: "50000000",
      max_total: "200000000",
      approval_above: "100000000",
      label: "TEST FIXTURE mandate 2 (Base vendor)",
    },
  ];
}

const COMMON = { v: 1 as const, vault: FIXTURE_VAULT, settlement: null, refs: null };

interface DecisionSpec {
  at: string;
  request_id: string;
  invoice: InvoiceFacts;
  ref: string;
  proposal: ModelProposal | null;
  attestationOk: boolean | null;
  /** The spends already on chain when this decision is taken. */
  spendsBefore: readonly FixtureSpend[];
  expected: Verdict;
}

/**
 * A decision entry whose `rules`, `verdict`, `decided_by`, `mandate_id` and `amount` are what the real
 * `decide()` returns for these inputs, so the fixture ledger carries the engine's own rule list.
 */
function decisionDraft(spec: DecisionSpec): Draft {
  const decision = decide({
    vault: FIXTURE_VAULT,
    agentPk: TEST_AGENT_KEY.publicKey,
    now: new Date(spec.at),
    invoice: spec.invoice,
    proposal: spec.proposal,
    attestationOk: spec.attestationOk,
    mandates: mandatesAfter(spec.spendsBefore),
    paidInvoiceHashes: new Set(spec.spendsBefore.map((s) => s.view.invoice_hash)),
    usedRefs: new Set(spec.spendsBefore.map((s) => s.view.ref)),
    intentsBalance: INTENTS_BALANCE,
    frozen: false,
    confidenceFloor: DEFAULT_CONFIDENCE_FLOOR,
    ref: spec.ref,
    // All fixture spends fall on one UTC day (2026-11-05), so the day's total is the sum so far.
    daily: { backstop: DAILY_BACKSTOP, spent_today: sumAmounts(spec.spendsBefore).toString() },
  });
  if (decision.verdict !== spec.expected) {
    throw new Error(
      `fixture decision ${spec.request_id}: decide() returned ${decision.verdict}, expected ${spec.expected}`,
    );
  }
  return {
    attested: spec.proposal !== null && spec.attestationOk === true,
    body: {
      ...COMMON,
      kind: "decision",
      at: spec.at,
      request_id: spec.request_id,
      mandate_id: decision.mandate_id,
      invoice_hash: spec.invoice.invoice_hash,
      amount: decision.amount,
      proposal: spec.proposal,
      rules: decision.rules,
      verdict: decision.verdict,
      decided_by: decision.decided_by,
      contract: null,
    },
  };
}

function paymentDraft(o: {
  at: string;
  request_id: string;
  decisionOf: number;
  spend: FixtureSpend;
  settlement?: LedgerEntryBody["settlement"];
}): Draft {
  const { view } = o.spend;
  return {
    attested: false,
    decisionOf: o.decisionOf,
    body: {
      ...COMMON,
      kind: "payment",
      at: o.at,
      request_id: o.request_id,
      mandate_id: view.mandate_id,
      invoice_hash: view.invoice_hash,
      amount: view.amount,
      proposal: null,
      rules: [],
      verdict: null,
      decided_by: null,
      contract: { code: null, tx_hash: o.spend.tx_hash, spend_id: view.id, status: view.status },
      settlement: o.settlement ?? null,
    },
  };
}

function drafts(): Draft[] {
  const proposalA: ModelProposal = {
    action: "pay",
    mandate_id: 1,
    amount: "25000000",
    payee_hint: { near_account: FIXTURE_NEAR_PAYEE, name: "Fixture Vendor" },
    reasoning: `${FIXTURE_LABEL}. Invoice A matches PO-1001.`,
    confidence: 0.93,
  };
  const proposalB: ModelProposal = {
    action: "pay",
    mandate_id: 2,
    amount: "40000000",
    payee_hint: { chain: "base", address: FIXTURE_BASE_ADDRESS },
    reasoning: `${FIXTURE_LABEL}. Invoice B matches PO-2002.`,
    confidence: 0.91,
  };
  return [
    decisionDraft({
      at: "2026-11-05T10:00:00.000Z",
      request_id: "fixture-req-0",
      invoice: {
        invoice_hash: INVOICE_A,
        amount: "25000000",
        po_ref: "PO-1001",
        purpose_hash: FIXTURE_PURPOSE_NEAR,
        payee_hint: { near_account: FIXTURE_NEAR_PAYEE, name: "Fixture Vendor" },
      },
      ref: SPEND_A.view.ref,
      proposal: proposalA,
      attestationOk: true,
      spendsBefore: [],
      expected: "allow",
    }),
    paymentDraft({
      at: "2026-11-05T10:00:05.000Z",
      request_id: "fixture-req-0",
      decisionOf: 0,
      spend: SPEND_A,
    }),
    decisionDraft({
      at: "2026-11-05T10:10:00.000Z",
      request_id: "fixture-req-1",
      invoice: {
        invoice_hash: INVOICE_B,
        amount: "40000000",
        po_ref: "PO-2002",
        purpose_hash: FIXTURE_PURPOSE_BASE,
        payee_hint: { chain: "base", address: FIXTURE_BASE_ADDRESS },
      },
      ref: SPEND_B.view.ref,
      proposal: proposalB,
      attestationOk: true,
      spendsBefore: [SPEND_A],
      expected: "allow",
    }),
    paymentDraft({
      at: "2026-11-05T10:10:20.000Z",
      request_id: "fixture-req-1",
      decisionOf: 2,
      spend: SPEND_B,
      settlement: { chain: "base", tx_hash: null, burn_tx_hash: TX_B },
    }),
    // An injected invoice: it carries PO-1001's purpose but names an attacker's NEAR account. The
    // rules alone refuse it (no model call), so there is no proposal and no evidence.
    decisionDraft({
      at: "2026-11-05T10:20:00.000Z",
      request_id: "fixture-req-2",
      invoice: {
        invoice_hash: INVOICE_INJECTED,
        amount: "25000000",
        po_ref: "PO-1001",
        purpose_hash: FIXTURE_PURPOSE_NEAR,
        payee_hint: { near_account: "attacker.fixture.testnet" },
      },
      ref: "FIX-INV-INJECTED",
      proposal: null,
      attestationOk: null,
      spendsBefore: [SPEND_A, SPEND_B],
      expected: "refuse",
    }),
  ];
}

/** A variant whose target does not exist is a bug in the caller: fail loudly instead of returning a valid snapshot. */
function assertOptionsApply(options: FixtureOptions, all: readonly Draft[]): void {
  const attested = all.flatMap((d, seq) => (d.attested ? [seq] : []));
  const { wrongNonceAtSeq, forgedSignerFromSeq, rotateLedgerKeyAtSeq, signAllWithRotatedKey } =
    options;
  if (wrongNonceAtSeq !== undefined && !attested.includes(wrongNonceAtSeq)) {
    throw new Error(
      `wrongNonceAtSeq ${wrongNonceAtSeq} has no attestation; the attested seqs are ${attested.join(", ")}`,
    );
  }
  if (
    forgedSignerFromSeq !== undefined &&
    !(
      Number.isInteger(forgedSignerFromSeq) &&
      forgedSignerFromSeq >= 0 &&
      forgedSignerFromSeq < all.length
    )
  ) {
    throw new Error(
      `forgedSignerFromSeq ${forgedSignerFromSeq} is not a seq of the ledger (0 to ${all.length - 1})`,
    );
  }
  if (rotateLedgerKeyAtSeq !== undefined && !ROTATION_SEQS.includes(rotateLedgerKeyAtSeq)) {
    throw new Error(
      `rotateLedgerKeyAtSeq ${rotateLedgerKeyAtSeq} is not an anchor boundary: a rotation is only valid at seq ${ROTATION_SEQS.join(" or ")} (0 is the first entry, ${all.length} is past the end)`,
    );
  }
  if (signAllWithRotatedKey === true && rotateLedgerKeyAtSeq === undefined) {
    throw new Error(
      "signAllWithRotatedKey needs rotateLedgerKeyAtSeq: there is no rotated key without a rotation",
    );
  }
}

export async function makeFixtureSnapshot(options: FixtureOptions = {}): Promise<Snapshot> {
  const all = drafts();
  assertOptionsApply(options, all);
  const honest = createEd25519Signer(TEST_LEDGER_KEY.secretKey);
  const forged = createEd25519Signer(TEST_FORGED_KEY.secretKey);
  const rotated = createEd25519Signer(TEST_ROTATED_KEY.secretKey);
  const rotateAt = options.rotateLedgerKeyAtSeq;
  /** The ledger key the vault had when entry `seq` was written (and when the anchor covering it was sent). */
  const keyAt = (seq: number): string =>
    rotateAt !== undefined && seq >= rotateAt
      ? TEST_ROTATED_KEY.publicKey
      : TEST_LEDGER_KEY.publicKey;
  const signerAt = (seq: number): LedgerSigner => {
    if (options.forgedSignerFromSeq !== undefined && seq >= options.forgedSignerFromSeq) {
      return forged;
    }
    if (rotateAt !== undefined && options.signAllWithRotatedKey === true) return rotated;
    return keyAt(seq) === TEST_ROTATED_KEY.publicKey ? rotated : honest;
  };
  const currentKey =
    rotateAt === undefined ? TEST_LEDGER_KEY.publicKey : TEST_ROTATED_KEY.publicKey;
  const ledger: LedgerEntry[] = [];

  for (const draft of all) {
    const { seq, prev_link } = nextBodyFields(ledger.at(-1) ?? null);
    let evidence: AttestationEvidence | null = null;
    if (draft.attested) {
      // ICR-1: the nonce binds the vault account id, the same string as LedgerEntryBody.vault.
      const nonce =
        options.wrongNonceAtSeq === seq
          ? sha256Hex(`TEST FIXTURE wrong nonce ${seq}`)
          : computeNonce({
              vault: draft.body.vault,
              prev_link,
              invoice_hash: draft.body.invoice_hash,
              mandate_id: draft.body.mandate_id,
              seq,
            });
      // ICR-2: the signed response body carries the recorded proposal (A7).
      if (draft.body.proposal === null)
        throw new Error(`attested fixture draft ${seq} has no proposal`);
      evidence = await buildTestEvidence({
        nonce,
        requestBody: JSON.stringify({ fixture: FIXTURE_LABEL, seq, part: "request" }),
        proposal: draft.body.proposal,
        chatId: `chatcmpl-test-fixture-${seq}`,
        fetchedAt: draft.body.at,
      });
    }
    const decision = draft.decisionOf === undefined ? undefined : ledger[draft.decisionOf];
    const refs =
      decision === undefined ? draft.body.refs : { decision_body_hash: decision.body_hash };
    const body: LedgerEntryBody = { ...draft.body, seq, prev_link, evidence, refs };
    ledger.push(await buildEntry(body, signerAt(seq)));
  }

  const entry = (i: number): LedgerEntry => {
    const found = ledger[i];
    if (found === undefined) throw new Error(`fixture entry ${i} missing`);
    return found;
  };

  const spends: SpendView[] = [
    { ...SPEND_A.view, decision_hash: entry(0).body_hash },
    { ...SPEND_B.view, decision_hash: entry(2).body_hash },
  ];

  return {
    v: 1,
    vault: FIXTURE_VAULT,
    network: "testnet",
    taken_at: FIXTURE_TAKEN_AT,
    ledger,
    chain: {
      access_keys: [
        {
          public_key: TEST_AGENT_KEY.publicKey,
          permission: {
            receiver_id: FIXTURE_VAULT,
            method_names: ["spend"],
            allowance: "1000000000000000000000000",
          },
        },
        {
          // After a rotation the old ledger key is deleted and the rotated one added.
          public_key: currentKey,
          permission: {
            receiver_id: FIXTURE_VAULT,
            method_names: ["anchor"],
            allowance: "250000000000000000000000",
          },
        },
      ],
      code_hash: FIXTURE_CODE_HASH,
      config: {
        owner: "owner.fixture.testnet",
        approvers: ["approver.fixture.testnet"],
        usdc: NETWORKS.testnet.usdc,
        intents: NETWORKS.testnet.intents,
        allowed_assets: [
          NETWORKS.testnet.allowedAssets.base,
          NETWORKS.testnet.allowedAssets.solana,
        ],
        daily_backstop: DAILY_BACKSTOP,
        held_ttl_ns: "259200000000000",
        frozen: false,
        factory: NETWORKS.testnet.factory,
        version: "0.1.0",
        ledger_key: currentKey,
      },
      anchors: ANCHORS.map((a, i) => ({
        seq: i + 1,
        root: entry(a.count - 1).link,
        count: a.count,
        at_ns: a.at_ns,
        // The key of the last entry the anchor covers (a rotation only happens between anchors).
        ledger_key: keyAt(a.count - 1),
      })),
      spends,
      intents_public_keys: [],
      intents_predecessor_auth: true,
      // R14: factory version ids are 1-based, as in the contract (`index: i + 1`, `current_version = count`).
      factory_version: 1,
      factory_versions: [
        {
          index: 1,
          code_hash: FIXTURE_CODE_HASH,
          mode: "global",
          notes: FIXTURE_FACTORY_NOTES,
          at_ns: "1793750400000000000",
        },
      ],
      // The matched burn pair (POA ft_burn memo + intents mt_burn owner/amount), as findBurnPair reports it.
      // The snapshot holds the pair summary only, so it does not depend on the receipt shape
      // (mainnet: two receipts; testnet stub: one receipt).
      burns: [
        {
          spend_id: SPEND_B.view.id,
          tx_hash: SPEND_B.tx_hash,
          memo: BURN_MEMO,
          intents_owner: FIXTURE_VAULT,
          amount: SPEND_B.view.amount,
          status: "ok",
        },
      ],
    },
    expected_code_hashes: [FIXTURE_CODE_HASH],
    pre_ledger_decision_hashes: [],
  };
}

export const SNAPSHOT_FILE = "valid-snapshot.json";
export const LEDGER_FILE = "valid-ledger.jsonl";

/**
 * The exact text of the two committed files. The writer and the byte-equality test both use it, and
 * biome.json excludes the two files, so no formatter rewrites them after they are written.
 */
export function serializeFixtures(snapshot: Snapshot): {
  snapshotJson: string;
  ledgerJsonl: string;
} {
  return {
    snapshotJson: `${JSON.stringify(snapshot, null, 2)}\n`,
    ledgerJsonl: `${snapshot.ledger.map((e) => JSON.stringify(e)).join("\n")}\n`,
  };
}

async function writeFixtures(): Promise<void> {
  const dir = dirname(fileURLToPath(import.meta.url));
  const { snapshotJson, ledgerJsonl } = serializeFixtures(await makeFixtureSnapshot());
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SNAPSHOT_FILE), snapshotJson);
  await writeFile(join(dir, LEDGER_FILE), ledgerJsonl);
  process.stdout.write(`wrote TEST FIXTURES to ${dir}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await writeFixtures();
}
