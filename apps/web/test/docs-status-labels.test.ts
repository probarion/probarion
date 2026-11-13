// The docs' status words against the landing's board and the records behind it. A page leaves Preview only when a
// committed record shows its flow ran with real wallets; a page stays Preview while its own steps have not run as
// written. Each check below names the record it stands on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jsxNodes, parseMdx } from "@/lib/docs/mdast";
import { findPage, PAGES } from "@/lib/docs/registry";
import { docsStatusRows } from "@/lib/docs/status";
import { BOARD_GROUPS, BOARD_TX } from "@/lib/site/facts";
import { ROOT, readMdx } from "./docs-helpers";

const text = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
const blob = (path: string) => `https://github.com/probarion/probarion/blob/main/${path}`;

const MAINNET_VERIFY = "docs/evidence/mainnet-v0/s2-2026-11-13/verify-2026-11-13.txt";
const S1 = "docs/evidence/mainnet-v0/s1-2026-11-13/README.md";
const S2 = "docs/evidence/mainnet-v0/s2-2026-11-13/README.md";
const TRIAL = "docs/evidence/trial-vault/README.md";

const items = BOARD_GROUPS.flatMap((g) => g.items);
const item = (id: string) => items.find((i) => i.id === id);
const part = (id: string) => items.flatMap((i) => i.parts ?? []).find((p) => p.id === id);

describe("the docs' status words", () => {
  it("call the ledger Live, on the mainnet run that kept, anchored and verified one with the SDK", () => {
    expect(findPage("concepts/ledger-and-anchors")?.status).toBe("live");
    expect(item("sdk-and-cli")?.proof).toBe("verified");
    // The live verify after S2: 6 entries, 4 anchors, checks a to h pass and i is skipped.
    const verify = text(MAINNET_VERIFY);
    expect(verify).toContain("Probarion verify: v0.probarion.near (mainnet)");
    expect(verify).toContain("entries 6, anchors 4");
    expect(verify).toContain("8 passed, 0 failed, 0 unproven, 1 skipped");
    expect(verify).toContain("RESULT: PASS");
    // The kit ran the SDK of this repository, outside it, and signed the entries with the anchor-only ledger key.
    expect(text(S1)).toContain("runs the\nSDK of this repository");
    expect(text(S1)).toContain("runs the SDK's `Probarion.process()` with no proposer");
    const page = readMdx("concepts/ledger-and-anchors");
    for (const link of [blob(MAINNET_VERIFY), blob(S1), blob(S2)]) expect(page).toContain(link);
    expect(page).toContain("anchored them 4 times");
    expect(page).toContain(
      "A ledger kept by an agent of your own, outside the team's runs, is not recorded yet.",
    );
  });

  it("call holds and approvals Live, on the testnet runs that held, approved and rejected with a real wallet", () => {
    expect(findPage("concepts/holds-and-approvals")?.status).toBe("live");
    expect(part("web-console-payments")?.proof).toBe("verified");
    const trial = text(TRIAL);
    expect(trial).toContain("## 2026-11-12: Reject, revoke, a spare agent key and Withdraw all");
    expect(trial).toContain(BOARD_TX.trialApprove.hash);
    expect(trial).toContain(BOARD_TX.trialReject.hash);
    const page = readMdx("concepts/holds-and-approvals");
    expect(page).toContain(`${blob(TRIAL)}#the-run`);
    // What did not run stays said: no expiry, one person, nothing on mainnet.
    expect(page).toContain("No expiry has been recorded yet");
    expect(page).toContain("made by one person, in a desktop browser");
    expect(page).toContain("No hold or approval has run on mainnet yet.");
  });

  it("keep Preview where a page's own steps have not run as written", () => {
    for (const path of [
      "start/owner-quickstart",
      "start/developer-quickstart",
      "build/let-an-agent-pay",
    ])
      expect(findPage(path)?.status, path).toBe("preview");
    expect(readMdx("start/developer-quickstart")).toContain(
      "This script itself has not been run against a testnet vault",
    );
    expect(readMdx("build/let-an-agent-pay")).toContain(
      "no run of a loop that keeps paying, like this page's, is recorded",
    );
  });

  it("call the web console Live as its tried status row does, and name its two untried parts", () => {
    const rows = docsStatusRows();
    expect(rows.find((r) => r.id === "web-console")?.status).toBe("live");
    expect(rows.find((r) => r.id === "web-console-not-tried")?.status).toBe("preview");
    expect(part("web-console-set-up")?.proof).toBe("verified");
    expect(part("web-console-money")?.proof).toBe("verified");
    for (const path of [
      "start/what-is-probarion",
      "start/testnet-and-mainnet",
      "operate/architecture",
    ]) {
      const page = readMdx(path);
      expect(page, path).toMatch(/email alerts and the Base top-up/i);
    }
  });

  it("repeat none of the sentences that called a recorded flow unrun", () => {
    const retired = [
      "A ledger kept by an agent of your own with the SDK is not recorded yet, so this page is Preview.",
      "so this page is Preview.",
      "The smoke run proves the contract path, not the SDK's ledger on a live vault, which is Preview.",
      "No rules-only run of `process()` that pays",
      "The Keys tab is Preview",
      "Apart from Payables, the console and the parts behind it are Preview",
      "The web console is deployed there too, as Preview",
      "no run of a loop of your own like this page's is recorded",
      "no run of it there is recorded yet",
      "no run of that loop in an agent of your own is recorded",
      "their flows have not yet run end to end with real wallets",
      "The faucet is Preview",
      "The testnet faucet is Preview",
      "| [Test USDC on testnet](#test-usdc-on-testnet) | Preview |",
    ];
    const found: string[] = [];
    for (const p of PAGES) {
      const page = readMdx(p.path);
      for (const s of retired) if (page.includes(s)) found.push(`${p.path || "index"}: ${s}`);
    }
    expect(found).toEqual([]);
    // The faucet's run is the board's "Money in and out" evidence.
    expect(readMdx("start/what-works-today")).toContain(BOARD_TX.demoFaucet.hash);
  });
});

describe("the docs home's developer door", () => {
  const door = jsxNodes(parseMdx(readMdx(""))).find(
    (n) =>
      n.name === "Door" &&
      n.attributes.some((a) => "value" in a && a.value === "Developer quickstart"),
  );
  const attr = (name: string) => {
    const a = door?.attributes.find((x) => "name" in x && x.name === name);
    return a && "value" in a && typeof a.value === "string" ? a.value : undefined;
  };
  const body = readMdx("").split('go="Developer quickstart"')[1]?.split("</Door>")[0] ?? "";

  it("starts with the MCP demo, which needs no key, then the npm install", () => {
    const mcp = JSON.parse(text("packages", "mcp", "package.json")) as {
      name: string;
      version: string;
    };
    const demo = `\`npx -y ${mcp.name}@${mcp.version} demo\``;
    expect(body).toContain(demo);
    expect(body).toContain("`npm install @probarion/sdk @probarion/core`");
    expect(body.indexOf(demo)).toBeLessThan(body.indexOf("npm install"));
    // The demo is a subcommand of the package's own CLI, and its server runs with no key.
    expect(text("packages", "mcp", "src", "cli.ts")).toContain('case "demo":');
    expect(text("packages", "mcp", "src", "demo.ts")).toContain("with no key in its environment");
    expect(attr("alsoHref")).toBe("/docs/build/install#install-from-npm");
  });

  it("states no time that no timed run backs", () => {
    expect(attr("who")).toBe("Developer · No key to start");
    expect(attr("who")).not.toMatch(/\d+\s*(min|s)\b/);
  });
});
