import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
    const codes = [...body.matchAll(/ErrorCode::([A-Za-z]+)/g)].map((m) => m[1]);
    // One check may name its code twice in a row: NoMandate for "no such position" and for "no
    // mandate there" (checks.rs:32-33). Only those adjacent repeats collapse, so a later check that
    // reuses an earlier code counts as a check of its own and breaks the 14.
    const order = codes.filter((code, at) => at === 0 || codes[at - 1] !== code);
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
  const files = walkFiles(join(ROOT, "packages", "sdk", "src"), ".ts")
    .filter((f) => !f.endsWith(".test.ts") && !/[\\/]testing[\\/]/.test(f))
    .map((f) => readFileSync(f, "utf8"));
  const sources = files.join("\n");

  /** A class's own source: from `export class <name>` to the next top-level export of its file. */
  function classBody(name: string): string {
    for (const src of files) {
      const start = src.search(new RegExp(`^export class ${name} `, "m"));
      if (start < 0) continue;
      const end = src.slice(start + 1).search(/^export /m);
      return src.slice(start, end < 0 ? undefined : start + 1 + end);
    }
    throw new Error(`no export class ${name} in packages/sdk/src`);
  }

  /**
   * The `.code` literals a class body sets itself: a `super` argument, a `?? "<code>"` fallback, or
   * a `code = "<code>"` field.
   */
  const ownCodes = (body: string): string[] =>
    [
      ...body.matchAll(
        /super\([^;]*?,\s*"([A-Za-z]+)"|\?\?\s*"([A-Za-z]+)"|\bcode\s*=\s*"([A-Za-z]+)"/g,
      ),
    ].map((m) => m[1] ?? m[2] ?? m[3] ?? "");

  it("document every exported error class, with its parent", () => {
    const found = [...sources.matchAll(/export class (\w+) extends (\w+)/g)]
      .map((m) => `${m[1]} < ${m[2]}`)
      .sort();
    expect(SDK_ERRORS.map((e) => `${e.name} < ${e.parent}`).sort()).toEqual(found);
  });

  it("give each class the code its own body sets, else its parent's", () => {
    const documented = new Map(SDK_ERRORS.map((e) => [e.name, e]));
    for (const e of SDK_ERRORS) {
      const own = ownCodes(classBody(e.name));
      if (own.length > 0) {
        expect(own, `the code ${e.name} sets in its own body`).toContain(e.code);
        continue;
      }
      const parent = documented.get(e.parent);
      if (parent !== undefined) {
        expect(e.code, `${e.name} sets no code, so it carries ${e.parent}'s`).toBe(parent.code);
        continue;
      }
      // The base class takes its code from each caller. Its row shows one of them as `.code` and
      // names every code the SDK builds it with, in backticks, in `when`.
      const built = [
        ...new Set(
          [...sources.matchAll(new RegExp(`new ${e.name}\\([^;]*?,\\s*"([A-Za-z]+)"`, "g"))].map(
            (m) => m[1],
          ),
        ),
      ].sort();
      const named = [...new Set([...e.when.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]))].sort();
      expect(built.length, `the SDK builds ${e.name} with a code`).toBeGreaterThan(0);
      expect(named, `the codes ${e.name}'s row names`).toEqual(built);
      expect(built, e.name).toContain(e.code);
    }
  });
});

describe("the HTTP error codes", () => {
  const SRC = join(WEB, "src");
  const pathOf = (f: string) => relative(SRC, f).split(sep).join("/");
  const at = (path: string) => readFileSync(join(SRC, path), "utf8");
  // lib/docs is the docs data itself, which names every code, so the scans leave it out.
  const files = [...walkFiles(SRC, ".ts"), ...walkFiles(SRC, ".tsx")]
    .filter((f) => !/\.test\.tsx?$/.test(f) && !/[\\/]lib[\\/]docs[\\/]/.test(f))
    .map((f) => ({ path: pathOf(f), text: readFileSync(f, "utf8") }));

  // Pairs that only a helper no route calls yet returns: [status, code, the helper's file, the
  // helper]. They stay out of HTTP_ERRORS. The last test here fails once a route can call the
  // helper, and says to restore the row.
  const UNROUTED_HTTP: readonly (readonly [number, string, string, string])[] = [];

  /**
   * The top-level comma-separated parts of the bracket that opens at `open` (a call's arguments, an
   * object's entries), as trimmed source. Strings and comments are skipped.
   */
  function parts(text: string, open: number): string[] {
    const out: string[] = [];
    let depth = 0;
    let from = open + 1;
    for (let i = open; i < text.length; i++) {
      const ch = text.charAt(i);
      if (ch === '"' || ch === "'" || ch === "`") {
        for (i++; i < text.length && text.charAt(i) !== ch; i++) if (text.charAt(i) === "\\") i++;
      } else if (ch === "/" && text.charAt(i + 1) === "/") {
        i = text.indexOf("\n", i);
        if (i < 0) break;
      } else if (ch === "/" && text.charAt(i + 1) === "*") {
        i = text.indexOf("*/", i) + 1;
        if (i < 1) break;
      } else if ("([{".includes(ch)) {
        depth++;
      } else if (")]}".includes(ch) && --depth === 0) {
        out.push(text.slice(from, i).trim());
        return out.filter((part) => part !== "");
      } else if (ch === "," && depth === 1) {
        out.push(text.slice(from, i).trim());
        from = i + 1;
      }
    }
    throw new Error(`no closing bracket for the one at ${open}`);
  }

  /** Each problem(status, code) call: its first two arguments, as source. */
  const problemCalls = (text: string) =>
    [...text.matchAll(/(?<!function )\bproblem\(/g)].map((m) => {
      const [status = "", code = ""] = parts(text, (m.index ?? 0) + m[0].length - 1);
      return { status, code, literal: /^\d{3}$/.test(status) && /^"[a-z_]+"$/.test(code) };
    });

  /**
   * api/canary/attempt answers a rejection with problem(STATUS[r.reason], r.reason): one pair per
   * entry of its STATUS map, which must hold exactly the reasons runAttempt rejects with.
   */
  function canaryPairs(): (readonly [string, string])[] {
    const route = at("app/api/canary/attempt/route.ts");
    expect(route, "the Canary route answers by its STATUS map").toContain(
      "problem(STATUS[r.reason], r.reason)",
    );
    const map = /const STATUS = \{([^}]*)\}/.exec(route)?.[1] ?? "";
    const pairs = [...map.matchAll(/(\w+):\s*(\d{3})/g)].map((m) => [m[2], m[1]] as const);
    const service = at("lib/canary/service.ts");
    const type = service.slice(service.indexOf("export type AttemptResult"));
    const union = /reason:\s*("[a-z_]+"(?:\s*\|\s*"[a-z_]+")*)\s*;/.exec(type)?.[1] ?? "";
    const reasons = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(reasons.length, "the rejection reasons of AttemptResult").toBeGreaterThan(0);
    expect(pairs.map(([, r]) => r).sort(), "one STATUS entry per rejection reason").toEqual(
      [...reasons].sort(),
    );
    for (const r of reasons)
      expect(service, `runAttempt rejects with "${r}"`).toContain(`rejected("${r}"`);
    return pairs;
  }

  /**
   * api/auth/verify answers verifier_unavailable with 503 unavailable (a literal pair) and every
   * other reason of LoginResult with problem(401, result.reason).
   */
  function signInPairs(): (readonly [string, string])[] {
    expect(at("app/api/auth/verify/route.ts"), "the sign-in route's failure answers").toMatch(
      /result\.reason === "verifier_unavailable"\s*\?\s*problem\(503, "unavailable"\)\s*:\s*problem\(401, result\.reason\)/,
    );
    const verify = at("lib/auth/verify.ts");
    const type = verify.slice(verify.indexOf("export type LoginResult"));
    const union = /reason:\s*((?:\|\s*)?"[a-z_]+"(?:\s*\|\s*"[a-z_]+")*)\s*;/.exec(type)?.[1] ?? "";
    const reasons = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(reasons, "the reasons of LoginResult").toContain("verifier_unavailable");
    for (const r of reasons) {
      // Once in the type, and again where verifyLogin returns it.
      expect(verify.split(`"${r}"`).length - 1, `verifyLogin returns "${r}"`).toBeGreaterThan(1);
    }
    return reasons.filter((r) => r !== "verifier_unavailable").map((r) => ["401", r] as const);
  }

  it("are every (status, code) pair the web app returns, and nothing else", () => {
    // Pair -> the files that return it.
    const found = new Map<string, Set<string>>();
    const add = (status: string, code: string, path: string) => {
      const key = `${status} ${code}`;
      found.set(key, (found.get(key) ?? new Set()).add(path));
    };
    for (const f of files) {
      // Literal problem() calls. The test below lists the others.
      for (const c of problemCalls(f.text))
        if (c.literal) add(c.status, c.code.slice(1, -1), f.path);
      // json({ error: "<code>", ... }, <status>): the status is the argument after the object.
      for (const m of f.text.matchAll(/\bjson\(/g)) {
        const [body = "", status = ""] = parts(f.text, (m.index ?? 0) + m[0].length - 1);
        if (!body.startsWith("{")) continue;
        const error = parts(body, 0).find((entry) => /^error\b/.test(entry));
        if (error === undefined) continue;
        const code = /^error:\s*"([a-z_]+)"$/.exec(error)?.[1];
        expect(code, `json() in ${f.path} answers with a literal error code`).toBeDefined();
        expect(status, `the status of json({ ${error} }) in ${f.path}`).toMatch(/^\d{3}$/);
        add(status, code ?? "", f.path);
      }
    }
    for (const [status, code] of canaryPairs())
      add(status, code, "app/api/canary/attempt/route.ts");
    for (const [status, code] of signInPairs()) add(status, code, "app/api/auth/verify/route.ts");
    for (const [status, code, holder, helper] of UNROUTED_HTTP) {
      const key = `${status} ${code}`;
      expect([...(found.get(key) ?? [])], `${helper} in ${holder} returns ${key}`).toContain(
        holder,
      );
      expect(at(holder), `${holder} defines ${helper}`).toMatch(
        new RegExp(`function ${helper}\\(`),
      );
      found.get(key)?.delete(holder);
      if (found.get(key)?.size === 0) found.delete(key);
    }
    expect(HTTP_ERRORS.map((e) => `${e.status} ${e.code}`).sort()).toEqual(
      [...found.keys()].sort(),
    );
  });

  it("call problem() with a literal status and code, apart from the two read above", () => {
    const dynamic = files.flatMap((f) =>
      problemCalls(f.text)
        .filter((c) => !c.literal)
        .map((c) => `${f.path}: problem(${c.status}, ${c.code})`),
    );
    expect(dynamic.sort(), "a problem() call the pair scan cannot read").toEqual([
      "app/api/auth/verify/route.ts: problem(401, result.reason)",
      "app/api/canary/attempt/route.ts: problem(STATUS[r.reason], r.reason)",
    ]);
  });

  it("leave each UNROUTED_HTTP helper uncalled, until a route can return its pair", () => {
    for (const [status, code, holder, helper] of UNROUTED_HTTP) {
      const callers = files
        .filter((f) => f.path !== holder && new RegExp(`\\b${helper}\\b`).test(f.text))
        .map((f) => f.path);
      expect(
        callers,
        `${callers.join(", ")} now names ${helper}, so a route can return ${status} ${code}: restore its row in HTTP_ERRORS (lib/docs/errors.ts) and remove it from UNROUTED_HTTP`,
      ).toEqual([]);
    }
  });

  it("send an Extension API caller to the console to paste text, which the extension cannot do", () => {
    const rows = HTTP_ERRORS.filter((e) => e.where.includes("Extension API"));
    expect(rows.length).toBeGreaterThan(0);
    for (const e of rows.filter((r) => /\bpaste\b/i.test(r.next)))
      expect(e.next, `${e.status} ${e.code}`).toMatch(/\bin the console\b/);
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

  it("select a subset by letter, and refuse an unknown or repeated letter", () => {
    expect(selectChecks()).toEqual(Object.keys(CHECK_NAMES));
    expect(selectChecks("a, c")).toEqual(["a", "c"]);
    expect(() => selectChecks("a,z")).toThrow(/unknown check "z"/);
    expect(() => selectChecks("a, c, a")).toThrow(/repeated check "a"/);
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
    const checks = html(createElement(SpendChecks));
    expect(checks.match(/<tr/g)).toHaveLength(15);
    // The real registry has build/errors, so each check's code links its row there.
    expect(checks.match(/href="\/docs\/build\/errors#[A-Za-z]+"/g)).toHaveLength(14);
    for (const c of SPEND_CHECKS) expect(checks).toContain(`href="/docs/build/errors#${c.code}"`);
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
