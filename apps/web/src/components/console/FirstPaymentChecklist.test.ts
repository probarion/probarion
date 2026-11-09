import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ChecklistInput, firstPaymentChecklist } from "@/lib/console/checklist";
import { FirstPaymentChecklist } from "./FirstPaymentChecklist";

// The card on a new vault's overview (site audit P1-8): which steps are done, which one is next, and a way to each.

const VAULT = "acme.vaults.probarion.testnet";
const BASE = `/console/${VAULT}`;
const NEW: ChecklistInput = {
  network: "testnet",
  keys: { ok: true, value: { agent: false, ledger: false } },
  usdc: { ok: true, value: "0" },
  intentsBase: { ok: false, kind: "not_allowed" },
  mandates: { ok: true, value: { counts: {}, total: 0 } },
  spends: { ok: true, value: { held: [], recent: [], counts: {}, total: 0 } },
  faucetUsdc: "25",
};

function render(input: ChecklistInput = NEW) {
  const checklist = firstPaymentChecklist(input);
  if (checklist === null) throw new Error("hidden");
  return renderToStaticMarkup(createElement(FirstPaymentChecklist, { vault: VAULT, checklist }));
}
const items = (html: string) =>
  [...html.matchAll(/<li\b[^>]*>(.*?)<\/li>/g)].map((m) => m[1] ?? "");
const links = (html: string) =>
  [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)].map((m) => ({
    href: /\shref="([^"]*)"/.exec(m[1] ?? "")?.[1],
    cls: (/\sclass="([^"]*)"/.exec(m[1] ?? "")?.[1] ?? "").split(/\s+/),
    text: m[2],
  }));

describe("FirstPaymentChecklist", () => {
  it("is titled, and says how many steps are done", () => {
    const html = render();
    expect(html).toContain("Your first agent payment");
    expect(html).toContain("1 of 5 done");
    expect(html).toMatch(/goes away after the first payment/);
  });

  it("lists the five steps in order", () => {
    const html = render();
    expect(html).toMatch(/<ol\b/);
    expect(items(html)).toHaveLength(5);
  });

  it("tells a screen reader each step's state", () => {
    const states = items(render({ ...NEW, usdc: { ok: false, kind: "rpc" } })).map(
      (li) => /<span class="sr-only">([^<]*)<\/span>/.exec(li)?.[1],
    );
    expect(states).toEqual(["Done.", "Next.", "Could not check.", "To do.", "To do."]);
  });

  it("links every undone step to its tab, and the next one as the ink pill", () => {
    const all = links(render());
    expect(all.map((l) => [l.href, l.text])).toEqual([
      [`${BASE}/keys`, "Go to Keys"],
      [`${BASE}/topup`, "Go to Top-up"],
      [`${BASE}/mandates`, "Go to Mandates"],
      [`${BASE}/payables`, "Go to Payables"],
    ]);
    expect(all[0]?.cls).toEqual(expect.arrayContaining(["bg-ink", "rounded-full", "min-h-11"]));
    for (const l of all.slice(1)) {
      expect(l.cls).toContain("underline");
      expect(l.cls).not.toContain("bg-ink");
    }
  });

  it("gives a done step no link", () => {
    const done = items(
      render({ ...NEW, keys: { ok: true, value: { agent: true, ledger: true } } }),
    );
    expect(done[0]).not.toMatch(/<a\b/);
    expect(done[1]).not.toMatch(/<a\b/);
    expect(done[2]).toMatch(/<a\b[^>]*bg-ink/);
  });

  it("marks a step it could not check in gold, and still links to it", () => {
    const li = items(render({ ...NEW, mandates: { ok: false, kind: "rpc" } }))[3] ?? "";
    expect(li).toMatch(/Could not check/);
    expect(li).toMatch(/bg-wait-bg/);
    expect(li).toMatch(/href="[^"]*\/mandates"/);
  });

  it("shows each step's words", () => {
    const html = render();
    expect(html).toContain("Agent key and ledger key");
    expect(html).toContain("Test USDC in the vault");
    expect(html).toContain("First mandate");
    expect(html).toContain("First payment");
  });
});
