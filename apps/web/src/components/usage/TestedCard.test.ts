import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TESTED } from "@/lib/site/tested";
import { repoFile } from "./evidence";
import { TestedCard } from "./TestedCard";

const html = renderToStaticMarkup(createElement(TestedCard));
const visible = (h: string) =>
  h
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const text = visible(html);
const hrefs = [...html.matchAll(/\shref="([^"]*)"/g)].map((m) =>
  (m[1] ?? "").replace(/&amp;/g, "&"),
);
/** A string of the table as the card shows it: backticks are code, so they are not drawn. */
const shown = (s: string) => s.replaceAll("`", "");

describe("the card of how far it is tested", () => {
  it("is the target of #tested, with its title and the dated lede", () => {
    expect(html).toMatch(/^<section id="tested"/);
    expect(html).toMatch(/<h2[^>]*>How far it is tested<\/h2>/);
    expect(text).toContain(TESTED.lede);
  });

  it("shows every row of the README's table, in its order, with when it was read", () => {
    const at = TESTED.rows.map((r) => text.indexOf(shown(r.figure)));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const r of TESTED.rows) {
      expect(text).toContain(shown(r.what));
      expect(text).toContain(`Read: ${shown(r.at)}.`);
    }
    expect([...html.matchAll(/<li>/g)]).toHaveLength(TESTED.rows.length);
  });

  it("sets the code in the figures as code", () => {
    expect(html).toContain("<code>@probarion/core</code>");
    expect(html).toContain("<code>decide()</code>");
  });

  it("links each source: a file on GitHub and a CI log in a new tab, a page of the site named as from /usage", () => {
    const want = TESTED.rows.flatMap((r) =>
      r.sources.map((s) =>
        s.href.startsWith("https://")
          ? s.href
          : s.href.startsWith("/")
            ? `${s.href}?via=usage`
            : repoFile(s.href),
      ),
    );
    expect(hrefs).toEqual(want);
    expect(hrefs).toContain("/canary?via=usage");
    expect(hrefs).toContain(repoFile("eval/results/adversary.md"));
    expect(html).toMatch(
      /<a[^>]*href="https:\/\/github\.com\/probarion\/probarion\/actions\/runs\/43533889651"[^>]*target="_blank"/,
    );
  });

  it("says attested decisions only beside the caveat that the TEE measurement is not pinned", () => {
    const rows = TESTED.rows.filter((r) => /attested decisions/.test(r.figure));
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.figure, r.what).toMatch(/[Tt]he TEE measurement is not pinned/);
  });
});
