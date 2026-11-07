import { VaultClient } from "@probarion/sdk";
import { masterKey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import type { Db } from "@/lib/db/port";
import { extAuth, extMember } from "@/lib/ext/auth";
import { json, problem, rateLimitOr429 } from "@/lib/http";
import { log, newRequestId, REQUEST_ID_HEADER } from "@/lib/log";
import { listAll } from "@/lib/near/reader";
import { getReader, getRpc } from "@/lib/near/server";
import { softRequestOrigin } from "@/lib/network";
import { tagRequest } from "@/lib/observe";
import { ExtractError, MAX_INVOICE_BYTES } from "@/lib/payables/extract";
import { type QueueResult, queueInvoice } from "@/lib/payables/queue";
import { byteCount, cleanName, fileTooLarge, mediaTypeOf } from "@/lib/payables/upload";
import { LIMITS } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The invoice, the vault and the mandate: at most the invoice cap plus 16 KiB of form, 4,210,688 bytes. upload.ts's
 * MAX_REQUEST_BYTES is the console's, with room for a purpose document. Not exported: a route file exports only its
 * handlers and its config.
 */
const MAX_EXT_REQUEST_BYTES = MAX_INVOICE_BYTES + 16 * 1024;
const MANDATE_ID = /^[1-9][0-9]{0,14}$/;

function respond(r: QueueResult, origin: string, vault: string): Response {
  const url = (id: string) =>
    `${origin}/console/${encodeURIComponent(vault)}/payables/${encodeURIComponent(id)}`;
  switch (r.status) {
    case "queued":
      return json(
        { invoice_id: r.invoiceId, status: "awaiting_owner", url: url(r.invoiceId) },
        201,
      );
    case "duplicate":
      return json({
        invoice_id: r.invoiceId,
        status: r.invoiceStatus,
        duplicate: true,
        url: url(r.invoiceId),
      });
    case "empty":
      return problem(422, "empty", "No text in this file. Upload it in the console instead.");
    case "amount_unclear":
      return problem(
        422,
        "amount_unclear",
        "Couldn't read one clear amount. Upload it in the console instead.",
      );
    case "chain_unavailable":
      return problem(
        503,
        "chain_unavailable",
        "NEAR could not be read. Nothing was queued. Try again.",
      );
    case "mandate_not_found":
      return problem(404, "mandate_not_found", "This mandate is not on the vault.");
    case "mandate_inactive":
      return problem(422, "mandate_inactive", `This mandate can't take invoices now: ${r.reason}.`);
    case "no_keys":
      return problem(
        409,
        "no_keys",
        "The vault's keys aren't active. Open the console's Keys tab.",
      );
    case "refused":
      return json({ error: "refused_by_code", rule: r.rule, detail: r.detail }, 422);
  }
}

/**
 * Queues an invoice from the browser extension (multipart `vault`, `mandate`, `file`), for an owner or an approver. It
 * never pays: the row waits for the owner's wallet-signed Confirm in the console.
 */
export async function POST(req: Request) {
  const requestId = req.headers.get(REQUEST_ID_HEADER) ?? newRequestId();
  const unavailable = (error: unknown) => {
    log.error("ext.invoice_failed", { request_id: requestId, error });
    return problem(503, "unavailable", `Nothing was queued. Try again (request ${requestId}).`);
  };
  let db: Db;
  try {
    db = serviceDb();
  } catch (error) {
    return unavailable(error);
  }
  try {
    const auth = await extAuth(req, db);
    if (auth instanceof Response) return auth;
    const { token, network } = auth;
    tagRequest(requestId, "extension", network);
    const limited = await rateLimitOr429(
      db,
      `ext:invoice:${network}:${token.account_id}`,
      LIMITS.extInvoice,
    );
    if (limited) return limited;

    const length = req.headers.get("content-length");
    if (length === null || !/^[0-9]{1,12}$/.test(length.trim())) {
      await req.body?.cancel().catch(() => {});
      return problem(411, "length_required", "Send the request with a Content-Length header");
    }
    if (Number(length) > MAX_EXT_REQUEST_BYTES) {
      await req.body?.cancel().catch(() => {});
      return problem(
        413,
        "too_large",
        `The request must be ${byteCount(MAX_EXT_REQUEST_BYTES)} bytes at most.`,
      );
    }
    const form = await req.formData().catch(() => null);
    if (!form) return problem(400, "invalid_input", "Send the invoice as multipart/form-data");

    // Membership is read again now, for this vault: a role removed since the token was made counts.
    const member = await extMember(token, form.get("vault"), ["owner", "approver"]);
    if (member instanceof Response) return member;
    // A Canary vault takes no invoices: the inbox leaves it out (lib/ext/inbox.ts), and so does the queue.
    if (member.kind === "canary") {
      return problem(403, "not_member", "This vault takes no invoices from the extension.");
    }
    const mandate = form.get("mandate");
    if (typeof mandate !== "string" || !MANDATE_ID.test(mandate)) {
      return problem(400, "invalid_input", "Choose a mandate.");
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return problem(400, "invalid_input", "Attach a PDF or a text file.");
    }
    if (file.size > MAX_INVOICE_BYTES) return fileTooLarge("invoice");
    const mediaType = mediaTypeOf(file);
    if (mediaType === null) {
      return problem(415, "unsupported", "Send the invoice as a PDF or a plain text (.txt) file");
    }

    const reader = getReader(network);
    const r = await queueInvoice(
      {
        db,
        master: masterKey(),
        mandates: (t) =>
          listAll((from, limit) => reader.listMandates(t.vault_id, from, limit), 100, {
            contractId: t.vault_id,
            methodName: "list_mandates",
          }),
        // A VaultClient with no sender: it reads the view and cannot send anything.
        checkSpend: (t, request, signerPk) =>
          new VaultClient(t.vault_id, getRpc(network)).checkSpend(request, signerPk),
      },
      {
        tenant: member,
        upload: {
          bytes: new Uint8Array(await file.arrayBuffer()),
          mediaType,
          filename: cleanName(file.name),
        },
        mandateId: Number(mandate),
        actor: token.account_id,
        requestId,
      },
    );
    return respond(r, await softRequestOrigin(), member.vault_id);
  } catch (error) {
    if (error instanceof ExtractError) return problem(422, "unreadable", error.message);
    return unavailable(error);
  }
}
