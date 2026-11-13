// /check as a visitor gets it: the page's server render (the form before the browser takes over), and a finished
// check's markup for each verdict, for reads that failed and for a check that could not run.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PLANNED_ROUTES } from "@/lib/routes";
import {
  CODE_A,
  MAINNET_HISTORY,
  NO_CODE,
  scriptedChain,
  unreachable,
} from "../../../test/fixtures/payee-chain";
import { CheckFailed, CheckResult } from "./CheckResult";
import { EXAMPLES } from "./check-view";
import { CHECK_PAGE } from "./copy";
import CheckPage, { metadata } from "./page";
import { type DoneRun, runCheck } from "./run";

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/\s+/g, " ");

const page = () => renderToStaticMarkup(createElement(CheckPage));

let clock = 0;
async function done(
  payee: string,
  fetch: typeof globalThis.fetch,
  vault?: string,
): Promise<DoneRun> {
  const [chain, address] = payee.split(":") as ["near" | "base", string];
  const run = await runCheck(
    { network: "mainnet", payee: { chain, address }, ...(vault === undefined ? {} : { vault }) },
    { fetch, now: () => (clock += 7) },
    { timeoutMs: 50, budgetMs: 400 },
  );
  if (run.kind !== "done") throw new Error(run.message);
  return run;
}

const chain = () =>
  scriptedChain({
    accounts: { "probarion-duong.near": NO_CODE, "vendor.near": CODE_A },
    ...MAINNET_HISTORY,
  });

describe("/check", () => {
  it("is a built, static page with its own title", () => {
    expect(metadata.title).toBe("Check a payee");
    expect(String(metadata.description)).toContain("Your browser reads public nodes itself");
    // Solana is not read on its own chain, so the description does not offer it beside NEAR and Base.
    expect(String(metadata.description)).toContain("A Solana payee is not read on its own chain.");
    expect(PLANNED_ROUTES).not.toContain("/check");
  });

  it("says why the check runs where a payee is chosen, in the brief's words", () => {
    const t = text(page());
    expect(t).toContain(
      "The agent does not pick a payee, so the place to check one is where it is chosen: before the owner signs a mandate.",
    );
    expect(t).toContain(
      "The agent's key can call one method, spend, and spend has no address field. A payee enters through the mandate the owner signs.",
    );
    expect(t).toContain("Check a payee before you sign a mandate");
    expect(t).toContain("No wallet, no sign-in, and the check calls no Probarion server route.");
  });

  it("has a network select, a payee field and an optional vault field, and a button that waits for the browser", () => {
    const html = page();
    expect(html).toMatch(
      /<select[^>]*>.*<option value="mainnet"[^>]*>mainnet<\/option><option value="testnet">testnet<\/option><\/select>/,
    );
    expect(html).toContain('name="payee"');
    expect(html).toContain('name="vault"');
    expect(text(html)).toContain("Vault (optional)");
    // Before the browser runs the page there is nothing to read the chain with, so the button waits.
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Check the payee<\/button>/);
  });

  it("offers every example with its note, and says each one reads live", () => {
    const t = text(page());
    expect(t).toContain(CHECK_PAGE.form.tryLabel);
    for (const e of EXAMPLES) {
      expect(t).toContain(e.label);
      expect(t).toContain(e.note);
    }
  });

  it("says what the check reads, what it does with a failed read, and what it is not", () => {
    const t = text(page());
    expect(t).toContain(
      "Your browser reads from rpc.mainnet.fastnear.com (falling back to rpc.intea.rs) on mainnet, rpc.testnet.fastnear.com on testnet,",
    );
    expect(t).toContain("archival-rpc.mainnet.fastnear.com and archival-rpc.testnet.fastnear.com");
    expect(t).toContain("mainnet.base.org");
    expect(t).toContain("It calls no Probarion server route, and this page saves nothing.");
    expect(t).toContain("A read that fails or times out is unknown, and an unknown is a warning.");
    expect(t).toContain("So the page does not answer allow on a read it could not make.");
    expect(t).toContain(
      "The blocklist is a seed, not a reputation service: 2 testnet names and 0 on mainnet",
    );
    expect(t).toContain("The code is unaudited.");
    expect(t).toContain("the owner can still sign a mandate for a payee this page blocks");
    const html = page();
    for (const l of CHECK_PAGE.about.links)
      expect(html).toContain(`href="${l.href.replaceAll("&", "&amp;")}"`);
  });

  it("adds no dash and no absolute claim to its copy", () => {
    const t = text(page());
    expect(t).not.toMatch(/[–—]/);
    // "The same first and last 4 hex characters" describes an address; "the first" or "the only" would be a claim.
    expect(t).not.toMatch(/\b(the first|the only|unhackable|never|guarantee[sd]?)\b/i);
  });
});

describe("a finished check", () => {
  it("shows the verdict in words, its reasons, each read with its hosts, the requests, the JSON and the CLI line", async () => {
    const run = await done("near:probarion-duong.near", chain().fetch, "v0.probarion.near");
    const html = renderToStaticMarkup(createElement(CheckResult, { run, shareHref: "#x" }));
    const t = text(html);
    expect(html).toContain('data-check-verdict="allow"');
    expect(t).toContain("Allow: near:probarion-duong.near on mainnet");
    expect(t).toContain("Every check passed.");
    expect(t).toContain("This vault paid near:probarion-duong.near once before.");
    expect(t).toContain("What we read, from where");
    expect(t).toContain("From: rpc.mainnet.fastnear.com, archival-rpc.mainnet.fastnear.com");
    expect(t).toContain("The payees of v0.probarion.near");
    expect(t).toContain(`The ${run.log.length} requests this browser sent`);
    expect(t).toContain("view_account probarion-duong.near at final");
    expect(t).toContain("The signals and the assessment as JSON");
    expect(t).toContain(
      "node packages/cli/dist/bin.js payee check near:probarion-duong.near --network mainnet --vault v0.probarion.near",
    );
    expect(t).toContain("Release 0.1.1 on npm does not have this command.");
    expect(t).toContain("It changes nothing on chain.");
    expect(t).toContain("Read-only: views and block headers, no transaction signed or sent.");
    expect(html).toContain('href="#x"');
  });

  it("puts block reasons first, each with its level and id as text", async () => {
    const run = await done("near:probarion-duonq.near", chain().fetch, "v0.probarion.near");
    const html = renderToStaticMarkup(createElement(CheckResult, { run }));
    expect(html).toContain('data-check-verdict="block"');
    const ids = [...html.matchAll(/data-reason="([a-z_0-9]+)" data-level="([a-z]+)"/g)].map(
      (m) => `${m[2]} ${m[1]}`,
    );
    expect(ids.slice(0, 2)).toEqual(["block lookalike", "block not_found"]);
    expect(text(html)).toContain("Block: near:probarion-duonq.near on mainnet");
    expect(html).not.toContain("Link to this check");
  });

  it("shows a read no node answered as unknown with its reason, and the verdict as a warning, not an allow", async () => {
    const run = await done("near:probarion-duong.near", unreachable, "v0.probarion.near");
    const html = renderToStaticMarkup(createElement(CheckResult, { run }));
    expect(html).toContain('data-check-verdict="warn"');
    expect(html).not.toContain('data-check-verdict="allow"');
    expect(html.match(/data-state="unknown"/g)?.length).toBe(3);
    const t = text(html);
    expect(t).toContain("Could not read whether probarion-duong.near exists on NEAR mainnet");
    expect(t).toMatch(/unknown: .*(Failed to fetch|fetch failed|network)/i);
    expect(t).toContain("no answer (network or CORS error)");
  });

  it("says a check that could not run is not an allow", () => {
    const html = renderToStaticMarkup(
      createElement(CheckFailed, {
        run: {
          kind: "failed",
          input: { network: "mainnet", payee: { chain: "near", address: "vendor.near" } },
          message: "a bug in the reads",
          log: [],
        },
      }),
    );
    expect(html).toContain('data-check-verdict="failed"');
    expect(text(html)).toContain(
      "The check could not run: a bug in the reads. This is not an allow: check the payee another way before you sign.",
    );
  });
});
