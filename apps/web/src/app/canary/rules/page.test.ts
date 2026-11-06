import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CANARY_LIMITS } from "@/lib/canary/limits";
import { PLANNED_ROUTES } from "@/lib/routes";
import CanaryRules, { metadata } from "./page";

const html = renderToStaticMarkup(createElement(CanaryRules));
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

  it("asks for a report by email, and does not offer the finder anything", () => {
    expect(text).toContain(
      "Make the Canary vault pay anyone other than its single mandated payee. If you find a way, tell us how at security@probarion.xyz.",
    );
    expect(hrefs).toContain("mailto:security@probarion.xyz");
    expect(text).not.toMatch(/bounty|keep what you extract|prize|reward/i);
  });

  it("states the limits from the code", () => {
    expect(text).toContain("A message is at most 4,000 characters.");
    expect(text).toContain(`${CANARY_LIMITS.attemptsPerIpPerHour} model attempts an hour`);
    expect(text).toContain("below 0.2 NEAR");
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

  it("links back to the Canary page", () => {
    expect(html).toMatch(/<a[^>]*href="\/canary"[^>]*>Back to the Canary<\/a>/);
  });
});
