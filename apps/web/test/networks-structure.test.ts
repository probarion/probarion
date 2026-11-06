// W-NET-R2, R4, R6: the rules about where a network may come from, held to the source. One deployment serves both networks,
// so a call site that reaches for "the" network (a setting, a build constant, a literal) would mix them. These checks read
// the files, as test/deploy.test.ts does.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PER_NETWORK_ENV_NAMES } from "@/lib/env";
import { isSourceFile, walk } from "./deploy-scan";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(WEB, "src");
const text = (...p: string[]) => readFileSync(join(...p), "utf8");
const posix = (f: string) => relative(WEB, f).replaceAll("\\", "/");

/** The app's own source: no test, no fixture. */
const sources = walk(SRC).filter(
  (f) => isSourceFile(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(".d.ts"),
);
const withText = sources.map((f) => ({ file: posix(f), src: readFileSync(f, "utf8") }));

describe("no source reads one network for the whole deployment", () => {
  it("never reads a single NEAR_NETWORK, a build-time network or a single-network setting", () => {
    const allowed = new Set([
      "src/lib/env.ts", // the default network, and the settings per network
      "src/lib/site/network.ts", // the same rule for next.config.ts and the browser
    ]);
    const banned = [
      /\bBUILD_NETWORK\b/,
      /\bNEXT_PUBLIC_NEAR_NETWORK\b/,
      /\.NEAR_NETWORK\b/,
      /\benv\.(NEAR_RPC_URLS|NEAR_ARCHIVAL_RPC_URLS|PROBARION_FACTORY_ID|PROBARION_VAULT_ID|CANARY_VAULT_ID|TEAM_VAULT_IDS)\b/,
    ];
    const found = withText
      .filter(({ file }) => !allowed.has(file))
      .flatMap(({ file, src }) =>
        banned.filter((re) => re.test(src)).map((re) => `${file}: ${re}`),
      );
    expect(found).toEqual([]);
  });

  it("never names a network by a literal when it builds a chain client or reads a vault", () => {
    const found = withText.flatMap(({ file, src }) =>
      [
        ...src.matchAll(
          /\b(getRpc|getReader|chainConsts|makeTenantProbarion|proofDeps|watcherDeps)\(\s*["'](mainnet|testnet)["']/g,
        ),
      ].map((m) => `${file}: ${m[0]}`),
    );
    expect(found).toEqual([]);
  });

  it("only the request, a vault or a tenant names the network of a chain client", () => {
    // Every call passes a variable: the request's network, `member.network`, `tenant.network` or an argument.
    const found = withText
      .filter(({ file }) => file !== "src/lib/near/server.ts")
      .flatMap(({ file, src }) =>
        // (`req.body.getReader()` is the Web Streams one, hence the look-behind.)
        [...src.matchAll(/(?<![.\w])(getRpc|getReader|chainConsts)\(\s*\)/g)].map(
          (m) => `${file}: ${m[0]}`,
        ),
      );
    expect(found).toEqual([]);
  });
});

describe("the pages of a vault", () => {
  const pages = walk(join(SRC, "app", "console", "[vault]")).filter((f) =>
    /[\\/]page\.tsx$/.test(f),
  );

  it("find every page of a vault", () => {
    expect(pages.map(posix).sort()).toEqual([
      "src/app/console/[vault]/alerts/page.tsx",
      "src/app/console/[vault]/keys/page.tsx",
      "src/app/console/[vault]/mandates/page.tsx",
      "src/app/console/[vault]/page.tsx",
      "src/app/console/[vault]/payables/[id]/page.tsx",
      "src/app/console/[vault]/payables/page.tsx",
      "src/app/console/[vault]/topup/page.tsx",
    ]);
  });

  it.each(pages.map((f) => [posix(f), readFileSync(f, "utf8")]))(
    "%s shows the other-network card in place of itself, right after the guard",
    (_file, src) => {
      expect(src).toMatch(/const \{[^}]*\belsewhere\b[^}]*\} = await requireMember\(/);
      expect(src).toContain("if (elsewhere) return <VaultOnOtherNetwork {...elsewhere} />;");
      // Nothing is read before the guard has answered: in the page itself, the card comes before the first read of
      // the chain or the database (a helper above the default export may read, but only the page calls it).
      const body = src.slice(src.indexOf("export default async function"));
      const card = body.indexOf("if (elsewhere)");
      expect(card).toBeGreaterThan(-1);
      for (const read of [
        "getReader(",
        "getRpc(",
        "serviceDb()",
        "loadOverview(",
        "chainConsts(",
      ]) {
        const first = body.indexOf(read);
        expect(first === -1 || card < first, `${read} in ${_file}`).toBe(true);
      }
    },
  );
});

/**
 * A function declared at the top of a file, in any of the ways an action or a handler is written: `function f`,
 * `async function f`, and `const f = async (...) =>`, `const f = async function`, `const f = (...) =>`, `const f = x =>`
 * (with a type annotation or a return type if it has one), exported or not. A top-level declaration starts at the
 * beginning of a line.
 */
const DECLARATION =
  /^(export )?(?:(?:async )?function\*? (\w+)|const (\w+)\b[^=\n]*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|\w+\s*=>))/gm;

/** The next top-level declaration or export, which ends the body of the one before it. */
const TOP_LEVEL = /^(?:export|function|async function|const|let|var|type|interface|class)\b/gm;

/**
 * The exported functions of a file, each with its body in which every call of a function of the same file is replaced by
 * that function's body (to three levels), so an action that hands its work to a helper is read as one piece, in the order
 * it runs. A body runs from its declaration to the next top-level declaration, so a helper written after an export is not
 * taken for part of it.
 */
function exportedFunctions(src: string): { name: string; body: string }[] {
  const marks = [...src.matchAll(TOP_LEVEL)].map((m) => m.index ?? 0);
  const all = [...src.matchAll(DECLARATION)].map((m) => {
    const from = m.index ?? 0;
    const to = marks.find((i) => i > from) ?? src.length;
    return { name: m[2] ?? m[3] ?? "", exported: m[1] !== undefined, body: src.slice(from, to) };
  });
  const bodies = new Map(all.map((f) => [f.name, f.body]));
  const inline = (body: string, depth: number): string =>
    depth === 0
      ? body
      : body.replace(/(?<!function )\b(\w+)\(/g, (call, name: string) => {
          const helper = bodies.get(name);
          return helper === undefined ? call : `${call}${inline(helper, depth - 1)}`;
        });
  return all.filter((f) => f.exported).map((f) => ({ name: f.name, body: inline(f.body, 3) }));
}

/** What the guard check reads before the guard has answered: a chain, the database, or a call to the outside. */
const READS = ["getReader(", "getRpc(", "serviceDb(", "chainConsts(", "fetch(", ".rpc("];

/**
 * Why an action or a handler (a body from `exportedFunctions`) is not held to the guard: it has no membership guard
 * (`memberForAction` or `memberForApi`), it reads the session alone (that would let a vault of the other network
 * through), or it reads something before the guard has answered. Empty when it is fine.
 */
function guardProblems(body: string): string[] {
  const problems: string[] = [];
  const guard = body.search(/\bmemberFor(Action|Api)\(/);
  if (guard === -1) problems.push("no membership guard");
  if (/\bgetSession\(\)/.test(body)) problems.push("reads the session alone");
  if (guard !== -1) {
    for (const read of READS) {
      const first = body.indexOf(read);
      if (first !== -1 && first < guard) problems.push(`${read} before the guard`);
    }
  }
  return problems;
}

/** The route options a handler file may export besides its handlers (Next reads them; they are not actions). */
const ROUTE_OPTIONS = new Set(["dynamic", "maxDuration", "runtime"]);

/**
 * The exports of a file that the guard check cannot read, so that a new way of writing a handler fails loudly instead of
 * being skipped: a constant that is not a function or a route option (a handler wrapped in a helper, say), a default
 * export, a re-export, a `let`, `var`, class or enum. Types and interfaces are not code and are fine. Empty when every
 * export is a function the check reads or a route option.
 */
function unreadableExports(src: string): string[] {
  const functions = new Set(exportedFunctions(src).map((f) => f.name));
  const found: string[] = [];
  for (const m of src.matchAll(/^export (?!type\b|interface\b)(.*)$/gm)) {
    const rest = m[1] ?? "";
    const constant = /^const (\w+)/.exec(rest);
    if (/^(?:async )?function\*? \w+/.test(rest)) continue; // a declaration: listed by exportedFunctions
    if (constant) {
      const name = constant[1] ?? "";
      if (!functions.has(name) && !ROUTE_OPTIONS.has(name)) found.push(`const ${name}`);
    } else {
      found.push(rest.slice(0, 40));
    }
  }
  return found;
}

describe("the routes and the actions of a vault", () => {
  const files = [
    ...walk(join(SRC, "app", "console", "[vault]")).filter((f) => /actions\.ts$/.test(f)),
    ...walk(join(SRC, "app", "api", "topup")).filter((f) => /route\.ts$/.test(f)),
    join(SRC, "app", "api", "console", "[vault]", "invoices", "route.ts"),
  ];
  const entries = files.flatMap((f) =>
    exportedFunctions(readFileSync(f, "utf8")).map((fn) => ({ file: posix(f), ...fn })),
  );

  it("finds every action and every handler (a new one must be added here, and is then held to the guard)", () => {
    expect(entries.map((e) => `${e.file}: ${e.name}`).sort()).toEqual([
      "src/app/api/console/[vault]/invoices/route.ts: POST",
      "src/app/api/topup/quote/route.ts: POST",
      "src/app/api/topup/status/route.ts: GET",
      "src/app/api/topup/submit/route.ts: POST",
      "src/app/console/[vault]/actions.ts: refreshMembersAction",
      "src/app/console/[vault]/actions.ts: updateSettingsAction",
      "src/app/console/[vault]/alerts/actions.ts: addEmailAction",
      "src/app/console/[vault]/alerts/actions.ts: connectTelegramAction",
      "src/app/console/[vault]/alerts/actions.ts: removeSubscriptionAction",
      "src/app/console/[vault]/keys/actions.ts: discardKeyAction",
      "src/app/console/[vault]/keys/actions.ts: generateKeyAction",
      "src/app/console/[vault]/keys/actions.ts: keepKeyAction",
      "src/app/console/[vault]/keys/actions.ts: syncKeysAction",
      "src/app/console/[vault]/mandates/actions.ts: checkPayeeAction",
      "src/app/console/[vault]/mandates/actions.ts: prepareMandateAction",
      "src/app/console/[vault]/payables/actions.ts: confirmInvoiceAction",
      "src/app/console/[vault]/payables/actions.ts: prepareConfirmAction",
      "src/app/console/[vault]/payables/actions.ts: rejectInvoiceAction",
      "src/app/console/[vault]/payables/actions.ts: setZeroRetentionAction",
      "src/app/console/[vault]/topup/actions.ts: prepareFundAction",
    ]);
  });

  it.each(entries.map((e) => [`${e.file}: ${e.name}`, e.body]))(
    "%s finds the member through the guard that checks the network, before anything is read or written",
    (name, body) => {
      // No membership guard, the session alone (that would let a vault of the other network through), or a chain, database
      // or outside call before the guard has answered.
      expect(guardProblems(body ?? ""), name).toEqual([]);
    },
  );

  it.each(files.map((f) => [posix(f), readFileSync(f, "utf8")]))(
    "%s exports nothing this check cannot read: no wrapped handler, default export, re-export or other constant",
    (file, src) => {
      expect(unreadableExports(src ?? ""), file).toEqual([]);
    },
  );
});

// The check has to see an action however it is written. These are inline sources, written the way a vault's actions.ts or
// route.ts could be one day.
describe("the guard check reads every way of exporting an action", () => {
  const names = (src: string) => exportedFunctions(src).map((f) => f.name);
  const problemsOf = (src: string, name: string) =>
    guardProblems(exportedFunctions(src).find((f) => f.name === name)?.body ?? "<not found>");

  const GUARDED = [
    "export async function declared(vault: string) {",
    "  const auth = await memberForAction(vault);",
    "  return serviceDb();",
    "}",
    "export const arrow = async (vault: string): Promise<void> => {",
    "  const auth = await memberForApi(vault);",
    "  getRpc(auth.member.network);",
    "};",
    "export const expression = async function (vault: string) {",
    "  await memberForAction(vault);",
    "  return fetch('https://example.invalid');",
    "};",
    "export const typed: Handler = async (req: Request, { params }: { params: Promise<{ v: string }> }) => {",
    "  const auth = await memberForApi((await params).v);",
    "  return auth;",
    "};",
    "export const plain = (req: Request) => {",
    "  return memberForApi('x');",
    "};",
    "export const bare = req => memberForApi('x');",
    "export const viaHelper = async (vault: string) => run(vault);",
    "const run = async (vault: string) => {",
    "  await memberForAction(vault);",
    "  return serviceDb();",
    "};",
    "export const dynamic = 'force-dynamic';",
    "export const maxDuration = 30;",
    "export type Result = { ok: boolean };",
  ].join("\n");

  it("finds a function declaration, and an export const written as an async arrow, an async function, a typed arrow, a plain arrow and a bare-parameter arrow", () => {
    expect(names(GUARDED)).toEqual([
      "declared",
      "arrow",
      "expression",
      "typed",
      "plain",
      "bare",
      "viaHelper",
    ]);
  });

  it("does not take an export const that is not a function for an action, and holds nothing else to the check", () => {
    expect(names(GUARDED)).not.toContain("dynamic");
    expect(names(GUARDED)).not.toContain("maxDuration");
    expect(unreadableExports(GUARDED)).toEqual([]);
  });

  it("passes each guarded form: the guard first, a helper read in place", () => {
    for (const name of names(GUARDED)) expect(problemsOf(GUARDED, name), name).toEqual([]);
  });

  it("fails an export const action that has no guard, in each way of writing it", () => {
    const sources = {
      arrow: "export const bad = async (vault: string) => {\n  return serviceDb();\n};",
      expression:
        "export const bad = async function (vault: string) {\n  return getRpc('mainnet');\n};",
      typed:
        "export const bad: Handler = async (req: Request) => {\n  return Response.json({});\n};",
      plain: "export const bad = (req: Request) => {\n  return Response.json({});\n};",
      bare: "export const bad = req => {\n  return Response.json({});\n};",
    };
    for (const [form, src] of Object.entries(sources)) {
      expect(names(src), form).toEqual(["bad"]);
      expect(problemsOf(src, "bad"), form).toContain("no membership guard");
    }
  });

  it("fails an export const action that reads before the guard, or only the session", () => {
    const early =
      "export const early = async (vault: string) => {\n  const db = serviceDb();\n  await memberForAction(vault);\n};";
    expect(problemsOf(early, "early")).toEqual(["serviceDb( before the guard"]);
    const viaHelper =
      "export const outer = async (vault: string) => helper(vault);\nconst helper = async (vault: string) => {\n  getReader('testnet');\n  await memberForApi(vault);\n};";
    expect(problemsOf(viaHelper, "outer")).toEqual(["getReader( before the guard"]);
    const session =
      "export const onlySession = async (vault: string) => {\n  const s = await getSession();\n  await memberForAction(vault);\n};";
    expect(problemsOf(session, "onlySession")).toContain("reads the session alone");
  });

  it("says so when an export cannot be read, so a new way of writing a handler is never silently skipped", () => {
    const cannotRead = [
      "export const POST = withAuth(async (req: Request) => {\n  return Response.json({});\n});",
      "export default async function handler(req: Request) {\n  return Response.json({});\n}",
      "export { thing } from './thing';",
      "export * from './all';",
      "export let counter = 0;",
      "export class Thing {}",
      "export const limit = 10;",
    ];
    for (const src of cannotRead) expect(unreadableExports(src), src).toHaveLength(1);
  });
});

describe("the root layout", () => {
  const layout = text(SRC, "app", "layout.tsx");

  it("does not read the request, so the static pages stay static: the network comes from the browser", () => {
    expect(layout).not.toMatch(
      /next\/headers|\bheaders\(|\bcookies\(|requestNetwork|softRequestNetwork/,
    );
  });
});

describe("the documented settings", () => {
  const example = readFileSync(join(WEB, "..", "..", ".env.example"), "utf8");
  const runbook = readFileSync(join(WEB, "..", "..", "docs", "runbooks", "web-deploy.md"), "utf8");

  it("lists the mainnet and the testnet form of every per-network setting in .env.example and the runbook", () => {
    for (const name of PER_NETWORK_ENV_NAMES) {
      for (const suffix of ["MAINNET", "TESTNET"]) {
        expect(example, `${name}_${suffix}`).toMatch(new RegExp(`^${name}_${suffix}=`, "m"));
        expect(runbook, `${name}_${suffix}`).toContain(`${name}_${suffix}`);
      }
    }
    for (const name of ["APP_ORIGIN_MAINNET", "APP_ORIGIN_TESTNET"]) {
      expect(example, name).toMatch(new RegExp(`^${name}=`, "m"));
      expect(runbook, name).toContain(name);
    }
  });

  it("marks the owner's steps for both networks in the runbook", () => {
    const section = runbook.slice(runbook.indexOf("### 3.5 Both networks in one project"));
    expect(section.length).toBeGreaterThan(0);
    expect(
      section.slice(0, section.indexOf("## 4.")).match(/\*\*OWNER:\*\*/g)?.length,
    ).toBeGreaterThanOrEqual(5);
  });
});
