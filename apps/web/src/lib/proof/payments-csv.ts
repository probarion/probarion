import { formatUsdc } from "@/lib/near/units";
import { type DecisionOutcome, type DecisionRow, decisionOutcome } from "./decisions";
import { safeText } from "./sanitize";
import type { ProofOk } from "./service";

// The vault's payments as a spreadsheet, served at /proof/<vault>/payments.csv. Pure: it reads the decision rows of
// one snapshot (decisionRows, the rows the Decisions cards of /proof show) and writes text, with no database or RPC
// call of its own.
//
// One row per decision entry of the ledger, newest first: the order of the Decisions cards, so row N of the file is
// card N of the page. A payment entry is not a row of its own: it is joined to the decision it points back to
// (refs.decision_body_hash), and the spend to the decision whose body_hash the chain binds it to (decision_hash). What
// became of the decision (the Decision and Reason columns) is `decisionOutcome`, which the cards' summary line reads
// too, so the file and the page cannot disagree.
//
// Columns:
// - Date (UTC): when the decision entry was written, "YYYY-MM-DD HH:MM:SS".
// - Mandate, Label: the mandate id the entry names, and its label as the snapshot's chain data holds it.
// - Payee: the destination of the spend the chain binds to the decision, else the mandate's payee on chain.
// - Amount (USDC): the entry's amount as a plain decimal with a dot and no thousands separator, such as 4 or 2.5.
// - Decision: the code's verdict (allow, hold, refuse, unknown), or "refused by contract" when the contract refused
//   the spend, as the card shows it (the card hides the code's allow next to a contract refusal).
// - Reason: why it was held or refused: the rule and its detail, the contract's code, the contract's hold for an
//   approver, or why no spend is on chain. Empty for a payment that went through with nothing kept back.
// - Spend id, Status now: each spend the chain binds to the decision, and its status on chain ("no spend" when there
//   is none). "Now" is when the snapshot read the chain: its taken_at, which the SDK stamps before it reads the chain,
//   and which the column's header names. A spend whose payment entry says held can read paid here: an approver
//   approved it on chain since, and no code writes an approval to the ledger.
// - Transaction, Explorer link: the contract tx each payment entry of the decision records. It is the spend tx, so
//   for a held spend that an approver paid later it is the tx that created the hold, not the approve tx.
// - Invoice SHA-256: the entry's invoice_hash. Ledger seq: the entry's position in the ledger.
//
// The file is RFC 4180: a header row, then the rows, each ended by CRLF, after a UTF-8 BOM so that a spreadsheet reads
// it as UTF-8. A field that holds a comma, a quote, a CR or an LF is quoted, its quotes doubled. Nothing comes before
// the header: no comment or preamble row, which spreadsheets would read as data. The capture time is in the file name
// and in the Status now header instead. Every field goes through the formula guard: one that starts with = + - @, a
// tab or a CR gets a leading apostrophe, so a spreadsheet shows it as text instead of running it. Labels, rule details
// and payees are set by the owner, the agent or the model, and a crafted ledger can put anything anywhere, so the
// guard runs on every field, not only on those.

/** The byte order mark that tells a spreadsheet the file is UTF-8. */
export const CSV_BOM = String.fromCharCode(0xfeff);
const CRLF = "\r\n";
/** What a spreadsheet may read as the start of a formula (OWASP's list). */
const FORMULA_START = /^[=+\-@\t\r]/;
/** What makes RFC 4180 quote a field. */
const NEEDS_QUOTES = /[",\r\n]/;

/** The columns, in order. Status now's header also names the time the snapshot read the chain: see `paymentsHeader`. */
export const PAYMENTS_COLUMNS = [
  "Date (UTC)",
  "Mandate",
  "Label",
  "Payee",
  "Amount (USDC)",
  "Decision",
  "Reason",
  "Spend id",
  "Status now",
  "Transaction",
  "Explorer link",
  "Invoice SHA-256",
  "Ledger seq",
] as const;

/** What Status now says when the chain binds no spend to the decision. */
export const NO_SPEND = "no spend";
/** The Reason of a decision the code did not keep back, with nothing recorded or found on chain (the card's words). */
export const NO_PAYMENT_ENTRY =
  "No payment entry in this snapshot records a spend for this decision";

/** A field a spreadsheet would read as a formula, with a leading apostrophe; any other field as it is. */
export function guardFormula(field: string): string {
  return FORMULA_START.test(field) ? `'${field}` : field;
}

/** One field as RFC 4180 writes it, after the formula guard. */
export function csvField(field: string): string {
  const guarded = guardFormula(field);
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** One record, ended by CRLF. */
export function csvRecord(fields: readonly string[]): string {
  return `${fields.map(csvField).join(",")}${CRLF}`;
}

/** An ISO time as "YYYY-MM-DD HH:MM:SS" in UTC, or null when it cannot be read. */
function utcSeconds(at: unknown): string | null {
  if (typeof at !== "string") return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 19).replace("T", " ");
}

/** The header row: Status now names when the snapshot read the chain (its taken_at). */
export function paymentsHeader(takenAt: unknown): string[] {
  const read = utcSeconds(takenAt);
  const when = read === null ? safeText(takenAt, 120) : `${read} UTC`;
  return PAYMENTS_COLUMNS.map((c) => (c === "Status now" ? `Status now (chain read ${when})` : c));
}

/** USDC base units as a plain decimal; "" for no amount; the row's text for one that is not a USDC amount. */
function amountField(amount: DecisionRow["amount"]): string {
  if (amount.units !== null) return formatUsdc(amount.units);
  return amount.text === "none" ? "" : amount.text;
}

const unique = (values: readonly (string | null)[]): string[] => [
  ...new Set(values.filter((v): v is string => v !== null)),
];

function decisionField(r: DecisionRow, o: DecisionOutcome): string {
  return o.kind === "contract_refused" ? "refused by contract" : r.verdict;
}

/** Why the decision was held or refused, or why nothing is on chain for it, in the words of its card. */
function reasonField(r: DecisionRow, o: DecisionOutcome): string {
  switch (o.kind) {
    case "contract_refused": {
      const code = o.payment.code;
      if (o.dryRun) {
        return code === null
          ? "refused in the contract's dry run, nothing sent"
          : `${code} in the contract's dry run, nothing sent`;
      }
      return code === null ? "nothing paid" : `${code}, nothing paid`;
    }
    case "code":
      return o.rule === null
        ? `${o.did} by the code, nothing sent`
        : `${o.did} by ${o.rule.id}, nothing sent: ${o.rule.detail}`;
    case "payment": {
      const p = o.payment;
      const spend = p.spendId === null ? "" : ` for spend ${p.spendId}`;
      const code = p.code === null ? "" : ` (${p.code})`;
      return `the payment entry at seq ${p.seq} says ${p.status}${spend}${code}, and the chain holds no spend for this decision`;
    }
    case "none":
      return NO_PAYMENT_ENTRY;
    case "spend": {
      // The contract took the spend; a rule may still have held it (the SDK sends a hold the contract holds too).
      const rule = r.checked.firstBlocking;
      if (rule !== null) {
        return `${r.verdict === "hold" ? "held" : "refused"} by ${rule.id}: ${rule.detail}`;
      }
      // The contract holds a spend only when it is above the mandate's approval limit (CONTRACT_HOLD).
      const held = r.checked.payments.find((p) => p.status === "held");
      return held === undefined
        ? ""
        : `above the mandate's approval limit, the contract held it for an approver (payment entry at seq ${held.seq})`;
    }
  }
}

/** The fields of one decision, in the order of PAYMENTS_COLUMNS, before quoting and the guard. */
export function paymentFields(r: DecisionRow): string[] {
  const o = decisionOutcome(r);
  const { spends, payments, mandate } = r.checked;
  return [
    utcSeconds(r.at) ?? r.at,
    r.mandateId === null ? "" : String(r.mandateId),
    mandate?.label ?? "",
    spends[0]?.destination ?? mandate?.payee ?? "",
    amountField(r.amount),
    decisionField(r, o),
    reasonField(r, o),
    spends.map((s) => String(s.id)).join("; "),
    spends.length === 0 ? NO_SPEND : spends.map((s) => s.status).join("; "),
    unique(payments.map((p) => p.txHash)).join("; "),
    unique(payments.map((p) => p.txUrl)).join("; "),
    r.invoiceHash ?? "",
    String(r.seq),
  ];
}

/** The whole file: the BOM, the header row, then one row per decision in the order of `rows` (newest first). */
export function paymentsCsv(rows: readonly DecisionRow[], takenAt: unknown): string {
  return `${CSV_BOM}${csvRecord(paymentsHeader(takenAt))}${rows.map((r) => csvRecord(paymentFields(r))).join("")}`;
}

/**
 * The download's file name: `<vault>-payments-<capture time>.csv`, the time in ISO 8601 basic form (no colon, which
 * a file name on Windows cannot hold), such as 20261109T115806Z. Without a readable capture time, `<vault>-payments.csv`.
 * `vault` is a validated NEAR account id, so the name needs no quoting.
 */
export function paymentsCsvFileName(vault: string, takenAt: unknown): string {
  const read = utcSeconds(takenAt);
  return read === null
    ? `${vault}-payments.csv`
    : `${vault}-payments-${read.replace(/[-:]/g, "").replace(" ", "T")}Z.csv`;
}

/**
 * The payments.csv download, with snapshot.json's caching: a browser does not reuse it (each click asks again), and a
 * member's view of a private vault is never stored by anyone.
 */
export function paymentsCsvResponse(r: ProofOk, rows: readonly DecisionRow[]): Response {
  return new Response(paymentsCsv(rows, r.snapshot.taken_at), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${paymentsCsvFileName(r.vault, r.snapshot.taken_at)}"`,
      "cache-control":
        r.audience === "public" ? "private, max-age=0, must-revalidate" : "private, no-store",
    },
  });
}
