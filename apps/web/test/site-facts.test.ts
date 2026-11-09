// The public site's claims, held to the files they come from. If a contract, a README line or a planned page changes,
// the copy has to change with it: an AI judge and human judges check the site against the repository.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks, type Snapshot } from "@probarion/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { BetaStrip, BetaStripView } from "@/components/site/BetaStrip";
import { InkBand } from "@/components/site/InkBand";
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
  LIVE_CHECK,
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
import recordedJson from "@/lib/site/live-check-recorded.json";
import { ledgerRows, verifyTamper } from "@/lib/site/tamper";
import fixture from "@/lib/site/valid-snapshot.json";
import { directives, importsOf, resolveLocal, toPosix, walk } from "./deploy-scan";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "..", "..");
const bytes = (...p: string[]) => readFileSync(join(...p));
const text = (...p: string[]) => readFileSync(join(...p), "utf8");

const SRC = join(WEB, "src");
const README = text(ROOT, "README.md");
const SNAPSHOT = fixture as unknown as Snapshot;

/** The whole landing page as a visitor gets it, with the chrome the layout puts around it. */
const landing = (network: "testnet" | "mainnet" = "testnet") =>
  renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(BetaStripView, { network }),
      createElement(SiteHeader),
      createElement(Home),
      createElement(SiteFooter),
    ),
  );
/** A source file's imports without its dynamic import() calls, so a static import of the same module still shows. */
const staticImports = (src: string) => importsOf(src.replace(/\bimport\(\s*"[^"]+"\s*\)/g, "null"));

/**
 * What a client component loads on first paint: its static imports, followed through local files. A dynamic import()
 * is left out, because it loads on first use. Local files come back relative to src, and packages by name.
 */
function firstLoadOf(entry: string): string[] {
  const seen = new Set([entry]);
  const queue = [entry];
  const reached: string[] = [];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const { spec, typeOnly } of staticImports(readFileSync(file, "utf8"))) {
      if (typeOnly) continue;
      const target = resolveLocal(spec, file, SRC);
      if (target === null) reached.push(spec);
      else if (!seen.has(target)) {
        seen.add(target);
        reached.push(toPosix(relative(SRC, target)));
        if (/\.tsx?$/.test(target)) queue.push(target);
      }
    }
  }
  return reached;
}

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

  it("loads the verifier and the fixture on the first click, through dynamic imports", () => {
    const src = text(SRC, "components", "site", "TamperTest.tsx");
    const dynamic = [...src.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1] ?? "");
    expect(dynamic).toEqual(["@/lib/site/tamper", "@/lib/site/valid-snapshot.json"]);
    expect(src.startsWith('"use client"')).toBe(true);
  });

  it("keeps the verifier, the fixture and the wallet out of every client component's first load", () => {
    const heavy =
      /^@probarion\/|^lib\/site\/tamper\.ts$|valid-snapshot|^lib\/config|^components\/ui|^@hot-labs\/|^components\/wallet/;
    const clients = walk(join(SRC, "components", "site")).filter(
      (f) => /\.tsx?$/.test(f) && directives(readFileSync(f, "utf8")).includes("use client"),
    );
    expect(clients.map((f) => f.split(/[\\/]/).pop())).toContain("TamperTest.tsx");
    for (const entry of clients) {
      expect(
        firstLoadOf(entry).filter((m) => heavy.test(m)),
        entry,
      ).toEqual([]);
    }
    // The walk does follow local files: the panel's view logic is reached through TamperTest.
    const panel = firstLoadOf(join(SRC, "components", "site", "TamperTest.tsx"));
    expect(panel).toContain("lib/site/tamper-view.ts");
  });

  it("sees a static import of a module that is also imported dynamically", () => {
    const src = 'import "@/lib/site/tamper";\nconst later = () => import("@/lib/other");\n';
    expect(staticImports(src).map((i) => i.spec)).toEqual(["@/lib/site/tamper"]);
  });
});

// Offline, the verifier checks a file against itself: the chain data comes from the same file, so a forged file with
// re-signed entries passes. Only a live run reads the chain, so no copy may say that a file proves anything by itself.
describe("what an offline run shows", () => {
  const sentences = (copy: string) => copy.split(/(?<=[.!?])\s+/);

  it("reads a claim one sentence at a time", () => {
    expect(sentences("Verify it offline. Then read a snapshot!")).toEqual([
      "Verify it offline.",
      "Then read a snapshot!",
    ]);
  });

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

  it("warns under the closing headline that a live run on the testnet vault fails today", () => {
    expect(CLOSING.live).toBe(
      "A live run reads the chain itself: `verify --vault`. On the testnet vault it fails checks d and h today, because the smoke run sent its spends without a ledger.",
    );
    expect(CHECK_LABELS.d).toBe("A decision for every spend");
    expect(CHECK_LABELS.h).toBe("Burn memos");
    expect(visibleText(landing())).toContain("it fails checks d and h today");
  });

  it("does not say on-chain in the step that describes a snapshot", () => {
    const body = JOURNEY.steps[4].body;
    expect(body).toContain("snapshot");
    expect(body).not.toMatch(/on[- ]chain/i);
    expect(sentences(body)).toEqual([
      "The SDK anchors the ledger root on the vault.",
      "The verifier ties each spend in a snapshot to exactly one decision, with no server and no account.",
      "Offline, those spends come from the file.",
      "A live run reads them from the chain.",
    ]);
  });

  it("promises only what needs no account today", () => {
    expect(HERO.fineprint).toBe(
      "Testnet today, mainnet planned. You need no account to read the chain or run the verifier.",
    );
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

  it("link to the testnet explorer, whatever network the page is opened at", () => {
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

  it("makes the ink band the target of /#payee, which the Canary page links to", () => {
    const band = renderToStaticMarkup(createElement(InkBand));
    expect(band).toMatch(/^<section[^>]*\sid="payee"/);
    expect([...band.matchAll(/\sid="payee"/g)]).toHaveLength(1);
    expect(band).toContain(BAND.gone);
    // The landing page has no other element with that id.
    expect([...landing().matchAll(/\sid="payee"/g)]).toHaveLength(1);
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

describe("facts the site shares with the README, SECURITY.md and the deployment record", () => {
  const prose = README.replace(/\s+/g, " ");
  const deployment = JSON.parse(text(ROOT, "contracts", "deployments", "testnet.json")) as {
    vault_v0: { locked: boolean };
  };
  const number = (name: string) => NUMBERS.find((n) => n.name === name)?.value;
  const step4 = JOURNEY.steps[3].panel;
  const entry = (key: string) => step4.find((line) => "key" in line && line.key === key);

  it("the smoke run's date", () => {
    const date = /on (\d{4}-\d{2}-\d{2})\./.exec(CHAIN.intro)?.[1];
    expect(README).toContain(`### NEAR testnet, ${date}`);
  });

  it("what the paid transaction paid, and to whom", () => {
    expect(README).toContain(`Spend 1 \`paid\`: ${HERO.paid.big} to \`${HERO.paid.payee}\``);
    expect(CHAIN.rows[0].body).toContain(`${HERO.paid.big} to \`${HERO.paid.payee}\``);
    expect(JOURNEY.steps[0].panel).toContainEqual({ key: "payee", value: HERO.paid.payee });
  });

  it("the paid transaction's events", () => {
    const named = CHAIN.rows[0].body.slice(CHAIN.rows[0].body.indexOf("Events"));
    const events = [...named.matchAll(/`(\w+)`/g)].map((m) => m[1] ?? "");
    expect(events).toContain(HERO.paid.event);
    expect(README).toContain(`(${events.map((e) => `\`${e}\``).join(", ")})`);
  });

  it("what the vault answers for each amount, on the limit the mandate has", () => {
    expect(entry("2 USDC")).toMatchObject({ value: "ok: true" });
    expect(README).toContain("2 USDC: { ok: true");
    expect(entry("6 USDC")).toMatchObject({ value: `ok: false, ${CONTRACT_REFUSAL_CODE}` });
    expect(README).toContain(`6 USDC: { ok: false, code: '${CONTRACT_REFUSAL_CODE}'`);
    const limit = /at most (\d+) USDC/.exec(JSON.stringify(step4))?.[1];
    expect(README).toContain(
      `mandate 1 "smoke near": active, pays ${HERO.paid.payee}, at most ${Number(limit) * 1_000_000} per payment`,
    );
  });

  it("the numbers band", () => {
    expect(number("checks")).toBe(String(Object.keys(CHECK_LABELS).length));
    expect(number("full-access keys")).toBe("0");
    expect(deployment.vault_v0.locked).toBe(true);
    expect(README).toContain("No full-access key");
    expect(number("method")).toBe("1");
    expect(prose).toContain("one function-call key that can call `spend` and nothing else");
    expect(number("recipient arguments")).toBe("0");
  });

  it("the fields of the contract's own SpendRequest, none of them a recipient", () => {
    const types = text(ROOT, "contracts", "vault", "src", "types.rs");
    const body = /pub struct SpendRequest \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? "";
    const fields = [...body.matchAll(/pub (?:r#)?(\w+):/g)].map((m) => m[1] ?? "");
    expect(fields).toEqual([...SPEND_REQUEST_FIELDS]);
  });

  it("that the model run is still in progress", () => {
    expect(JOURNEY.steps[1].tag).toBe("Adapter built. First live attested run in progress.");
    const row = README.split("\n").find((l) => l.startsWith("| NEAR AI Cloud adapter"));
    expect(row).toContain("**Built**");
    expect(row).toContain("**In progress**");
  });

  it("that no third party has audited the code", () => {
    expect(text(ROOT, "SECURITY.md")).toContain(
      "**Unaudited beta.** No third party has audited the contracts or the packages.",
    );
    expect(README).toContain("**Unaudited beta.** No third party has audited this code.");
  });

  it("the code the contract refused with", () => {
    expect(HERO.refused.code.join("")).toBe("PROBARION:NoMandate");
    expect(CHAIN.rows[2].body).toContain("`PROBARION:NoMandate`");
    expect(README).toContain("PROBARION:NoMandate");
  });

  it("what the smoke run was, and that mainnet is still planned", () => {
    expect(CHAIN.intro).toContain("no ledger");
    expect(HERO.note).toContain("test tokens");
    expect(HERO.fineprint).toContain("mainnet planned");
  });

  it("the license", () => {
    expect(FOOTER.note).toContain("MIT");
    expect(text(ROOT, "LICENSE").startsWith("MIT License")).toBe(true);
  });

  // Each row of the site's status list, with the README Status rows it stands for and the words that make the pill true.
  const statusRows = [
    {
      row: "Vault contract",
      pill: "On testnet",
      readme: [{ start: "Vault contract", says: ["**Shipped on NEAR testnet**"] }],
    },
    {
      row: "Offline verifier, checks a to i",
      pill: "Shipped in source",
      readme: [
        { start: "`@probarion/core`", says: ["**Shipped** in source"] },
        { start: "CLI `check`, `verify`", says: ["**Shipped** in source"] },
      ],
    },
    {
      row: "Reproducible builds",
      pill: "Shipped",
      readme: [{ start: "Reproducible builds", says: ["**Shipped**"] }],
    },
    {
      row: "Web console",
      pill: "In progress",
      readme: [{ start: "Web console", says: ["**In progress**"] }],
    },
    {
      row: "Public proof page",
      pill: "Built, no public vault yet",
      readme: [{ start: "Public `/proof/<vault>` page", says: ["**Built**"] }],
    },
    {
      row: "Payables agent",
      pill: "In progress",
      readme: [{ start: "Payables, the reference agent", says: ["**In progress**"] }],
    },
    {
      row: "Live attested model run",
      pill: "In progress",
      readme: [{ start: "NEAR AI Cloud adapter", says: ["**In progress**"] }],
    },
    {
      row: "MCP server",
      pill: "Planned",
      readme: [{ start: "MCP server", says: ["**Planned**"] }],
    },
    {
      row: "Vault factory",
      pill: "On testnet",
      readme: [{ start: "Factory contract", says: ["**Shipped on NEAR testnet**"] }],
    },
    {
      row: "Canary public challenge",
      pill: "Page built, not open yet",
      readme: [
        {
          start: "Canary, a public vault",
          says: ["**In progress**", "does not pay from its own cycle", "It is not open yet"],
        },
      ],
    },
    {
      row: "Mainnet vault",
      pill: "Planned",
      readme: [{ start: "Mainnet vault", says: ["**Planned**"] }],
    },
    {
      row: "TypeScript SDK and CLI",
      pill: "In source, not on npm",
      readme: [
        { start: "`@probarion/sdk`", says: ["**Shipped** in source"] },
        { start: "`probarion` CLI", says: ["**Shipped** in source"] },
        { start: "npm release 0.1.0", says: ["**Planned**", "nothing is published"] },
      ],
    },
  ];

  it("holds every row of the status list to the README", () => {
    expect(statusRows.map(({ row }) => row).sort()).toEqual(
      STATUS.rows.map(({ row }) => row).sort(),
    );
  });

  it.each(statusRows)("the status row $row matches the README", ({ row, pill, readme }) => {
    expect(STATUS.rows.find((r) => r.row === row)?.pill).toBe(pill);
    for (const { start, says } of readme) {
      const line = README.split("\n").find((l) => l.startsWith(`| ${start}`));
      expect(line, start).toBeDefined();
      const status = line?.split(" | ")[1];
      for (const words of says) expect(status, start).toContain(words);
    }
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
      { row: "Vault factory", pill: "On testnet", tone: "live" },
      { row: "Web console", pill: "In progress", tone: "work" },
      { row: "Public proof page", pill: "Built, no public vault yet", tone: "work" },
      { row: "TypeScript SDK and CLI", pill: "In source, not on npm", tone: "work" },
      { row: "Payables agent", pill: "In progress", tone: "work" },
      { row: "Live attested model run", pill: "In progress", tone: "work" },
      { row: "Canary public challenge", pill: "Page built, not open yet", tone: "work" },
      { row: "MCP server", pill: "Planned", tone: "plan" },
      { row: "Mainnet vault", pill: "Planned", tone: "plan" },
    ]);
  });

  it("says v0 runs an older build, and the factory's vaults run the fixed build on record", () => {
    expect(STATUS.build).toBe(
      "`v0.probarion.testnet` runs a build older than the current source; the vaults the testnet factory creates run the fixed build recorded in `contracts/code-hashes.json`.",
    );
    const prose = README.replace(/\s+/g, " ");
    expect(prose).toContain("`v0.probarion.testnet` runs the earlier build");
    const hashes = JSON.parse(text(ROOT, "contracts", "code-hashes.json")) as {
      entries: { code_hash: string }[];
    };
    const fixed = /code hash `(3cQXYDvf[1-9A-HJ-NP-Za-km-z]+)`/.exec(prose)?.[1];
    expect(hashes.entries.map((e) => e.code_hash)).toContain(fixed);
    const record = JSON.parse(text(ROOT, "contracts", "deployments", "testnet.json")) as {
      factory: { code_hash: string; versions: { code_hash: string }[] };
    };
    expect(record.factory.versions.map((v) => v.code_hash)).toEqual([fixed]);
    expect(hashes.entries.map((e) => e.code_hash)).toContain(record.factory.code_hash);
    expect(prose).toContain(`Code hash \`${record.factory.code_hash}\``);
    expect(visibleText(landing())).toContain("runs a build older than the current source");
  });

  it("says no third party has audited this code and links SECURITY.md", () => {
    const html = landing();
    expect(visibleText(html)).toContain("No third party has audited this code. Read the");
    expect(hrefs(html)).toContain(LINKS.security);
    expect(LINKS.security.endsWith("/SECURITY.md")).toBe(true);
  });
});

describe("the live check", () => {
  const errors = text(ROOT, "contracts", "vault", "src", "errors.rs");
  const all = /pub const ALL: \[ErrorCode; \d+\] = \[([\s\S]*?)\];/.exec(errors)?.[1] ?? "";
  const codes = [...all.matchAll(/ErrorCode::(\w+)/g)].map((m) => m[1] ?? "");

  it("has one plain sentence for every error code the contract has", () => {
    expect(codes.length).toBe(24);
    expect(Object.keys(LIVE_CHECK.codes).sort()).toEqual([...codes].sort());
  });

  it("is a section of the landing page, reached at #try, with an eyebrow, a title and a live region", () => {
    const html = renderToStaticMarkup(createElement(Home));
    expect(html).toContain('id="try"');
    const out = visibleText(html);
    expect(out).toContain(LIVE_CHECK.title);
    expect(out).toContain("No wallet or account needed");
    expect(html).toContain("The contract&#x27;s answer");
    // The live region holds the verdict and its sentence only, not the request preview that changes on every key.
    const answer = html.slice(html.indexOf("The contract&#x27;s answer"));
    const region = /<div[^>]*aria-live="polite"[^>]*>([\s\S]*?)<\/div>/.exec(answer)?.[1] ?? "";
    expect(visibleText(region)).toContain("Would pay");
    expect(region).not.toContain("check_spend(");
  });

  it("has its own title for a text that is not an amount, apart from the no-answer title", () => {
    expect(LIVE_CHECK.copy.notAmountTitle).toBe("Not an amount");
    expect(LIVE_CHECK.copy.notAmountTitle).not.toBe(LIVE_CHECK.copy.noAnswer);
  });

  it("is complete with no JavaScript: each scenario with its recorded answer and the date", () => {
    const out = visibleText(renderToStaticMarkup(createElement(Home)));
    const recorded = recordedJson as { recordedAt: string };
    expect(out).toContain(recorded.recordedAt.slice(0, 10));
    for (const x of LIVE_CHECK.scenarios) expect(out).toContain(x.title);
    for (const word of ["Would pay", "OverPerPayment", "NoMandate", "NotAgent"]) {
      expect(out).toContain(word);
    }
  });

  it("names the vault and the method it asks, and says nothing is signed or paid", () => {
    expect(LIVE_CHECK.copy.method).toContain("`check_spend`");
    expect(LIVE_CHECK.copy.method).toContain("nothing is signed and nothing is paid");
    const views = text(ROOT, "contracts", "vault", "src", "checks.rs");
    expect(views).toContain(
      "pub fn check_spend(&self, request: SpendRequest, signer_pk: PublicKey)",
    );
  });

  it("puts the address of the hijacked prompt nowhere in the request", () => {
    const hijack = LIVE_CHECK.scenarios.find((x) => x.id === "hijack");
    expect(hijack && "injected" in hijack ? hijack.injected : "").toContain("attacker.near");
    expect(JSON.stringify(SPEND_REQUEST_FIELDS)).not.toContain("attacker");
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
    for (const { label } of named) expect(out, label).toContain(`${label} (coming soon)`);
  });

  it("leaves no route out of the footer that it does not cover some other way", () => {
    const out = visibleText(landing());
    // /canary is built, so the footer links it as a page and does not call it coming soon.
    expect(out).not.toContain("Canary (coming soon)");
    expect(hrefs(landing())).toContain("/canary");
    // /usage is built too, and the old planned name /open is gone.
    expect(out).not.toContain("Usage (coming soon)");
    expect(out).not.toContain("Open metrics");
    expect(hrefs(landing())).toContain("/usage");
    expect(hrefs(landing())).not.toContain("/open");
    expect(out).not.toContain("coming soon");
    expect(hrefs(landing())).toEqual(
      expect.arrayContaining(["/security", "/status", "/terms", "/privacy"]),
    );
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
    const out = visibleText(
      renderToStaticMarkup(createElement(BetaStripView, { network: "testnet" })),
    );
    expect(out).toContain("Unaudited beta.");
    expect(out).toContain("Probarion holds no owner key");
    expect(out).toContain("Non-custodial");
    expect(out).toContain("Use small amounts.");
    expect(out).toContain("Runs on NEAR testnet with test tokens.");
  });

  it("does not say testnet when the build is mainnet", () => {
    const out = visibleText(
      renderToStaticMarkup(createElement(BetaStripView, { network: "mainnet" })),
    );
    expect(out).not.toMatch(/testnet|test tokens/i);
    expect(out).toContain("Unaudited beta.");
    expect(out).toContain("Runs on NEAR mainnet.");
    expect(betaStrip("mainnet").where).toBe("Runs on NEAR mainnet.");
  });
});

describe("the beta strip, before the browser has told it the network", () => {
  // The pages are static: the strip cannot know which address it is served at until it runs in the browser, so what the
  // server renders (and what hydration meets) is only what is true on both networks (W-NET-R6).
  it("says the standing facts and no network at all in the server render", () => {
    const out = visibleText(renderToStaticMarkup(createElement(BetaStrip)));
    expect(out).toContain("Unaudited beta.");
    expect(out).toContain("No third party has audited this code.");
    expect(out).toContain("Probarion holds no owner key");
    expect(out).toContain("Use small amounts.");
    expect(out).not.toMatch(/testnet|mainnet|test tokens|Runs on/i);
  });

  it("is the same markup as the view with no network", () => {
    expect(renderToStaticMarkup(createElement(BetaStrip))).toBe(
      renderToStaticMarkup(createElement(BetaStripView, { network: null })),
    );
  });

  it("adds the network sentence of the network it is told, and no other", () => {
    for (const [network, says, not] of [
      ["testnet", "Runs on NEAR testnet with test tokens.", /mainnet/i],
      ["mainnet", "Runs on NEAR mainnet.", /testnet|test tokens/i],
    ] as const) {
      const out = visibleText(renderToStaticMarkup(createElement(BetaStripView, { network })));
      expect(out, network).toContain(says);
      expect(out, network).not.toMatch(not);
    }
  });

  it("has no network sentence in the neutral copy", () => {
    expect(betaStrip(null).where).toBeNull();
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

  it("renders no network switch on the server: it appears after mount, and only when the other network is served", () => {
    expect(html).not.toContain('aria-label="Network"');
    expect(html).not.toContain("Network:");
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

describe("the root layout", () => {
  const layout = text(SRC, "app", "layout.tsx");

  it("puts the beta strip, the header and the footer on every page", () => {
    for (const part of ["BetaStrip", "SiteHeader", "SiteFooter"]) {
      expect(importsOf(layout).map((i) => i.spec)).toContain(`@/components/site/${part}`);
      expect(layout).toContain(`<${part}`);
    }
    expect(layout.indexOf("<BetaStrip")).toBeLessThan(layout.indexOf("<main"));
    expect(layout.indexOf("<SiteFooter")).toBeGreaterThan(layout.indexOf("</main>"));
  });

  it("loads every mono weight the console's headings ask for", () => {
    const mono = layout.slice(layout.indexOf("IBM_Plex_Mono({"));
    expect(mono).toContain('weight: ["400", "500", "600"]');
  });
});

describe("the chrome's landmarks and headings", () => {
  it("puts the beta strip in a landmark", () => {
    const html = renderToStaticMarkup(createElement(BetaStripView, { network: "testnet" }));
    expect(html).toMatch(/^<aside [^>]*aria-label="Beta notice"/);
  });

  it("does not skip a heading level in the footer, on a page with no h2 of its own", () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    expect(html).toContain("<h2>Product</h2>");
    expect(html).not.toContain("<h3");
  });

  it("leaves a scroll panel a tab stop with no JavaScript", () => {
    const html = renderToStaticMarkup(createElement(Home));
    expect(html).toMatch(/<section [^>]*aria-label="The SpendRequest fields" tabindex="0"/);
  });

  it("wraps a 64-character account in the console's signed-in row", () => {
    const row = text(SRC, "app", "console", "layout.tsx");
    expect(row).toContain('<span className="min-w-0">');
    expect(row).toContain('<span className="mono wrap-anywhere">{session.accountId}</span>');
  });

  it("keeps Sign out on one line beside a 64-character account, with a gap between them", () => {
    const row = text(SRC, "app", "console", "layout.tsx");
    expect(row).toMatch(/className="[^"]*\bflex\b[^"]*\bgap-3\b[^"]*"/);
    expect(row).toMatch(
      /<span className="shrink-0 whitespace-nowrap">\s*<SignOutButton \/>\s*<\/span>/,
    );
    expect(row).toContain('<Link href="/extension"');
  });
});

describe("the proof routes' width", () => {
  const proof = (...p: string[]) => join(SRC, "app", "proof", ...p);

  it("gives /proof the header's wrap, so their left edges line up", () => {
    expect(readFileSync(proof("page.tsx"), "utf8")).toContain("s.wrap");
    expect(existsSync(proof("layout.tsx"))).toBe(false);
  });

  it("keeps a vault's own page in the narrower container", () => {
    expect(readFileSync(proof("[vault]", "layout.tsx"), "utf8")).toContain("<Container>");
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

  it("leaves with a full page load after sign-in, because a prefetched redirect makes router.push a no-op", () => {
    const source = text(WEB, "src", "components", "wallet", "SignInButton.tsx");
    const signIn = source.slice(
      source.indexOf("export function SignInButton"),
      source.indexOf("export function SignOutButton"),
    );
    expect(signIn).toContain("window.location.assign(next);");
    expect(signIn).not.toContain("useRouter()");
  });

  it("stays busy after a successful sign-in, so a second click cannot ask the wallet to sign again", () => {
    const source = text(WEB, "src", "components", "wallet", "SignInButton.tsx");
    const signIn = source.slice(
      source.indexOf("export function SignInButton"),
      source.indexOf("export function SignOutButton"),
    );
    expect(signIn).not.toContain("finally");
    expect(signIn.indexOf("setBusy(false)")).toBeGreaterThan(signIn.indexOf("catch (e)"));
  });

  it("shows a sign-out error out of the row's flow, so a long account keeps its width", () => {
    const source = text(WEB, "src", "components", "wallet", "SignInButton.tsx");
    const signOut = source.slice(source.indexOf("export function SignOutButton"));
    expect(signOut).toContain('<span className="relative">');
    expect(signOut).toContain("absolute top-full right-0");
    expect(signOut).toContain("whitespace-normal");
  });

  it("keeps the verify flag on one line in the closing", () => {
    expect(text(WEB, "src", "components", "site", "site.module.css")).toMatch(
      /\.closeNote code \{\s*white-space: nowrap;/,
    );
  });

  it("takes where to go after sign-in only from the server's safeNext", () => {
    const page = text(WEB, "src", "app", "login", "page.tsx");
    expect(page).toContain("<SignInButton next={safeNext} />");
    expect(page).toContain('next.startsWith("/console") ? next : "/console"');
    expect(page).toContain("const safeNext = extensionNextPath(next) ?? consoleNext;");
  });

  it("says on the Browser extension page that the extension is not released yet", () => {
    const page = text(WEB, "src", "app", "extension", "page.tsx");
    expect(page).toMatch(
      /<Notice tone="info">\s*The Probarion extension for Chrome is not released yet\.\s*<\/Notice>/,
    );
    // Its intro puts what the extension does in the future tense, as /privacy does.
    const words = page.replace(/\s+/g, " ");
    expect(words).toContain(
      "The extension will send invoices to wait for your confirmation and show what waits for you, but it can't pay or approve: an invoice it sends will be paid only after you confirm it in the console with your wallet.",
    );
    expect(words).not.toContain("The extension sends invoices");
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
    expect(paths).toContain("/usage");
    expect(paths.filter((p) => p.startsWith("/console") || p.startsWith("/api"))).toEqual([]);
    expect(paths.filter((p) => PLANNED_ROUTES.includes(p))).toEqual([]);
    expect(paths).toEqual(publicRoutes());
  });
});

describe("the stylesheet", () => {
  const globals = text(WEB, "src", "app", "globals.css");
  const site = text(WEB, "src", "components", "site", "site.module.css");
  const rule = (selector: string) => {
    const at = site.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return site.slice(at, site.indexOf("}", at));
  };

  it("clears the sticky header at every jump target, once", () => {
    expect(globals).toMatch(/html {[^}]*scroll-padding-top: 84px/);
    expect(site).not.toContain("scroll-margin-top");
  });

  it("marks a pressed button without taking the outline the focus ring draws", () => {
    const pressed = rule('.act[aria-pressed="true"]');
    expect(pressed).toContain("box-shadow: 0 0 0 2px var(--color-bad)");
    expect(pressed).not.toContain("outline");
  });

  it("holds buttons still on hover when reduced motion is asked for", () => {
    const reduce = site.slice(site.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduce).toMatch(/\.btn:hover,\s*\.act:hover {\s*transform: none;/);
  });

  it("gives the only public input a readable placeholder and a size phones do not zoom", () => {
    expect(rule(".accountInput")).toContain("font-size: 16px");
    expect(rule(".accountInput::placeholder")).toContain("color: var(--color-mute)");
  });

  it("keeps the word erased off the struck-through line on phones", () => {
    const phone = site.slice(site.indexOf("@media (max-width: 620px)"));
    expect(phone).toMatch(/\.rowNote {[^}]*display: inline-block;[^}]*width: 100%/);
  });

  it("lets the left card of the ledger test end where its table ends, not at the verdict's height", () => {
    expect(rule(".tamper > .sheet:first-child")).toContain("align-self: start");
  });

  it("keeps two lines free for the status line on phones, so the buttons below it hold still", () => {
    const phone = site.slice(site.indexOf("@media (max-width: 620px)"));
    expect(phone).toMatch(/\.sheetHead > span:last-child {[^}]*min-height: 3\.1em/);
  });

  it("stacks the status line under the title on the narrowest two-column cards, so a long one does not move the buttons", () => {
    const block = "@media (min-width: 961px) and (max-width: 1100px)";
    const narrow = site.slice(site.indexOf(block) + block.length);
    expect(narrow).toMatch(/^[^@]*\.sheetHead {[^}]*flex-direction: column/);
  });

  it("folds the header into the menu at 1100 px, and only the header", () => {
    expect(site).not.toContain("@media (max-width: 1040px)");
    const fold = site.slice(site.indexOf("@media (max-width: 1100px)"));
    const block = fold.slice(0, fold.indexOf("@media (max-width: 960px)"));
    expect(block).toContain(".navLinks");
    expect(block).toContain(".phoneMenu");
    expect(block).not.toContain(".heroGrid");
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

  it("keep the gold headline at 3:1 on paper, all along its gradient", () => {
    const gradient = /--gradient-gold-text:\s*linear-gradient\(([^;]+)\);/.exec(css)?.[1] ?? "";
    const stops = [...gradient.matchAll(/(#[0-9a-f]{6})\s+(\d+)%/gi)].map((m) => m[1] ?? "");
    expect(stops.length).toBeGreaterThan(1);
    const channels = (hex: string) =>
      [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    const mix = (a: string, b: string, t: number) => {
      const [from, to] = [channels(a), channels(b)];
      const part = from.map((c, i) => Math.round(c + ((to[i] ?? c) - c) * t));
      return `#${part.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    };
    for (const [i, stop] of stops.slice(1).entries()) {
      for (let t = 0; t <= 1; t += 0.01) {
        const colour = mix(stops[i] ?? stop, stop, t);
        expect(contrast(colour, token("paper")), colour).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("are read from tokens: site.module.css holds no literal colour", () => {
    const module = text(WEB, "src", "components", "site", "site.module.css");
    expect(module.replace(/url\("data:[^"]*"\)/g, "")).not.toMatch(
      /#[0-9a-f]{3,8}\b|\brgba?\(\s*\d/i,
    );
  });
});
