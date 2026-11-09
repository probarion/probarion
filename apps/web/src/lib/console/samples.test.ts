import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decide, type MandateView, NETWORKS, payeeHintContradiction } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { buildMandateInput } from "@/lib/console/mandates";
import { extractFacts, fingerprintText, refFor } from "@/lib/payables/facts";
import {
  invoiceUploadBody,
  loadSampleInvoice,
  loadSampleMandate,
  SAMPLE_INVOICE_PATH,
  SAMPLE_INVOICE_USDC,
  SAMPLE_PO,
  SAMPLE_PO_FILE,
  SAMPLE_PO_PATH,
  SAMPLE_PO_SHA256,
  sampleInUse,
  sampleInvoiceText,
  sampleMandateForm,
  withSamplePo,
} from "./samples";

// The testnet sample kit (site audit P1-8): a purchase order whose mandate the form fills in one click, and an
// invoice that Payables pays against it, so a first-time owner needs no documents of their own.

const PUBLIC = join(__dirname, "../../../public");
const file = (path: string) => readFileSync(join(PUBLIC, path), "utf8");
const po = file(SAMPLE_PO_PATH);
const invoice = file(SAMPLE_INVOICE_PATH);

const OWNER = "alice.testnet";
const AGENT = `ed25519:${"3".repeat(44)}`;
const VAULT = "acme.vaults.probarion.testnet";
const NOW = new Date("2026-11-09T10:00:00Z");
const ctx = {
  now: NOW,
  vault: VAULT,
  baseAsset: NETWORKS.testnet.allowedAssets.base,
  allowedAssets: [NETWORKS.testnet.allowedAssets.base],
  agentKeys: [AGENT],
  protocolAccounts: [NETWORKS.testnet.usdc, NETWORKS.testnet.intents],
};
const HASH = "a".repeat(64);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** fetch, answered from public/ the way the dev server serves it. */
const served = async (path: string) => new Response(readFileSync(join(PUBLIC, path)));
const missing = async () => new Response("not found", { status: 404 });

describe("the sample files", () => {
  it("are served from public/samples", () => {
    expect(SAMPLE_PO_PATH).toMatch(/^\/samples\/[a-z0-9-]+\.txt$/);
    expect(SAMPLE_INVOICE_PATH).toMatch(/^\/samples\/[a-z0-9-]+\.txt$/);
  });

  it("are testnet only and say the tokens have no value", () => {
    for (const text of [po, invoice]) {
      expect(text).not.toMatch(/mainnet/i);
      expect(text).toMatch(/testnet/i);
      expect(text).toMatch(/no value/i);
    }
  });

  it("state the caps that the sample mandate signs", () => {
    expect(po).toContain(SAMPLE_PO.ref);
    expect(po).toContain(`${SAMPLE_PO.perPaymentUsdc} test USDC per payment`);
    expect(po).toContain(`${SAMPLE_PO.totalUsdc} test USDC in total`);
    expect(po).toContain(`${SAMPLE_PO.uses} payments`);
    expect(po).toContain(`${SAMPLE_PO.days} days`);
  });

  it("make an invoice Payables reads as the stated amount against the sample PO", () => {
    const facts = extractFacts(invoice, "f".repeat(64), HASH);
    expect(facts.amountIssue).toBeNull();
    expect(facts.amount).toBe((BigInt(SAMPLE_INVOICE_USDC) * 1_000_000n).toString());
    expect(facts.po_ref).toBe(SAMPLE_PO.ref);
    expect(facts.invoiceNumber).not.toBeNull();
  });

  it("name no payee account, so the payment goes to the mandate's payee whoever it is", () => {
    const facts = extractFacts(invoice, "f".repeat(64), HASH);
    expect(facts.payee_hint?.near_account).toBeUndefined();
    expect(facts.payee_hint?.address).toBeUndefined();
    for (const payee of [OWNER, "bob.testnet", "c".repeat(64)]) {
      expect(payeeHintContradiction(facts.payee_hint, { type: "near", account_id: payee })).toBe(
        null,
      );
    }
  });

  it("keep the sample payment under the sample mandate's caps and its approval line", () => {
    const amount = Number(SAMPLE_INVOICE_USDC);
    expect(amount).toBeGreaterThan(0);
    expect(amount).toBeLessThanOrEqual(Number(SAMPLE_PO.perPaymentUsdc));
    expect(amount).toBeLessThanOrEqual(
      Number(
        sampleMandateForm({ now: NOW, owner: OWNER, agentPk: AGENT, purposeHash: HASH })
          .approvalAboveUsdc,
      ),
    );
  });
});

describe("sampleMandateForm", () => {
  const form = sampleMandateForm({ now: NOW, owner: OWNER, agentPk: AGENT, purposeHash: HASH });

  it("fills a form the console accepts as it is", () => {
    const check = buildMandateInput(form, ctx);
    expect(check.ok ? null : check.errors).toBeNull();
  });

  it("pays the signed-in owner, through the agent key given, under the PO's caps", () => {
    expect(form).toMatchObject({
      payeeKind: "near",
      payee: OWNER,
      agentPk: AGENT,
      purposeHash: HASH,
      maxPerPaymentUsdc: SAMPLE_PO.perPaymentUsdc,
      maxTotalUsdc: SAMPLE_PO.totalUsdc,
      maxUses: SAMPLE_PO.uses,
    });
    expect(form.label).toContain(SAMPLE_PO.ref);
  });

  it("holds nothing the sample invoice asks for: approval is only above the per-payment cap", () => {
    expect(form.approvalAboveUsdc).toBe(SAMPLE_PO.perPaymentUsdc);
  });

  it("expires the PO's number of days after today (UTC)", () => {
    expect(form.expiresOn).toBe("2026-12-09");
    const late = sampleMandateForm({
      now: new Date("2026-12-31T23:30:00Z"),
      owner: OWNER,
      agentPk: AGENT,
      purposeHash: HASH,
    });
    expect(late.expiresOn).toBe("2027-01-30");
  });
});

describe("withSamplePo", () => {
  it("attaches the sample PO as the invoice's purpose document, and keeps the rest of the form", async () => {
    const form = new FormData();
    form.set("text", "Invoice INV-1001");
    const sent = withSamplePo(form, new Blob([po], { type: "text/plain" }));
    expect(sent.get("text")).toBe("Invoice INV-1001");
    const purpose = sent.get("purpose");
    expect(purpose).toBeInstanceOf(File);
    expect((purpose as File).name).toBe(SAMPLE_PO_FILE);
    expect(await (purpose as File).text()).toBe(po);
  });

  it("replaces a purpose file already in the form, so exactly one is sent", () => {
    const form = new FormData();
    form.set("purpose", new File(["other"], "mine.txt"));
    const sent = withSamplePo(form, new Blob([po]));
    expect(sent.getAll("purpose")).toHaveLength(1);
    expect((sent.get("purpose") as File).name).toBe(SAMPLE_PO_FILE);
  });
});

describe("the sample PO's hash", () => {
  it("is pinned: every sample mandate already on chain holds it, so the file's bytes must not change", () => {
    expect(sha256(po)).toBe(SAMPLE_PO_SHA256);
  });
});

describe("sampleInvoiceText", () => {
  const at = (iso: string) => sampleInvoiceText(invoice, new Date(iso));

  it("gives each use its own invoice number, so a sample that was refused can be run again", () => {
    const a = at("2026-11-09T10:12:30Z");
    const b = at("2026-11-09T10:12:31Z");
    const na = extractFacts(a, "f".repeat(64), HASH).invoiceNumber;
    const nb = extractFacts(b, "f".repeat(64), HASH).invoiceNumber;
    expect(na).not.toBeNull();
    expect(na).not.toBe(nb);
    expect(fingerprintText(a)).not.toBe(fingerprintText(b));
  });

  it("still reads as the sample's amount, against the sample PO", () => {
    const facts = extractFacts(at("2026-11-09T10:12:30Z"), "f".repeat(64), HASH);
    expect(facts.amountIssue).toBeNull();
    expect(facts.amount).toBe((BigInt(SAMPLE_INVOICE_USDC) * 1_000_000n).toString());
    expect(facts.po_ref).toBe(SAMPLE_PO.ref);
    expect(facts.payee_hint?.near_account).toBeUndefined();
  });
});

describe("loadSampleInvoice", () => {
  it("loads a fresh invoice text and the PO it is sent with, once, together", async () => {
    const kit = await loadSampleInvoice(served, new Date("2026-11-09T10:12:30Z"));
    expect(kit.text).toBe(sampleInvoiceText(invoice, new Date("2026-11-09T10:12:30Z")));
    expect(await kit.po.text()).toBe(po);
  });

  it("fails when either file cannot be loaded, so nothing is half-filled", async () => {
    await expect(loadSampleInvoice(missing, new Date())).rejects.toThrow();
    const noPo = async (path: string) => (path === SAMPLE_PO_PATH ? missing() : served(path));
    await expect(loadSampleInvoice(noPo, new Date())).rejects.toThrow();
  });
});

describe("loadSampleMandate", () => {
  const o = { now: NOW, owner: OWNER, agentPk: AGENT };

  it("fills the form with the hash of the PO as it is served", async () => {
    const form = await loadSampleMandate(served, o);
    expect(form).toEqual(sampleMandateForm({ ...o, purposeHash: SAMPLE_PO_SHA256 }));
  });

  it("refuses a PO whose bytes are not the pinned sample, so no mandate gets a hash no sample invoice matches", async () => {
    const other = async () =>
      new Response(`${po}changed
`);
    await expect(loadSampleMandate(other, o)).rejects.toThrow();
    await expect(loadSampleMandate(missing, o)).rejects.toThrow();
  });
});

describe("sampleInUse", () => {
  const kit = { text: "Invoice INV-20261109101230", po: new Blob([po]) };

  it("holds while the text is the sample's, as it was filled", () => {
    expect(sampleInUse(kit, kit.text)).toBe(true);
  });

  it("ends once the text is edited, so a changed invoice asks for its own purpose document", () => {
    expect(sampleInUse(kit, `${kit.text} `)).toBe(false);
    expect(sampleInUse(kit, "")).toBe(false);
  });

  it("is off without a sample", () => {
    expect(sampleInUse(null, kit.text)).toBe(false);
  });
});

describe("invoiceUploadBody", () => {
  it("sends the form as it is without the sample", () => {
    const form = new FormData();
    form.set("text", "x");
    expect(invoiceUploadBody(form, null)).toBe(form);
  });

  it("attaches the sample PO when the sample invoice is in use", () => {
    const sent = invoiceUploadBody(new FormData(), new Blob([po]));
    expect((sent.get("purpose") as File).name).toBe(SAMPLE_PO_FILE);
  });
});

describe("the sample end to end, through the policy", () => {
  it("a mandate from the sample PO allows the sample invoice: no refusal, and no approver hold", async () => {
    const form = await loadSampleMandate(served, { now: NOW, owner: OWNER, agentPk: AGENT });
    const check = buildMandateInput(form, ctx);
    if (!check.ok) throw new Error(JSON.stringify(check.errors));
    const m = check.input;
    const mandate: MandateView = {
      id: 1,
      payee: { type: "near", account_id: OWNER },
      purpose_hash: m.purpose_hash,
      max_per_payment: m.max_per_payment,
      max_total: m.max_total,
      spent: "0",
      reserved: "0",
      max_uses: m.max_uses,
      uses: 0,
      expires_at_ns: m.expires_at_ns,
      approval_above: m.approval_above,
      agent_pk: m.agent_pk,
      label: m.label,
      status: "active",
      created_at_ns: String(BigInt(NOW.getTime()) * 1_000_000n),
    };
    const text = sampleInvoiceText(invoice, NOW);
    const invoiceHash = sha256(text);
    const {
      invoiceNumber: _n,
      amountIssue: _a,
      ...facts
    } = extractFacts(text, invoiceHash, sha256(po));
    const d = decide({
      vault: VAULT,
      agentPk: AGENT,
      now: new Date(NOW.getTime() + 60_000),
      invoice: facts,
      proposal: null,
      attestationOk: null,
      mandates: [mandate],
      paidInvoiceHashes: new Set(),
      usedRefs: new Set(),
      intentsBalance: null,
      frozen: false,
      confidenceFloor: 0.7,
      ref: refFor(invoiceHash),
      daily: { backstop: "500000000", spent_today: "0" },
    });
    expect(d.rules.filter((r) => r.outcome === "refuse")).toEqual([]);
    expect(d.mandate_id).toBe(1);
    expect(d.amount).toBe("2000000");
    for (const id of ["invoice.po_mismatch", "mandate.payee_mismatch"]) {
      expect(d.rules.find((r) => r.id === id)?.outcome).toBe("pass");
    }
    // The contract holds a spend for an approver only above approval_above.
    expect(BigInt(facts.amount) <= BigInt(m.approval_above)).toBe(true);
  });
});
