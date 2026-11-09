import { NETWORKS } from "@probarion/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Network } from "@/lib/config";
import { SAMPLE_PO_PATH } from "@/lib/console/samples";

// The "Trying it out?" offers (site audit P1-8): on testnet the mandate form and the invoice form each fill
// themselves from the sample kit in one click. On mainnet neither offers a sample.

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/app/console/[vault]/mandates/actions", () => ({
  checkPayeeAction: async () => ({ exists: true }),
  prepareMandateAction: async () => ({ error: "not in this test" }),
}));
vi.mock("@/components/wallet/TxButton", () => ({
  TxButton: (p: { label: string }) => createElement("button", { type: "button" }, p.label),
}));

import { InvoiceUploadForm } from "./InvoiceUploadForm";
import { MandateFormPanel } from "./MandateFormPanel";
import { SampleOffer } from "./SampleOffer";

const VAULT = "acme.vaults.probarion.testnet";
const AGENT = `ed25519:${"3".repeat(44)}`;

const mandateForm = (network: Network) =>
  renderToStaticMarkup(
    createElement(MandateFormPanel, {
      vault: VAULT,
      owner: "alice.testnet",
      network,
      baseAsset: NETWORKS[network].allowedAssets.base,
      allowedAssets: [NETWORKS[network].allowedAssets.base],
      protocolAccounts: [NETWORKS[network].usdc, NETWORKS[network].intents],
      agentKeys: [{ public_key: AGENT, label: "invoice bot" }],
      dailyBackstop: "500000000",
      floats: { near: { ok: true, units: "25000000" }, base: { ok: false } },
      outOfNearCodes: [],
    }),
  );
const invoiceForm = (network: Network) =>
  renderToStaticMarkup(createElement(InvoiceUploadForm, { vault: VAULT, network }));

describe("the mandate form's sample offer", () => {
  it("offers the sample PO on testnet, with the file to download", () => {
    const html = mandateForm("testnet");
    expect(html).toContain("Trying it out?");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Use the sample PO<\/button>/);
    const link = (html.match(/<a\b[^>]*>[^<]*<\/a>/g) ?? []).find((a) =>
      a.includes(`href="${SAMPLE_PO_PATH}"`),
    );
    expect(link).toMatch(/\sdownload=""/);
    expect(link).toMatch(/>Download the sample PO<\/a>$/);
    expect(link).toMatch(/min-h-11/);
    expect(html).toMatch(/5 test USDC a payment, 20 in all, 5 payments, for 30 days, paid to you/);
  });

  it("offers nothing on mainnet", () => {
    const html = mandateForm("mainnet");
    expect(html).not.toContain("Trying it out?");
    expect(html).not.toContain("sample");
  });
});

describe("the invoice form's sample offer", () => {
  it("offers the sample invoice on testnet", () => {
    const html = invoiceForm("testnet");
    expect(html).toContain("Trying it out?");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Use the sample invoice<\/button>/);
    expect(html).toMatch(/2 test USDC/);
  });

  it("still asks for a purpose document until the sample is chosen", () => {
    const purpose = (invoiceForm("testnet").match(/<input\b[^>]*>/g) ?? []).filter((t) =>
      t.includes('name="purpose"'),
    );
    expect(purpose).toHaveLength(1);
    expect(purpose[0]).toMatch(/\stype="file"/);
    expect(purpose[0]).toMatch(/\srequired=""/);
  });

  it("offers nothing on mainnet", () => {
    const html = invoiceForm("mainnet");
    expect(html).not.toContain("Trying it out?");
    expect(html).not.toContain("sample");
  });
});

describe("SampleOffer", () => {
  const offer = (p: Partial<Parameters<typeof SampleOffer>[0]>) =>
    renderToStaticMarkup(
      createElement(SampleOffer, { text: "t", label: "Use the sample", onUse: () => {}, ...p }),
    );

  it("keeps its status region on the page before there is anything to say, so the first note is announced", () => {
    const html = offer({});
    expect(html).toMatch(/<div[^>]*role="status"[^>]*><\/div>/);
    expect(html).not.toContain("empty:hidden");
  });

  it("says it is loading while it loads, and cannot be clicked twice", () => {
    const html = offer({ busy: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Loading the sample…<\/button>/);
  });

  it("shows a note that went wrong in the bad tone, and one that went right in the mute one", () => {
    expect(offer({ note: { text: "Could not load.", failed: true } })).toMatch(
      /<p class="[^"]*text-bad[^"]*">Could not load\.<\/p>/,
    );
    expect(offer({ note: { text: "Filled." } })).toMatch(
      /<p class="[^"]*text-mute[^"]*">Filled\.<\/p>/,
    );
  });
});
