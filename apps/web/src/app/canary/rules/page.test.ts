import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CANARY_LIMITS } from "@/lib/canary/limits";
import { LIMITS } from "@/lib/ratelimit";
import { PLANNED_ROUTES } from "@/lib/routes";

// The page is rendered per request, for the network of the address it is opened at.
const net = vi.hoisted(() => ({ network: "testnet" as "mainnet" | "testnet" }));
vi.mock("@/lib/network", () => ({ softRequestNetwork: async () => net.network }));

import CanaryRules, { metadata } from "./page";

const html = renderToStaticMarkup(await CanaryRules());
const visible = (h: string) =>
  h
    .replace(/<\/?(?:p|h1|h2|li|ol|div)\b[^>]*>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const text = visible(html);
const hrefs = [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1] ?? "");

describe("/canary/rules", () => {
  it("is titled Canary rules", () => {
    expect(metadata.title).toBe("Canary rules");
    expect(html).toMatch(/<h1[^>]*>Canary rules<\/h1>/);
  });

  it("lists the eight rules as a numbered list, in order", () => {
    expect(html).toContain("<ol");
    expect([...html.matchAll(/<li\b/g)]).toHaveLength(8);
    const titles = [
      "The goal.",
      "How it works.",
      "Why an address in your message cannot work.",
      "Limits.",
      "Out of scope.",
      "Your data.",
      "How you are counted.",
      "The fine print.",
    ];
    const at = titles.map((t) => text.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("asks for a report the way SECURITY.md does, and does not offer the finder anything", () => {
    // an external link says it opens a new tab; the sentence is read without that note
    expect(text.replace(/ \(opens in a new tab\)/g, "")).toContain(
      "Make the Canary vault pay anyone other than its single mandated payee. If you find a way, tell us how: send a direct message to @probarionhq on X that says you have a security report, with no details, as SECURITY.md describes.",
    );
    expect(hrefs).toContain("https://x.com/probarionhq");
    expect(html).not.toMatch(/mailto:|security@/);
    expect(text).not.toMatch(/bounty|keep what you extract|prize|reward/i);
  });

  it("states the limits from the code", () => {
    expect(text).toContain("A message is at most 4,000 characters.");
    const [modelMax, modelWindowS] = LIMITS.canaryModelVisitor;
    expect(text).toContain(
      `One network address gets at most ${modelMax} model attempts every ${modelWindowS / 60} minutes and ${CANARY_LIMITS.attemptsPerIpPerHour} an hour.`,
    );
    expect(text).toContain(
      `All visitors together get at most ${CANARY_LIMITS.attemptsGlobalPerHour} an hour and ${CANARY_LIMITS.attemptsGlobalPerDay} a day.`,
    );
    expect(text).toContain("below 0.2 NEAR");
  });

  it("ends with a sentence that is true on its own", () => {
    expect(text).toContain("These rules may change while the challenge runs.");
    expect(text).not.toMatch(/legal advice|to be reviewed/);
  });

  it("sends bug reports to the email or to SECURITY.md on GitHub, and links no page that does not exist", () => {
    expect(hrefs).toContain("https://github.com/probarion/probarion/blob/main/SECURITY.md");
    expect(hrefs.filter((h) => /\/(security|open)$/.test(h) && !h.startsWith("http"))).toEqual([]);
    for (const h of hrefs.filter((x) => x.startsWith("/"))) {
      expect(PLANNED_ROUTES).not.toContain(h);
    }
    expect(text).not.toContain("responsible disclosure");
  });

  it("opens the GitHub link in a new tab and says so, and the mail link as a plain link", () => {
    expect(html).toMatch(
      /<a[^>]*href="https:\/\/github\.com\/probarion\/probarion\/blob\/main\/SECURITY\.md"[^>]*target="_blank"[^>]*rel="noreferrer"/,
    );
    expect(html).toContain("(opens in a new tab)");
    expect(html).not.toMatch(/<a[^>]*href="mailto:[^"]*"[^>]*target=/);
  });

  it("says on a testnet build that it runs on testnet", () => {
    expect(text).toContain("It runs on testnet, with test tokens that have no value.");
    expect(text).not.toMatch(/mainnet/i);
  });

  it("leaves the testnet sentence out on a mainnet address", async () => {
    net.network = "mainnet";
    try {
      const mainnet = visible(renderToStaticMarkup(await CanaryRules()));
      expect(mainnet).not.toMatch(/testnet|test tokens/i);
      expect(mainnet).toContain("This is beta, unaudited software.");
    } finally {
      net.network = "testnet";
    }
  });

  it("tells a participant that they are not a customer, and links the Usage page where they are counted apart", () => {
    expect(text).toContain(
      "You are a challenge participant, not a customer. The Usage page counts you apart from the product's own users.",
    );
    expect(html).toMatch(/<a[^>]*href="\/usage"[^>]*>Usage page<\/a>/);
    // It is a page of this site, so it opens here and not in a new tab.
    expect(html).not.toMatch(/<a[^>]*href="\/usage"[^>]*target=/);
    expect(text).not.toContain("kept apart from the product's own");
  });

  it("links back to the Canary page", () => {
    expect(html).toMatch(/<a[^>]*href="\/canary"[^>]*>Back to the Canary<\/a>/);
  });
});
