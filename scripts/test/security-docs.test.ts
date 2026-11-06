import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string): string =>
  readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
const REPO = "https://github.com/probarion/probarion";
const DAY_MS = 86_400_000;

// Copied unchanged from apps/web/test/site-facts.test.ts:666. The bracket keeps the name out of the repository.
const OTHER_PROJECT: RegExp = /vest[i]arion/i;

/** RFC 9116 fields, in order: `Name: value`, one per line; `#` starts a comment. */
function fields(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([A-Za-z-]+): (.+)$/.exec(line);
    if (m === null) throw new Error(`not a field: ${line}`);
    out.push([m[1] ?? "", m[2] ?? ""]);
  }
  return out;
}
const values = (f: [string, string][], name: string): string[] =>
  f.filter(([k]) => k === name).map(([, v]) => v);

const SKIP = new Set(["node_modules", "target", "dist", ".next", "coverage"]);
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(rs|ts|tsx|sql)$/.test(name)) out.push(path);
  }
  return out;
}
/** Every claim id that has a `probarion-claim:` marker in the code or its tests. */
function claimMarkers(): Set<string> {
  const ids = new Set<string>();
  for (const base of ["contracts", "packages", "apps/web/src", "apps/web/test"]) {
    for (const file of walk(join(root, base))) {
      for (const m of readFileSync(file, "utf8").matchAll(/probarion-claim:\s*([A-Z0-9-]+)/g)) {
        ids.add(m[1] ?? "");
      }
    }
  }
  return ids;
}

describe("security.txt (RFC 9116)", () => {
  const raw = readFileSync(join(root, "apps/web/public/.well-known/security.txt"), "utf8");
  const f = fields(raw);

  it("is LF text with a final newline", () => {
    expect(raw).not.toContain("\r");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("names the X account first, and a mail contact only as security@probarion.xyz", () => {
    const contacts = values(f, "Contact");
    expect(contacts[0]).toBe("https://x.com/probarionhq");
    for (const c of contacts) expect(c).toMatch(/^(https:\/\/|mailto:)/);
    for (const c of contacts.filter((x) => x.startsWith("mailto:"))) {
      expect(c).toBe("mailto:security@probarion.xyz");
    }
  });

  it("expires once, between 30 and 366 days from now (renew it before this turns red)", () => {
    const expires = values(f, "Expires");
    expect(expires).toHaveLength(1);
    const days = (Date.parse(expires[0] ?? "") - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(30);
    expect(days).toBeLessThan(366);
  });

  it("names each address it is served from as canonical", () => {
    const canonical = values(f, "Canonical");
    for (const c of canonical) expect(c).toMatch(/^https:\/\/[^/]+\/\.well-known\/security\.txt$/);
    expect(canonical).toEqual(
      expect.arrayContaining([
        "https://probarion.xyz/.well-known/security.txt",
        "https://probarion.vercel.app/.well-known/security.txt",
      ]),
    );
  });

  it("points the policy and the acknowledgments at SECURITY.md", () => {
    expect(values(f, "Policy")).toEqual([`${REPO}/blob/main/SECURITY.md`]);
    expect(values(f, "Acknowledgments")).toEqual([`${REPO}/blob/main/SECURITY.md#acknowledgments`]);
    expect(values(f, "Preferred-Languages").length).toBeLessThanOrEqual(1);
  });
});

describe("SECURITY.md", () => {
  const md = read("SECURITY.md");

  it("keeps the beta sentence, the channels and the 72-hour target", () => {
    expect(md).toContain(
      "**Unaudited beta.** No third party has audited the contracts or the packages.",
    );
    expect(md).toContain("[@probarionhq](https://x.com/probarionhq)");
    expect(md).toContain("once private vulnerability reporting is switched on");
    expect(md).toContain("72 hours");
  });

  it("has the sections that other files link to", () => {
    for (const h of [
      "## Reporting a vulnerability",
      "## Safe harbor",
      "## The Canary",
      "## Practices",
      "## Threat model",
      "### What is not proven yet",
      "## Acknowledgments",
    ]) {
      expect(md.split("\n"), h).toContain(h);
    }
  });

  it("keeps the exact Practices line that plan 05 Task 18 replaces", () => {
    expect(md).toContain(
      "- No owner keys on servers. Agent keys are generated server-side, encrypted at rest with a master key held outside the database, and can call only `spend`.",
    );
  });

  it("claims nothing the repository does not do", () => {
    expect(md).not.toMatch(/keep what you extract/i);
    expect(md).not.toMatch(/bounty program/i);
    expect(md).not.toMatch(/dependency audit/i);
    expect(md).not.toContain("key sealing (in");
  });

  it("links the threat model and the severity levels", () => {
    expect(md).toContain("](docs/THREAT_MODEL.md)");
    expect(md).toContain("](docs/RUNBOOK.md#severity-levels)");
  });

  it("states the SEV2 target and sends third-party weaknesses to their vendor", () => {
    expect(md).toContain("14 days");
    for (const vendor of ["1Click", "Vercel", "Telegram", "Resend", "Supabase"])
      expect(md, vendor).toContain(vendor);
  });
});

describe("docs/THREAT_MODEL.md", () => {
  const md = read("docs/THREAT_MODEL.md");

  it("has the eleven attacks in order, and no twelfth", () => {
    const at = Array.from({ length: 11 }, (_, i) =>
      md.search(new RegExp(`^\\| ${i + 1} \\|`, "m")),
    );
    for (const [i, position] of at.entries()) expect(position, `row ${i + 1}`).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(md).not.toMatch(/^\| 12 \|/m);
    expect(md).toContain("RequiresOneYocto");
  });

  it("has the sections later tasks and the README read", () => {
    for (const h of [
      "Assets",
      "Attacks",
      "The hosted service",
      "Blast radius if Probarion is breached",
      "Failure modes",
      "Trust assumptions",
      "Known gaps",
      "Out of scope",
    ]) {
      expect(md.split("\n"), h).toContain(`## ${h}`);
    }
  });

  it("cites only claim ids that have a marker in the code", () => {
    const known = claimMarkers();
    const cited = [...md.matchAll(/claim `([A-Z0-9-]+)`/g)].map((m) => m[1] ?? "");
    expect(cited.length).toBeGreaterThan(10);
    expect(cited.filter((id) => !known.has(id))).toEqual([]);
  });

  it("cites the RUNBOOK heading of row 9, and the heading exists", () => {
    expect(md).toContain("](RUNBOOK.md#agent-keys-allowance-nearly-used-up)");
    expect(read("docs/RUNBOOK.md").split("\n")).toContain(
      "### Agent key's allowance nearly used up",
    );
  });

  it("links only files that exist", () => {
    const missing: string[] = [];
    for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1] ?? "";
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const file = target.split("#")[0] ?? "";
      if (!existsSync(resolve(root, "docs", file))) missing.push(target);
    }
    expect(missing).toEqual([]);
  });

  it("names none of the owner's other projects", () => {
    expect(md).not.toMatch(OTHER_PROJECT);
    expect(read("SECURITY.md")).not.toMatch(OTHER_PROJECT);
  });
});
