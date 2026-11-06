import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { definitions, EMPTY } from "@/lib/usage/copy";
import { parseUsage, type UsageMetrics } from "@/lib/usage/parse";
import {
  Definitions,
  PilotsCard,
  Unavailable,
  UnitCostsCard,
  UsageHeader,
  UsageTable,
  UsageTiles,
} from "./UsageSections";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const visible = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const hrefs = (h: string) => [...h.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);

const usage = (over: Record<string, unknown> = {}): UsageMetrics => {
  const u = parseUsage(
    {
      network: "mainnet",
      totals: [
        { segment: "team", metric: "vaults", value: 1 },
        { segment: "external", metric: "vaults", value: 3 },
        { segment: "canary", metric: "vaults", value: 1 },
        { segment: "team", metric: "spends_paid", value: 4 },
        { segment: "external", metric: "spends_paid", value: 1234 },
        { segment: "external", metric: "cross_chain_payouts", value: 2 },
        { segment: "canary", metric: "canary_attempts", value: 120 },
        { segment: "external", metric: "model_decisions", value: 10 },
        { segment: "external", metric: "nearai_tokens_in", value: 9000 },
        { segment: "external", metric: "nearai_tokens_out", value: 1000 },
      ],
      recent: [
        { segment: "external", metric: "spends_paid", value: 34 },
        { segment: "canary", metric: "canary_attempts", value: 15 },
      ],
      canary_participants: 7,
      external_owners: 3,
      team_vaults: 1,
      pilots: [
        { cohort: "external", n: 2 },
        { cohort: "team", n: 1 },
      ],
      pilot_names: ["Acme Design", "Beta Co"],
      updated_at: "2026-11-06T10:15:30.123456+00:00",
      ...over,
    },
    "mainnet",
  );
  if (!u) throw new Error("fixture usage is malformed");
  return u;
};

describe("the header", () => {
  const head = (network: "testnet" | "mainnet") => html(createElement(UsageHeader, { network }));

  it("has the eyebrow, the title and the lede", () => {
    const h = head("mainnet");
    expect(visible(h)).toContain("Usage · NEAR mainnet");
    expect(h).toMatch(/<h1[^>]*>Usage, counted apart<\/h1>/);
    expect(visible(h)).toContain(
      "Team vaults, external owners and Canary participants are counted separately. These are counts, not dollar volumes, so nothing here comes from the team paying itself. Every payment is on chain.",
    );
  });

  it("links the definitions on the page and the Canary, and no page that does not exist", () => {
    const h = head("mainnet");
    expect(h).toMatch(/<a[^>]*href="#definitions"[^>]*>Definitions<\/a>/);
    expect(h).toMatch(/<a[^>]*href="\/canary"[^>]*>Canary<\/a>/);
    expect(hrefs(h)).toEqual(["#definitions", "/canary"]);
  });

  it("shows the testnet pill on testnet only, and says testnet", () => {
    expect(visible(head("testnet"))).toContain("Testnet: test tokens, no value");
    expect(visible(head("testnet"))).toContain("Usage · NEAR testnet");
    expect(visible(head("mainnet"))).not.toContain("Testnet");
  });
});

describe("the tiles", () => {
  const tiles = visible(html(createElement(UsageTiles, { usage: usage() })));

  it("show the owners, the participants as at least, and the team's vaults, in that order", () => {
    expect(tiles).toContain("External owners 3 distinct owner wallets");
    expect(tiles).toContain("Canary participants: at least 7 not customers");
    expect(tiles).toContain("Team vaults 1 ours, counted apart");
    const at = ["External owners", "Canary participants: at least", "Team vaults"].map((t) =>
      tiles.indexOf(t),
    );
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("draws a zero as a zero and thousands apart", () => {
    const t = visible(
      html(
        createElement(UsageTiles, {
          usage: usage({ external_owners: 0, canary_participants: 12345, team_vaults: 0 }),
        }),
      ),
    );
    expect(t).toContain("External owners 0");
    expect(t).toContain("Canary participants: at least 12,345");
    expect(t).toContain("Team vaults 0");
  });
});

describe("the table", () => {
  const render = (u = usage()) => html(createElement(UsageTable, { usage: u }));
  const rows = (h: string) =>
    [...h.matchAll(/<tr>(.*?)<\/tr>/gs)].map((m) =>
      [...(m[1] ?? "").matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((c) => visible(c[1] ?? "")),
    );

  it("is titled, and lays the segments out as three columns", () => {
    const h = render();
    expect(visible(h)).toContain("All time, with the last 7 days in grey");
    expect(rows(h)[0]).toEqual(["Metric", "Team", "External", "Canary"]);
    expect([...h.matchAll(/<th scope="col"/g)]).toHaveLength(4);
  });

  it("has the rows in the owner's order, zero-filled", () => {
    const body = rows(render()).slice(1);
    expect(body.map((r) => r[0])).toEqual([
      "Vaults",
      "Mandates signed",
      "Payments made",
      "of which cross-chain (Base)",
      "Held for approval",
      "Refused by code",
      "Refused on chain",
      "Canary attempts",
      "Canary attempts sent straight to the contract",
      "Model decisions",
    ]);
    expect(body.every((r) => r.length === 4)).toBe(true);
    expect(body[0]).toEqual(["Vaults", "1", "3", "1"]);
    expect(body[1]).toEqual(["Mandates signed", "0", "0", "0"]);
  });

  it("shows the all-time value with a grey +N for the last 7 days, only where N is more than 0", () => {
    const body = rows(render()).slice(1);
    const paid = body.find((r) => r[0] === "Payments made");
    expect(paid?.[1]).toBe("4");
    expect(paid?.[2]).toContain("1,234 +34");
    expect(paid?.[3]).toBe("0");
    const canary = body.find((r) => r[0] === "Canary attempts");
    expect(canary?.[3]).toContain("120 +15");
    expect(visible(render())).not.toContain("+0");
    // A screen reader is told what the grey number is.
    expect(render()).toContain("in the last 7 days");
  });

  it("names each row with a row header, so that a number is tied to its metric", () => {
    const h = render();
    const headers = [...h.matchAll(/<th scope="row"[^>]*>(.*?)<\/th>/gs)].map((m) =>
      visible(m[1] ?? ""),
    );
    expect(headers).toEqual([
      "Vaults",
      "Mandates signed",
      "Payments made",
      "of which cross-chain (Base)",
      "Held for approval",
      "Refused by code",
      "Refused on chain",
      "Canary attempts",
      "Canary attempts sent straight to the contract",
      "Model decisions",
    ]);
    // The four column headers stay column headers, and no metric name is a plain cell any more.
    expect([...h.matchAll(/<th scope="col"/g)]).toHaveLength(4);
    expect(
      rows(h)
        .slice(1)
        .every((r) => r.length === 4),
    ).toBe(true);
    expect([...h.matchAll(/<td/g)]).toHaveLength(10 * 3);
  });

  it("puts the cross-chain row under Payments made as a part of it", () => {
    const h = render();
    expect(h).toMatch(/<span class="[^"]*indent[^"]*">of which cross-chain \(Base\)<\/span>/);
  });

  it("keeps wide tables in a scrolling panel with a name", () => {
    const h = render();
    expect(h).toMatch(/<section[^>]*aria-label="Usage by segment"/);
    expect(h).toContain("<table");
  });

  it("says when it was updated and how it is refreshed", () => {
    expect(visible(render())).toContain(
      "Updated 2026-11-06 10:15 UTC. Refreshed at most hourly while people view this page, and once a day on a schedule.",
    );
    expect(visible(render(usage({ updated_at: null, totals: [], recent: [] })))).toContain(
      "Updated: not computed yet.",
    );
  });

  it("draws every figure as a plain number, never as text from the database", () => {
    const h = render(
      usage({ totals: [{ segment: "team", metric: "vaults", value: "7" }], recent: [] }),
    );
    expect(rows(h)[1]).toEqual(["Vaults", "7", "0", "0"]);
  });
});

describe("the unit costs", () => {
  const render = (u: UsageMetrics, price: Parameters<typeof UnitCostsCard>[0]["price"]) =>
    html(createElement(UnitCostsCard, { totals: u.totals, price }));
  const cells = (h: string) =>
    [...h.matchAll(/<tr>(.*?)<\/tr>/gs)].map((m) =>
      [...(m[1] ?? "").matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((c) => visible(c[1] ?? "")),
    );

  it("shows the measured tokens per decision for the segment that has some, and the empty glyph for the others", () => {
    const h = render(usage(), null);
    expect(visible(h)).toContain("Unit costs");
    const tokens = cells(h).find((r) => r[0] === "NEAR AI tokens per decision");
    expect(tokens).toEqual(["NEAR AI tokens per decision", EMPTY, "1,000", EMPTY]);
  });

  it("says the price is not set yet while there is none, and shows no dollar figure", () => {
    const h = render(usage(), null);
    const t = visible(h);
    expect(t).toContain("USD per decision price not set yet");
    expect(t).not.toContain("$");
    expect(t).not.toContain("Price:");
    expect(t).toContain("Gas per spend not measured yet");
    expect(t).toContain("Hosting and RPC not published yet");
    expect(t).toContain(
      "A price is shown only once it is set from NEAR AI's own price list, with the date read. Nothing is estimated.",
    );
  });

  it("shows dollars per decision, and the price's model and source, once a price is set", () => {
    const h = render(usage(), {
      model: "model-x",
      inputPerMTok: 1,
      outputPerMTok: 2,
      source: "price list read on 2026-11-06",
    });
    const usd = cells(h).find((r) => r[0] === "USD per decision");
    expect(usd).toEqual(["USD per decision", EMPTY, "$0.00110", EMPTY]);
    expect(visible(h)).toContain("Price: model-x, price list read on 2026-11-06");
    expect(visible(h)).not.toContain("price not set yet");
  });

  it("has the empty glyph for every segment when no model has decided anything", () => {
    const h = render(usage({ totals: [] }), null);
    const tokens = cells(h).find((r) => r[0] === "NEAR AI tokens per decision");
    expect(tokens).toEqual(["NEAR AI tokens per decision", EMPTY, EMPTY, EMPTY]);
  });

  it("names each unit cost with a row header", () => {
    const h = render(usage(), null);
    const headers = [...h.matchAll(/<th scope="row"[^>]*>(.*?)<\/th>/gs)].map((m) =>
      visible(m[1] ?? ""),
    );
    expect(headers).toEqual([
      "NEAR AI tokens per decision",
      "USD per decision",
      "Gas per spend",
      "Hosting and RPC",
    ]);
    expect([...h.matchAll(/<th scope="col"/g)]).toHaveLength(4);
  });

  it("names the rows in the owner's order", () => {
    const names = cells(render(usage(), null)).map((r) => r[0]);
    expect(names).toEqual([
      "Unit cost",
      "NEAR AI tokens per decision",
      "USD per decision",
      "Gas per spend",
      "Hosting and RPC",
    ]);
  });
});

describe("the pilots", () => {
  const render = (names: string[]) =>
    visible(
      html(createElement(PilotsCard, { pilots: { team: 1, external: 2, canary: 0 }, names })),
    );

  it("counts each cohort, with the names of those who agreed in writing", () => {
    const t = render(["Acme Design", "Beta Co"]);
    expect(t).toContain("Pilots, by cohort");
    expect(t).toContain("External 2 · Team 1 · Canary 0");
    expect(t).toContain("Named with written consent: Acme Design, Beta Co");
  });

  it("says nothing about names when there are none", () => {
    const t = render([]);
    expect(t).toContain("External 2 · Team 1 · Canary 0");
    expect(t).not.toContain("Named with written consent");
  });

  it("writes a name as text: markup in it is not markup", () => {
    const h = html(
      createElement(PilotsCard, {
        pilots: { team: 0, external: 1, canary: 0 },
        names: ["<img src=x onerror=alert(1)>"],
      }),
    );
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img");
  });
});

describe("the definitions", () => {
  const h = html(createElement(Definitions, { network: "testnet" }));

  it("is the target of #definitions, titled as the owner approved", () => {
    expect(h).toMatch(/<section[^>]*id="definitions"/);
    expect(h).toMatch(/<h2[^>]*>How each number is counted<\/h2>/);
  });

  it("lists every definition, with the name of the figure in bold where it is about one", () => {
    const t = visible(h);
    for (const d of definitions("testnet")) {
      expect(t).toContain(d.lead ? `${d.lead} ${d.text}` : d.text);
    }
    expect([...h.matchAll(/<li\b/g)]).toHaveLength(definitions("testnet").length);
    expect(h).toContain("<strong>Refused on chain:</strong>");
  });

  it("says which network the page counts", () => {
    expect(visible(h)).toContain("This page counts NEAR testnet only, with test tokens.");
    expect(visible(html(createElement(Definitions, { network: "mainnet" })))).toContain(
      "This page counts NEAR mainnet only.",
    );
  });
});

describe("the unavailable state", () => {
  it("says the numbers are not available and that payments stay visible on chain", () => {
    expect(visible(html(createElement(Unavailable)))).toBe(
      "The usage numbers are not available right now. Every payment stays visible on chain.",
    );
  });
});

describe("the stylesheet of the tables", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../site/usage.module.css", import.meta.url)),
    "utf8",
  );
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    if (at < 0) return "";
    return css.slice(at, css.indexOf("}", at));
  };

  it("makes a row header look like the cell it replaces: the column-header style is undone for it", () => {
    const th = rule("table.usage tbody th");
    expect(th).not.toBe("");
    // The column headers are small capitals in grey (canary.module.css); a metric's name is plain text.
    for (const undo of [
      "text-transform: none",
      "font-weight: inherit",
      "font-size: inherit",
      "letter-spacing: normal",
      "color: inherit",
      "white-space: normal",
    ]) {
      expect(th, undo).toContain(undo);
    }
    // And the last row has no rule under it, as the cells of the last row have none.
    expect(rule("table.usage tbody tr:last-child th")).toContain("border-bottom: 0");
  });
});
