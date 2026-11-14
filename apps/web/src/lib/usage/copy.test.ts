import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Network } from "@/lib/config";
import {
  definitions,
  deltaText,
  EMPTY,
  eyebrow,
  networkSentence,
  pilotsLine,
  priceLine,
  tokensCell,
  UNAVAILABLE,
  USAGE_COPY,
  updatedLine,
} from "./copy";

const NETWORKS: Network[] = ["testnet", "mainnet"];

/** Every string reachable from a value. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

/** All the words a visitor can be shown, for both networks, with and without a price, names and a time. */
function allCopy(): string[] {
  const out = [
    ...strings(USAGE_COPY),
    UNAVAILABLE,
    updatedLine(null),
    updatedLine("2026-11-06T10:15:30.123456+00:00"),
    deltaText(3),
    deltaText(1234),
    pilotsLine({ external: 2, team: 1, canary: 3 }) ?? "",
    pilotsLine({ external: 2, team: 1, canary: 0 }) ?? "",
    USAGE_COPY.pilots.named,
    priceLine({ model: "m", source: "price list read on 2026-11-06" }),
    tokensCell(1234.4),
    tokensCell(null),
  ];
  for (const network of NETWORKS) {
    out.push(eyebrow(network), networkSentence(network), ...strings(definitions(network)));
  }
  return out;
}

describe("the words the Usage page must not use", () => {
  it("makes no promise: not 'never', not a guarantee, not 100%", () => {
    expect(allCopy().filter((t) => /\bnever\b|guarantee|100\s?%/i.test(t))).toEqual([]);
  });

  it("uses no em dash in a sentence, as the rest of the site does not", () => {
    // The one em dash is the empty-cell glyph of the unit costs (the console's keys table uses it too).
    expect(EMPTY).toBe("—");
    expect(allCopy().filter((t) => t.includes("—") && t !== EMPTY)).toEqual([]);
  });

  it("leaves out the words of the Canary challenge: bounty, prize, reward", () => {
    expect(allCopy().filter((t) => /bounty|prize|reward/i.test(t))).toEqual([]);
  });

  it("does not call a Canary model answer an attestation", () => {
    expect(allCopy().filter((t) => /attested/i.test(t))).toEqual([]);
  });

  it("leaves those words out of the page's own source too", () => {
    const web = fileURLToPath(new URL("../../..", import.meta.url));
    const files = [
      join("src", "app", "usage", "page.tsx"),
      join("src", "lib", "usage", "view.ts"),
      join("src", "lib", "usage", "pricing.ts"),
      ...readdirSync(join(web, "src", "components", "usage"))
        .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
        .map((f) => join("src", "components", "usage", f)),
    ];
    expect(files.length).toBeGreaterThan(3);
    const banned = /\bnever\b|guarantee|100\s?%|bounty|prize|reward/i;
    expect(files.filter((f) => banned.test(readFileSync(join(web, f), "utf8")))).toEqual([]);
    const dash = files.filter((f) => readFileSync(join(web, f), "utf8").includes("—"));
    expect(dash).toEqual([]);
  });

  it("names none of the owner's other projects", () => {
    // The bracket keeps the name itself out of this repository.
    expect(allCopy().filter((t) => /vest[i]arion/i.test(t))).toEqual([]);
  });
});

describe("the header, as the owner approved it", () => {
  it("names the network in the eyebrow", () => {
    expect(eyebrow("testnet")).toBe("Usage · NEAR testnet");
    expect(eyebrow("mainnet")).toBe("Usage · NEAR mainnet");
  });

  it("has the title and the lede word for word", () => {
    expect(USAGE_COPY.head.title).toBe("Usage, counted apart");
    expect(USAGE_COPY.head.lede).toBe(
      "Team vaults, external owners and Canary participants are counted separately. These are counts, not dollar volumes, so the team paying itself adds no volume to them. Every payment is on chain.",
    );
  });

  it("has the two pills and the testnet pill", () => {
    expect(USAGE_COPY.head.definitions).toBe("Definitions");
    expect(USAGE_COPY.head.canary).toBe("Canary");
    expect(USAGE_COPY.head.testnetPill).toBe("Testnet: test tokens, no value");
  });

  it("titles the page Usage", () => {
    expect(USAGE_COPY.meta.title).toBe("Usage");
  });
});

describe("the three tiles", () => {
  it("say what each count is, and that Canary participants are at least that many, and not customers", () => {
    expect(USAGE_COPY.tiles.owners).toEqual({
      label: "External owners",
      sub: "distinct owner wallets",
    });
    expect(USAGE_COPY.tiles.participants).toEqual({
      label: "Canary participants: at least",
      sub: "not customers",
    });
    expect(USAGE_COPY.tiles.team).toEqual({ label: "Team vaults", sub: "ours, counted apart" });
  });
});

describe("the table and its footnote", () => {
  it("is titled as the owner approved, with the segments as columns", () => {
    expect(USAGE_COPY.table.title).toBe("All time, with the last 7 days in grey");
    expect([
      USAGE_COPY.table.metric,
      USAGE_COPY.table.team,
      USAGE_COPY.table.external,
      USAGE_COPY.table.canary,
    ]).toEqual(["Metric", "Team", "External", "Canary"]);
  });

  it("shows a week's count as +N, with thousands apart", () => {
    expect(deltaText(3)).toBe("+3");
    expect(deltaText(1234)).toBe("+1,234");
  });

  it("says when it was updated, in UTC to the minute, and how it is refreshed", () => {
    expect(updatedLine("2026-11-06T10:15:30.123456+00:00")).toBe(
      "Updated 2026-11-06 10:15 UTC. Refreshed at most hourly while people view this page, and once a day on a schedule.",
    );
    expect(updatedLine(null)).toBe(
      "Updated: not computed yet. Refreshed at most hourly while people view this page, and once a day on a schedule.",
    );
  });

  it("reads a time in another zone as the UTC minute it is", () => {
    expect(updatedLine("2026-11-06T12:15:59+02:00")).toContain("Updated 2026-11-06 10:15 UTC.");
  });
});

describe("the unit costs", () => {
  it("has the four rows, in order, and the words for what is not there yet", () => {
    const c = USAGE_COPY.costs;
    expect([c.tokens, c.usd, c.gas, c.hosting]).toEqual([
      "NEAR AI tokens per decision",
      "USD per decision",
      "Gas per spend",
      "Hosting and RPC",
    ]);
    expect(c.usdUnset).toBe("price not set yet");
    expect(c.gasUnset).toBe("not measured yet");
    expect(c.hostingUnset).toBe("not published yet");
    expect(c.title).toBe("Unit costs");
  });

  it("says a price comes from NEAR AI's own list, with the date, and that nothing is estimated", () => {
    expect(USAGE_COPY.costs.footnote).toBe(
      "A price is shown only once it is set from NEAR AI's own price list, with the date read. Nothing is estimated.",
    );
  });

  it("names the model and where the price was read", () => {
    expect(priceLine({ model: "deepseek-v3", source: "price list read on 2026-11-06" })).toBe(
      "Price: deepseek-v3, price list read on 2026-11-06",
    );
  });

  it("shows the tokens as a whole number with thousands apart, and the empty glyph where there are none", () => {
    expect(tokensCell(1000)).toBe("1,000");
    expect(tokensCell(1234.5)).toBe("1,235");
    expect(tokensCell(0.4)).toBe("0");
    expect(tokensCell(null)).toBe(EMPTY);
  });
});

describe("the pilots", () => {
  it("counts each cohort that has a pilot, external first, as the owner approved, and leaves out a cohort with none", () => {
    expect(pilotsLine({ external: 2, team: 1, canary: 3 })).toBe("External 2 · Team 1 · Canary 3");
    expect(pilotsLine({ external: 2, team: 1, canary: 0 })).toBe("External 2 · Team 1");
    expect(pilotsLine({ external: 0, team: 1, canary: 0 })).toBe("Team 1");
    expect(pilotsLine({ external: 1234, team: 0, canary: 0 })).toBe("External 1,234");
    expect(USAGE_COPY.pilots.title).toBe("Pilots, by cohort");
    expect(USAGE_COPY.pilots.named).toBe("Named with written consent:");
  });

  it("has no line, and so no zero, while no cohort has a pilot", () => {
    expect(pilotsLine({ external: 0, team: 0, canary: 0 })).toBeNull();
    expect(USAGE_COPY.pilots.titleNone).toBe("Pilots");
  });
});

describe("how each number is counted", () => {
  const text = (n: Network) => strings(definitions(n)).join(" ");
  const sentences = (n: Network) =>
    definitions(n).map((d) => `${d.lead ? `${d.lead} ` : ""}${d.text}`);

  it("is titled as the owner approved", () => {
    expect(USAGE_COPY.definitions.title).toBe("How each number is counted");
  });

  it("covers the counting rules of the spec in plain sentences", () => {
    for (const n of NETWORKS) {
      const s = sentences(n);
      expect(s).toContain(
        "These are counts, not dollar volumes. Amounts are not added up, so the team paying itself adds no volume to them.",
      );
      expect(
        s.some((x) =>
          x.startsWith(
            "Canary participants come only from Canary attempts by people who are not on the team. A team member's Canary attempts are counted under team.",
          ),
        ),
      ).toBe(true);
      expect(s).toContain("Vaults: a vault counts on the day it was registered.");
      expect(
        s.some((x) =>
          x.startsWith("Refused on chain: a spend the contract refused, with its transaction."),
        ),
      ).toBe(true);
      expect(text(n)).toContain("has no transaction and is not counted here");
    }
  });

  it("says that an outside count appears once it is above zero, and that the team's counts are always shown", () => {
    for (const n of NETWORKS) {
      expect(sentences(n)).toContain(
        "The team's counts are always shown. External owners, Canary participants and pilots, with their columns and tiles, appear once their count is above zero. The Canary vault and its mandate, which the team set up, do not show the Canary column on their own.",
      );
      // The method is stated with no zero in it.
      expect(text(n)).not.toMatch(/\b0\b/);
    }
  });

  it("says what the Canary column is made of, since its vault and its attempts are counted from different places", () => {
    for (const n of NETWORKS) {
      expect(sentences(n)).toContain(
        "In the Canary column, vaults, mandates, payments and held spends are the Canary vault's own on-chain events. Refusals, attempts and model decisions come from the attempts instead, because the Canary's ledger is private.",
      );
    }
  });

  it("says where payments and mandates come from, word for word", () => {
    expect(
      sentences("testnet").some((x) =>
        x.startsWith("Payments and mandates come from on-chain events our watcher records."),
      ),
    ).toBe(true);
  });

  it("says the pilots are not split by network, and are named only with consent", () => {
    for (const n of NETWORKS) {
      expect(sentences(n)).toContain(
        "Pilots are counted by cohort from our pilot list, and are not split by network. A pilot's name appears only with its written consent.",
      );
    }
  });

  it("says which network the page counts, and that the other one is counted apart", () => {
    expect(networkSentence("testnet")).toBe(
      "The live counts are for NEAR testnet only, with test tokens. Activity on the other NEAR network is counted apart and is not added in.",
    );
    expect(networkSentence("mainnet")).toBe(
      "The live counts are for NEAR mainnet only. Activity on the other NEAR network is counted apart and is not added in.",
    );
    for (const n of NETWORKS) expect(sentences(n)).toContain(networkSentence(n));
  });

  // A testnet page also shows the mainnet record and what it costs, from the committed evidence: their words are in
  // components/usage/MainnetSections.tsx, and MainnetSections.test.ts holds them.
  it("keeps mainnet out of the counts' copy of a testnet build", () => {
    expect(allCopy().length).toBeGreaterThan(20);
    const testnet = [
      eyebrow("testnet"),
      networkSentence("testnet"),
      ...strings(definitions("testnet")),
      ...strings(USAGE_COPY),
    ];
    expect(testnet.filter((t) => /mainnet/i.test(t))).toEqual([]);
  });

  it("says model decisions are answers of a model, and does not call them attestations of the Canary", () => {
    const t = text("mainnet");
    expect(t).toContain("Model decisions:");
    expect(t).not.toMatch(/attested/i);
  });

  it("names the 90 seconds after which an attempt that did not finish is counted", () => {
    expect(text("mainnet")).toContain("once 90 seconds have passed");
  });

  it("counts the attempts that were recorded, not every one that was tried: a turned-away attempt has no row", () => {
    const attempts = definitions("mainnet").find((d) => d.lead === "Canary attempts:");
    expect(attempts?.text).toMatch(/^every attempt that was recorded\. /);
    expect(text("mainnet")).not.toContain("every attempt on the Canary page");
  });

  it("has an entry for every row of the table", () => {
    const leads = definitions("mainnet").flatMap((d) => (d.lead ? [d.lead] : []));
    for (const lead of [
      "Vaults:",
      "Held for approval:",
      "Refused by code:",
      "Refused on chain:",
      "Canary attempts:",
      "Model decisions:",
    ]) {
      expect(leads).toContain(lead);
    }
  });
});

describe("when the numbers cannot be read", () => {
  it("says so in the owner's words", () => {
    expect(UNAVAILABLE).toBe(
      "The usage numbers are not available right now. Every payment stays visible on chain.",
    );
  });
});
