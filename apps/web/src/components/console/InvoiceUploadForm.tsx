"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Field, inkPillClass, inputClass, Notice } from "@/components/ui";
import { type UploadAnswer, uploadAnswer } from "@/lib/payables/upload-answer";

/**
 * Posts one invoice to POST /api/console/[vault]/invoices (multipart: `file` or `text`, and `purpose`). The answer is
 * worded by uploadAnswer; a gateway page that is not JSON never throws here.
 */
export function InvoiceUploadForm({ vault }: { vault: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<UploadAnswer | null>(null);
  const base = `/console/${encodeURIComponent(vault)}/payables`;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        setBusy(true);
        setMsg(null);
        try {
          const res = await fetch(`/api/console/${encodeURIComponent(vault)}/invoices`, {
            method: "POST",
            body: new FormData(form),
            credentials: "same-origin",
          });
          const body: unknown = await res.json().catch(() => null);
          setMsg(uploadAnswer(res.status, body));
          router.refresh();
        } catch {
          setMsg(uploadAnswer(0, null));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field
        label="Invoice (PDF or .txt)"
        hint="The invoice and its purpose document together: at most 4 MiB."
      >
        <input type="file" name="file" accept="application/pdf,text/plain,.pdf,.txt" />
      </Field>
      <Field label="…or paste the invoice text">
        <textarea name="text" rows={5} className={inputClass} />
      </Field>
      <Field
        label="Purpose document (required: the PO or contract whose sha256 you put in the mandate)"
        hint="It is hashed and matched to a mandate; the payment goes to that mandate's payee."
      >
        <input type="file" name="purpose" required />
      </Field>
      <button className={inkPillClass} disabled={busy} type="submit">
        {busy ? "Code → model → contract…" : "Run the payables cycle"}
      </button>
      <div className="mt-3" role="status">
        {msg ? (
          <Notice tone={msg.tone}>
            {msg.text}{" "}
            {msg.invoiceId ? (
              <Link className="underline" href={`${base}/${encodeURIComponent(msg.invoiceId)}`}>
                See the invoice
              </Link>
            ) : null}
          </Notice>
        ) : null}
      </div>
    </form>
  );
}
