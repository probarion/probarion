import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "@/app/privacy/page";
import SecurityPage from "@/app/security/page";
import TermsPage from "@/app/terms/page";
import { CLI_SETUP_LINES } from "@/lib/proof/cli";
import { PLANNED_ROUTES } from "@/lib/routes";
import { LINKS } from "@/lib/site/facts";

const render = (page: () => React.ReactElement) => renderToStaticMarkup(createElement(page));
/** Text as React writes it into the markup. */
const asMarkup = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

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

  it("/security's check runs on a fresh clone: it shows the build first, and gives a hosted vault its ledger", () => {
    const html = render(SecurityPage);
    // dist/ is not in the repository, so the verify command needs the set-up lines before it.
    let at = 0;
    for (const line of CLI_SETUP_LINES) {
      const next = html.indexOf(asMarkup(line), at);
      expect(next, line).toBeGreaterThan(at);
      at = next;
    }
    expect(html.indexOf("node packages/cli/dist/bin.js verify", at)).toBeGreaterThan(at);
    // Without --ledger the CLI checks the chain against an empty ledger, and an anchored vault fails.
    expect(html).toContain(
      asMarkup(
        "node packages/cli/dist/bin.js verify --network testnet --vault <vault> --ledger probarion-<vault>-ledger.jsonl",
      ),
    );
    expect(html).toContain("/proof/&lt;vault&gt;/ledger.jsonl");
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
    expect(html).toContain("about two days after your last request");
  });

  it("/privacy says what the Canary and Sentry keep, as they keep it", () => {
    const html = render(PrivacyPage);
    // The Canary's ledger holds the model's answer, which can quote the visitor (migration 0008), and the keyed
    // hashes stay with each attempt, counted on the leaderboard.
    expect(html).toContain(
      "which can quote your message, goes into the Canary&#x27;s own signed ledger",
    );
    expect(html).toContain("for rate limits and for the leaderboard&#x27;s count of visitors");
    expect(html).not.toContain("stored only as keyed hashes, for rate limits");
    // An error report carries its log line, which can name a vault or an account.
    expect(html).not.toContain("or your account name");
    expect(html).toContain("A report carries the log line of the error");
  });

  it("/privacy's zero-retention sentences say what the signed ledger still holds, as the console does", () => {
    const html = render(PrivacyPage);
    // Zero-retention empties the invoice row's file, facts and file name only (lib/payables/pipeline.ts). The ledger
    // entry keeps the amount, the facts the model was shown and its answer whatever the setting (packages/core/src/
    // types.ts, LedgerEntryBody and AttestationEvidence), as the Payables tab says.
    const paragraphs = [...html.matchAll(/<p class="mb-2">(.*?)<\/p>/g)].map((m) => m[1] ?? "");
    const zero = paragraphs.filter((p) => /zero-retention/i.test(p));
    expect(zero).toHaveLength(2);
    for (const p of zero) {
      expect(p).toMatch(/signed ledger still records the amount/i);
      expect(p).toContain("PO reference");
      expect(p).toContain("the model&#x27;s answer, which may quote details of the invoice");
    }
    expect(html).not.toContain("stores no invoice file, text, facts or file name");
  });
});
