import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECRET_ENV_NAMES } from "@/lib/log";
import { COMPONENTS } from "@/lib/sentry-scrub";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const doc = readFileSync(join(ROOT, "docs", "ops", "MONITORING.md"), "utf8");

/** GitHub's anchor for a heading (as scripts/test/runbook.test.ts makes it): lower case, punctuation dropped. */
const slug = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");
const anchorsOf = (path: string): string[] =>
  [...readFileSync(path, "utf8").matchAll(/^#+ (.+)$/gm)].map((h) => slug(h[1] ?? ""));

describe("docs/ops/MONITORING.md", () => {
  it("lists every secret variable and field name for Sentry's data scrubber", () => {
    for (const name of SECRET_ENV_NAMES) expect(doc, name).toContain(`\`${name}\``);
    for (const field of [
      "agent_key",
      "secret",
      "invoice_text",
      "authorization",
      "cookie",
      "token",
    ]) {
      expect(doc, field).toContain(`\`${field}\``);
    }
  });

  it("describes the status page and its test alert", () => {
    expect(doc.split(/\r?\n/)).toContain("## Status page");
    expect(doc).toContain("Send test alert");
    expect(doc).toMatch(/testnet/);
  });

  it("filters alert rules only on component values the app sets, and covers the money path", () => {
    const used = [...doc.matchAll(/component:([a-z]+)/g)].map((m) => m[1] ?? "");
    const known: readonly string[] = COMPONENTS;
    expect(used.filter((c) => !known.includes(c))).toEqual([]);
    for (const c of ["payables", "topup", "canary", "watcher", "alerts", "extension"])
      expect(used, c).toContain(c);
  });

  it("names the three health routes and the status page setting", () => {
    for (const route of ["/api/health", "/api/health/rpc", "/api/health/nearai"])
      expect(doc).toContain(route);
    expect(doc).toContain("pnpm proof set links.status_page");
  });

  it("keeps the monitor numbers the judging-window checklist (plan 05 Task 17) refers to", () => {
    for (const row of [
      // Stage A: 3 is the testnet RPC provider 0, 4 is NEAR AI Cloud.
      "| 3 | NEAR RPC testnet, provider 0 | `https://probarion.xyz/api/health/rpc?provider=0` | 200 |",
      "| 4 | NEAR AI Cloud | `https://probarion.xyz/api/health/nearai` | 200 |",
      // Stage B: 5 and 6 are the mainnet RPC providers 0 and 1, 7 the testnet one.
      "| 5 | NEAR RPC mainnet, provider 0 | `https://probarion.xyz/api/health/rpc?provider=0` |",
      "| 6 | NEAR RPC mainnet, provider 1 | `https://probarion.xyz/api/health/rpc?provider=1` |",
      "| 7 | NEAR RPC testnet, provider 0 | `https://testnet.probarion.xyz/api/health/rpc?provider=0` |",
    ]) {
      expect(doc).toContain(row);
    }
  });

  it("links only files and headings that exist", () => {
    const broken: string[] = [];
    for (const m of doc.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1] ?? "";
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [file = "", anchor] = target.split("#");
      const path =
        file === "" ? join(ROOT, "docs", "ops", "MONITORING.md") : join(ROOT, "docs", "ops", file);
      if (!existsSync(path)) {
        broken.push(target);
        continue;
      }
      if (anchor !== undefined && path.endsWith(".md") && !anchorsOf(path).includes(anchor)) {
        broken.push(target);
      }
    }
    expect(broken).toEqual([]);
  });
});
