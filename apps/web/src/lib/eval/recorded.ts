import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AttestationCheck,
  type AttestationEvidence,
  type AttestationResult,
  canonicalJson,
  checkAttestation,
  checkRequestBinding,
  computeNonce,
  type ModelProposal,
  type NonceContext,
  parseModelProposal,
  toProposalRequestFacts,
  toProposalRequestMandate,
} from "@probarion/core";
import type { ProposeInput, ProposeResult } from "@probarion/sdk";
import type { Prepared } from "./run";

// One model answer per case, recorded by the OWNER from NEAR AI Cloud (scripts/eval-record.ts) and replayed offline.
// A replay trusts an answer only as the SDK's model step would at that ledger position: A1-A7 against the nonce the
// runner computes for the case, A8 against the invoice text the runner extracts, and the facts and mandate the model
// was shown equal to the ones the code computes today. Anything else and the case is decided rules-only, with
// model.unavailable, as Probarion.modelStep does.

/** What eval:record writes to eval/recorded/<case id>.json. */
export interface RecordedAnswer {
  v: 1;
  note: string;
  case: string;
  recorded_at: string;
  model: string;
  /** The ledger position the nonce was made for (the case's vault, seq 0, ZERO_LINK, its invoice and mandate). */
  context: NonceContext;
  proposal: ModelProposal;
  evidence: AttestationEvidence;
  usage: { promptTokens: number; completionTokens: number } | null;
  /** Milliseconds from the request to the checked answer, as the recorder measured them. */
  latency_ms: number;
  /** A1-A7 and A8 as the recorder ran them before writing the file. The replay runs them again. */
  offline_check: AttestationResult;
  request_binding_check: AttestationCheck;
}

export const RECORDED_DIR = "eval/recorded";
export const recordedPath = (id: string): string => `${RECORDED_DIR}/${id}.json`;

/** Loads the committed answer of a case, or null when none was recorded. */
export function loadRecorded(root: string, id: string): RecordedAnswer | null {
  const at = join(root, recordedPath(id));
  if (!existsSync(at)) return null;
  return JSON.parse(readFileSync(at, "utf8")) as RecordedAnswer;
}

/** How a recorded answer was used. */
export type ReplayStatus = "not_recorded" | "replayed" | "stale" | "invalid";

export interface Replay {
  status: ReplayStatus;
  /** Why the answer was not used (stale or invalid), else null. */
  problem: string | null;
  /** The proposal decide() trusts: set only when the status is `replayed`. */
  proposal: ModelProposal | null;
  /** decide()'s attestationOk: null with no answer, false when one was not used, true when it was. */
  attestationOk: boolean | null;
  answer: RecordedAnswer | null;
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** Checks a recorded answer against what the runner computes for the case now. */
export async function replayAnswer(p: Prepared, answer: RecordedAnswer | null): Promise<Replay> {
  if (answer === null) {
    return { status: "not_recorded", problem: null, proposal: null, attestationOk: null, answer };
  }
  const unused = (status: "stale" | "invalid", problem: string): Replay => ({
    status,
    problem,
    proposal: null,
    attestationOk: false,
    answer,
  });
  if (p.text === null || p.facts === null || p.context === null || p.candidate === null) {
    return unused("stale", "the case no longer reaches the model step");
  }
  if (answer.case !== p.case.id) return unused("invalid", `the answer is for case ${answer.case}`);
  if (!same(answer.context, p.context)) {
    return unused("stale", "the ledger context differs from the one the runner computes");
  }
  const inputs = answer.evidence?.request_inputs;
  if (!same(inputs?.facts ?? null, toProposalRequestFacts(p.facts))) {
    return unused(
      "stale",
      "the facts the model was shown differ from what the code reads now: record again",
    );
  }
  if (!same(inputs?.mandates ?? null, [toProposalRequestMandate(p.candidate)])) {
    return unused("stale", "the mandate the model was shown differs from the case's mandate");
  }
  let proposal: ModelProposal;
  try {
    proposal = parseModelProposal(answer.proposal);
  } catch (error) {
    return unused("invalid", `the proposal does not parse: ${(error as Error).message}`);
  }
  const attestation = await checkAttestation(answer.evidence, computeNonce(p.context), proposal);
  if (!attestation.ok) {
    const failed = attestation.checks.filter((c) => !c.pass).map((c) => `${c.id} (${c.detail})`);
    return unused("invalid", `attestation checks failed: ${failed.join("; ")}`);
  }
  const a8 = checkRequestBinding(answer.evidence, p.text, p.context);
  if (!a8.pass) return unused("invalid", `A8 failed: ${a8.detail}`);
  return { status: "replayed", problem: null, proposal, attestationOk: true, answer };
}

/** What eval:record needs of NearAiProposer (a test passes one wired to the SDK's fake NEAR AI). */
export interface Proposer {
  propose(input: ProposeInput): Promise<ProposeResult>;
}

/**
 * Asks the model about one case exactly as Probarion.modelStep would (the case's text, its facts, its nonce mandate
 * alone, the nonce of its ledger position), then runs A1-A7 and A8 on the answer. `ok` is false when any check
 * fails: the recorder then writes nothing for the case.
 */
export async function recordAnswer(
  p: Prepared,
  proposer: Proposer,
  clock: { now: () => Date; ms: () => number },
): Promise<{ answer: RecordedAnswer; ok: boolean }> {
  if (p.text === null || p.facts === null || p.context === null || p.candidate === null) {
    throw new Error(`case ${p.case.id} does not reach the model step`);
  }
  const nonce = computeNonce(p.context);
  const started = clock.ms();
  const result = await proposer.propose({
    invoiceText: p.text,
    mandates: [p.candidate],
    nonce,
    facts: p.facts,
  });
  const latency = Math.max(0, Math.round(clock.ms() - started));
  const offline = await checkAttestation(result.evidence, nonce, result.proposal);
  const a8 = checkRequestBinding(result.evidence, p.text, p.context);
  const answer: RecordedAnswer = {
    v: 1,
    note: "Recorded from NEAR AI Cloud by the OWNER with pnpm eval:record. Real attestation evidence; the invoice is synthetic test data.",
    case: p.case.id,
    recorded_at: clock.now().toISOString(),
    model: result.evidence.model,
    context: p.context,
    proposal: result.proposal,
    evidence: result.evidence,
    usage: result.usage,
    latency_ms: latency,
    offline_check: offline,
    request_binding_check: a8,
  };
  return { answer, ok: offline.ok && a8.pass };
}
