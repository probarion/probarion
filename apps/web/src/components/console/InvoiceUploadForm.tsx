"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { type SampleNote, SampleOffer, sampleLinkClass } from "@/components/console/SampleOffer";
import { Field, inkPillClass, inputClass, Notice } from "@/components/ui";
import type { Network } from "@/lib/config";
import {
  invoiceUploadBody,
  loadSampleInvoice,
  SAMPLE_INVOICE_USDC,
  SAMPLE_PO,
  sampleInUse,
} from "@/lib/console/samples";
import { type UploadAnswer, uploadAnswer } from "@/lib/payables/upload-answer";

/**
 * Posts one invoice to POST /api/console/[vault]/invoices (multipart: `file` or `text`, and `purpose`). The answer is
 * worded by uploadAnswer; a gateway page that is not JSON never throws here. On testnet it offers the sample invoice
 * (site audit P1-8): its text with a fresh invoice number, sent with the sample PO as its purpose document. Both are
 * loaded before the form is filled, and the sample holds only while the text is the one filled: an edit, or an
 * invoice file picked, goes back to asking for a purpose document.
 */
export function InvoiceUploadForm({ vault, network }: { vault: string; network: Network }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<UploadAnswer | null>(null);
  const [text, setText] = useState("");
  const [kit, setKit] = useState<{ text: string; po: Blob } | null>(null);
  const [loading, setLoading] = useState(false);
  const [sampleNote, setSampleNote] = useState<SampleNote | null>(null);
  // The invoice file input is uncontrolled: a new key clears a file picked before the sample text was filled in.
  const [fileKey, setFileKey] = useState(0);
  const sample = sampleInUse(kit, text);
  const base = `/console/${encodeURIComponent(vault)}/payables`;

  async function fillSample() {
    setLoading(true);
    setSampleNote(null);
    try {
      const loaded = await loadSampleInvoice((path) => fetch(path), new Date());
      setKit(loaded);
      setText(loaded.text);
      setFileKey((k) => k + 1);
      setSampleNote({
        text: `Filled in the sample invoice, with ${SAMPLE_PO.ref} as its purpose document. Send it with Run the payables cycle.`,
      });
    } catch {
      setSampleNote({
        text: "The sample could not be loaded. Reload the page and try again.",
        failed: true,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        setBusy(true);
        setMsg(null);
        try {
          const body = invoiceUploadBody(new FormData(form), sample && kit ? kit.po : null);
          const res = await fetch(`/api/console/${encodeURIComponent(vault)}/invoices`, {
            method: "POST",
            body,
            credentials: "same-origin",
          });
          const answer: unknown = await res.json().catch(() => null);
          setMsg(uploadAnswer(res.status, answer));
          router.refresh();
        } catch {
          setMsg(uploadAnswer(0, null));
        } finally {
          setBusy(false);
        }
      }}
    >
      {network === "testnet" ? (
        <SampleOffer
          text={`Send the sample invoice (${SAMPLE_INVOICE_USDC} test USDC) with the sample purchase order ${SAMPLE_PO.ref} attached. It matches a mandate made from the sample PO.`}
          label="Use the sample invoice"
          onUse={fillSample}
          busy={loading}
          note={sampleNote}
        />
      ) : null}
      <Field
        label="Invoice (PDF or .txt)"
        hint="The invoice and its purpose document together: at most 4 MiB."
      >
        <input
          key={fileKey}
          type="file"
          name="file"
          accept="application/pdf,text/plain,.pdf,.txt"
          onChange={() => {
            setKit(null);
            setSampleNote(null);
          }}
        />
      </Field>
      <Field label="…or paste the invoice text">
        <textarea
          name="text"
          rows={5}
          className={inputClass}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      {sample ? (
        <div className="mb-3 text-sm">
          <p className="font-medium">Purpose document</p>
          <p className="text-mute">
            The sample purchase order ({SAMPLE_PO.ref}) is attached when you send.
          </p>
          <button
            type="button"
            className={sampleLinkClass}
            onClick={() => {
              setKit(null);
              setSampleNote(null);
            }}
          >
            Attach my own file instead
          </button>
        </div>
      ) : (
        <Field
          label="Purpose document (required: the PO or contract whose sha256 you put in the mandate)"
          hint="It is hashed and matched to a mandate; the payment goes to that mandate's payee."
        >
          <input type="file" name="purpose" required />
        </Field>
      )}
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
