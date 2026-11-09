// The ledger test on the landing page and on /proof: real edits to a real signed fixture, checked by the real verifier.
// No React here. The browser reaches this module only through a dynamic import() in TamperTest, on the first click, so
// neither the verifier nor the fixture is part of the landing page's first load.
import {
  type CheckId,
  type CheckResult,
  firstBrokenSeq,
  type LedgerEntry,
  runChecks,
  type Snapshot,
} from "@probarion/core";

export type TamperEditId = "amount" | "erase" | "verdict";

/** What an edit does to the one row it touches, so the table can show the change while the verifier reports it. */
export interface RowChange {
  amount?: string;
  outcome?: string;
  erased?: boolean;
}

export interface TamperEdit {
  id: TamperEditId;
  label: string;
  /** One sentence on what changed, shown above the table. */
  summary: string;
  seq: number;
  /** The word on the row, because colour is not the only signal. */
  rowNote: string;
  change: RowChange;
}

export const TAMPER_EDITS: readonly TamperEdit[] = [
  {
    id: "amount",
    label: "Change an amount",
    summary: "Entry 2 edited: 40 USDC became 0.000001 USDC",
    seq: 2,
    rowNote: "amount edited",
    change: { amount: "0.000001" },
  },
  {
    id: "erase",
    label: "Erase a refusal",
    summary: "Entry 4 erased from the ledger",
    seq: 4,
    rowNote: "erased",
    change: { erased: true },
  },
  {
    id: "verdict",
    label: "Turn a refusal into an approval",
    summary: "Entry 4 edited: refuse became allow",
    seq: 4,
    rowNote: "verdict edited",
    change: { outcome: "Allow" },
  },
];

function entryAt(snapshot: Snapshot, seq: number): LedgerEntry {
  const entry = snapshot.ledger.find((e) => e.body.seq === seq);
  if (entry === undefined) throw new Error(`the fixture has no entry ${seq}`);
  return entry;
}

/** A deep copy of `snapshot` with one edit applied. The signatures stay as they were, which is the point. */
export function applyTamper(snapshot: Snapshot, id: TamperEditId): Snapshot {
  const copy = structuredClone(snapshot);
  switch (id) {
    case "amount":
      entryAt(copy, 2).body.amount = "1";
      break;
    case "erase":
      entryAt(copy, 4);
      copy.ledger = copy.ledger.filter((e) => e.body.seq !== 4);
      break;
    case "verdict":
      entryAt(copy, 4).body.verdict = "allow";
      break;
  }
  return copy;
}

export interface TamperCheck {
  id: CheckId;
  status: CheckResult["status"];
  /** The verifier's own words. Plain text from a local fixture; React escapes it. */
  detail: string;
}

export interface TamperResult {
  ok: boolean;
  firstBroken: number | null;
  passed: number;
  failed: number;
  unproven: number;
  checks: TamperCheck[];
}

/** Runs the real checks a to i on the fixture, untouched when `id` is null. */
export async function verifyTamper(
  snapshot: Snapshot,
  id: TamperEditId | null,
): Promise<TamperResult> {
  const report = await runChecks(id === null ? snapshot : applyTamper(snapshot, id));
  const count = (status: CheckResult["status"]) =>
    report.checks.filter((c) => c.status === status).length;
  return {
    ok: report.ok,
    firstBroken: firstBrokenSeq(report),
    passed: count("pass"),
    failed: count("fail"),
    unproven: count("unproven"),
    checks: report.checks.map(({ id: check, status, detail }) => ({ id: check, status, detail })),
  };
}

export interface LedgerRow {
  seq: number;
  kind: string;
  outcome: string;
  mandate: string;
  /** In USDC with all six decimals, so the column lines up. */
  amount: string;
}

const CHAIN_NAME: Readonly<Record<string, string>> = { base: "Base", solana: "Solana" };
const RULE_WORDS: Readonly<Record<string, string>> = {
  "mandate.payee_mismatch": "payee mismatch",
};

const capitalized = (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

function usdcSixDecimals(units: string | null): string {
  if (units === null) return "";
  const digits = units.padStart(7, "0");
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

function outcomeOf({ body }: LedgerEntry): string {
  if (body.kind === "decision") {
    if (body.verdict !== "refuse") return capitalized(body.verdict ?? "");
    const rule = body.rules.find((r) => r.outcome === "refuse");
    return rule === undefined ? "Refuse" : `Refuse: ${RULE_WORDS[rule.id] ?? rule.id}`;
  }
  const status = body.contract?.status ?? "";
  if (status === "burned" && body.settlement !== null) {
    return `Withdrawal to ${CHAIN_NAME[body.settlement.chain] ?? body.settlement.chain}`;
  }
  return capitalized(status);
}

/** The table's rows, read from the fixture on the server: small props, so the fixture stays off the client. */
export function ledgerRows(snapshot: Snapshot): LedgerRow[] {
  return snapshot.ledger.map((entry) => ({
    seq: entry.body.seq,
    kind: capitalized(entry.body.kind),
    outcome: outcomeOf(entry),
    mandate: entry.body.mandate_id === null ? "" : String(entry.body.mandate_id),
    amount: usdcSixDecimals(entry.body.amount),
  }));
}
