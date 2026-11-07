import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_NAMES, VAULT_ERROR_CODES } from "@probarion/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentRules } from "@/components/docs/AgentRules";
import { NetworkChip, StatusChip } from "@/components/docs/chips";
import { ErrorCatalog } from "@/components/docs/ErrorCatalog";
import { SpendChecks } from "@/components/docs/SpendChecks";
import { StatusTable } from "@/components/docs/StatusTable";
import { VerifierChecks } from "@/components/docs/VerifierChecks";
import { AGENT_RULES } from "@/lib/docs/agents";
import { HTTP_ERRORS, SDK_ERRORS, VAULT_ERRORS } from "@/lib/docs/errors";
import { SPEND_CHECKS } from "@/lib/docs/spend-checks";
import { docsStatusRows } from "@/lib/docs/status";
import { FEATURE_STATUSES } from "@/lib/docs/types";
import { checkAnchor, selectChecks, VERIFIER_DOCS } from "@/lib/docs/verifier";
import { CHECK_LABELS, STATUS } from "@/lib/site/facts";
import { ROOT, WEB, walkFiles } from "./docs-helpers";

const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("the spend checks", () => {
  it("are the codes of the contract's evaluate, in the order they first appear", () => {
    const rs = read("contracts", "vault", "src", "checks.rs");
    const start = rs.indexOf("pub fn evaluate(");
    expect(start).toBeGreaterThan(-1);
    const body = rs.slice(start, rs.indexOf("Ok(Approved", start));
    const order = [...new Set([...body.matchAll(/ErrorCode::([A-Za-z]+)/g)].map((m) => m[1]))];
    expect(order).toHaveLength(14);
    expect(SPEND_CHECKS.map((c) => c.code)).toEqual(order);
    for (const c of SPEND_CHECKS) expect(c.question.endsWith("?"), c.code).toBe(true);
  });
});

describe("the vault error codes", () => {
  it("explain every code, in the order of VAULT_ERROR_CODES, and nothing else", () => {
    expect(Object.keys(VAULT_ERRORS)).toEqual([...VAULT_ERROR_CODES]);
    for (const code of VAULT_ERROR_CODES) {
      const e = VAULT_ERRORS[code];
      for (const field of [e.meaning, e.raisedBy, e.next]) expect(field.trim(), code).not.toBe("");
    }
  });

  it("are the same list, in the same order, as the contract's ErrorCode enum", () => {
    const rs = read("contracts", "vault", "src", "errors.rs");
    const block = /pub enum ErrorCode\s*\{([\s\S]*?)\}/.exec(rs)?.[1] ?? "";
    const variants = [...block.matchAll(/^\s*([A-Z][A-Za-z]+)\s*,/gm)].map((m) => m[1]);
    expect(variants).toEqual([...VAULT_ERROR_CODES]);
  });
});

describe("the SDK error classes", () => {
  // testing/ holds the test doubles (FakePanic, FakeRawPanic, FakeVmError, FakeRpcFault), which are
  // not SDK errors. walkFiles returns backslash paths on Windows, hence [\\/].
  const sources = walkFiles(join(ROOT, "packages", "sdk", "src"), ".ts")
    .filter((f) => !f.endsWith(".test.ts") && !/[\\/]testing[\\/]/.test(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  it("document every exported error class, with its parent", () => {
    const found = [...sources.matchAll(/export class (\w+) extends (\w+)/g)]
      .map((m) => `${m[1]} < ${m[2]}`)
      .sort();
    expect(SDK_ERRORS.map((e) => `${e.name} < ${e.parent}`).sort()).toEqual(found);
  });

  it("name only codes the SDK source passes to a constructor or to super", () => {
    for (const e of SDK_ERRORS) expect(sources, e.name).toMatch(new RegExp(`[,(]\\s*"${e.code}"`));
  });
});

describe("the HTTP error codes", () => {
  // The (status, code) pairs the scan below cannot see. Each one names the file under apps/web/src
  // that holds its code, and the test reads that file only, so a code renamed there fails it.
  // api/auth/verify returns problem(401, result.reason) (reasons in lib/auth/verify.ts).
  // api/canary/attempt returns problem(STATUS[r.reason], r.reason) (reasons in
  // lib/canary/service.ts; its 502 failed is the same pair as the invoices route's json() answer).
  // The console invoices route sends `duplicate` and `failed` through json(). Pairs the scan
  // already finds (401 challenge_missing_or_expired, 400 empty, 409 busy, 429 budget,
  // 503 not_ready) are not listed here.
  const EXTRA_HTTP: readonly (readonly [number, string, string])[] = [
    [400, "too_long", "lib/canary/service.ts"],
    [401, "bad_signature", "lib/auth/verify.ts"],
    [401, "invalid_input", "lib/auth/verify.ts"],
    [409, "duplicate", "app/api/console/[vault]/invoices/route.ts"],
    [502, "failed", "app/api/console/[vault]/invoices/route.ts"],
    [503, "closed", "lib/canary/service.ts"],
  ];

  it("are every (status, code) pair the web app returns, and nothing else", () => {
    // lib/docs is the docs data itself, which names every code, so the scan leaves it out.
    const source = walkFiles(join(WEB, "src"), ".ts")
      .filter((f) => !f.endsWith(".test.ts") && !/[\\/]lib[\\/]docs[\\/]/.test(f))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const found = new Set<string>();
    for (const m of source.matchAll(/problem\(\s*(\d{3}),\s*"([a-z_]+)"/g)) {
      found.add(`${m[1]} ${m[2]}`);
    }
    for (const [status, code, file] of EXTRA_HTTP) {
      const holder = readFileSync(join(WEB, "src", file), "utf8");
      expect(holder, `${code} in ${file}`).toContain(`"${code}"`);
      expect(found.has(`${status} ${code}`), `${status} ${code} is found by the scan`).toBe(false);
      found.add(`${status} ${code}`);
    }
    expect(HTTP_ERRORS.map((e) => `${e.status} ${e.code}`).sort()).toEqual([...found].sort());
  });
});

describe("the verifier checks", () => {
  it("explain exactly the checks the verifier and the site name", () => {
    expect(Object.keys(VERIFIER_DOCS)).toEqual(Object.keys(CHECK_LABELS));
    expect(Object.keys(VERIFIER_DOCS)).toEqual(Object.keys(CHECK_NAMES));
    for (const [id, doc] of Object.entries(VERIFIER_DOCS)) {
      expect(doc.proves.trim(), id).not.toBe("");
      expect(doc.limits.trim(), id).not.toBe("");
    }
  });

  it("select a subset by letter, and refuse an unknown letter", () => {
    expect(selectChecks()).toEqual(Object.keys(CHECK_NAMES));
    expect(selectChecks("a, c")).toEqual(["a", "c"]);
    expect(() => selectChecks("a,z")).toThrow(/unknown check "z"/);
  });
});

describe("the status rows", () => {
  it("map every landing STATUS row to a docs status word, with a stable id", () => {
    const rows = docsStatusRows();
    expect(rows.map((r) => r.feature)).toEqual(STATUS.rows.map((r) => r.row));
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(FEATURE_STATUSES).toContain(r.status);
    }
    const tone = Object.fromEntries(STATUS.rows.map((r) => [r.id, r.tone]));
    for (const r of rows) {
      expect(r.status).toBe(
        { live: "live", work: "preview", plan: "planned" }[tone[r.id] ?? "plan"],
      );
    }
  });
});

describe("generated components", () => {
  it("anchor every vault code, SDK class and HTTP code", () => {
    const vault = html(createElement(ErrorCatalog, { kind: "vault" }));
    for (const code of VAULT_ERROR_CODES) expect(vault).toContain(`id="${code}"`);
    const sdk = html(createElement(ErrorCatalog, { kind: "sdk" }));
    for (const e of SDK_ERRORS) expect(sdk).toContain(`id="${e.name}"`);
    const http = html(createElement(ErrorCatalog, { kind: "http" }));
    for (const e of HTTP_ERRORS) expect(http).toContain(`id="http-${e.status}-${e.code}"`);
    expect(() => html(createElement(ErrorCatalog, { kind: "rpc" as never }))).toThrow(
      /unknown kind "rpc"/,
    );
  });

  it("list the 14 spend checks and the verifier checks with their anchors", () => {
    expect(html(createElement(SpendChecks)).match(/<tr/g)).toHaveLength(15);
    const all = html(createElement(VerifierChecks, {}));
    for (const id of Object.keys(CHECK_NAMES))
      expect(all).toContain(`id="${checkAnchor(id as never)}"`);
    expect(html(createElement(VerifierChecks, { only: "h" })).match(/<h3/g)).toHaveLength(1);
  });

  it("show the status table and the agent rules", () => {
    const table = html(createElement(StatusTable));
    for (const r of docsStatusRows()) expect(table).toContain(`id="${r.id}"`);
    expect(html(createElement(AgentRules)).match(/<li/g)).toHaveLength(AGENT_RULES.length);
  });

  it("put only the three status words and the two network words on chips", () => {
    expect(html(createElement(StatusChip, { status: "live" }))).toContain("Live");
    expect(html(createElement(StatusChip, { status: "preview" }))).toContain("Preview");
    expect(html(createElement(StatusChip, { status: "planned" }))).toContain("Planned");
    expect(html(createElement(NetworkChip, { network: "Testnet" }))).toContain("Testnet");
  });
});
