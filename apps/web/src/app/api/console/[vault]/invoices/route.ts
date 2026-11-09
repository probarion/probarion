import type { MandateView } from "@probarion/core";
import { memberForApi } from "@/lib/auth/guard";
import type { Network } from "@/lib/config";
import { masterKey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import type { Db } from "@/lib/db/port";
import { assertSameOrigin, json, problem, rateLimitOr429 } from "@/lib/http";
import { log, newRequestId } from "@/lib/log";
import { listAll } from "@/lib/near/reader";
import { getReader } from "@/lib/near/server";
import { tagRequest } from "@/lib/observe";
import { ExtractError, MAX_INVOICE_BYTES } from "@/lib/payables/extract";
import { NUMBER_DUPLICATE_RULE, numberDuplicateNotice } from "@/lib/payables/number-duplicate";
import { type PipelineResult, processInvoice } from "@/lib/payables/pipeline";
import {
  byteCount,
  cleanName,
  fileTooLarge,
  type InvoiceUpload,
  MAX_REQUEST_BYTES,
  mediaTypeOf,
} from "@/lib/payables/upload";
import { LIMITS } from "@/lib/ratelimit";
import { makeTenantProbarion } from "@/lib/sdk/factory";
import { kickWatcher } from "@/lib/watcher/server";

export const dynamic = "force-dynamic";
// The tenant lease (PROCESS_LEASE_SECONDS, 90 s) outlasts this with a 30 s margin; route.test.ts checks it.
export const maxDuration = 60;

/** Shown for an unconfirmed outcome: the spend was sent and is never sent again. */
const PAYMENT_PENDING =
  "Payment sent, confirmation pending. Do not send it again. You can read the vault's spends on chain by this invoice's ref.";

/** Shown when no attested model confirmed the amount the code read: nothing was sent, the owner confirms. */
const OWNER_CONFIRMS =
  "Nothing was sent. No attested model confirmed the amount the code read, so this invoice waits for the owner to confirm the amount.";

const tooLarge = () =>
  problem(
    413,
    "too_large",
    `The request must be ${byteCount(MAX_REQUEST_BYTES)} bytes (4 MiB + 64 KiB) at most: the invoice, its purpose document and the form together.`,
  );

type Read = { upload: InvoiceUpload; purposeBytes: Uint8Array | null } | Response;

async function readUpload(form: FormData): Promise<Read> {
  const file = form.get("file");
  const pasted = form.get("text");
  const purpose = form.get("purpose");
  let upload: InvoiceUpload;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_INVOICE_BYTES) return fileTooLarge("invoice");
    const mediaType = mediaTypeOf(file);
    if (mediaType === null) {
      return problem(415, "unsupported", "Upload the invoice as a PDF or a plain text (.txt) file");
    }
    upload = {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mediaType,
      filename: cleanName(file.name),
    };
  } else if (typeof pasted === "string" && pasted.trim() !== "") {
    const encoded = new TextEncoder().encode(pasted);
    if (encoded.length > MAX_INVOICE_BYTES) return fileTooLarge("invoice text");
    upload = { bytes: encoded, mediaType: "text/plain", filename: null };
  } else {
    return problem(400, "invalid_input", "Attach a PDF/text file or paste the invoice text");
  }
  let purposeBytes: Uint8Array | null = null;
  if (purpose instanceof File && purpose.size > 0) {
    if (purpose.size > MAX_INVOICE_BYTES) return fileTooLarge("purpose document");
    purposeBytes = new Uint8Array(await purpose.arrayBuffer());
  }
  return { upload, purposeBytes };
}

/** Every mandate of the vault, all pages (the SDK's pageAll refuses a node that loops or truncates). */
function vaultMandates(network: Network, vault: string): Promise<MandateView[]> {
  return listAll((from, limit) => getReader(network).listMandates(vault, from, limit), 100, {
    contractId: vault,
    methodName: "list_mandates",
  });
}

function respond(r: PipelineResult, requestId: string): Response {
  switch (r.status) {
    case "decided":
      return json({
        invoiceId: r.invoiceId,
        status: r.invoiceStatus,
        outcome: r.outcome,
        recorded: r.recorded,
        amountIssue: r.amountIssue,
        requestId,
        ...(r.invoiceStatus === "unconfirmed" ? { notice: PAYMENT_PENDING } : {}),
        ...(r.invoiceStatus === "awaiting_owner" ? { notice: OWNER_CONFIRMS } : {}),
        // The number rule refused another text with the number of an invoice that may have paid: whether an upload
        // can ever run again depends on what happened to that one, and on whether this refusal reached the row.
        ...(r.outcome.status === "refused_by_code" &&
        r.outcome.code === NUMBER_DUPLICATE_RULE &&
        r.numberMatch !== null
          ? { notice: numberDuplicateNotice(r.numberMatch, r.recorded) }
          : {}),
      });
    case "duplicate":
      return json(
        {
          error: "duplicate",
          detail:
            r.invoiceStatus === "unconfirmed"
              ? `This invoice was already sent. ${PAYMENT_PENDING}`
              : r.invoiceStatus === "processing"
                ? "This invoice is being processed, or its outcome is still being confirmed."
                : r.invoiceStatus === "awaiting_owner"
                  ? "This invoice is already waiting for the owner to confirm its amount."
                  : r.invoiceStatus === "rejected"
                    ? "The owner rejected this invoice, so the same text is refused again. A corrected invoice is a new one."
                    : "This invoice was already processed.",
          invoiceId: r.invoiceId,
          status: r.invoiceStatus,
        },
        409,
      );
    case "busy":
      return problem(
        409,
        "busy",
        "Another invoice for this vault is being processed; retry in a few seconds.",
      );
    case "no_keys":
      return problem(
        409,
        "no_keys",
        `Activate the ${r.missing.join(" and ")} key on the Keys tab first.`,
      );
    case "no_mandate":
      return problem(
        409,
        "no_mandate",
        r.purposeHash === null
          ? "Attach the purpose document: the PO or contract you hashed when you created the mandate."
          : `No mandate of this vault has this purpose document (sha256 ${r.purposeHash.slice(0, 12)}…). Attach the PO or contract you hashed in the mandate.`,
      );
    case "key_unavailable":
      if (r.reason === "inactive") {
        return problem(
          409,
          "key_unavailable",
          `Mandate #${r.mandateId} is bound to agent key ${r.publicKey}, which is not active in this console. Activate it on the Keys tab, or create the mandate for an active key. Nothing was sent.`,
        );
      }
      return problem(
        503,
        "key_unavailable",
        `The ${r.purpose} key cannot be opened on the server, so nothing was sent. The operator has been alerted.`,
      );
    case "chain_unavailable":
      return problem(
        503,
        "chain_unavailable",
        "The vault's mandates could not be read from NEAR; nothing was stored or sent. Try again.",
      );
    case "empty":
      return problem(
        400,
        "empty",
        "No text could be read from the invoice. A scanned PDF has no text layer: paste the text instead.",
      );
    case "failed":
      // A fixed message: the SDK's error text goes to the log (payables.failed), never to the browser.
      return json(
        {
          error: "failed",
          detail: `The cycle stopped before any payment was sent. Upload the invoice again to retry (request ${requestId}).`,
          invoiceId: r.invoiceId,
        },
        502,
      );
    default: {
      const unknown: never = r;
      log.error("payables.unknown_result", { request_id: requestId, result: unknown });
      return problem(500, "internal");
    }
  }
}

/** Runs one Payables cycle for an invoice (multipart: `file` or `text`, optional `purpose`). Owner or approver. */
export async function POST(req: Request, { params }: { params: Promise<{ vault: string }> }) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const { vault } = await params;
  const auth = await memberForApi(vault, ["owner", "approver"]);
  if (auth instanceof Response) return auth;
  const requestId = req.headers.get("x-request-id") ?? newRequestId();
  tagRequest(requestId, "payables", auth.member.network, { tenant: auth.member.tenant_id });
  const unavailable = (error: unknown) => {
    log.error("payables.route_failed", {
      request_id: requestId,
      tenant: auth.member.tenant_id,
      error,
    });
    return problem(503, "unavailable", `Nothing was sent. Try again (request ${requestId}).`);
  };
  let db: Db;
  try {
    db = serviceDb();
    const limited = await rateLimitOr429(
      db,
      `invoices:${auth.member.tenant_id}`,
      LIMITS.invoiceUpload,
    );
    if (limited) return limited;
  } catch (e) {
    return unavailable(e);
  }

  const length = req.headers.get("content-length");
  if (length === null || !/^[0-9]{1,12}$/.test(length.trim())) {
    await req.body?.cancel().catch(() => {});
    return problem(411, "length_required", "Send the request with a Content-Length header");
  }
  if (Number(length) > MAX_REQUEST_BYTES) {
    await req.body?.cancel().catch(() => {});
    return tooLarge();
  }
  const form = await req.formData().catch(() => null);
  if (!form) return problem(400, "invalid_input", "Send the invoice as multipart/form-data");
  const read = await readUpload(form);
  if (read instanceof Response) return read;

  // From here the cycle runs, and what it records or sends changes the vault: the watcher looks at it as soon as this
  // response is sent, so the owner's alerts do not wait for the next scheduled run.
  kickWatcher(auth.member.tenant_id, auth.member.network);
  try {
    const r = await processInvoice(
      {
        db,
        master: masterKey(),
        mandates: (t) => vaultMandates(auth.member.network, t.vault_id),
        makeProbarion: (o) => makeTenantProbarion(auth.member.network, o),
      },
      {
        tenant: auth.member,
        upload: read.upload,
        purposeBytes: read.purposeBytes,
        actor: auth.session.accountId,
        requestId,
      },
    );
    return respond(r, requestId);
  } catch (e) {
    if (e instanceof ExtractError) return problem(400, "unreadable", e.message);
    // processInvoice throws only before process() runs (once it has run, the result is returned): nothing was sent.
    return unavailable(e);
  }
}
