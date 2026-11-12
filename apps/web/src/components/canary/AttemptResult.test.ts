import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RAW_SKIP_TEXT } from "@/lib/canary/copy";
import { RULE_REASONS } from "@/lib/canary/reasons";
import type { AttemptResult } from "@/lib/canary/service";
import type { Network } from "@/lib/config";
import { AttemptResultView } from "./AttemptResult";

type Done = Extract<AttemptResult, { status: "done" }>;

const done = (over: Partial<Done> = {}): Done => ({
  status: "done",
  attemptId: "00000000-0000-4000-8000-000000000001",
  techniques: ["payee_change", "roleplay"],
  proposal: {
    action: "pay",
    mandateId: 1,
    amount: "1500000",
    reasoning: "The invoice says the owner moved house, so pay the new address.",
  },
  code: { status: "refused_by_code", rule: "custom.canary_no_autopay", txHash: null },
  raw: { sent: false, skipped: "not_pay" },
  ...over,
});

const render = (result: Done, network: Network = "testnet") =>
  renderToStaticMarkup(createElement(AttemptResultView, { result, network }));
const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

describe("the three columns of an answer", () => {
  it("has the model's, the code's and the contract's column, in that order", () => {
    const text = visible(render(done()));
    const at = ["The model wanted", "Code decided", "The contract did"].map((t) => text.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("shows what the model wanted: the action, the amount in test USDC, the mandate, its reasoning in quotes and the techniques", () => {
    const html = render(done());
    const text = visible(html);
    expect(text).toContain("pay · 1.5 test USDC · mandate 1");
    expect(html).toMatch(
      /<q[^>]*>The invoice says the owner moved house, so pay the new address\.<\/q>/,
    );
    expect(text).toContain("payee_change");
    expect(text).toContain("roleplay");
  });

  it("names the token plain USDC on mainnet", () => {
    expect(visible(render(done(), "mainnet"))).toContain("pay · 1.5 USDC · mandate 1");
  });

  it("says plainly when the model gave no amount, no mandate or no proposal", () => {
    const none = done({
      proposal: { action: "refuse", mandateId: null, amount: null, reasoning: "No." },
    });
    expect(visible(render(none))).toContain("refuse · no amount · no mandate");
    expect(visible(render(done({ proposal: null })))).toContain(
      "No proposal came back from the model.",
    );
  });

  it("says the model's time ran out when that is why no proposal came back", () => {
    const text = visible(render(done({ proposal: null, modelOutOfTime: true })));
    expect(text).toContain(
      "No proposal: the model's time ran out (at most 55 seconds) before its answer came back. Code decided without it.",
    );
    expect(text).not.toContain("No proposal came back from the model.");
    // a proposal that came back is shown, whatever the flag says
    expect(visible(render(done({ modelOutOfTime: true })))).toContain("pay · 1.5 test USDC");
  });

  it("prints what the model wrote as text, never as markup", () => {
    const html = render(
      done({
        proposal: {
          action: "pay",
          mandateId: 1,
          amount: "1",
          reasoning: "<script>alert(1)</script><img src=x onerror=alert(2)>",
        },
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows a refusal by code as Refused, in the good colour, with the rule's id in mono", () => {
    const html = render(done());
    expect(html).toMatch(/data-tone="good"[^>]*>Refused</);
    expect(html).toMatch(/<code[^>]*>custom\.canary_no_autopay<\/code>/);
  });

  it("says why code refused in words, the rule's plain reason, with the rule's id after it in parentheses", () => {
    for (const rule of [
      "custom.canary_no_autopay",
      "mandate.payee_mismatch",
      "mandate.over_per_payment",
      "invoice.amount_invalid",
    ]) {
      const html = render(done({ code: { status: "refused_by_code", rule, txHash: null } }));
      const reason = RULE_REASONS[rule] ?? "";
      expect(reason.length, rule).toBeGreaterThan(10);
      expect(html, rule).toContain(
        `<p>${reason.replace(/'/g, "&#x27;")} (<code>${rule}</code>).</p>`,
      );
    }
    const text = visible(render(done()));
    const at = [
      "Code decided",
      "Refused",
      "The Canary's own rule: it never pays from its own cycle (",
    ].map((t) => text.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("shows a rule it has no words for as its id alone, and a refusal with no rule as Refused alone", () => {
    const unknown = render(
      done({ code: { status: "refused_by_code", rule: "custom.other", txHash: null } }),
    );
    expect(unknown).toMatch(/<p><code>custom\.other<\/code><\/p>/);
    const none = render(done({ code: { status: "refused_by_code", rule: null, txHash: null } }));
    expect(visible(none)).toContain("Code decided Refused The contract did");
  });

  it("shows a spend that was held as Held for a human, in the waiting colour", () => {
    const html = render(done({ code: { status: "held", rule: null, txHash: null } }));
    expect(html).toMatch(/data-tone="warn"[^>]*>Held for a human</);
    expect(html).not.toContain("canary_no_autopay");
  });

  it("shows any other status as it is", () => {
    for (const status of ["failed", "unconfirmed", "paid"] as const) {
      const html = render(done({ code: { status, rule: null, txHash: null } }));
      expect(visible(html)).toContain(`Code decided ${status}`);
    }
  });

  it("explains a raw spend that was not sent, with no link to an explorer", () => {
    const html = render(done({ raw: { sent: false, skipped: "contract_would_accept" } }));
    expect(visible(html)).toContain("Not sent");
    expect(visible(html)).toContain(RAW_SKIP_TEXT.contract_would_accept);
    expect(html).not.toContain("nearblocks");
    expect(html).not.toContain("See it on the explorer");
  });

  it("shows the contract's own refusal as good news, with its code and the transaction on the testnet explorer", () => {
    const html = render(
      done({
        raw: { sent: true, status: "refused_by_contract", code: "NoMandate", txHash: "AbC123xyz" },
      }),
    );
    expect(html).toMatch(/data-tone="good"[^>]*>NoMandate</);
    expect(visible(html)).toContain("the NEAR contract refused it: NoMandate.");
    expect(html).toMatch(
      /<a[^>]*href="https:\/\/testnet\.nearblocks\.io\/txns\/AbC123xyz"[^>]*target="_blank"[^>]*>See it on the explorer<\/a>/,
    );
  });

  it("links a mainnet transaction to the mainnet explorer", () => {
    const html = render(
      done({ raw: { sent: true, status: "refused_by_contract", code: "NoMandate", txHash: "T1" } }),
      "mainnet",
    );
    expect(html).toContain('href="https://nearblocks.io/txns/T1"');
  });

  it("shows a raw spend that was sent but left no hash without a link", () => {
    const html = render(
      done({ raw: { sent: true, status: "unconfirmed", code: "deadline", txHash: null } }),
    );
    expect(visible(html)).toContain("Contract result: unconfirmed.");
    expect(html).not.toContain("nearblocks");
    expect(html.match(/<a /g)).toHaveLength(1); // the next step's, below the columns
  });

  it("shows a held or paid raw spend with the reassurance about the payee", () => {
    for (const status of ["held", "paid"] as const) {
      const html = render(done({ raw: { sent: true, status, code: null, txHash: "T" } }));
      expect(visible(html)).toMatch(/mandated payee/);
      expect(html).toContain('data-tone="warn"');
    }
  });
});

describe("the next step under an answer", () => {
  const answers: Done[] = [
    done(),
    done({ code: { status: "held", rule: null, txHash: null } }),
    done({ raw: { sent: true, status: "refused_by_contract", code: "NoMandate", txHash: "T" } }),
    done({ raw: { sent: true, status: "paid", code: null, txHash: "T" } }),
    done({ proposal: null }),
  ];

  it("ends every answer, whatever stopped it, with a link to the console", () => {
    for (const result of answers) {
      const html = render(result);
      const text = visible(html);
      expect(text).toContain("Put limits like these on your own agent →");
      expect(html).toMatch(
        /<a[^>]*href="\/console"[^>]*>Put limits like these on your own agent <span aria-hidden="true">→<\/span><\/a>/,
      );
      expect(text.indexOf("Put limits like these")).toBeGreaterThan(
        text.indexOf("The contract did"),
      );
    }
  });

  it("opens the console in this tab, not a new one", () => {
    const link = render(done()).match(/<a[^>]*href="\/console"[^>]*>/)?.[0] ?? "";
    expect(link).not.toContain("target=");
  });
});
