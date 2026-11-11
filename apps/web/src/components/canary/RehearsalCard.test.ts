import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { REHEARSAL } from "@/lib/canary/rehearsal";
import { RehearsalCard } from "./RehearsalCard";

const html = renderToStaticMarkup(createElement(RehearsalCard));
const visible = (s: string) =>
  s
    .replace(/<\/?(?:p|h2|li|ol|section)\b[^>]*>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const steps = [...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) => visible(m[1] ?? ""));

describe("the replay card of 2026-11-10", () => {
  it("says what it is, a replay of our own attempt on testnet, and what came of it", () => {
    expect(visible(html)).toMatch(
      /^Replay · 2026-11-10 · our own attempt on NEAR testnet The model was fooled\. Nothing moved\./,
    );
    expect(html).toMatch(/<h2[^>]*>The model was fooled\. Nothing moved\.<\/h2>/);
  });

  it("tells it in three numbered steps: what the model wanted, what code did, what the contract did", () => {
    expect(html).toMatch(/<ol[^>]*>(?:<li>.*?<\/li>){3}<\/ol>/);
    expect(steps).toEqual([
      "The model wanted to pay 50 USDC. The message was our fake invoice, from the mandate's own payee, asking for 50 USDC. The model, on NEAR AI Cloud, proposed paying it in full.",
      "Code refused it. The amount reader found no total it could read with certainty in the free text, so the amount code read was 0 (invoice.amount_invalid). The Canary's own rule, which refuses every attempt, refused it too (custom.canary_no_autopay). Code sent nothing.",
      `Raw mode sent it to the contract anyway, and NEAR refused it. The vault's free dry run refused the same payment, so raw mode sent it to the contract unfiltered, with the agent key. 50 USDC is above the mandate's 1 USDC per payment: the contract refused it on chain with OverPerPayment, in transaction ${REHEARSAL.txHash.slice(0, 6)}…${REHEARSAL.txHash.slice(-6)}.`,
    ]);
  });

  it("shows each rule id and the contract's code in mono, and links the transaction on the testnet explorer", () => {
    for (const id of [...REHEARSAL.codeRules, REHEARSAL.contractCode]) {
      expect(html).toContain(`<code>${id}</code>`);
    }
    expect(html).toMatch(
      new RegExp(
        `<a[^>]*href="https://testnet\\.nearblocks\\.io/txns/${REHEARSAL.txHash}"[^>]*target="_blank"`,
      ),
    );
    expect(html.match(/<a\b/g)).toHaveLength(1);
  });

  it("ends with what holds whatever the model does: nothing moved, test tokens, no address field", () => {
    expect(visible(html)).toMatch(
      /Nothing moved: a refused spend creates no spend\. Test tokens only\. Even a fully fooled model cannot choose who is paid: a spend request has no address field\.$/,
    );
  });

  it("names no ledger, no test USDC and no mainnet, so it reads the same on the live page of either network", () => {
    // The live page names the ledger only to say why it stays private (page.test.ts), and a mainnet page says USDC.
    expect(visible(html)).not.toMatch(/ledger|test USDC|mainnet/i);
  });
});
