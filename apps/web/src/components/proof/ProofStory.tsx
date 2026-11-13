import type { Snapshot } from "@probarion/core";
import type { ReactNode } from "react";
import { formatUsdc } from "@/lib/near/units";
import type { DecisionRow } from "@/lib/proof/decisions";

// The three lines at the top of a vault's /proof page: what its snapshot records, counted from the chain's spends and
// the snapshot's decision rows (the rows the Decisions section shows). Counts only. A rule or a contract code is named
// as the ledger records it, and the decision cards below say why each one went the way it did.

/** The spend statuses that moved USDC out of the vault: paid on NEAR, or burned for a withdrawal through Intents. */
const PAID: readonly string[] = ["paid", "burned"];
const DIGITS = /^(0|[1-9][0-9]*)$/;
/** How many rules or codes a line names; the rest are counted, so a crafted ledger cannot make a line long. */
const NAMED = 4;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isSeq = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A rule id or a contract code, and how many decisions or payments it names. */
export type StoryCount = readonly [label: string, n: number];

export interface ProofStoryFacts {
  /** Spends the chain holds as paid or burned. */
  paid: number;
  /** Their USDC in all, or null when an amount is not a whole number of base units. */
  paidUsdc: string | null;
  /** Paid after an allowed decision made with model output whose A1 to A7 pass on this snapshot. */
  attested: number;
  /** Paid after an allowed rules-only decision. */
  rulesOnly: number;
  /** Paid with a decision hash the snapshot lists as from before the signed ledger. */
  preLedger: number;
  /** Paid on a decision of the ledger that is neither of the two above: its card says more. */
  unplaced: number;
  /** Paid on no decision of the ledger and none from before it: check (d) says more. */
  unbound: number;
  decisions: number;
  withModel: number;
  /** Decisions the code refused, by the first rule that refused. */
  refused: StoryCount[];
  /** Decisions the code held, by the first rule that held. */
  held: StoryCount[];
  /** Payments the contract refused on chain, by its code. */
  contract: StoryCount[];
}

function tally(labels: readonly string[]): StoryCount[] {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The facts the three lines state, from the snapshot's chain spends and its decision rows. */
export function proofStoryFacts(snapshot: Snapshot, rows: readonly DecisionRow[]): ProofStoryFacts {
  const chain: Record<string, unknown> = isObject(snapshot.chain) ? snapshot.chain : {};
  const preLedger = new Set(
    listOf(snapshot.pre_ledger_decision_hashes).filter((h) => typeof h === "string"),
  );
  // Each spend id is on one row at most (decisionRows binds it once).
  const rowOf = new Map<number, DecisionRow>();
  for (const r of rows) for (const sp of r.checked.spends) rowOf.set(sp.id, r);
  const seen = new Set<number>();
  const f = { paid: 0, attested: 0, rulesOnly: 0, preLedger: 0, unplaced: 0, unbound: 0 };
  let units = 0n;
  let readable = true;
  for (const sp of listOf(chain.spends)) {
    if (!isObject(sp) || !isSeq(sp.id) || seen.has(sp.id)) continue;
    if (typeof sp.status !== "string" || !PAID.includes(sp.status)) continue;
    seen.add(sp.id);
    f.paid++;
    if (typeof sp.amount === "string" && DIGITS.test(sp.amount)) units += BigInt(sp.amount);
    else readable = false;
    const r = rowOf.get(sp.id);
    if (r === undefined) {
      if (typeof sp.decision_hash === "string" && preLedger.has(sp.decision_hash)) f.preLedger++;
      else f.unbound++;
    } else if (r.verdict === "allow" && r.decidedBy === "model+rules" && r.attestation?.ok) {
      f.attested++;
    } else if (r.verdict === "allow" && r.decidedBy === "rules-only") {
      f.rulesOnly++;
    } else {
      f.unplaced++;
    }
  }
  const first = (r: DecisionRow) => r.checked.firstBlocking?.id ?? "no rule recorded";
  return {
    ...f,
    paidUsdc: readable ? formatUsdc(units.toString()) : null,
    decisions: rows.length,
    withModel: rows.filter((r) => r.decidedBy === "model+rules").length,
    refused: tally(rows.filter((r) => r.verdict === "refuse").map(first)),
    held: tally(rows.filter((r) => r.verdict === "hold").map(first)),
    contract: tally(
      rows.flatMap((r) =>
        r.checked.payments.filter((p) => p.status === "refused").map((p) => p.code ?? "no code"),
      ),
    ),
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const total = (counts: readonly StoryCount[]) => counts.reduce((sum, [, n]) => sum + n, 0);

const code = "font-mono text-[0.9em] wrap-anywhere";

/** "(mandate.payee_mismatch)" for one label, "(4 a, 2 b)" for several, the ones past NAMED counted. */
function Named({ counts }: { counts: readonly StoryCount[] }) {
  const named = counts.slice(0, NAMED);
  const rest = counts.length - named.length;
  const one = counts.length === 1;
  return (
    <>
      {" ("}
      {named.map(([label, n], i) => (
        <span key={label}>
          {i > 0 ? ", " : null}
          {one ? null : `${n} `}
          <code className={code}>{label}</code>
        </span>
      ))}
      {rest > 0 ? `, and ${plural(rest, "other", "others")}` : null}
      {")"}
    </>
  );
}

/** Line 2: how the paid spends were decided, or, with none paid, what the ledger holds. */
function decidedLine(f: ProofStoryFacts): string {
  if (f.paid === 0) {
    return f.decisions === 0
      ? "Its signed ledger holds no decision yet."
      : `Its signed ledger holds ${plural(f.decisions, "decision", "decisions")}, ${f.withModel} made with model output.`;
  }
  const them = (n: number) => (n === 1 ? "it" : "them");
  const ways: [number, string][] = [
    [
      f.attested,
      `after an attested model proposed ${them(f.attested)} (A1 to A7 pass on this snapshot)`,
    ],
    [f.rulesOnly, "on the code rules alone"],
    [f.preLedger, "on a decision from before the signed ledger"],
    [
      f.unplaced,
      `on another kind of decision (see ${f.unplaced === 1 ? "its card" : "their cards"} below)`,
    ],
    [f.unbound, "on no decision in the signed ledger (see check d)"],
  ];
  const [head, ...rest] = ways.filter(([n]) => n > 0);
  if (head === undefined) return "";
  if (rest.length === 0) {
    const all = f.paid === 1 ? "It was" : f.paid === 2 ? "Both were" : `All ${f.paid} were`;
    return `${all} paid ${head[1]}.`;
  }
  // "Of these, 1 was paid after ..., 1 on the code rules alone, and 1 on a decision from before the signed ledger."
  const others = rest.map(([n, how]) => `${n} ${how}`);
  const listed = others.map((o, i) => (i === others.length - 1 ? `and ${o}` : o)).join(", ");
  return `Of these, ${head[0]} ${head[0] === 1 ? "was" : "were"} paid ${head[1]}, ${listed}.`;
}

/** Line 3: what the code refused or held and what the contract refused, or that none was. */
function refusedLine(f: ProofStoryFacts): ReactNode {
  const refused = total(f.refused);
  const held = total(f.held);
  const contract = total(f.contract);
  if (refused + held + contract === 0) {
    return "No decision was refused or held, and the contract refused no payment.";
  }
  return (
    <>
      {refused > 0 ? (
        <>
          {plural(refused, "decision was", "decisions were")} refused by the code rules
          <Named counts={f.refused} />.
        </>
      ) : null}
      {held > 0 ? (
        <>
          {refused > 0 ? " " : null}
          {plural(held, "decision was", "decisions were")} held
          {refused > 0 ? null : " by the code rules"}
          <Named counts={f.held} />.
        </>
      ) : null}
      {contract > 0 ? (
        <>
          {refused + held > 0 ? " " : null}
          The contract refused {plural(contract, "payment", "payments")} on chain
          <Named counts={f.contract} />.
        </>
      ) : null}
    </>
  );
}

/**
 * The story of a vault's snapshot in three lines: what was paid, how it was decided, and what was refused or held.
 * `takenAt` is the snapshot's time in full, as the page and the verifier print it ("snapshot taken <taken_at>"), never
 * rounded, so it is not mistaken for another snapshot's. With no decision in the ledger, the third line is left out.
 */
export function ProofStory({
  snapshot,
  rows,
  takenAt,
}: {
  snapshot: Snapshot;
  rows: readonly DecisionRow[];
  takenAt: string;
}) {
  const f = proofStoryFacts(snapshot, rows);
  const usdc = f.paidUsdc === null ? "" : `, ${f.paidUsdc} USDC in all`;
  return (
    <ul
      className="mt-4 grid gap-1.5 border-l-2 border-gold-deep pl-4 text-sm text-ink"
      data-story=""
    >
      <li data-story-line="paid">
        {f.paid === 0
          ? `As of ${takenAt}, this vault has paid out no spend on chain.`
          : `As of ${takenAt}, this vault has paid out ${plural(f.paid, "spend", "spends")} on chain${usdc}.`}
      </li>
      <li data-story-line="decided">{decidedLine(f)}</li>
      {f.decisions > 0 ? <li data-story-line="refused">{refusedLine(f)}</li> : null}
    </ul>
  );
}
