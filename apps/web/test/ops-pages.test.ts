import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "@/app/privacy/page";
import SecurityPage from "@/app/security/page";
import TermsPage from "@/app/terms/page";
import { PLANNED_ROUTES } from "@/lib/routes";
import { LINKS } from "@/lib/site/facts";

const render = (page: () => React.ReactElement) => renderToStaticMarkup(createElement(page));

describe("the operations pages", () => {
  it("are built, so nothing is planned any more", () => {
    expect(PLANNED_ROUTES).toEqual([]);
  });

  it("/security links the policy, the threat model, the runbook, security.txt and the Canary rules", () => {
    const html = render(SecurityPage);
    for (const href of [
      LINKS.security,
      LINKS.threatModel,
      LINKS.runbook,
      "/.well-known/security.txt",
      "/canary/rules",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain("72 hours");
    expect(html).toContain("node packages/cli/dist/bin.js verify");
  });

  it("/terms states non-custodial, beta, unaudited and at your own risk, and the rules PLAN4 asks for", () => {
    const html = render(TermsPage);
    for (const t of [
      "It does not hold your funds.",
      "Unaudited beta.",
      "At your own risk.",
      "Liability.",
      "Payments are final.",
      "Third-party services.",
      "Lawful use.",
      "Not legal advice.",
    ]) {
      expect(html).toContain(t);
    }
  });

  it("/terms and /privacy both open with the legal status of the spec's Legal row", () => {
    for (const page of [TermsPage, PrivacyPage]) {
      const html = render(page);
      for (const re of [
        /non-custodial/i,
        /\bbeta\b/i,
        /unaudited/i,
        /own risk/i,
        /not legal advice/i,
        /lawyer/i,
      ]) {
        expect(html).toMatch(re);
      }
    }
  });

  it("/privacy names every processor, the stored IP address, the permanent chain data and no analytics", () => {
    const html = render(PrivacyPage);
    for (const t of [
      "Vercel",
      "Supabase",
      "NEAR AI Cloud",
      "Telegram",
      "Resend",
      "Sentry",
      "1Click",
      "RPC",
      "GitHub",
      "IP address",
      "zero-retention",
      "ledger.jsonl",
      "no analytics",
    ]) {
      expect(html).toContain(t);
    }
    expect(html).toMatch(/permanent/i);
    expect(html).toContain("within two days");
  });
});
