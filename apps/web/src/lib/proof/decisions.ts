import {
  type AttestationEvidence,
  checkAttestation,
  computeNonce,
  isNearAccountId,
  isNearTxHash,
  KNOWN_SYSTEM_PROMPT_HASHES,
  type ModelProposal,
  parseTdxQuote,
  type Snapshot,
  sha256Hex,
  ZERO_LINK,
} from "@probarion/core";
import { explorerTxUrl, type Network } from "@/lib/config";
import { formatUsdc } from "@/lib/near/units";
import { safeText } from "./sanitize";
import { chainCommand } from "./view";

// One row per decision entry of a snapshot, as /proof shows it (G7): what the ledger records the TEE was shown, what
// it signed, and what the code and the contract checked, with checks A1 to A7 run on the entry here. A1 to A7 do not
// tie the recorded request inputs to the signed request (A8 does, with the invoice text), so a row says so. Pure data,
// newest first. Every string that came from the ledger or the chain goes through `safeText`. The raw TDX quote, the
// GPU payload and the response body are never copied into a row: a row gives their sizes and points to the vault's
// snapshot.json, which holds them.

/** A ledger verdict as a row shows it. Anything core does not define is "unknown". */
export type DecisionVerdict = "allow" | "hold" | "refuse" | "unknown";
/** Who decided, as the entry records it. A null or unknown value is "unknown", which check (e) fails. */
export type DecisionDecider = "model+rules" | "rules-only" | "unknown";
export type RuleOutcome = "pass" | "hold" | "refuse" | "unknown";

/** An amount in USDC base units: the units when they are a whole number, and the text a reader sees. */
export interface DecisionAmount {
  units: string | null;
  text: string;
}

/** One mandate as the model was shown it (`request_inputs.mandates`). */
export interface ShownMandate {
  id: string;
  label: string;
  payee: string;
  purposeHash: string;
  maxPerPayment: DecisionAmount;
  remaining: DecisionAmount;
  expires: string;
  status: string;
}

/**
 * The system prompt the ledger records for the request (`request_inputs.system_prompt`), named when its sha256 is in
 * core's allow-list (the one check A8 uses). A1 to A7 do not show that the TEE was given this prompt: only A8 does.
 */
export interface ShownSystemPrompt {
  /** The allow-list name, or NOT_IN_ALLOW_LIST. */
  name: string;
  /** True when the recorded prompt matches the allow-listed prompt `name`. */
  known: boolean;
  sha256: string;
  /** The prompt, one safe line per line of it (a newline would otherwise show as a replacement character). */
  lines: string[];
}

/**
 * What the ledger records the TEE was shown: the request side of the evidence. The model, the nonce and
 * request_sha256 are covered by A1, A5 and A6. The system prompt, facts and mandates are `request_inputs` as the
 * ledger records them, which only A8 ties to the signed request. The invoice text itself is not in the ledger.
 */
export interface TeeSaw {
  model: string;
  /** Null when the evidence has no `request_inputs` (evidence recorded before they were stored). */
  systemPrompt: ShownSystemPrompt | null;
  facts: {
    invoiceHash: string;
    amount: DecisionAmount;
    poRef: string | null;
    purposeHash: string | null;
  } | null;
  mandates: ShownMandate[];
  invoiceTextSha256: string | null;
  invoiceTextNote: string;
  nonce: string;
  requestSha256: string;
  /**
   * INPUTS_BINDING_NOTE whenever `request_inputs` are shown: they are the ledger's record, which A1 to A7 do not tie
   * to the signed request. Null when there are none to show (`inputsNote` says why).
   */
  inputsBinding: string | null;
  /** Set when `request_inputs` is missing or unreadable: says what cannot be shown. */
  inputsNote: string | null;
}

export interface ShownProposal {
  action: string;
  amount: DecisionAmount;
  mandateId: string;
  confidence: string;
  reasoning: string;
  payeeHint: string | null;
}

/** The attestation report, by size and parts. Its raw quote and GPU payload stay in snapshot.json. */
export interface ShownReport {
  signer: string;
  algo: string;
  requestNonce: string;
  /** "TDX quote v4, 632 bytes", or why it cannot be read. This is a format read, not a verification. */
  quote: { version: 4 | 5 | null; bytes: number | null; text: string };
  /** report_data split in its two halves: the zero-padded signer, then the nonce. Null when it is not 128 hex. */
  reportData: { signerHalf: string; nonceHalf: string } | null;
  gpuPayload: { present: boolean; bytes: number | null; text: string };
  eventLog: { present: boolean; text: string };
}

/** What the TEE signed: the response side of the evidence. */
export interface TeeSigned {
  text: string;
  signer: string;
  /** The signature shortened to its first and last bytes, with its length. */
  signature: string;
  algo: string;
  chatId: string;
  responseSha256: string;
  /** The UTF-8 size of the stored response body, or null when there is none. */
  responseBytes: number | null;
  /** The entry's recorded proposal; A7 says whether the signed response holds exactly it. */
  proposal: ShownProposal | null;
  report: ShownReport | null;
  fetchedAt: string;
  /** Where the full response body, TDX quote and GPU payload are. Null when the vault id cannot be linked. */
  snapshotHref: string | null;
  rawNote: string;
}

export interface AttestationRow {
  id: string;
  pass: boolean;
  detail: string;
}

/** Checks A1 to A7 on this entry, from core's `checkAttestation`. Never more than offline consistency. */
export interface DecisionAttestation {
  ok: boolean;
  summary: string;
  binding: "address" | "tls" | "none";
  checks: AttestationRow[];
}

export interface ShownRule {
  id: string;
  outcome: RuleOutcome;
  detail: string;
}

/** A payment entry that points back to this decision (`refs.decision_body_hash`). */
export interface ShownPayment {
  seq: number;
  at: string;
  status: string;
  /** The contract's code, such as a panic code (OverPerPayment), or null. */
  code: string | null;
  spendId: string | null;
  /** The contract tx on the explorer; `txUrl` is null when the entry names none or a malformed one. */
  txUrl: string | null;
  txLabel: string;
}

/** An on-chain spend whose decision_hash is this entry's body_hash, as the snapshot read it. */
export interface ShownSpend {
  id: number;
  anchorId: string;
  status: string;
  amount: DecisionAmount;
  destination: string;
  mandateId: string;
}

/** The mandate's caps as the chain holds them in this snapshot. */
export interface ShownMandateCaps {
  id: number;
  label: string;
  payee: string;
  maxPerPayment: DecisionAmount;
  maxTotal: DecisionAmount;
  maxUses: string;
  approvalAbove: DecisionAmount;
  expires: string;
  status: string;
}

export interface ContractCheck {
  code: string;
  text: string;
  /** True when a payment entry of this decision records this code. */
  refused: boolean;
}

/** What the code and the contract checked. */
export interface ContractChecked {
  verdict: DecisionVerdict;
  rules: ShownRule[];
  /**
   * The rule that held or refused the decision: the first whose outcome is the verdict, as the SDK picks its code.
   * A refusal wins over an earlier hold, so the first rule that did not pass may only have held. Null for any other
   * verdict, or when no rule has the verdict's outcome.
   */
  firstBlocking: ShownRule | null;
  payments: ShownPayment[];
  spends: ShownSpend[];
  mandate: ShownMandateCaps | null;
  /** Set when the entry names a mandate the snapshot's chain data does not hold. */
  mandateNote: string | null;
  contractChecks: ContractCheck[];
  holdRule: string;
}

export interface AnchorCoverage {
  covered: boolean;
  /** The first on-chain anchor whose count includes this entry. */
  anchorSeq: number | null;
  count: number | null;
  text: string;
}

export interface DecisionRow {
  /** The entry's position in the ledger, which is its seq in a well-formed ledger. */
  seq: number;
  /** The stable anchor id of the row: "seq-N". */
  id: string;
  /** "spend-N" for each on-chain spend bound to this decision. */
  spendIds: string[];
  at: string;
  verdict: DecisionVerdict;
  decidedBy: DecisionDecider;
  mandateId: number | null;
  amount: DecisionAmount;
  invoiceHash: string | null;
  bodyHash: string;
  /** One sentence when the model's part needs one, such as NO_MODEL for a rules-only decision; else null. */
  modelNote: string | null;
  /** Null when the entry carries no evidence. */
  saw: TeeSaw | null;
  signed: TeeSigned | null;
  attestation: DecisionAttestation | null;
  checked: ContractChecked;
  anchor: AnchorCoverage;
}

/** What a rules-only decision with no evidence says in place of the two TEE columns. */
export const NO_MODEL =
  "No model was used. The code's rules decided, and the contract checked any spend that was sent.";

export const NOT_IN_ALLOW_LIST = "not in allow-list";

export const INVOICE_TEXT_NOTE =
  "The invoice text is not in the ledger: the ledger keeps only its sha256, so A8 needs the text from whoever holds it.";

/** What goes with the request inputs a row shows: they are the ledger's record, not something A1 to A7 checked. */
export const INPUTS_BINDING_NOTE =
  "These are the request inputs as the ledger records them. A1 to A7 do not tie them to the signed request: A8 does, and it needs the invoice text.";

/**
 * The fixed limits line that goes with every A1 to A7 result. It says what the page did not check; it never says the
 * TEE or the quote was verified.
 */
export const DECISION_LIMITS =
  "A1 to A7 run offline on this snapshot: they show that the signature, the signed response, the recorded proposal and the attestation report agree with each other and with this ledger position. The TDX quote is not verified here: O1 (Intel DCAP) and O2 (NVIDIA NRAS) run only with verify --online, which needs the optional package @nearai/inference-sdk on Node 24.22.1 or later. The measurement is not pinned, so even O1 does not show which image the TEE runs. A8 needs the invoice text, which the ledger never stores. Without A8, the request inputs a row shows (the system prompt, the facts and the mandates) are only the ledger's record: A1 to A7 do not tie them to the signed request.";

/** The command that runs O1 and O2 on a vault: the page's chain command with `--online`. */
export function onlineCommand(network: Network, vault: string): string {
  return `${chainCommand(network, vault)} --online`;
}

/**
 * What the vault contract checks before it reserves a spend, in the order of `evaluate` in
 * contracts/vault/src/checks.rs, each with the code it panics with.
 */
export const CONTRACT_CHECKS: readonly { readonly code: string; readonly text: string }[] = [
  { code: "NotAgent", text: "The signer is one of the vault's agent keys" },
  { code: "InvalidInput", text: "The invoice hash, decision hash and ref are well formed" },
  { code: "Frozen", text: "The vault is not frozen" },
  { code: "NoMandate", text: "The mandate exists" },
  { code: "MandateInactive", text: "The mandate is not revoked" },
  { code: "MandateExpired", text: "The mandate has not expired" },
  { code: "NotMandateAgent", text: "The signer is the mandate's agent key" },
  { code: "ZeroAmount", text: "The amount is above zero" },
  { code: "OverPerPayment", text: "The amount is at most the mandate's per-payment cap" },
  { code: "UsesExhausted", text: "The mandate has a use left" },
  {
    code: "OverMandateTotal",
    text: "Spent, reserved and this amount stay within the mandate's total",
  },
  // A released spend (rejected, expired or failed) frees its invoice hash, but its ref stays consumed forever.
  {
    code: "DuplicateInvoice",
    text: "No other spend that is held, pending, paid or burned holds this invoice hash",
  },
  { code: "DuplicateRef", text: "No earlier spend used this ref" },
  { code: "OverDailyBackstop", text: "The day's total stays within the vault's daily backstop" },
];

/** What the contract does with a spend that passes every check above. */
export const CONTRACT_HOLD =
  "A spend that passes every check and is above the mandate's approval limit is held for an approver.";

/** The anchor id of the decision row at ledger seq `seq`. */
export const seqAnchorId = (seq: number): string => `seq-${seq}`;
/** The anchor id of the decision row that on-chain spend `id` is bound to. */
export const spendAnchorId = (id: number): string => `spend-${id}`;

const HEX32 = /^[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;
const HEX_BYTES = /^(0x)?((?:[0-9a-fA-F]{2})*)$/;
const VERDICTS: readonly string[] = ["allow", "hold", "refuse"];
const OUTCOMES: readonly string[] = ["pass", "hold", "refuse"];
/** A model name, a label or a status: one line, kept short. */
const SHORT = 120;
/** A check or rule detail is a sentence with values in it, so it gets the room view.ts gives one. */
const DETAIL_MAX = 1000;
/** The model's reasoning is at most 2000 characters (ModelProposal). */
const REASONING_MAX = 2000;
const PROMPT_LINES = 60;
const PROMPT_LINE_MAX = 400;
const MANDATES_SHOWN = 20;
const RULES_SHOWN = 40;
const SIGNATURE_TEXT_MAX = 400;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isSeq = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** A sha256 as is, or the safe text of whatever stands in its place. */
function hashText(v: unknown): string {
  return typeof v === "string" && HEX32.test(v) ? v : safeText(v, SHORT);
}

/** Text or null: null and undefined stay null, anything else becomes safe text. */
function maybeText(v: unknown, max = SHORT): string | null {
  return v === null || v === undefined ? null : safeText(v, max);
}

function idText(v: unknown): string {
  return isSeq(v) ? String(v) : v === null || v === undefined ? "none" : safeText(v, SHORT);
}

/** An amount in USDC base units (6 decimals), or the raw text, marked, when it is not a whole number. */
function usdc(v: unknown): DecisionAmount {
  if (typeof v === "string" && DIGITS.test(v)) return { units: v, text: `${formatUsdc(v)} USDC` };
  if (v === null || v === undefined) return { units: null, text: "none" };
  return { units: null, text: `${safeText(v, SHORT)} (not a USDC amount)` };
}

/** A time in nanoseconds as "2026-12-09 23:59 UTC", or "unreadable". */
function nsText(v: unknown): string {
  if (typeof v !== "string" || !DIGITS.test(v)) return "unreadable";
  const date = new Date(Number(BigInt(v) / 1_000_000n));
  return Number.isNaN(date.getTime())
    ? "unreadable"
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A payee as one line: the NEAR account, or chain:address for an Intents payee. */
function payeeText(p: unknown): string {
  if (!isObject(p)) return "unreadable payee";
  if (p.type === "near") return safeText(p.account_id, SHORT);
  if (p.type === "intents") return `${safeText(p.chain, 16)}:${safeText(p.address, SHORT)}`;
  return "unreadable payee";
}

function hintText(h: unknown): string | null {
  if (!isObject(h)) return null;
  const parts = [
    h.name === undefined ? null : `name ${safeText(h.name, SHORT)}`,
    h.near_account === undefined ? null : `NEAR account ${safeText(h.near_account, SHORT)}`,
    h.chain === undefined && h.address === undefined
      ? null
      : `${safeText(h.chain ?? "unknown chain", 16)} address ${safeText(h.address ?? "none", SHORT)}`,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

function verdictOf(v: unknown): DecisionVerdict {
  return typeof v === "string" && VERDICTS.includes(v) ? (v as DecisionVerdict) : "unknown";
}

function deciderOf(v: unknown): DecisionDecider {
  return v === "model+rules" || v === "rules-only" ? v : "unknown";
}

function rulesOf(v: unknown): ShownRule[] {
  return listOf(v)
    .slice(0, RULES_SHOWN)
    .map((r) => {
      const rule = isObject(r) ? r : {};
      return {
        id: safeText(rule.id, SHORT),
        outcome:
          typeof rule.outcome === "string" && OUTCOMES.includes(rule.outcome)
            ? (rule.outcome as RuleOutcome)
            : "unknown",
        detail: safeText(rule.detail, DETAIL_MAX),
      };
    });
}

/** Text split on its line breaks, each line made safe, with a cap on lines and on each line. */
function safeLines(v: unknown): string[] {
  if (typeof v !== "string") return [safeText(v, PROMPT_LINE_MAX)];
  const lines = v.split(/\r?\n/);
  const shown = lines.slice(0, PROMPT_LINES).map((l) => safeText(l, PROMPT_LINE_MAX));
  return lines.length > PROMPT_LINES
    ? [...shown, `(${lines.length - PROMPT_LINES} more lines in snapshot.json)`]
    : shown;
}

function systemPromptOf(v: unknown): ShownSystemPrompt {
  const sha256 = typeof v === "string" ? sha256Hex(v) : "";
  const known = KNOWN_SYSTEM_PROMPT_HASHES.find((p) => p.sha256 === sha256);
  return {
    name: known ? known.name : NOT_IN_ALLOW_LIST,
    known: known !== undefined,
    sha256: typeof v === "string" ? sha256 : "not a text",
    lines: safeLines(v),
  };
}

function shownMandate(v: unknown): ShownMandate {
  const m = isObject(v) ? v : {};
  return {
    id: idText(m.id),
    label: safeText(m.label, SHORT),
    payee: payeeText(m.payee),
    purposeHash: hashText(m.purpose_hash),
    maxPerPayment: usdc(m.max_per_payment),
    remaining: usdc(m.remaining),
    expires: nsText(m.expires_at_ns),
    status: safeText(m.status, SHORT),
  };
}

function sawOf(ev: Record<string, unknown>): TeeSaw {
  const inputs = ev.request_inputs;
  const base = {
    model: safeText(ev.model, SHORT),
    invoiceTextNote: INVOICE_TEXT_NOTE,
    nonce: hashText(ev.nonce),
    requestSha256: hashText(ev.request_sha256),
  };
  if (!isObject(inputs)) {
    return {
      ...base,
      systemPrompt: null,
      facts: null,
      mandates: [],
      invoiceTextSha256: null,
      inputsBinding: null,
      inputsNote:
        inputs === undefined
          ? "This evidence carries no request inputs, so what the model was shown is not recorded and A8 cannot run."
          : "The evidence's request inputs are not an object, so what the model was shown cannot be read.",
    };
  }
  const f = inputs.facts;
  const mandates = listOf(inputs.mandates);
  return {
    ...base,
    systemPrompt: systemPromptOf(inputs.system_prompt),
    facts: isObject(f)
      ? {
          invoiceHash: hashText(f.invoice_hash),
          amount: usdc(f.amount),
          poRef: maybeText(f.po_ref),
          purposeHash: f.purpose_hash === null ? null : hashText(f.purpose_hash),
        }
      : null,
    mandates: mandates.slice(0, MANDATES_SHOWN).map(shownMandate),
    invoiceTextSha256: hashText(inputs.invoice_text_sha256),
    inputsBinding: INPUTS_BINDING_NOTE,
    inputsNote:
      mandates.length > MANDATES_SHOWN
        ? `The model was shown ${mandates.length} mandates; the first ${MANDATES_SHOWN} are listed here.`
        : null,
  };
}

/** A hex string's size in bytes, or null when it is not hex. */
function hexBytes(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = HEX_BYTES.exec(v.trim());
  return m === null ? null : (m[2] ?? "").length / 2;
}

/** `0x` and the first 6 and last 4 bytes of a signature, with its size. */
function shortSignature(v: unknown): string {
  const bytes = hexBytes(v);
  if (typeof v !== "string" || bytes === null || bytes < 12) return safeText(v, SHORT);
  const hex = v.trim().replace(/^0x/, "");
  return `0x${hex.slice(0, 12)}...${hex.slice(-8)} (${bytes} bytes)`;
}

function reportOf(r: Record<string, unknown>): ShownReport {
  const quote = typeof r.intel_quote === "string" ? parseTdxQuote(r.intel_quote) : null;
  const quoteBytes = hexBytes(r.intel_quote);
  const reportData = typeof r.report_data === "string" ? r.report_data.toLowerCase() : "";
  const gpu = r.nvidia_payload;
  const gpuBytes = typeof gpu === "string" ? utf8Bytes(gpu) : null;
  let eventLog = "none";
  if (r.event_log !== null && r.event_log !== undefined) {
    try {
      eventLog = `present, ${utf8Bytes(JSON.stringify(r.event_log))} bytes`;
    } catch {
      eventLog = "present, unreadable";
    }
  }
  return {
    signer: safeText(r.signing_address, SHORT),
    algo: safeText(r.signing_algo, SHORT),
    requestNonce: hashText(r.request_nonce),
    quote: quote
      ? {
          version: quote.version,
          bytes: quoteBytes,
          text: `TDX quote v${quote.version}, ${quoteBytes} bytes`,
        }
      : {
          version: null,
          bytes: quoteBytes,
          text:
            quoteBytes === null
              ? "unreadable: the quote is not hex"
              : `unreadable: ${quoteBytes} bytes that are not a TDX quote v4 or v5`,
        },
    reportData: /^[0-9a-f]{128}$/.test(reportData)
      ? { signerHalf: reportData.slice(0, 64), nonceHalf: reportData.slice(64) }
      : null,
    gpuPayload:
      gpu === null || gpu === undefined
        ? { present: false, bytes: null, text: "no GPU payload" }
        : gpuBytes === null
          ? { present: true, bytes: null, text: "present, not a text" }
          : { present: true, bytes: gpuBytes, text: `GPU payload present, ${gpuBytes} bytes` },
    eventLog: { present: eventLog !== "none", text: eventLog },
  };
}

function proposalOf(p: unknown): ShownProposal | null {
  if (!isObject(p)) return null;
  return {
    action: safeText(p.action, SHORT),
    amount: usdc(p.amount),
    mandateId: idText(p.mandate_id),
    confidence:
      typeof p.confidence === "number" && Number.isFinite(p.confidence)
        ? String(p.confidence)
        : "unreadable",
    reasoning: safeText(p.reasoning ?? "", REASONING_MAX),
    payeeHint: hintText(p.payee_hint),
  };
}

function signedOf(
  ev: Record<string, unknown>,
  proposal: unknown,
  snapshotHref: string | null,
): TeeSigned {
  const sig = isObject(ev.signature) ? ev.signature : {};
  return {
    text: safeText(sig.text, SIGNATURE_TEXT_MAX),
    signer: safeText(sig.signing_address, SHORT),
    signature: shortSignature(sig.signature),
    algo: safeText(sig.signing_algo, SHORT),
    chatId: safeText(ev.chat_id, SHORT),
    responseSha256: hashText(ev.response_sha256),
    responseBytes: typeof ev.response_body === "string" ? utf8Bytes(ev.response_body) : null,
    proposal: proposalOf(proposal),
    report: isObject(ev.report) ? reportOf(ev.report) : null,
    fetchedAt: safeText(ev.fetched_at, SHORT),
    snapshotHref,
    rawNote:
      "The full response body, TDX quote and GPU payload are in the vault's snapshot.json, not on this page.",
  };
}

/**
 * The nonce A6 expects, as core's check (e) computes it: the entry must name the snapshot's vault, its seq must be
 * its position and its prev_link the link of the entry before it, and then the nonce is computeNonce over the body's
 * own fields. When any of these does not hold, or the nonce cannot be computed, `detail` says why A6 fails.
 */
function expectedNonce(
  s: Record<string, unknown>,
  ledger: unknown[],
  i: number,
  body: Record<string, unknown>,
): { nonce: string } | { detail: string } {
  if (body.vault !== s.vault) {
    return {
      detail: `this entry names vault ${safeText(body.vault, SHORT)}, not ${safeText(s.vault, SHORT)}: its attestation nonce would bind the wrong vault`,
    };
  }
  const position = "this entry is not at the chain position its attestation nonce is computed from";
  if (body.seq !== i) {
    return { detail: `${position}: it says seq ${safeText(body.seq, SHORT)}, and it sits at ${i}` };
  }
  const previous =
    i === 0
      ? ZERO_LINK
      : isObject(ledger[i - 1])
        ? (ledger[i - 1] as { link?: unknown }).link
        : undefined;
  if (body.prev_link !== previous) {
    return { detail: `${position}: its prev_link is not the link of the entry before it` };
  }
  try {
    return {
      nonce: computeNonce({
        vault: body.vault as string,
        prev_link: body.prev_link as string,
        invoice_hash: body.invoice_hash as string | null,
        mandate_id: body.mandate_id as number | null,
        seq: body.seq as number,
      }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return { detail: `the nonce cannot be recomputed from this entry's position: ${reason}` };
  }
}

async function attestationOf(
  evidence: unknown,
  proposal: unknown,
  nonce: { nonce: string } | { detail: string },
): Promise<DecisionAttestation> {
  let checks: AttestationRow[];
  let binding: DecisionAttestation["binding"] = "none";
  try {
    const r = await checkAttestation(
      evidence as AttestationEvidence,
      "nonce" in nonce ? nonce.nonce : "",
      (proposal ?? null) as ModelProposal | null,
    );
    binding = r.binding === "address" || r.binding === "tls" ? r.binding : "none";
    checks = r.checks.map((c) => ({
      id: safeText(c.id, 8),
      pass: c.pass === true,
      detail:
        c.id === "A6" && "detail" in nonce
          ? safeText(nonce.detail, DETAIL_MAX)
          : safeText(c.detail, DETAIL_MAX),
    }));
  } catch (error) {
    const detail = safeText(
      `the evidence cannot be checked: ${error instanceof Error ? error.message : "unknown error"}`,
      DETAIL_MAX,
    );
    checks = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"].map((id) => ({ id, pass: false, detail }));
  }
  const failed = checks.filter((c) => !c.pass).map((c) => c.id);
  const ok = checks.length > 0 && failed.length === 0;
  return {
    ok,
    summary: ok
      ? "Consistent offline: A1 to A7 pass"
      : `Not consistent offline: ${failed.join(", ")} ${failed.length === 1 ? "fails" : "fail"}`,
    binding,
    checks,
  };
}

function modelNoteOf(decidedBy: DecisionDecider, raw: unknown, evidence: unknown): string | null {
  const has = evidence !== null && evidence !== undefined;
  if (has && !isObject(evidence)) {
    return "The entry's evidence is not an object, so what the TEE saw and signed cannot be shown.";
  }
  if (decidedBy === "rules-only") {
    return has
      ? "The entry carries model evidence, but it was decided rules-only: the code did not use the model's proposal."
      : NO_MODEL;
  }
  if (decidedBy === "unknown") {
    return `The entry does not say who decided (decided_by is ${safeText(raw, SHORT)}), so check (e) fails it.`;
  }
  return has
    ? null
    : "The entry says the model and the rules decided, but it carries no evidence, so check (e) fails it.";
}

function paymentOf(e: Record<string, unknown>, i: number, network: Network): ShownPayment {
  const b = e.body as Record<string, unknown>;
  const c = isObject(b.contract) ? b.contract : {};
  const hash = c.tx_hash;
  const named = hash !== null && hash !== undefined && hash !== "";
  const tx = isNearTxHash(hash);
  return {
    seq: i,
    at: safeText(b.at, SHORT),
    status: c.status === null || c.status === undefined ? "none" : safeText(c.status, SHORT),
    code: maybeText(c.code),
    spendId: c.spend_id === null || c.spend_id === undefined ? null : idText(c.spend_id),
    txUrl: tx ? explorerTxUrl(network, hash) : null,
    txLabel: tx ? `contract tx, seq ${i}` : named ? "malformed tx hash" : "no tx recorded",
  };
}

function spendOf(sp: Record<string, unknown>): ShownSpend {
  const id = sp.id as number;
  return {
    id,
    anchorId: spendAnchorId(id),
    status: safeText(sp.status, SHORT),
    amount: usdc(sp.amount),
    destination: payeeText(sp.destination),
    mandateId: idText(sp.mandate_id),
  };
}

function capsOf(m: Record<string, unknown>, id: number): ShownMandateCaps {
  return {
    id,
    label: safeText(m.label, SHORT),
    payee: payeeText(m.payee),
    maxPerPayment: usdc(m.max_per_payment),
    maxTotal: usdc(m.max_total),
    maxUses: isSeq(m.max_uses) ? String(m.max_uses) : safeText(m.max_uses, SHORT),
    approvalAbove: usdc(m.approval_above),
    expires: nsText(m.expires_at_ns),
    status: safeText(m.status, SHORT),
  };
}

function anchorOf(anchors: Record<string, unknown>[], i: number): AnchorCoverage {
  const covering = anchors
    .filter((a) => isSeq(a.count) && a.count > i)
    .sort((a, b) => (a.count as number) - (b.count as number))[0];
  if (covering === undefined) {
    return {
      covered: false,
      anchorSeq: null,
      count: null,
      text: "No anchor on chain covers this entry yet, so it is not chain-attested.",
    };
  }
  const count = covering.count as number;
  const seq = isSeq(covering.seq) ? covering.seq : null;
  const range =
    count === 1 ? "the first entry" : `the first ${count} entries (seq 0 to ${count - 1})`;
  return {
    covered: true,
    anchorSeq: seq,
    count,
    text: `Anchor ${seq ?? "(unreadable seq)"} on chain counts ${range}, this one included. Check (c) compares its root with the ledger.`,
  };
}

/**
 * Every decision entry of `snapshot`, newest first, with what the ledger records the TEE was shown, what it signed,
 * checks A1 to A7, and what the code and the contract checked. A1 to A7 come from core's `checkAttestation`, with the
 * nonce recomputed as core's check (e) does and the entry's own proposal, so evidence moved to another vault or
 * another place in the chain, or an entry whose vault, seq or prev_link is not where it sits, fails A6. Never throws:
 * an unreadable value is shown as such.
 */
export async function decisionRows(snapshot: Snapshot, network: Network): Promise<DecisionRow[]> {
  const s: Record<string, unknown> = isObject(snapshot) ? snapshot : {};
  const ledger = listOf(s.ledger);
  const chain = isObject(s.chain) ? s.chain : {};
  const spends = listOf(chain.spends).filter(isObject);
  const mandates = listOf(chain.mandates).filter(isObject);
  const anchors = listOf(chain.anchors).filter(isObject);
  const snapshotHref = isNearAccountId(s.vault) ? `/proof/${s.vault}/snapshot.json` : null;
  // The payment entries of each decision, by the decision's body hash, in ledger order.
  const paymentsOf = new Map<string, ShownPayment[]>();
  ledger.forEach((p, j) => {
    if (!isObject(p) || !isObject(p.body) || p.body.kind !== "payment") return;
    const hash = isObject(p.body.refs) ? p.body.refs.decision_body_hash : undefined;
    if (typeof hash !== "string" || !HEX32.test(hash)) return;
    paymentsOf.set(hash, [...(paymentsOf.get(hash) ?? []), paymentOf(p, j, network)]);
  });
  const usedSpends = new Set<number>();
  const rows: DecisionRow[] = [];
  for (let i = ledger.length - 1; i >= 0; i--) {
    const e = ledger[i];
    if (!isObject(e) || !isObject(e.body) || e.body.kind !== "decision") continue;
    const body = e.body;
    const bodyHash =
      typeof e.body_hash === "string" && HEX32.test(e.body_hash) ? e.body_hash : null;
    const decidedBy = deciderOf(body.decided_by);
    const evidence = body.evidence;
    const hasEvidence = evidence !== null && evidence !== undefined;
    const payments = bodyHash === null ? [] : (paymentsOf.get(bodyHash) ?? []);
    // A spend id is an anchor id: each one goes on one row only, even if a crafted chain binds it twice.
    const bound = (bodyHash === null ? [] : spends)
      .filter((sp) => sp.decision_hash === bodyHash && isSeq(sp.id) && !usedSpends.has(sp.id))
      .map(spendOf);
    for (const sp of bound) usedSpends.add(sp.id);
    const mandateId = isSeq(body.mandate_id) ? body.mandate_id : null;
    const mandate = mandateId === null ? undefined : mandates.find((m) => m.id === mandateId);
    const rules = rulesOf(body.rules);
    const verdict = verdictOf(body.verdict);
    const codes = new Set(payments.map((p) => p.code).filter((c): c is string => c !== null));
    rows.push({
      seq: i,
      id: seqAnchorId(i),
      spendIds: bound.map((sp) => sp.anchorId),
      at: safeText(body.at, SHORT),
      verdict,
      decidedBy,
      mandateId,
      amount: usdc(body.amount),
      invoiceHash:
        body.invoice_hash === null || body.invoice_hash === undefined
          ? null
          : hashText(body.invoice_hash),
      bodyHash: bodyHash ?? safeText(e.body_hash, SHORT),
      modelNote: modelNoteOf(decidedBy, body.decided_by, evidence),
      saw: isObject(evidence) ? sawOf(evidence) : null,
      signed: isObject(evidence) ? signedOf(evidence, body.proposal, snapshotHref) : null,
      attestation: hasEvidence
        ? await attestationOf(evidence, body.proposal, expectedNonce(s, ledger, i, body))
        : null,
      checked: {
        verdict,
        rules,
        firstBlocking:
          verdict === "hold" || verdict === "refuse"
            ? (rules.find((r) => r.outcome === verdict) ?? null)
            : null,
        payments,
        spends: bound,
        mandate: mandate === undefined || mandateId === null ? null : capsOf(mandate, mandateId),
        mandateNote:
          mandateId !== null && mandate === undefined
            ? `Mandate ${mandateId} is not in this snapshot's chain data.`
            : null,
        contractChecks: CONTRACT_CHECKS.map((c) => ({ ...c, refused: codes.has(c.code) })),
        holdRule: CONTRACT_HOLD,
      },
      anchor: anchorOf(anchors, i),
    });
  }
  return rows;
}
