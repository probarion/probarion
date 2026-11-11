import { formatUsdc } from "@/lib/near/units";
import { type DecisionOutcome, type DecisionRow, decisionOutcome } from "./decisions";
import { safeText } from "./sanitize";
import type { ProofOk } from "./service";

// The vault's payments as a spreadsheet, served at /proof/<vault>/payments.csv. Pure: it reads the decision rows of
// one snapshot (decisionRows, the function that builds the Decisions cards of /proof) and writes text, with no
// database or RPC call of its own.
//
// One row per decision entry of the ledger, newest first: for the same snapshot, the rows are the cards in the order
// the page lists them, built by the same code. The download takes its own snapshot, though (the route loads the proof
// itself, as snapshot.json does), so it can be older or newer than the page's: the capture time in the file name and
// in the Chain read column is the snapshot's taken_at, to compare with the page's "snapshot taken" line. A payment
// entry is not a row of its own: it is joined to the decision it points back to (refs.decision_body_hash), and the
// spend to the decision whose body_hash the chain binds it to (decision_hash). What became of the decision (the
// Decision and Reason columns) is `decisionOutcome`, which the cards' summary line reads too, so the two cannot
// disagree on one snapshot.
//
// Columns:
// - Date (UTC): when the decision entry was written, "YYYY-MM-DD HH:MM:SS".
// - Mandate, Label: the mandate id the entry names, and its label as the snapshot's chain data holds it.
// - Payee: the destination of the spend the chain binds to the decision. Empty when the chain holds none: nothing was
//   sent, and the account an invoice named is not the mandate's (a refusal by mandate.payee_mismatch names both in
//   the Reason).
// - Amount (USDC): the entry's amount as a plain decimal with a dot and no thousands separator, such as 4 or 2.5.
// - Decision: the code's verdict (allow, hold, refuse, unknown), or "refused by contract" when the contract refused
//   the spend, as the card shows it (the card hides the code's allow next to a contract refusal).
// - Reason: why it was held or refused: the rule and its detail, the contract's code, the contract's hold for an
//   approver, or why no spend is on chain; and a spend on chain that no payment entry records, as the card says it.
//   Empty for a payment that went through with nothing kept back.
// - Spend id, Status now: each spend the chain binds to the decision, and its status on chain ("no spend" when there
//   is none). "Now" is when the snapshot read the chain. A spend whose payment entry says held can read paid here: an
//   approver approved it on chain since, and no code writes an approval to the ledger.
// - Chain read (UTC): that time, the snapshot's taken_at, which the SDK stamps before it reads the chain. It is the
//   same on every row, so that a row copied elsewhere keeps it, and the header row stays the same from one file to
//   the next.
// - Spend transaction, Explorer link: the contract tx each payment entry of the decision records, the one that sent
//   the spend. For a spend the contract held and an approver paid later, it is the tx that created the hold, which
//   moved no USDC; the approve tx is in no ledger entry, so it is not in the file.
// - Invoice SHA-256: the entry's invoice_hash. Ledger seq: the entry's position in the ledger.
//
// The file is RFC 4180: a header row, then the rows, each ended by CRLF, after a UTF-8 BOM so that a spreadsheet reads
// it as UTF-8. A field that holds a comma, a quote, a CR or an LF is quoted, its quotes doubled. Nothing comes before
// the header: no comment or preamble row, which spreadsheets would read as data. The capture time is in the file name
// and in the Chain read column instead. Every field goes through the formula guard (`guardFormula`): an apostrophe
// goes before any = + - @, tab or CR that starts a cell, so a spreadsheet shows it as text instead of running it.
// Labels, rule details and payees are set by the owner, the agent, the model or the sender of an invoice, and a
// crafted ledger can put anything anywhere, so the guard runs on every field, not only on those.

/** The byte order mark that tells a spreadsheet the file is UTF-8. */
export const CSV_BOM = String.fromCharCode(0xfeff);
const CRLF = "\r\n";
/**
 * Where a spreadsheet may start a cell inside a field, and the spaces and quotes it may skip or trim there. Excel in a
 * locale whose list separator is the semicolon (de-DE, fr-FR and many others) splits each line of a .csv on `;`, not
 * on commas, and honours a quote only at the start of a cell, so each `;` of a field starts a cell, and so does each
 * CR or LF (a quote in the middle of a cell does not keep it in the field). OWASP's CSV injection guidance names this
 * separator case.
 */
const CELL_IN_FIELD = /([;\r\n][ "]*)(?=[=+\-@\t\r])/g;
/** A field whose first cell, after any spaces or quotes, starts with what a spreadsheet may read as a formula. */
const FORMULA_START = /^[ "]*[=+\-@\t\r]/;
/** What makes RFC 4180 quote a field. */
const NEEDS_QUOTES = /[",\r\n]/;

/**
 * The columns, in order: the header row, the same in every file. The time the snapshot read the chain is a column of
 * its own (Chain read), not part of a header.
 */
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
  "Chain read (UTC)",
  "Spend transaction",
  "Explorer link",
  "Invoice SHA-256",
  "Ledger seq",
] as const;

/** What Status now says when the chain binds no spend to the decision. */
export const NO_SPEND = "no spend";
/** The Reason of a decision the code did not keep back, with nothing recorded or found on chain (the card's words). */
export const NO_PAYMENT_ENTRY =
  "No payment entry in this snapshot records a spend for this decision";

/**
 * A field with an apostrophe before each = + - @, tab or CR that starts a cell (OWASP's list): at the start of the
 * field, or after a `;`, CR or LF in it, each after any spaces or quotes there. A spreadsheet then shows that cell as
 * text instead of running it, whether it splits the line on commas or on semicolons. Any other field as it is.
 */
export function guardFormula(field: string): string {
  const inner = field.replace(CELL_IN_FIELD, "$1'");
  const start = FORMULA_START.exec(inner);
  if (start === null) return inner;
  const at = start[0].length - 1;
  return `${inner.slice(0, at)}'${inner.slice(at)}`;
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

/**
 * The Chain read field: the snapshot's taken_at as "YYYY-MM-DD HH:MM:SS", a text it cannot read as the snapshot has
 * it, and "" when it is no text at all.
 */
export function chainReadField(takenAt: unknown): string {
  return utcSeconds(takenAt) ?? (typeof takenAt === "string" ? safeText(takenAt, 120) : "");
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
      const { spends, payments } = r.checked;
      // The contract holds a spend only when it is above the mandate's approval limit (CONTRACT_HOLD). Its
      // held_until_ns stays set after an approve, and its payment entry, when one was written, says held.
      const entry = payments.find((p) => p.status === "held");
      if (entry !== undefined || spends.some((s) => s.heldByContract)) {
        const recorded =
          entry !== undefined
            ? `payment entry at seq ${entry.seq}`
            : "no payment entry in this snapshot records it";
        return `above the mandate's approval limit, the contract held it for an approver (${recorded})`;
      }
      if (payments.length > 0) return "";
      // The SDK writes a payment entry after each spend; when that write fails, only the chain records the spend.
      const ids = spends.map((s) => s.id).join(", ");
      return `no payment entry in this snapshot records it, but the chain holds ${spends.length === 1 ? "spend" : "spends"} ${ids} for this decision`;
    }
  }
}

/**
 * The fields of one decision, in the order of PAYMENTS_COLUMNS, before quoting and the guard. `chainRead` is the
 * snapshot's Chain read field (`chainReadField`), the same for every row of one file.
 */
export function paymentFields(r: DecisionRow, chainRead: string): string[] {
  const o = decisionOutcome(r);
  const { spends, payments, mandate } = r.checked;
  return [
    utcSeconds(r.at) ?? r.at,
    r.mandateId === null ? "" : String(r.mandateId),
    mandate?.label ?? "",
    spends[0]?.destination ?? "",
    amountField(r.amount),
    decisionField(r, o),
    reasonField(r, o),
    spends.map((s) => String(s.id)).join("; "),
    spends.length === 0 ? NO_SPEND : spends.map((s) => s.status).join("; "),
    chainRead,
    unique(payments.map((p) => p.txHash)).join("; "),
    unique(payments.map((p) => p.txUrl)).join("; "),
    r.invoiceHash ?? "",
    String(r.seq),
  ];
}

/** The whole file: the BOM, the header row, then one row per decision in the order of `rows` (newest first). */
export function paymentsCsv(rows: readonly DecisionRow[], takenAt: unknown): string {
  const chainRead = chainReadField(takenAt);
  return `${CSV_BOM}${csvRecord(PAYMENTS_COLUMNS)}${rows.map((r) => csvRecord(paymentFields(r, chainRead))).join("")}`;
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
