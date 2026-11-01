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
import type {
  AttestationEvidence,
  LedgerEntry,
  LedgerEntryBody,
  ModelProposal,
  RuleResult,
  Snapshot,
  SpendView,
} from "../../src/types.js";
import { buildTestEvidence, FIXTURE_LABEL } from "./evidence.js";
import { TEST_AGENT_KEY, TEST_FORGED_KEY, TEST_LEDGER_KEY, TEST_ROTATED_KEY } from "./keys.js";

export const FIXTURE_VAULT = "fixture.vaults.probarion.testnet";
export const FIXTURE_TAKEN_AT = "2026-11-05T12:00:00.000Z";
export const FIXTURE_CODE_HASH = bs58.encode(
  sha256Bytes(utf8("probarion/test-fixture/vault-wasm")),
);
export const FIXTURE_NEAR_PAYEE = "vendor.fixture.testnet";
export const FIXTURE_BASE_ADDRESS = "0x1111111111111111111111111111111111111111";
export const FIXTURE_PURPOSE_NEAR = sha256Hex("TEST FIXTURE PO-1001");
export const FIXTURE_PURPOSE_BASE = sha256Hex("TEST FIXTURE PO-2002");

const INVOICE_A = sha256Hex("TEST FIXTURE invoice A");
const INVOICE_B = sha256Hex("TEST FIXTURE invoice B");
const INVOICE_INJECTED = sha256Hex("TEST FIXTURE injected invoice");
const BASE_ASSET = NETWORKS.testnet.allowedAssets.base;
const BURN_MEMO = `${WITHDRAW_MEMO_PREFIX}${FIXTURE_BASE_ADDRESS}`;
const TX_A = "FixtureSpendTxA1111111111111111111111111111111";
const TX_B = "FixtureSpendTxB1111111111111111111111111111111";

export interface FixtureOptions {
  /** Build the evidence at this seq with a nonce that does not match its ledger context (A6 fails). */
  wrongNonceAtSeq?: number;
  /** Sign entries from this seq on with a key that is not the vault's ledger key (check a fails). */
  forgedSignerFromSeq?: number;
  /** set_ledger_key rotation before this seq: later entries, the anchors covering them and config.ledger_key use TEST_ROTATED_KEY. */
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

const pass = (id: RuleResult["id"], detail: string): RuleResult => ({
  id,
  outcome: "pass",
  detail,
});

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
  const common = { v: 1 as const, vault: FIXTURE_VAULT, settlement: null, refs: null };
  return [
    {
      attested: true,
      body: {
        ...common,
        kind: "decision",
        at: "2026-11-05T10:00:00.000Z",
        request_id: "fixture-req-0",
        mandate_id: 1,
        invoice_hash: INVOICE_A,
        amount: "25000000",
        proposal: proposalA,
        rules: [
          pass("mandate.none", "mandate 1 selected by proposal"),
          pass(
            "mandate.payee_mismatch",
            `destination is the mandate payee near:${FIXTURE_NEAR_PAYEE}`,
          ),
        ],
        verdict: "allow",
        decided_by: "model+rules",
        contract: null,
      },
    },
    {
      attested: false,
      decisionOf: 0,
      body: {
        ...common,
        kind: "payment",
        at: "2026-11-05T10:00:05.000Z",
        request_id: "fixture-req-0",
        mandate_id: 1,
        invoice_hash: INVOICE_A,
        amount: "25000000",
        proposal: null,
        rules: [],
        verdict: null,
        decided_by: null,
        contract: { code: null, tx_hash: TX_A, spend_id: 1, status: "paid" },
      },
    },
    {
      attested: true,
      body: {
        ...common,
        kind: "decision",
        at: "2026-11-05T10:10:00.000Z",
        request_id: "fixture-req-1",
        mandate_id: 2,
        invoice_hash: INVOICE_B,
        amount: "40000000",
        proposal: proposalB,
        rules: [
          pass("mandate.none", "mandate 2 selected by proposal"),
          pass("intents.balance_low", "POA balance 100000000"),
        ],
        verdict: "allow",
        decided_by: "model+rules",
        contract: null,
      },
    },
    {
      attested: false,
      decisionOf: 2,
      body: {
        ...common,
        kind: "payment",
        at: "2026-11-05T10:10:20.000Z",
        request_id: "fixture-req-1",
        mandate_id: 2,
        invoice_hash: INVOICE_B,
        amount: "40000000",
        proposal: null,
        rules: [],
        verdict: null,
        decided_by: null,
        contract: { code: null, tx_hash: TX_B, spend_id: 2, status: "burned" },
        settlement: { chain: "base", tx_hash: null, burn_tx_hash: TX_B },
      },
    },
    {
      attested: false,
      body: {
        ...common,
        kind: "decision",
        at: "2026-11-05T10:20:00.000Z",
        request_id: "fixture-req-2",
        mandate_id: 1,
        invoice_hash: INVOICE_INJECTED,
        amount: "25000000",
        proposal: null,
        rules: [
          {
            id: "mandate.payee_mismatch",
            outcome: "refuse",
            detail: `${FIXTURE_LABEL}. Invoice names NEAR account attacker.fixture.testnet; the mandate pays ${FIXTURE_NEAR_PAYEE}`,
          },
        ],
        verdict: "refuse",
        decided_by: "rules-only",
        contract: null,
      },
    },
  ];
}

export async function makeFixtureSnapshot(options: FixtureOptions = {}): Promise<Snapshot> {
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

  for (const draft of drafts()) {
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
      evidence = await buildTestEvidence({
        nonce,
        requestBody: JSON.stringify({ fixture: FIXTURE_LABEL, seq, part: "request" }),
        responseBody: JSON.stringify({ fixture: FIXTURE_LABEL, seq, part: "response" }),
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
    {
      id: 1,
      mandate_id: 1,
      amount: "25000000",
      invoice_hash: INVOICE_A,
      ref: "FIX-INV-A",
      decision_hash: entry(0).body_hash,
      agent_pk: TEST_AGENT_KEY.publicKey,
      destination: { type: "near", account_id: FIXTURE_NEAR_PAYEE },
      status: "paid",
      created_at_ns: "1793872805000000000",
      held_until_ns: null,
      memo: null,
    },
    {
      id: 2,
      mandate_id: 2,
      amount: "40000000",
      invoice_hash: INVOICE_B,
      ref: "FIX-INV-B",
      decision_hash: entry(2).body_hash,
      agent_pk: TEST_AGENT_KEY.publicKey,
      destination: {
        type: "intents",
        chain: "base",
        address: FIXTURE_BASE_ADDRESS,
        asset: BASE_ASSET,
      },
      status: "burned",
      created_at_ns: "1793873420000000000",
      held_until_ns: null,
      memo: BURN_MEMO,
    },
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
        daily_backstop: "500000000",
        held_ttl_ns: "259200000000000",
        frozen: false,
        factory: NETWORKS.testnet.factory,
        version: "0.1.0",
        ledger_key: currentKey,
      },
      anchors: [
        {
          seq: 1,
          root: entry(1).link,
          count: 2,
          at_ns: "1793872806000000000",
          ledger_key: keyAt(1),
        },
        {
          seq: 2,
          root: entry(3).link,
          count: 4,
          at_ns: "1793873421000000000",
          ledger_key: keyAt(3),
        },
        {
          seq: 3,
          root: entry(4).link,
          count: 5,
          at_ns: "1793874001000000000",
          ledger_key: keyAt(4),
        },
      ],
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
          notes: FIXTURE_LABEL,
          at_ns: "1793750400000000000",
        },
      ],
      // The matched burn pair (POA ft_burn memo + intents mt_burn owner/amount), as findBurnPair reports it.
      // The snapshot holds the pair summary only, so it does not depend on the receipt shape
      // (mainnet: two receipts; testnet stub: one receipt).
      burns: [
        {
          spend_id: 2,
          tx_hash: TX_B,
          memo: BURN_MEMO,
          intents_owner: FIXTURE_VAULT,
          amount: "40000000",
          status: "ok",
        },
      ],
    },
    expected_code_hashes: [FIXTURE_CODE_HASH],
    pre_ledger_decision_hashes: [],
  };
}

async function writeFixtures(): Promise<void> {
  const dir = dirname(fileURLToPath(import.meta.url));
  const snapshot = await makeFixtureSnapshot();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "valid-snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(
    join(dir, "valid-ledger.jsonl"),
    `${snapshot.ledger.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  process.stdout.write(`wrote TEST FIXTURES to ${dir}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await writeFixtures();
}
