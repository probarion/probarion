// /check against the accessibility rules a static render can show: names for every control, references that resolve,
// one live line for the end of a check, verdicts in words and not in colour alone, and links that say they open a new
// tab. axe over the built page is the e2e suite's job; this holds the markup the page ships.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inputClass } from "@/components/ui";
import { MAINNET_HISTORY, scriptedChain } from "../../../test/fixtures/payee-chain";
import { CheckResult } from "./CheckResult";
import CheckPage from "./page";
import { runCheck } from "./run";

const page = renderToStaticMarkup(createElement(CheckPage));

async function result(): Promise<string> {
  const chain = scriptedChain({ accounts: {}, ...MAINNET_HISTORY });
  let t = 0;
  const run = await runCheck(
    {
      network: "mainnet",
      payee: { chain: "near", address: "probarion-duonq.near" },
      vault: "v0.probarion.near",
    },
    { fetch: chain.fetch, now: () => (t += 3) },
  );
  if (run.kind !== "done") throw new Error(run.message);
  return renderToStaticMarkup(createElement(CheckResult, { run, shareHref: "#x" }));
}

const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? "");
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];

describe("/check's markup", () => {
  it("has one h1, and headings that step down one level at a time", () => {
    const levels = [...page.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    for (const [i, l] of levels.entries())
      if (i > 0) expect(l - (levels[i - 1] ?? 1)).toBeLessThanOrEqual(1);
  });

  it("names every field with its own label, and links each hint to its field", () => {
    const controls = [...tags(page, "input"), ...tags(page, "select")];
    expect(controls).toHaveLength(3);
    for (const c of controls) {
      const id = attr(c, "id");
      expect(id, c).toBeTruthy();
      expect(page).toContain(`for="${id}"`);
    }
    const described = controls.flatMap((c) =>
      (attr(c, "aria-describedby") ?? "").split(" ").filter(Boolean),
    );
    expect(described).toHaveLength(2);
    for (const id of described) expect(ids(page)).toContain(id);
  });

  it("gives every id once, and every reference an element", () => {
    const all = ids(page);
    expect(new Set(all).size).toBe(all.length);
    for (const m of page.matchAll(/aria-(?:labelledby|describedby)="([^"]+)"/g)) {
      for (const id of (m[1] ?? "").split(" ")) expect(all, id).toContain(id);
    }
  });

  it("names the form and the sections", () => {
    expect(tags(page, "form")[0]).toContain('aria-label="The payee"');
    for (const s of tags(page, "section")) expect(attr(s, "aria-labelledby"), s).toBeTruthy();
  });

  it("gives each button a type and words, and says which example a button fills in", () => {
    const buttons = [...page.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    expect(buttons.length).toBe(6);
    for (const [, a, inner] of buttons) {
      expect(a, inner).toMatch(/\stype="(button|submit)"/);
      expect((inner ?? "").replace(/<[^>]+>/g, "").trim(), a).not.toBe("");
    }
    const examples = buttons.filter(([, a]) => /aria-pressed/.test(a ?? ""));
    expect(examples).toHaveLength(5);
    for (const [, a] of examples) expect(a).toMatch(/aria-describedby="check-ex-[a-z0-9-]+"/);
  });

  it("keeps the fields at 16px and 44px tall, so a phone does not zoom and a finger can hit them", () => {
    expect(inputClass).toContain("text-base");
    expect(inputClass).toContain("min-h-11");
    for (const c of [...tags(page, "input"), ...tags(page, "select")])
      expect(c).toContain("text-base");
  });

  it("has one status line for the end of a check, outside the region that is busy while it reads", () => {
    const status = tags(page, "p").filter((t) => /role="status"/.test(t));
    expect(status).toHaveLength(1);
    expect(status[0]).toContain("sr-only");
    const at = page.indexOf('role="status"');
    const busy = page.indexOf("aria-busy=");
    expect(busy).toBeGreaterThan(at);
    expect(page.match(/aria-live=|role="status"|role="alert"/g)).toHaveLength(1);
  });

  it("sets no positive tabindex and hides no focus ring", () => {
    expect(page).not.toMatch(/tabindex="[1-9]/i);
    expect(page).not.toMatch(/\boutline-none\b/);
  });

  it("says that a link opens a new tab, and sends no Referer with it", () => {
    const external = [...page.matchAll(/<a\b([^>]*)target="_blank"([^>]*)>([\s\S]*?)<\/a>/g)];
    expect(external.length).toBeGreaterThanOrEqual(5);
    for (const [, before, after, inner] of external) {
      expect(`${before}${after}`).toContain('rel="noreferrer"');
      expect(inner).toContain('<span class="sr-only"> (opens in a new tab)</span>');
    }
  });
});

describe("a finished check's markup", () => {
  it("says the verdict and every reason's level in words, not in colour alone", async () => {
    const html = await result();
    expect(html).toMatch(/<span class="[^"]*">Block<\/span>/);
    expect(html).toMatch(/<h3[^>]*>Block: /);
    const levels = [
      ...html.matchAll(/data-level="([a-z]+)"><div[^>]*><span class="[^"]*">([a-z]+)<\/span>/g),
    ];
    expect(levels.length).toBe(html.match(/data-level=/g)?.length);
    expect(levels.length).toBeGreaterThan(2);
    for (const m of levels) expect(m[2]).toBe(m[1]);
    const states = [
      ...html.matchAll(/data-state="([a-z_]+)"[\s\S]*?<span class="[^"]*">([a-z ]+)<\/span>/g),
    ];
    expect(states.length).toBe(html.match(/data-state=/g)?.length);
    expect(states.length).toBe(4);
    for (const m of states) expect(m[2]).toBe(m[1]?.replace("_", " "));
  });

  it("heads the requests table's columns, and keeps every part in a heading or a disclosure with a name", async () => {
    const html = await result();
    const heads = tags(html, "th");
    expect(heads).toHaveLength(4);
    for (const th of heads) expect(th).toContain('scope="col"');
    for (const s of html.matchAll(/<summary[^>]*>([^<]+)<\/summary>/g))
      expect(s[1]?.trim()).not.toBe("");
    expect(html.match(/<summary/g)).toHaveLength(2);
    expect([...html.matchAll(/<h([1-6])\b/g)].map((m) => m[1])).toEqual(["3", "3", "3", "3"]);
  });

  it("caps no block of text at a height, so nothing scrolls that a keyboard cannot reach", async () => {
    const html = await result();
    const pre = tags(html, "pre");
    expect(pre).toHaveLength(1);
    for (const t of pre) expect(t).not.toMatch(/max-h-|overflow-(y-)?(auto|scroll)/);
  });
});
