// The public site's claims, held to the files they come from. If a contract, a README line or a planned page changes,
// the copy has to change with it: an AI judge and human judges check the site against the repository.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks, type Snapshot } from "@probarion/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { BetaStrip } from "@/components/site/BetaStrip";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { explorerTxUrl } from "@/lib/config";
import { cli } from "@/lib/proof/cli";
import { PLANNED_ROUTES } from "@/lib/routes";
import {
  BAND,
  betaStrip,
  CHAIN,
  CHECK_LABELS,
  CLOSING,
  CONTRACT_REFUSAL_CODE,
  FIXTURE_PATH,
  FOOTER,
  HEADER_ANCHORS,
  HERO,
  JOURNEY,
  LINKS,
  NUMBERS,
  OG_IMAGE,
  PROOF_INDEX,
  publicRoutes,
  RECORDED_RESULT,
  RULES_SHOWN,
  SITE_DESCRIPTION,
  SPEND_REQUEST_FIELDS,
  STATUS,
  TAMPER_COPY,
  TX,
  VERIFIER_OUTPUT,
} from "@/lib/site/facts";
import { ledgerRows, verifyTamper } from "@/lib/site/tamper";
import fixture from "@/lib/site/valid-snapshot.json";
import { importsOf } from "./deploy-scan";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "..", "..");
const bytes = (...p: string[]) => readFileSync(join(...p));
const text = (...p: string[]) => readFileSync(join(...p), "utf8");

const README = text(ROOT, "README.md");
const SNAPSHOT = fixture as unknown as Snapshot;

/** The whole landing page as a visitor gets it, with the chrome the layout puts around it. */
const landing = (network: "testnet" | "mainnet" = "testnet") =>
  renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(BetaStrip, { network }),
      createElement(SiteHeader),
      createElement(Home),
      createElement(SiteFooter),
    ),
  );
const visibleText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
const hrefs = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1] ?? "");

describe("the ledger test", () => {
  it("shows the recorded result that the verifier really gives", async () => {
    const r = await verifyTamper(SNAPSHOT, null);
    const statuses = (x: typeof r) => x.checks.map(({ id, status }) => ({ id, status }));
    expect(statuses(RECORDED_RESULT)).toEqual(statuses(r));
    expect(RECORDED_RESULT.ok).toBe(r.ok);
    expect(RECORDED_RESULT.firstBroken).toBe(r.firstBroken);
    expect([RECORDED_RESULT.passed, RECORDED_RESULT.failed, RECORDED_RESULT.unproven]).toEqual([
      r.passed,
      r.failed,
      r.unproven,
    ]);
  });

  it("names exactly the checks runChecks returns", async () => {
    const report = await runChecks(SNAPSHOT);
    expect(Object.keys(CHECK_LABELS).sort()).toEqual(report.checks.map((c) => c.id).sort());
    expect(new Set(Object.values(CHECK_LABELS)).size).toBe(9);
  });

  it("keeps the verifier and the fixture out of the landing page's first load", () => {
    const src = text(WEB, "src", "components", "site", "TamperTest.tsx");
    const heavy = /@probarion\/core|lib\/site\/tamper|valid-snapshot|lib\/config|components\/ui/;
    const dynamic = [...src.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1] ?? "");
    expect(dynamic).toEqual(["@/lib/site/tamper", "@/lib/site/valid-snapshot.json"]);
    const loaded = importsOf(src).filter((i) => !i.typeOnly && !dynamic.includes(i.spec));
    expect(loaded.filter((i) => heavy.test(i.spec))).toEqual([]);
    expect(src.startsWith('"use client"')).toBe(true);
  });
});

// Offline, the verifier checks a file against itself: the chain data comes from the same file, so a forged file with
// re-signed entries passes. Only a live run reads the chain, so no copy may say that a file proves anything by itself.
describe("what an offline run shows", () => {
  const sentences = (copy: string) => copy.split(/(?<=[.!?])s+/);

  it("says offline in the lede and the numbers band only beside the word snapshot", () => {
    const claims = [
      HERO.lede,
      SITE_DESCRIPTION,
      ...NUMBERS.map(({ name, rest }) => `${name}${rest}`),
    ];
    for (const sentence of claims.flatMap(sentences)) {
      if (/offline/i.test(sentence)) expect(sentence).toMatch(/snapshot/i);
    }
    expect(HERO.lede).not.toMatch(/offline/i);
    expect(SITE_DESCRIPTION).not.toMatch(/offline/i);
    expect(visibleText(landing())).not.toContain("without trusting us");
  });

  it("says in the numbers band what a live run and an offline run each do", () => {
    const checks = NUMBERS.find(({ name }) => name === "checks");
    expect(checks?.rest).toBe(
      " anyone can run. Live, they read the chain. Offline, they check a snapshot against itself, so take the snapshot yourself.",
    );
  });

  it("names the flag that reads the chain under the closing headline, and the CLI has it", () => {
    expect(CLOSING.line1).toBe("Don't trust us.");
    expect(CLOSING.line2).toBe("Run the verifier.");
    expect(CLOSING.live).toContain("reads the chain itself");
    expect(CLOSING.live).toContain("`verify --vault`");
    expect(visibleText(landing())).toContain("reads the chain itself");
    const verify = text(ROOT, "packages", "cli", "src", "commands", "verify.ts");
    expect(verify).toContain('.option("--vault <id>"');
  });

  it("says on /proof what the downloaded file shows", () => {
    expect(PROOF_INDEX.intro).toContain(
      "Offline, the verifier checks that file against itself. The page also gives the command that reads the chain again.",
    );
    expect(PROOF_INDEX.intro).not.toContain("verify offline");
  });

  it("says what the ledger test shows, and nothing more", () => {
    expect(TAMPER_COPY.intro).toContain("catches an edit that was not re-signed");
    expect(TAMPER_COPY.intro).toContain("test fixture");
  });
});

describe("transactions", () => {
  const deployment = JSON.parse(text(ROOT, "contracts", "deployments", "testnet.json")) as {
    accounts: { vault_v0: string };
    smoke: { near_payment_tx: string; base_burn_tx: string; no_mandate_tx: string };
  };

  it("match the testnet deployment record and appear in the README", () => {
    expect(TX.nearPayment.hash).toBe(deployment.smoke.near_payment_tx);
    expect(TX.baseBurn.hash).toBe(deployment.smoke.base_burn_tx);
    expect(TX.noMandate.hash).toBe(deployment.smoke.no_mandate_tx);
    for (const t of Object.values(TX)) expect(README).toContain(t.hash);
  });

  it("link to the testnet explorer, whatever network this build runs on", () => {
    for (const t of Object.values(TX)) {
      expect(t.url).toBe(explorerTxUrl("testnet", t.hash));
      expect(t.url).toContain("testnet");
    }
  });

  it("shorten each hash with its own first and last characters", () => {
    for (const t of Object.values(TX)) {
      const [head, tail] = t.label.split("…");
      expect(t.hash.startsWith(head ?? "?")).toBe(true);
      expect(t.hash.endsWith(tail ?? "?")).toBe(true);
    }
  });

  it("name the vault the deployment record names", () => {
    expect(visibleText(landing())).toContain(deployment.accounts.vault_v0);
  });
});

describe("the claims about the code", () => {
  const types = text(ROOT, "packages", "core", "src", "types.ts");
  const fieldsOf = (name: string) => {
    const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(types)?.[1];
    if (body === undefined) throw new Error(`interface ${name} not found`);
    return [...body.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1] ?? "");
  };

  it("shows the fields of SpendRequest as the source has them, and none is a recipient", () => {
    expect([...SPEND_REQUEST_FIELDS]).toEqual(fieldsOf("SpendRequest"));
    expect(SPEND_REQUEST_FIELDS).not.toContain(BAND.gone);
    for (const f of fieldsOf("SpendRequest")) {
      expect(f).not.toMatch(/recipient|payee|address|receiver|destination/i);
    }
  });

  it("shows mandate fields that exist on a mandate", () => {
    const mandate = fieldsOf("MandateInput");
    const step = JOURNEY.steps[0];
    const keys = step.panel.flatMap((l) => ("key" in l ? [l.key] : []));
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(mandate, k).toContain(k);
  });

  it("names only rules that exist in the policy engine", () => {
    const policy = text(ROOT, "packages", "core", "src", "policy.ts");
    for (const rule of RULES_SHOWN) expect(policy, rule).toContain(`"${rule}"`);
  });

  it("pins the journey's output strings to the README", () => {
    expect(README).toContain(VERIFIER_OUTPUT.summary);
    expect(README).toContain(VERIFIER_OUTPUT.result);
    expect(README).toContain(CONTRACT_REFUSAL_CODE);
    expect(README).toContain("provider_tee");
    const out = visibleText(landing());
    expect(out).toContain(VERIFIER_OUTPUT.summary);
    expect(out).toContain(VERIFIER_OUTPUT.result);
    expect(out).toContain(CONTRACT_REFUSAL_CODE);
    expect(out).toContain(cli("verify --offline"));
    expect(out).toContain(FIXTURE_PATH);
  });

  it("links only to files and headings that exist in the repository", () => {
    expect(LINKS.github).toBe("https://github.com/probarion/probarion");
    expect(LINKS.fixture).toContain(FIXTURE_PATH);
    expect(README).toContain("## How to evaluate Probarion in 5 minutes");
    expect(LINKS.evaluate).toBe(
      "https://github.com/probarion/probarion#how-to-evaluate-probarion-in-5-minutes",
    );
    for (const url of Object.values(LINKS)) {
      const path = /\/blob\/main\/(.+)$/.exec(url)?.[1];
      if (path !== undefined) expect(existsSync(join(ROOT, ...path.split("/"))), url).toBe(true);
    }
    expect(text(ROOT, "SECURITY.md")).toContain("### What is not proven yet");
  });

  it("takes the description from the README's first sentence", () => {
    expect(README).toContain("A mandate layer for AI agents on NEAR.");
    expect(SITE_DESCRIPTION.startsWith("A mandate layer for AI agents on NEAR.")).toBe(true);
    expect(SITE_DESCRIPTION.length).toBeLessThanOrEqual(200);
  });

  it("ships the social image at the size the metadata states", () => {
    const png = bytes(WEB, "public", OG_IMAGE.url.slice(1));
    expect(png.readUInt32BE(16)).toBe(OG_IMAGE.width);
    expect(png.readUInt32BE(20)).toBe(OG_IMAGE.height);
    expect(existsSync(join(WEB, "src", "app", "icon.svg"))).toBe(true);
  });
});

describe("the payment journey", () => {
  const prose = README.replace(/\s+/g, " ");
  const step = (n: number) => {
    const found = JOURNEY.steps.find((s) => s.n === n);
    if (found === undefined) throw new Error(`no step ${n}`);
    return found;
  };

  it("says the testnet vault has no ledger key or anchors yet, as the README does", () => {
    expect(prose).toContain("this vault has no ledger key and no anchors yet");
    expect(step(5).tag).toContain("The testnet vault has no ledger key or anchors yet");
    expect(step(5).tag).toContain("runs on a test fixture");
    expect(step(5).body).toContain("The SDK anchors the ledger root");
  });

  it("marks the ledger as what the SDK does, and says the smoke run had none", () => {
    expect(prose).toContain("without the SDK, a model or a ledger");
    expect(step(3).body).toContain("The SDK signs the decision into the ledger");
    expect(step(3).tag).toContain("smoke run sent spends without a ledger");
  });

  it("shows the verifier's command on one line, as the README has it, with a prompt that does not copy", () => {
    const command = cli(`verify --offline ${FIXTURE_PATH}`);
    expect(README).toContain(command);
    expect(step(5).panel).toContainEqual({ command });
    expect(step(5).tag).toContain("Build it from a clone first (README step 1).");
    const html = renderToStaticMarkup(createElement(Home));
    expect(html).toContain(`>$ </span>${command}`);
    const css = text(WEB, "src", "components", "site", "site.module.css");
    expect(css).toMatch(/\.prompt {[^}]*user-select: none/);
  });

  it("shows the example mandate with mandate 1's approval limit", () => {
    expect(step(1).panel).toContainEqual({ key: "approval_above", value: "5 USDC" });
  });

  it("does not present the proposal panel as the fields of ModelProposal", () => {
    expect(step(2).panelLabel).toBe("What the proposal is bound to");
    expect(step(2).panel).toContainEqual({ note: "What the proposal is bound to" });
  });

  it("dates the check_spend result by when mandate 1 expires", () => {
    expect(step(4).panel[0]).toEqual({
      note: "check_spend on mandate 1, at most 5 USDC, valid until 2026-12-01",
    });
  });
});

describe("the status list", () => {
  it("is exactly the rows and pills that are true today", () => {
    expect(STATUS.rows).toEqual([
      { row: "Vault contract", pill: "On testnet", tone: "live" },
      { row: "Offline verifier, checks a to i", pill: "Shipped in source", tone: "live" },
      { row: "Reproducible builds", pill: "Shipped", tone: "live" },
      { row: "Web console", pill: "In progress", tone: "work" },
      { row: "Public proof page", pill: "Built, no public vault yet", tone: "work" },
      { row: "TypeScript SDK and CLI", pill: "In source, not on npm", tone: "work" },
      { row: "Payables agent", pill: "In progress", tone: "work" },
      { row: "Live attested model run", pill: "In progress", tone: "work" },
      { row: "Vault factory", pill: "Built, not deployed", tone: "work" },
      { row: "Canary public challenge", pill: "Planned", tone: "plan" },
      { row: "MCP server", pill: "Planned", tone: "plan" },
      { row: "Mainnet vault", pill: "Planned", tone: "plan" },
    ]);
  });

  it("says the testnet vault runs an older build, and the fixed build's hash is on record", () => {
    expect(STATUS.build).toBe(
      "The testnet vault runs a build older than the current source, and the fixed build's hash is recorded in `contracts/code-hashes.json`.",
    );
    const prose = README.replace(/\s+/g, " ");
    expect(prose).toContain("testnet vault runs the earlier build");
    const hashes = JSON.parse(text(ROOT, "contracts", "code-hashes.json")) as {
      entries: { code_hash: string }[];
    };
    const fixed = /code hash `(3cQXYDvf[1-9A-HJ-NP-Za-km-z]+)`/.exec(prose)?.[1];
    expect(hashes.entries.map((e) => e.code_hash)).toContain(fixed);
    expect(visibleText(landing())).toContain("runs a build older than the current source");
  });

  it("says no third party has audited this code and links SECURITY.md", () => {
    const html = landing();
    expect(visibleText(html)).toContain("No third party has audited this code. Read the");
    expect(hrefs(html)).toContain(LINKS.security);
    expect(LINKS.security.endsWith("/SECURITY.md")).toBe(true);
  });
});

describe("the rendered landing page", () => {
  it("says it is an unaudited beta", () => {
    expect(visibleText(landing())).toContain("Unaudited beta");
  });

  it("uses the word audited only to say no audit has happened", () => {
    const rest = visibleText(landing())
      .replace(/Unaudited beta/g, "")
      .replace(/No third party has audited this code/g, "");
    expect(rest).not.toMatch(/audit/i);
  });

  it("links to no planned route, and marks each one it names as coming soon", () => {
    const html = landing();
    const planned = (href: string) =>
      PLANNED_ROUTES.some((r) =>
        new RegExp(`^${r.replace(/\[[^\]]+\]/g, "[^/]+")}$`).test(href.replace(/[?#].*$/, "")),
      );
    expect(hrefs(html).filter(planned)).toEqual([]);
    const out = visibleText(html);
    const named = [...FOOTER.product, ...FOOTER.legal].filter((i) =>
      PLANNED_ROUTES.includes(i.route),
    );
    expect(named.length).toBeGreaterThan(0);
    for (const { label } of named) expect(out, label).toContain(`${label} (coming soon)`);
  });

  it("leaves no route out of the footer that it does not cover some other way", () => {
    const out = visibleText(landing());
    expect(out).toContain("Canary (coming soon)");
    expect(out).toContain("Open metrics (coming soon)");
    expect(out).toContain("Terms (coming soon)");
    expect(out).toContain("Privacy (coming soon)");
  });

  it("names none of the owner's other projects", () => {
    // The bracket keeps the name itself out of this repository.
    expect(landing()).not.toMatch(/vest[i]arion/i);
    expect(text(WEB, "src", "lib", "site", "facts.ts")).not.toMatch(/vest[i]arion/i);
  });

  it("has no em dash in its copy", () => {
    expect(visibleText(landing())).not.toContain("—");
  });

  it("has a landing section behind every anchor of the header, reachable from any page", () => {
    const html = renderToStaticMarkup(createElement(Home));
    expect(HEADER_ANCHORS.length).toBeGreaterThan(0);
    for (const { href } of HEADER_ANCHORS) {
      expect(href.startsWith("/#"), href).toBe(true);
      expect(html, href).toContain(`id="${href.slice(2)}"`);
    }
  });

  it("is complete with no JavaScript: the rows, the nine check names and the recorded result", () => {
    const out = visibleText(renderToStaticMarkup(createElement(Home)));
    for (const row of ledgerRows(SNAPSHOT)) expect(out).toContain(row.outcome);
    for (const label of Object.values(CHECK_LABELS)) expect(out).toContain(label);
    expect(out).toContain("9 passed, 0 failed, 0 unproven");
    expect(out).toContain("PASS");
    expect(out).toContain("Recorded result");
  });

  it("says what the ledger test is, and links the fixture on GitHub", () => {
    const html = renderToStaticMarkup(createElement(Home));
    const out = visibleText(html);
    expect(out).toContain("real verifier from @probarion/core");
    expect(out).toContain("runs in your browser");
    expect(out).toContain("five entries signed with test keys");
    expect(out).toContain("not a live vault");
    expect(out).toContain("Nothing leaves the page");
    expect(out).toContain(FIXTURE_PATH);
    expect(hrefs(html)).toContain(LINKS.fixture);
    expect(html).toContain('aria-live="polite"');
  });

  it("links every transaction on the testnet explorer, opening in a new tab", () => {
    const html = landing();
    for (const row of CHAIN.rows) {
      expect(hrefs(html)).toContain(row.tx.url);
      expect(html).toContain(row.tx.label);
    }
    expect(html).toContain("(opens in a new tab)");
  });

  it("offers the two closing links on main", () => {
    const links = hrefs(landing());
    expect(links).toContain(
      "https://github.com/probarion/probarion#how-to-evaluate-probarion-in-5-minutes",
    );
    expect(links).toContain(
      "https://github.com/probarion/probarion/blob/main/docs/specs/2026-10-21-probarion-design.md",
    );
    expect(links).toContain("#verify");
    expect(links).toContain("/console");
  });
});

describe("the beta strip", () => {
  it("says the three standing facts and the test network", () => {
    const out = visibleText(renderToStaticMarkup(createElement(BetaStrip, { network: "testnet" })));
    expect(out).toContain("Unaudited beta.");
    expect(out).toContain("Probarion holds no owner key");
    expect(out).toContain("Non-custodial");
    expect(out).toContain("Use small amounts.");
    expect(out).toContain("Runs on NEAR testnet with test tokens.");
  });

  it("does not say testnet when the build is mainnet", () => {
    const out = visibleText(renderToStaticMarkup(createElement(BetaStrip, { network: "mainnet" })));
    expect(out).not.toMatch(/testnet|test tokens/i);
    expect(out).toContain("Unaudited beta.");
    expect(out).toContain("Runs on NEAR mainnet.");
    expect(betaStrip("mainnet").where).toBe("Runs on NEAR mainnet.");
  });
});

describe("the header", () => {
  const html = renderToStaticMarkup(createElement(SiteHeader));

  it("offers the console and the built pages, and hides planned ones", () => {
    const links = hrefs(html);
    expect(links).toContain("/console");
    expect(links).toContain("/proof");
    expect(links).toContain(LINKS.github);
    for (const route of PLANNED_ROUTES) expect(links).not.toContain(route);
    expect(html).not.toContain("coming soon");
  });

  it("has a menu for phones that works with no JavaScript", () => {
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    const menu = html.slice(html.indexOf("<details"));
    const inMenu = hrefs(menu);
    for (const { href } of HEADER_ANCHORS) expect(inMenu).toContain(href);
    expect(inMenu).toContain("/proof");
    expect(inMenu).toContain("/console");
    expect(inMenu).toContain(LINKS.github);
  });
});

describe("the sign-in page", () => {
  it("names no wallet, because the list depends on the network", () => {
    // Read from the source: the page's sign-in button needs a mounted app router to render.
    const page = text(WEB, "src", "app", "login", "page.tsx").replace(/\s+/g, " ");
    expect(page).toContain("Pick your wallet from the list.");
    expect(page).toContain("it moves no funds and adds no keys");
    expect(page).not.toMatch(/\b(HOT|Meteor|Intear|near-connect)\b/);
  });
});

describe("robots and the sitemap", () => {
  it("allow the public pages and keep crawlers off the console and the API", () => {
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;
    expect(rule?.allow).toBe("/");
    expect(rule?.disallow).toEqual(["/console", "/api"]);
  });

  it("list the landing page and /proof, and nothing private or planned", () => {
    const paths = sitemap().map((e) => new URL(e.url).pathname);
    expect(paths).toContain("/");
    expect(paths).toContain("/proof");
    expect(paths.filter((p) => p.startsWith("/console") || p.startsWith("/api"))).toEqual([]);
    expect(paths.filter((p) => PLANNED_ROUTES.includes(p))).toEqual([]);
    expect(paths).toEqual(publicRoutes());
  });
});

describe("colours", () => {
  const css = text(WEB, "src", "app", "globals.css");
  const token = (name: string) => {
    const hex = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css)?.[1];
    if (hex === undefined) throw new Error(`token --color-${name} not found`);
    return hex;
  };
  const luminance = (hex: string) => {
    const channel = (at: number) => {
      const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  it("keep small text at WCAG AA on the surfaces it sits on", () => {
    const pairs: [string, string][] = [
      ["ink", "paper"],
      ["mute", "paper"],
      ["mute", "surface"],
      ["gold-small", "paper"],
      ["ok", "ok-bg"],
      ["ok", "surface"],
      ["bad", "bad-bg"],
      ["bad", "surface"],
      ["wait", "wait-bg"],
      ["plan", "plan-bg"],
      ["band-fg", "band"],
      ["band-mute", "band"],
      ["band-bad", "band-bad-bg"],
      ["band-bad", "band"],
      ["gold-light", "ink"],
    ];
    for (const [fg, bg] of pairs) {
      expect(contrast(token(fg), token(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("are read from tokens: the site's stylesheet and components hold no literal colour", () => {
    const module = text(WEB, "src", "components", "site", "site.module.css");
    expect(module.replace(/url\("data:[^"]*"\)/g, "")).not.toMatch(
      /#[0-9a-f]{3,8}\b|\brgba?\(\s*\d/i,
    );
  });
});
