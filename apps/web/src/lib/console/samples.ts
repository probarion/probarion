import { sha256HexOf } from "@/components/console/sha256";
import type { MandateForm } from "@/lib/console/mandates";

/**
 * The testnet sample kit (site audit P1-8): a purchase order and an invoice under `public/samples/`, so a first-time
 * owner can sign a mandate and run a payment without documents of their own. The console hashes the PO file as it
 * is served, in the browser, the same way it hashes a file the owner picks, so the mandate's purpose_hash is always
 * the hash of the bytes Payables is later sent. Testnet only: the files say the tokens have no value.
 */
export const SAMPLE_PO_PATH = "/samples/probarion-sample-po.txt";
export const SAMPLE_INVOICE_PATH = "/samples/probarion-sample-invoice.txt";
/** The PO file's name when the invoice form attaches it. */
export const SAMPLE_PO_FILE = "probarion-sample-po.txt";
/**
 * The sha256 of the PO file. Every mandate signed from the sample holds it as its purpose_hash, so the file's bytes
 * must not change: an edited file would no longer match those mandates. The form refuses a PO that hashes otherwise.
 */
export const SAMPLE_PO_SHA256 = "30739be9a9186c8884c598e6f46ef54a7ebc14c401548f59b43b512b0496278d";

/** What the sample PO allows, as its text states it (the test reads the file). Whole test USDC. */
export const SAMPLE_PO = {
  ref: "PO-1001",
  perPaymentUsdc: "5",
  totalUsdc: "20",
  uses: "5",
  days: 30,
} as const;

/** What the sample invoice asks for, in whole test USDC. */
export const SAMPLE_INVOICE_USDC = "2";

const DAY_MS = 86_400_000;

/**
 * The mandate form filled from the sample PO: the signed-in owner is the payee (test USDC goes back to them), through
 * `agentPk`, under the PO's caps, until the PO's number of days from today (UTC). Approval is only above the
 * per-payment cap, so no approver holds the sample invoice (the owner still confirms its amount when no attested model
 * does).
 */
export function sampleMandateForm(o: {
  now: Date;
  owner: string;
  agentPk: string;
  purposeHash: string;
}): MandateForm {
  return {
    payeeKind: "near",
    payee: o.owner,
    purposeHash: o.purposeHash,
    maxPerPaymentUsdc: SAMPLE_PO.perPaymentUsdc,
    maxTotalUsdc: SAMPLE_PO.totalUsdc,
    maxUses: SAMPLE_PO.uses,
    expiresOn: new Date(o.now.getTime() + SAMPLE_PO.days * DAY_MS).toISOString().slice(0, 10),
    approvalAboveUsdc: SAMPLE_PO.perPaymentUsdc,
    agentPk: o.agentPk,
    label: `Sample ${SAMPLE_PO.ref}`,
  };
}

/**
 * The invoice form's data with the sample PO as its purpose document, in place of any file picked: what the invoice
 * form sends when the owner chose the sample invoice. `po` is the PO file as it is served.
 */
export function withSamplePo(form: FormData, po: Blob): FormData {
  form.set("purpose", new File([po], SAMPLE_PO_FILE, { type: "text/plain" }));
  return form;
}

/** A static file fetcher: `fetch` in the browser, a stub in tests. */
export type Get = (path: string) => Promise<Response>;

async function served(get: Get, path: string): Promise<Response> {
  const res = await get(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res;
}

/**
 * The sample invoice with its own invoice number for this use (INV-<UTC time to the second>), so that a sample the
 * pipeline refused, or one already paid, can be run again: the duplicate guard keys the number and the text.
 */
export function sampleInvoiceText(template: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  return template.replace("INV-1001", `INV-${stamp}`);
}

/** The sample invoice text and the PO it is sent with, both loaded before the form is filled. */
export async function loadSampleInvoice(get: Get, now: Date): Promise<{ text: string; po: Blob }> {
  const [invoice, po] = await Promise.all([
    served(get, SAMPLE_INVOICE_PATH),
    served(get, SAMPLE_PO_PATH),
  ]);
  return { text: sampleInvoiceText(await invoice.text(), now), po: await po.blob() };
}

/** The mandate form from the sample PO as it is served, once its hash is the pinned one. */
export async function loadSampleMandate(
  get: Get,
  o: { now: Date; owner: string; agentPk: string },
): Promise<MandateForm> {
  const po = await served(get, SAMPLE_PO_PATH);
  const hash = await sha256HexOf(await po.arrayBuffer());
  if (hash !== SAMPLE_PO_SHA256) throw new Error("the sample PO is not the pinned file");
  return sampleMandateForm({ ...o, purposeHash: hash });
}

/**
 * Whether the invoice form is still sending the sample: it was loaded, and the text is the sample's as it was filled.
 * An edit ends it, so a changed invoice asks for its own purpose document.
 */
export function sampleInUse(kit: { text: string } | null, text: string): boolean {
  return kit !== null && text === kit.text;
}

/** What the invoice form sends: its own data, with the sample PO attached when the sample invoice is in use. */
export function invoiceUploadBody(form: FormData, po: Blob | null): FormData {
  return po === null ? form : withSamplePo(form, po);
}
