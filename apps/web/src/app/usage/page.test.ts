import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { quietLogs } from "../../../test/fixtures/quiet-logs";

// The page's data and settings are replaced; the page itself is the real one, rendered to markup. The pure parts (copy,
// the parser, the table) have their own tests: this holds them together in the owner's order.
const mocks = vi.hoisted(() => ({
  env: vi.fn(),
  load: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.env }));
vi.mock("@/lib/usage/data", () => ({ loadUsage: mocks.load }));

import { PLANNED_ROUTES } from "@/lib/routes";
import { parseUsage } from "@/lib/usage/parse";
import UsagePage, { dynamic, metadata } from "./page";

const logs = quietLogs();

const RAW = {
  network: "mainnet",
  totals: [
    { segment: "team", metric: "vaults", value: 1 },
    { segment: "external", metric: "vaults", value: 3 },
    { segment: "external", metric: "spends_paid", value: 12 },
    { segment: "canary", metric: "canary_attempts", value: 120 },
    { segment: "external", metric: "model_decisions", value: 10 },
    { segment: "external", metric: "nearai_tokens_in", value: 9000 },
    { segment: "external", metric: "nearai_tokens_out", value: 1000 },
  ],
  recent: [{ segment: "external", metric: "spends_paid", value: 5 }],
  canary_participants: 7,
  external_owners: 3,
  team_vaults: 1,
  pilots: [
    { cohort: "external", n: 2 },
    { cohort: "team", n: 1 },
  ],
  pilot_names: ["Acme Design"],
  updated_at: "2026-11-06T10:15:30.123456+00:00",
};

const usage = (network: "mainnet" | "testnet" = "mainnet") =>
  parseUsage({ ...RAW, network }, network);

beforeEach(() => {
  mocks.env.mockReset();
  mocks.load.mockReset();
  mocks.env.mockReturnValue({ NEAR_NETWORK: "mainnet" });
  mocks.load.mockResolvedValue(usage());
});

const page = async () => renderToStaticMarkup(await UsagePage());
const visible = (html: string) =>
  html
    .replace(
      /<\/?(?:p|h1|h2|h3|section|div|li|ul|tr|td|th|header|table|thead|tbody|span|strong)\b[^>]*>/g,
      " ",
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const hrefs = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);
const UNAVAILABLE =
  "The usage numbers are not available right now. Every payment stays visible on chain.";

describe("the page's settings", () => {
  it("is titled Usage and reads the database on every request (the numbers have their own cache)", () => {
    expect(metadata.title).toBe("Usage");
    expect(metadata.description).toBe(
      "Live usage counts, with team vaults, external owners and Canary participants kept apart.",
    );
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("the page with its numbers", () => {
  it("shows the sections in the owner's order", async () => {
    const t = visible(await page());
    const order = [
      "Usage · NEAR mainnet",
      "Usage, counted apart",
      "External owners 3",
      "Canary participants: at least 7",
      "Team vaults 1",
      "All time, with the last 7 days in grey",
      "Updated 2026-11-06 10:15 UTC",
      "Unit costs",
      "Pilots, by cohort",
      "How each number is counted",
    ];
    const at = order.map((s) => t.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("asks for the numbers of the network the app runs on", async () => {
    await page();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenCalledWith("mainnet");
    mocks.env.mockReturnValue({ NEAR_NETWORK: "testnet" });
    mocks.load.mockResolvedValue(usage("testnet"));
    const t = visible(await page());
    expect(mocks.load).toHaveBeenLastCalledWith("testnet");
    expect(t).toContain("Usage · NEAR testnet");
    expect(t).toContain("Testnet: test tokens, no value");
  });

  it("does not call a mainnet page a testnet one", async () => {
    const t = visible(await page());
    expect(t).not.toContain("Testnet: test tokens");
    expect(t).not.toContain("test tokens");
    expect(t).toContain("This page counts NEAR mainnet only.");
  });

  it("has the tiles, the table with +N for the week, the unit costs and the pilots", async () => {
    const t = visible(await page());
    expect(t).toContain("External owners 3 distinct owner wallets");
    expect(t).toContain("Canary participants: at least 7 not customers");
    expect(t).toContain("Team vaults 1 ours, counted apart");
    expect(t).toContain("Payments made 0 12 +5");
    expect(t).toContain("NEAR AI tokens per decision — 1,000 —");
    expect(t).toContain("USD per decision price not set yet");
    expect(t).toContain("External 2 · Team 1 · Canary 0");
    expect(t).toContain("Named with written consent: Acme Design");
  });

  it("leaves the names out when no pilot agreed to one", async () => {
    mocks.load.mockResolvedValue(parseUsage({ ...RAW, pilot_names: [] }, "mainnet"));
    expect(visible(await page())).not.toContain("Named with written consent");
  });

  it("puts every table in a panel that can scroll on a phone", async () => {
    const html = await page();
    const panels = [...html.matchAll(/<section[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(panels).toEqual(["Usage by segment", "Unit costs by segment"]);
    expect([...html.matchAll(/<table/g)]).toHaveLength(2);
  });

  it("links only the definitions and the Canary, and no page that is not built", async () => {
    const links = hrefs(await page());
    expect(links).toEqual(["#definitions", "/canary"]);
    for (const l of links) expect(PLANNED_ROUTES).not.toContain(l);
  });

  it("has a target for the Definitions pill", async () => {
    expect(await page()).toMatch(/<section[^>]*id="definitions"/);
  });

  it("uses none of the words the page must not use", async () => {
    const t = visible(await page());
    expect(t).not.toMatch(/\bnever\b|guarantee|100\s?%|bounty|prize|reward|attested|open metrics/i);
  });
});

describe("the page when the numbers are not available", () => {
  it("says so, keeps the header and the definitions, and draws no figure", async () => {
    mocks.load.mockResolvedValue(null);
    const html = await page();
    const t = visible(html);
    expect(t).toContain(UNAVAILABLE);
    expect(t).toContain("Usage, counted apart");
    expect(t).toContain("How each number is counted");
    expect(html).toMatch(/id="definitions"/);
    expect(html).not.toContain("<table");
    expect(t).not.toContain("Canary participants: at least");
    expect(t).not.toContain("ours, counted apart");
    expect(t).not.toContain("Unit costs");
    expect(t).not.toContain("Pilots, by cohort");
  });

  it("is that same state when the settings cannot be read, with a warning, and reads nothing", async () => {
    mocks.env.mockImplementation(() => {
      throw new Error("Invalid environment: SUPABASE_URL is required");
    });
    const t = visible(await page());
    expect(t).toContain(UNAVAILABLE);
    expect(t).toContain("Usage, counted apart");
    expect(t).toContain("How each number is counted");
    // The network comes from the build when the settings are unreadable.
    expect(t).toContain("Usage · NEAR testnet");
    expect(mocks.load).not.toHaveBeenCalled();
    const warned = logs.lines.filter((l) => l.includes("usage.env_unreadable"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("SUPABASE_URL is required");
  });

  it("does not fail when the data layer itself throws, which it should not: it is the same state, with a warning", async () => {
    mocks.load.mockRejectedValue(new Error("boom"));
    const t = visible(await page());
    expect(t).toContain(UNAVAILABLE);
    expect(logs.lines.filter((l) => l.includes("usage.unavailable"))).toHaveLength(1);
  });

  it("is not a 500 for any of them: rendering does not throw", async () => {
    for (const setup of [
      () => mocks.load.mockResolvedValue(null),
      () => mocks.load.mockRejectedValue("not even an error"),
      () =>
        mocks.env.mockImplementation(() => {
          throw "not even an error";
        }),
    ]) {
      mocks.env.mockReturnValue({ NEAR_NETWORK: "testnet" });
      setup();
      await expect(page()).resolves.toContain(UNAVAILABLE);
    }
  });
});
