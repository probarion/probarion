import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECRET_ENV_NAMES } from "@/lib/log";
import { COMPONENTS } from "@/lib/sentry-scrub";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const doc = readFileSync(join(ROOT, "docs", "ops", "MONITORING.md"), "utf8");

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
    for (const c of ["payables", "topup", "canary", "watcher", "alerts"])
      expect(used, c).toContain(c);
  });

  it("names the three health routes and the status page setting", () => {
    for (const route of ["/api/health", "/api/health/rpc", "/api/health/nearai"])
      expect(doc).toContain(route);
    expect(doc).toContain("pnpm proof set links.status_page");
  });
});
