import type { SpendOutcome } from "@probarion/sdk";
import { safeText } from "@/lib/proof/sanitize";
import type { AmountIssue } from "./amount";
import { amountIssueText, outcomeLabel } from "./view";

// What the upload form shows for each answer of POST /api/console/[vault]/invoices (route.ts), in plain words. Pure,
// so the browser form and a test share it. Every server string is passed through safeText.

export interface UploadAnswer {
  tone: "good" | "warn" | "bad";
  text: string;
  /** The invoice to link ("See the cycle"): the new one, or the existing one of a duplicate. */
  invoiceId: string | null;
}

const NO_ANSWER =
  "the server did not answer; check the invoice list before you upload again (the cycle may have run).";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const text = (v: unknown, max = 600): string | null =>
  typeof v === "string" && v !== "" ? safeText(v, max) : null;

const AMOUNT_ISSUE = /^(not_found|ambiguous|unreadable|currency|truncated|zero|not_payable)$/;

/** `body` is the parsed JSON, or null when the answer was not JSON (a gateway's 502 or 504 page). */
export function uploadAnswer(status: number, body: unknown): UploadAnswer {
  if (!isRecord(body)) {
    if (status === 413) {
      return {
        tone: "bad",
        text: "The upload is too large: an invoice is at most 4 MiB.",
        invoiceId: null,
      };
    }
    return { tone: "bad", text: `Status ${status}: ${NO_ANSWER}`, invoiceId: null };
  }
  const invoiceId = text(body.invoiceId, 64);
  const detail = text(body.detail);
  const notice = text(body.notice);
  if (status >= 200 && status < 300 && invoiceId !== null) {
    const outcome = isRecord(body.outcome) ? (body.outcome as unknown as SpendOutcome) : null;
    if (notice !== null) return { tone: "warn", text: notice, invoiceId };
    const label = outcome
      ? outcomeLabel(outcome.status, outcome.code, outcome.spendId)
      : `Status: ${text(body.status, 40) ?? "unknown"}`;
    const issue =
      typeof body.amountIssue === "string" && AMOUNT_ISSUE.test(body.amountIssue)
        ? amountIssueText(body.amountIssue as AmountIssue)
        : null;
    const good = outcome?.status === "paid" || outcome?.status === "burned";
    return {
      tone: good ? "good" : outcome?.status === "held" ? "warn" : "bad",
      text: issue ? `Decided: ${label}. ${issue}` : `Decided: ${label}.`,
      invoiceId,
    };
  }
  const code = text(body.error, 60) ?? `status ${status}`;
  switch (code) {
    case "duplicate":
      return {
        tone: "warn",
        text: `Duplicate: ${detail ?? "this invoice was already uploaded."}`,
        invoiceId,
      };
    case "no_mandate":
      return {
        tone: "bad",
        text: `No mandate matches this invoice. Attach the PO or contract document whose hash is in the mandate (the same file you hashed when you created it). ${detail ?? ""}`.trim(),
        invoiceId: null,
      };
    case "too_large":
      return {
        tone: "bad",
        text: detail ?? "The upload is too large: an invoice is at most 4 MiB.",
        invoiceId: null,
      };
    default:
      if (status >= 500 && detail === null) {
        return { tone: "bad", text: `Status ${status}: ${NO_ANSWER}`, invoiceId };
      }
      return { tone: "bad", text: detail ? `${code}: ${detail}` : code, invoiceId };
  }
}
