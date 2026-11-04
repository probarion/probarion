// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures spell out JSX and template-literal source text
// The scanners behind the deploy guardrails must fail on a broken tree, or a green deploy.test.ts proves nothing.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appRoutes,
  builtPlannedRoutes,
  clientBoundaryViolations,
  codeOnly,
  cronProblems,
  deadLinks,
  directives,
  envNamesRead,
  hrefResolves,
  importsOf,
  linksIn,
  migrationProblems,
  nextPublicNames,
  parseDotenv,
  processEnvReads,
  publicPaths,
  readsCronSecret,
  scriptTargets,
  specEnvNames,
  stripSqlComments,
  stripSqlStrings,
} from "./deploy-scan";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway web app directory holding exactly these files. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "deploy-scan-"));
  made.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

describe("directives and imports", () => {
  it("reads the directive prologue past leading comments", () => {
    expect(directives('"use client";\nimport x from "y";')).toEqual(["use client"]);
    expect(directives("// note\n/* block */\n'use server'\nexport const a = 1;")).toEqual([
      "use server",
    ]);
    expect(directives('import x from "y";\n"use client";')).toEqual([]);
  });

  it("lists static, side-effect, re-exported and dynamic imports, and flags type-only ones", () => {
    const src = [
      'import a from "./a";',
      'import { b, c } from "@/lib/b";',
      "import {",
      "  d,",
      '} from "./multi";',
      'import type { T } from "./types";',
      'import { type U, type V } from "./inline-types";',
      'import { type W, x } from "./mixed";',
      'import "./side-effect.css";',
      'export * from "./star";',
      'export type { Q } from "./q";',
      'const lazy = () => import("./lazy");',
      '// import ghost from "./ghost";',
      ' * import ghost2 from "./ghost2";',
    ].join("\n");
    const got = Object.fromEntries(importsOf(src).map((i) => [i.spec, i.typeOnly]));
    expect(got).toEqual({
      "./a": false,
      "@/lib/b": false,
      "./multi": false,
      "./types": true,
      "./inline-types": true,
      "./mixed": false,
      "./side-effect.css": false,
      "./star": false,
      "./q": true,
      "./lazy": false,
    });
  });
});

describe("clientBoundaryViolations", () => {
  const client = (body: string) => `"use client";\n${body}`;

  it("passes a client component that imports only browser-safe code", () => {
    const web = tree({
      "src/components/A.tsx": client(
        'import { f } from "@/lib/pure";\nexport const A = () => f();',
      ),
      "src/lib/pure.ts":
        "export const f = () => process.env.NEXT_PUBLIC_X ?? process.env.NODE_ENV;",
    });
    expect(clientBoundaryViolations(web)).toEqual([]);
  });

  it("flags a direct import of a module marked server-only", () => {
    const web = tree({
      "src/components/A.tsx": client(
        'import { s } from "@/lib/secret";\nexport const A = () => s;',
      ),
      "src/lib/secret.ts": 'import "server-only";\nexport const s = 1;',
    });
    expect(clientBoundaryViolations(web)).toEqual([
      'src/components/A.tsx -> src/lib/secret.ts: imports "server-only"',
    ]);
  });

  it("flags a server-only module reached through a chain of relative and alias imports", () => {
    const web = tree({
      "src/components/A.tsx": client('import { m } from "../lib/mid";\nexport const A = () => m;'),
      "src/lib/mid.ts": 'import { s } from "@/lib/deep/secret";\nexport const m = s;',
      "src/lib/deep/secret.ts": 'import "server-only";\nexport const s = 1;',
    });
    expect(clientBoundaryViolations(web)).toEqual([
      'src/components/A.tsx -> src/lib/mid.ts -> src/lib/deep/secret.ts: imports "server-only"',
    ]);
  });

  it("flags the project's own server modules by path even without the marker", () => {
    const web = tree({
      "src/components/A.tsx": client(
        'import { getEnv } from "@/lib/env";\nexport const A = getEnv;',
      ),
      "src/lib/env.ts": "export const getEnv = () => 1;",
    });
    expect(clientBoundaryViolations(web)).toEqual([
      "src/components/A.tsx -> src/lib/env.ts: is a server-only module",
    ]);
  });

  it("flags Node built-ins, server packages and non-public environment reads", () => {
    const web = tree({
      "src/components/A.tsx": client(
        'import { readFileSync } from "node:fs";\nimport sodium from "libsodium-wrappers";\nexport const A = () => [readFileSync, sodium, process.env.KEY_ENCRYPTION_SECRET];',
      ),
      "src/components/B.tsx": client("export const B = (n: string) => process.env[n];"),
    });
    expect(clientBoundaryViolations(web)).toEqual([
      'src/components/A.tsx: reads process.env.KEY_ENCRYPTION_SECRET, which the browser never gets; imports "node:fs"; imports "libsodium-wrappers"',
      "src/components/B.tsx: reads process.env by a computed name",
    ]);
  });

  it("flags a destructured or optional-chained read of a server variable", () => {
    const web = tree({
      "src/components/A.tsx": client(
        "const { CRON_SECRET, NEXT_PUBLIC_X: shown } = process.env;\nexport const A = () => [CRON_SECRET, shown];",
      ),
      "src/components/B.tsx": client(
        "export const B = () => process.env?.SUPABASE_SERVICE_ROLE_KEY;",
      ),
      "src/components/C.tsx": client("export const C = () => process.env?.NEXT_PUBLIC_OK;"),
    });
    expect(clientBoundaryViolations(web)).toEqual([
      "src/components/A.tsx: reads process.env.CRON_SECRET, which the browser never gets",
      "src/components/B.tsx: reads process.env.SUPABASE_SERVICE_ROLE_KEY, which the browser never gets",
    ]);
  });

  it("reads every direct form of process.env, and nothing from a comment or a string", () => {
    const src = [
      "const a = process.env.DOT;",
      "const b = process.env?.OPTIONAL;",
      'const c = process.env["INDEXED"];',
      "const { PLAIN, RENAMED: r, WITH_DEFAULT = 1 } = process.env;",
      "const { ...all } = process.env;",
      "// process.env.IN_A_COMMENT",
      'const m = "process.env.IN_A_STRING";',
      "const n = process.env[name];",
    ].join("\n");
    expect(processEnvReads(src)).toEqual([
      "*",
      "DOT",
      "INDEXED",
      "OPTIONAL",
      "PLAIN",
      "RENAMED",
      "WITH_DEFAULT",
    ]);
    expect(processEnvReads("const x = load(process.env);")).toEqual([]);
  });

  it("ignores type-only imports, which the compiler erases", () => {
    const web = tree({
      "src/components/A.tsx": client(
        'import type { S } from "@/lib/secret";\nexport const A = (s: S) => s;',
      ),
      "src/lib/secret.ts": 'import "server-only";\nexport type S = string;',
    });
    expect(clientBoundaryViolations(web)).toEqual([]);
  });

  it('stops at a "use server" module: its imports are not bundled for the browser', () => {
    const web = tree({
      "src/components/A.tsx": client('import { act } from "@/app/actions";\nexport const A = act;'),
      "src/app/actions.ts":
        '"use server";\nimport { s } from "@/lib/secret";\nexport const act = async () => s;',
      "src/lib/secret.ts": 'import "server-only";\nexport const s = 1;',
    });
    expect(clientBoundaryViolations(web)).toEqual([]);
  });

  it("does not check a server component", () => {
    const web = tree({
      "src/app/page.tsx": 'import { s } from "@/lib/secret";\nexport default () => s;',
      "src/lib/secret.ts": 'import "server-only";\nexport const s = 1;',
    });
    expect(clientBoundaryViolations(web)).toEqual([]);
  });
});

describe("routes and links", () => {
  const web = () =>
    tree({
      "src/app/page.tsx": "export default () => null;",
      "src/app/login/page.tsx": "export default () => null;",
      "src/app/(site)/about/page.tsx": "export default () => null;",
      "src/app/console/[vault]/page.tsx": "export default () => null;",
      "src/app/console/[vault]/keys/page.tsx": "export default () => null;",
      "src/app/api/health/route.ts": "export async function GET() {}",
      "src/app/_private/page.tsx": "export default () => null;",
      "src/app/docs/[...slug]/page.tsx": "export default () => null;",
      "public/brand/logo.svg": "<svg/>",
    });

  it("reads route patterns from page and route files, leaving out groups and private folders", () => {
    expect(appRoutes(web())).toEqual([
      "/",
      "/about",
      "/api/health",
      "/console/[vault]",
      "/console/[vault]/keys",
      "/docs/[...slug]",
      "/login",
    ]);
  });

  it("matches an address to a pattern, with holes standing for dynamic segments only", () => {
    const p = ["/", "/login", "/console/[vault]", "/console/[vault]/keys", "/docs/[...slug]"];
    const f = ["/brand/logo.svg"];
    expect(hrefResolves("/", p, f)).toBe(true);
    expect(hrefResolves("/login?next=/console", p, f)).toBe(true);
    expect(hrefResolves("/console/${encodeURIComponent(v)}/keys", p, f)).toBe(true);
    expect(hrefResolves("/console/[vault]", p, f)).toBe(true);
    expect(hrefResolves("/console/abc/keys", p, f)).toBe(true);
    expect(hrefResolves("/docs/a/b", p, f)).toBe(true);
    expect(hrefResolves("/brand/logo.svg", p, f)).toBe(true);
    expect(hrefResolves("/canary", p, f)).toBe(false);
    expect(hrefResolves("/console/abc/payables", p, f)).toBe(false);
    expect(hrefResolves("/${x}/keys", p, f)).toBe(false);
    expect(hrefResolves("/login/extra", p, f)).toBe(false);
  });

  it("reads literal links and leaves computed and external ones alone", () => {
    const src = [
      '<Link href="/a">a</Link>',
      "<Link href={'/b'}>b</Link>",
      "<Link href={`/c/${id}`}>c</Link>",
      '<a href="https://example.com/x">x</a>',
      '<a href="#anchor">y</a>',
      '<a href="mailto:a@b.c">z</a>',
      "<Link href={href}>d</Link>",
      "<Link href={`${base}/e`}>e</Link>",
      'redirect("/login");',
      "redirect(loginPath(next));",
      '<RouteLink route="/canary">c</RouteLink>',
      '<RouteLink route="/proof/[vault]" href={`/proof/${v}`}>p</RouteLink>',
      "<RouteLink route={`/console/[vault]${path}`} href={`${base}${path}`}>t</RouteLink>",
    ].join("\n");
    expect(linksIn(src)).toEqual([
      { kind: "route", value: "/canary" },
      { kind: "route", value: "/proof/[vault]" },
      { kind: "href", value: "/proof/${v}", via: "/proof/[vault]" },
      { kind: "href", value: "/a" },
      { kind: "href", value: "/b" },
      { kind: "href", value: "/c/${id}" },
      { kind: "redirect", value: "/login" },
    ]);
  });

  it("reports a link to a page that does not exist, and accepts one to a planned page", () => {
    const dir = tree({
      "src/app/page.tsx": [
        'import Link from "next/link";',
        'export default () => (<><Link href="/login">in</Link><Link href="/canary">c</Link></>);',
      ].join("\n"),
      "src/app/login/page.tsx": "export default () => null;",
      "src/components/Nav.tsx": [
        'export const Nav = () => (<><RouteLink route="/open">o</RouteLink>',
        '<RouteLink route="/proof/[vault]" href={`/proof/${v}`}>p</RouteLink>',
        '<RouteLink route="/nowhere">n</RouteLink></>);',
      ].join("\n"),
    });
    expect(deadLinks(dir, ["/open", "/proof/[vault]"])).toEqual([
      'src/app/page.tsx: href "/canary" has no page',
      'src/components/Nav.tsx: route "/nowhere" has no page',
    ]);
    // Planning a page excuses a <RouteLink> to it, never a plain link: that one would still 404.
    expect(deadLinks(dir, ["/open", "/proof/[vault]", "/canary", "/nowhere"])).toEqual([
      'src/app/page.tsx: href "/canary" has no page',
    ]);
  });

  it("checks the address a built RouteLink shows", () => {
    const dir = tree({
      "src/app/proof/[vault]/page.tsx": "export default () => null;",
      "src/components/Nav.tsx":
        '<RouteLink route="/proof/[vault]" href={`/proof/${v}`}>p</RouteLink>',
    });
    expect(deadLinks(dir, [])).toEqual([]);
    const bad = tree({
      "src/app/proof/[vault]/page.tsx": "export default () => null;",
      "src/components/Nav.tsx": '<RouteLink route="/proof/[vault]" href="/prooof/x">q</RouteLink>',
    });
    expect(deadLinks(bad, [])).toEqual(['src/components/Nav.tsx: href "/prooof/x" has no page']);
  });

  it("serves the metadata files Next.js reads from app/ as well as the files in public/", () => {
    const dir = tree({
      "src/app/page.tsx": "export default () => null;",
      "src/app/favicon.ico": "ico",
      "src/app/icon.png": "png",
      "src/app/apple-icon.png": "png",
      "src/app/opengraph-image.tsx": "export default () => null;",
      "src/app/robots.ts": "export default () => ({});",
      "src/app/sitemap.ts": "export default () => [];",
      "src/app/(marketing)/manifest.json": "{}",
      "src/app/blog/icon.svg": "<svg/>",
      "src/app/_private/icon.png": "png",
      "src/app/globals.css": "",
      "public/brand/logo.svg": "<svg/>",
    });
    expect(publicPaths(dir)).toEqual([
      "/apple-icon.png",
      "/blog/icon.svg",
      "/brand/logo.svg",
      "/favicon.ico",
      "/icon.png",
      "/manifest.json",
      "/opengraph-image",
      "/robots.txt",
      "/sitemap.xml",
    ]);
  });

  it("accepts a link to a metadata file and still flags one to a file that is not there", () => {
    const dir = tree({
      "src/app/page.tsx": [
        '<><a href="/favicon.ico">i</a><a href="/robots.txt">r</a><a href="/sitemap.xml">s</a>',
        '<a href="/nope.ico">n</a><a href="/apple-icon.png">a</a></>',
      ].join(""),
      "src/app/favicon.ico": "ico",
      "src/app/robots.ts": "export default () => ({});",
      "src/app/sitemap.ts": "export default () => [];",
    });
    expect(deadLinks(dir, [])).toEqual([
      'src/app/page.tsx: href "/nope.ico" has no page',
      'src/app/page.tsx: href "/apple-icon.png" has no page',
    ]);
  });

  it("finds a planned route whose page exists under another parameter name", () => {
    const dir = tree({
      "src/app/proof/[id]/page.tsx": "export default () => null;",
      "src/app/console/[vault]/keys/page.tsx": "export default () => null;",
    });
    expect(
      builtPlannedRoutes(dir, [
        "/proof/[vault]",
        "/console/[vault]/keys",
        "/console/[vault]/payables",
        "/canary",
      ]),
    ).toEqual(["/proof/[vault]", "/console/[vault]/keys"]);
  });
});

describe("codeOnly", () => {
  it("removes comments and empties strings, but not a comment marker inside a string", () => {
    const out = codeOnly(
      [
        'const a = "x.CRON_SECRET"; // y.CRON_SECRET',
        "/* z.CRON_SECRET */ const u = 'https://h'; env.KEPT",
      ].join("\n"),
    );
    expect(out).not.toContain("CRON_SECRET");
    expect(out).toContain("env.KEPT");
  });

  it("keeps the expressions of a template literal, nested ones too, and drops its text", () => {
    const out = codeOnly(
      "const s = `text ${a.B} more ${fn({ k: 1 }).C} ${`inner ${d.E}`} end`; f.AFTER",
    );
    expect(out).toContain("a.B");
    expect(out).toContain(".C");
    expect(out).toContain("d.E");
    expect(out).toContain("f.AFTER");
    expect(out).not.toMatch(/text|more|inner|end/);
  });

  it("turns a string index into a property access", () => {
    expect(codeOnly('process.env["CRON_SECRET"]')).toBe("process.env.CRON_SECRET");
    expect(codeOnly("process.env['A_B']")).toBe("process.env.A_B");
    expect(codeOnly('process.env?.["X"]')).toBe("process.env?.X");
    expect(codeOnly('list["not an identifier"]')).toBe('list[""]');
    expect(codeOnly('process.env[name + "X"]')).toBe('process.env[name + ""]');
    expect(codeOnly('list[0]["A"]')).toBe("list[0].A");
    expect(codeOnly('get()["A"]')).toBe("get().A");
  });

  it("leaves a one-string array alone: it lists a name, it does not read one", () => {
    expect(codeOnly('const a = ["CRON_SECRET"];')).toBe('const a = [""];');
    expect(codeOnly('return ["A"]')).toBe('return [""]');
    expect(codeOnly('f(["A"], x)')).toBe('f([""], x)');
    expect(codeOnly('{ names: ["A"] }')).toBe('{ names: [""] }');
  });
});

describe("readsCronSecret", () => {
  it("accepts a property read, an indexed read and a destructured one", () => {
    expect(readsCronSecret("const s = getEnv().CRON_SECRET;")).toBe(true);
    expect(readsCronSecret('const s = process.env["CRON_SECRET"];')).toBe(true);
    expect(readsCronSecret("const { CRON_SECRET } = getEnv();")).toBe(true);
    expect(readsCronSecret("const { A, CRON_SECRET, B } = env;")).toBe(true);
    expect(readsCronSecret("check(`Bearer ${process.env.CRON_SECRET}`)")).toBe(true);
  });

  it("refuses the name in a string, a comment or a type", () => {
    expect(readsCronSecret('export const NAMES = ["CRON_SECRET"];')).toBe(false);
    expect(readsCronSecret("// compare with process.env.CRON_SECRET\nconst a = 1;")).toBe(false);
    expect(readsCronSecret("/* env.CRON_SECRET */ const a = 1;")).toBe(false);
    expect(readsCronSecret('const m = "env.CRON_SECRET is missing";')).toBe(false);
    expect(readsCronSecret("interface Env { CRON_SECRET: string }")).toBe(false);
    expect(readsCronSecret("const e: { CRON_SECRET: string } = { CRON_SECRET: 'x' };")).toBe(false);
  });
});

describe("cronProblems", () => {
  const route = (body: string) => ({ "src/app/api/cron/watch/route.ts": body });
  const cron = [{ path: "/api/cron/watch", schedule: "* * * * *" }];
  const NEVER_READS =
    "/api/cron/watch: the route never reads CRON_SECRET (Vercel sends it as a bearer token)";
  const GET_ONLY = "export async function GET() { return new Response(); }";

  it("accepts no crons, and a cron whose GET route compares the bearer token with the secret", () => {
    expect(cronProblems(tree({}), {})).toEqual([]);
    expect(cronProblems(tree({}), { crons: [] })).toEqual([]);
    const ok = tree(
      route(
        'export async function GET(req: Request) { return req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}` ? new Response("ok") : new Response(null, { status: 401 }); }',
      ),
    );
    expect(cronProblems(ok, { crons: cron })).toEqual([]);
  });

  it("accepts a route that reads the secret as an index, destructured, or through a helper it imports", () => {
    const indexed = tree(route('export const GET = async () => process.env["CRON_SECRET"];'));
    expect(cronProblems(indexed, { crons: cron })).toEqual([]);
    const destructured = tree(
      route(
        "export async function GET() { const { CRON_SECRET } = process.env; return CRON_SECRET; }",
      ),
    );
    expect(cronProblems(destructured, { crons: cron })).toEqual([]);
    const dir = tree({
      ...route(
        'import { authorized } from "@/lib/cron";\nexport const GET = async (r: Request) => authorized(r);',
      ),
      "src/lib/cron.ts":
        "export const authorized = (r: Request, s = process.env.CRON_SECRET) => !!s && !!r;",
    });
    expect(cronProblems(dir, { crons: cron })).toEqual([]);
  });

  it("flags a cron with no route, a route without GET, and one that never reads the secret", () => {
    expect(cronProblems(tree({}), { crons: cron })).toEqual([
      "/api/cron/watch: no route handler at src/app/api/cron/watch/route.ts",
    ]);
    expect(cronProblems(tree(route("export async function POST() {}")), { crons: cron })).toEqual([
      "/api/cron/watch: the route does not export GET (Vercel crons send GET)",
      NEVER_READS,
    ]);
    expect(cronProblems(tree(route(GET_ONLY)), { crons: cron })).toEqual([NEVER_READS]);
  });

  it("flags a route that imports a file which only lists the name as a string", () => {
    const dir = tree({
      ...route(
        'import { NAMES } from "@/lib/names";\nexport async function GET() { return NAMES; }',
      ),
      "src/lib/names.ts": 'export const NAMES = ["CRON_SECRET", "OTHER"];',
    });
    expect(cronProblems(dir, { crons: cron })).toEqual([NEVER_READS]);
  });

  it("flags a route that only mentions the name in a comment or a message", () => {
    const comment = tree(
      route(`// TODO check process.env.CRON_SECRET\n/* env.CRON_SECRET */\n${GET_ONLY}`),
    );
    expect(cronProblems(comment, { crons: cron })).toEqual([NEVER_READS]);
    const message = tree(
      route('export async function GET() { return new Response("set process.env.CRON_SECRET"); }'),
    );
    expect(cronProblems(message, { crons: cron })).toEqual([NEVER_READS]);
  });

  it("flags a route that imports the logger and does no auth", () => {
    const dir = tree({
      ...route(
        'import { log } from "@/lib/log";\nexport async function GET() { log.info("tick"); return new Response(); }',
      ),
      "src/lib/log.ts": [
        'const SECRET_ENV_NAMES = ["CRON_SECRET", "KEY_ENCRYPTION_SECRET"] as const;',
        "export const log = { info: (m: string) => process.env[SECRET_ENV_NAMES[0]] && m };",
        "export const masked = () => process.env.CRON_SECRET;",
      ].join("\n"),
    });
    expect(cronProblems(dir, { crons: cron })).toEqual([NEVER_READS]);
  });

  it("does not count the env loader, which names every variable", () => {
    const dir = tree({
      ...route(
        'import { getEnv } from "@/lib/env";\nexport async function GET() { getEnv(); return new Response(); }',
      ),
      "src/lib/env.ts": "export const getEnv = () => ({ CRON_SECRET: process.env.CRON_SECRET });",
    });
    expect(cronProblems(dir, { crons: cron })).toEqual([NEVER_READS]);
  });

  it("accepts any five-field schedule (names, lists, ranges, steps) and a query string in the path", () => {
    const dir = tree(route("export async function GET() { return process.env.CRON_SECRET; }"));
    expect(
      cronProblems(dir, {
        crons: [
          { path: "/api/cron/watch", schedule: "0 9 * * MON" },
          { path: "/api/cron/watch?kind=a", schedule: "*/5 1,3-5 1-15/2 JAN-MAR 1,3-5" },
        ],
      }),
    ).toEqual([]);
  });

  it("finds the route by the path alone, and still reports a missing one with its query", () => {
    expect(
      cronProblems(tree({}), { crons: [{ path: "/api/cron/gone?x=1", schedule: "* * * * *" }] }),
    ).toEqual(["/api/cron/gone?x=1: no route handler at src/app/api/cron/gone/route.ts"]);
  });

  it("flags a duplicate path, a path outside /api and a schedule that is not five fields", () => {
    const dir = tree(route("export async function GET() { return process.env.CRON_SECRET; }"));
    const got = cronProblems(dir, {
      crons: [
        { path: "/api/cron/watch", schedule: "* * * * *" },
        { path: "/api/cron/watch", schedule: "every minute" },
        { path: "/cron/x", schedule: "5 * * * * *" },
      ],
    });
    expect(got).toContain("/api/cron/watch: listed twice");
    expect(got).toContain(
      '/api/cron/watch: schedule "every minute" is not a five-field cron expression',
    );
    expect(got).toContain("/cron/x: a cron path must start with /api/");
    expect(got).toContain('/cron/x: schedule "5 * * * * *" is not a five-field cron expression');
  });
});

describe("scriptTargets", () => {
  it("finds the files that tsx and node run, and ignores other commands", () => {
    expect(
      scriptTargets({
        a: "tsx scripts/a.ts",
        b: "tsx --tsconfig x.json scripts/b.mts --apply",
        c: "node scripts/c.mjs && next build",
        d: "next dev",
        e: "vitest run",
        f: "playwright test",
      }),
    ).toEqual([
      { script: "a", file: "scripts/a.ts" },
      { script: "b", file: "scripts/b.mts" },
      { script: "c", file: "scripts/c.mjs" },
    ]);
  });
});

describe("environment variables", () => {
  it("reads the table of section 14 and stops at the next section", () => {
    const spec = [
      "## 13. Something",
      "| `NOT_THIS` | x |",
      "## 14. Environment variables",
      "| Name | Used by |",
      "|---|---|",
      "| `NEAR_NETWORK` | all |",
      "| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | web |",
      "Some prose with `NOT_A_ROW` in it.",
      "## 16. Evidence",
      "| `ALSO_NOT` | x |",
    ].join("\n");
    expect(specEnvNames(spec)).toEqual([
      "NEAR_NETWORK",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]);
    expect(() => specEnvNames("## 1. Intro")).toThrow(/section 14/);
  });

  it("reads NAME=value lines and skips comments", () => {
    const got = parseDotenv("# A=1\nA=\nB=x\n  C=3\nD=y=z\n");
    expect([...got]).toEqual([
      ["A", ""],
      ["B", "x"],
      ["D", "y=z"],
    ]);
  });

  it("finds the variable names the code reads, however it reads them", () => {
    const dir = tree({
      "src/lib/env.ts": [
        "export interface Env {",
        "  NEAR_NETWORK: string;",
        "  CRON_SECRET: string;",
        "  OPTIONAL_THING?: string;",
        "}",
        "export function load(src: Record<string, string | undefined>) { return src.FROM_SRC; }",
      ].join("\n"),
      "src/lib/a.ts": 'export const a = process.env.DIRECT + process.env["QUOTED"] + env.FROM_ENV;',
      "src/lib/b.ts": [
        "const { DESTRUCTURED, RENAMED: r, ...rest } = process.env;",
        "const chained = process.env?.OPTIONAL_CHAIN;",
        "const e = process.env;",
        "export const aliased = e.ALIASED;",
        "export function f(cfg: Record<string, string | undefined> = process.env) {",
        "  return cfg.PARAM_ALIAS;",
        "}",
        "// process.env.IN_A_COMMENT and e.COMMENTED_ALIAS",
        'export const s = "process.env.IN_A_STRING";',
      ].join("\n"),
      "src/lib/log.ts": 'const SECRET_ENV_NAMES = [\n  "MASKED_ONE",\n  "MASKED_TWO",\n] as const;',
      "src/lib/palette.ts": 'export const COLOR_NAMES = ["NOT_A_VARIABLE"];',
      "scripts/run.ts": 'const NAMES = ["NO_ENV_IN_THE_LIST_NAME"] as const;',
      "scripts/req.ts": 'const REQUIRED_ENV_NAMES = ["SCRIPT_INPUT"] as const;',
      "src/lib/a.test.ts": "process.env.IN_A_TEST_ONLY;",
      "next.config.ts": "export default { env: { NEXT_PUBLIC_X: process.env.FROM_NEXT_CONFIG } };",
    });
    expect([...envNamesRead(dir).keys()].sort()).toEqual([
      "ALIASED",
      "CRON_SECRET",
      "DESTRUCTURED",
      "DIRECT",
      "FROM_ENV",
      "FROM_NEXT_CONFIG",
      "FROM_SRC",
      "MASKED_ONE",
      "MASKED_TWO",
      "NEAR_NETWORK",
      "OPTIONAL_CHAIN",
      "OPTIONAL_THING",
      "PARAM_ALIAS",
      "QUOTED",
      "RENAMED",
      "SCRIPT_INPUT",
    ]);
  });

  it("finds every NEXT_PUBLIC_ name", () => {
    expect(
      nextPublicNames("a NEXT_PUBLIC_A, process.env.NEXT_PUBLIC_B_C and NEXT_PUBLIC_A again"),
    ).toEqual(["NEXT_PUBLIC_A", "NEXT_PUBLIC_B_C"]);
    expect(nextPublicNames("PUBLIC_NOT and the bare NEXT_PUBLIC_ prefix")).toEqual([]);
  });
});

describe("migrationProblems", () => {
  const f = (name: string, sql = "select 1;") => ({ name, sql });
  const good = [
    f("20261108000001_core.sql"),
    f("20261108000002_api.sql"),
    f("20261109000003_keys.sql"),
  ];

  it("accepts an ordered, gap-free set whose dates move forward", () => {
    expect(migrationProblems(good)).toEqual([]);
    expect(migrationProblems([...good, f("20261111000004_watcher.sql")])).toEqual([]);
  });

  it("flags a gap, a repeat, a bad name and a version that sorts before its predecessor", () => {
    expect(migrationProblems([good[0] as never, f("20261108000003_x.sql")])).toEqual([
      "20261108000003_x.sql: sequence 3 where 2 was expected (no gaps, no repeats)",
    ]);
    expect(migrationProblems([good[0] as never, f("20261108000001_dup.sql")])).toContain(
      "20261108000001_dup.sql: sequence 1 where 2 was expected (no gaps, no repeats)",
    );
    expect(migrationProblems([f("0001_core.sql")])).toEqual([
      "0001_core.sql: name must be <YYYYMMDD><6-digit sequence>_<snake_case>.sql",
    ]);
    expect(migrationProblems([f("20261109000001_a.sql"), f("20261108000002_b.sql")])).toEqual([
      "20261108000002_b.sql: version 20261108000002 does not sort after 20261109000001_a.sql",
    ]);
  });

  it("flags SQL that a hosted Supabase would run differently or refuse", () => {
    const bad = (sql: string) => migrationProblems([f("20261108000001_x.sql", sql)]);
    expect(bad("create extension if not exists pgcrypto;")).toEqual([
      '20261108000001_x.sql: creates extension "pgcrypto", which is not on the allowed list',
    ]);
    expect(bad("alter table t owner to postgres;").length).toBeGreaterThan(0);
    expect(bad("create role app login;")).toHaveLength(1);
    expect(bad("grant all on t to postgres;")).toHaveLength(1);
    expect(bad("alter table t owner to supabase_admin;").length).toBeGreaterThan(0);
    expect(bad("select cron.schedule('x', '* * * * *', 'select 1');")).toHaveLength(1);
    expect(bad("select net.http_get('https://x');")).toHaveLength(1);
    expect(bad("select auth.uid();")).toHaveLength(1);
    expect(bad("select * from auth.users;")).toHaveLength(1);
    expect(bad("set role postgres;")).toHaveLength(1);
    expect(
      bad(
        "alter default privileges for role postgres in schema public revoke all on tables from anon;",
      ),
    ).toEqual([
      "20261108000001_x.sql: sets default privileges for a named role: the hosted roles differ",
    ]);
    expect(
      bad("ALTER DEFAULT PRIVILEGES FOR USER app GRANT SELECT ON TABLES TO anon;"),
    ).toHaveLength(1);
    // Dynamic SQL in an execute string really runs, so it is read.
    expect(
      bad("do $$ begin execute 'alter table t owner to postgres'; end $$;").length,
    ).toBeGreaterThan(0);
    expect(
      bad("do $$ begin execute format('create role %I', 'x'); end $$;").length,
    ).toBeGreaterThan(0);
  });

  it("does not read prose inside a quoted string as a statement", () => {
    const ok = (sql: string) => migrationProblems([f("20261108000001_x.sql", sql)]);
    expect(ok("select 'alter table t owner to postgres' as note;")).toEqual([]);
    expect(ok("insert into t (msg) values ('create role x; set role postgres');")).toEqual([]);
    expect(ok("do $$ begin raise exception 'cannot reach postgres: it''s down'; end $$;")).toEqual(
      [],
    );
    expect(ok("comment on table t is 'owned by supabase_admin';")).toEqual([]);
  });

  it("empties quoted strings, keeps escaped quotes inside them, and keeps execute strings", () => {
    expect(stripSqlStrings("select 'a', 'it''s', 'b';")).toBe("select '', '', '';");
    expect(stripSqlStrings("execute 'grant x'; execute format('y'); raise 'z';")).toBe(
      "execute 'grant x'; execute format('y'); raise '';",
    );
  });

  it("leaves alone comments, a column called role, and ordinary DDL", () => {
    const ok = (sql: string) => migrationProblems([f("20261108000001_x.sql", sql)]);
    expect(ok("-- owner to postgres, create extension pgcrypto, auth.uid()\nselect 1;")).toEqual(
      [],
    );
    expect(ok("/* create role x; */ select 1;")).toEqual([]);
    expect(ok("insert into t values (1) on conflict (a) do update set role = 'owner';")).toEqual(
      [],
    );
    expect(ok("update t set role = 'viewer' where a = 1;")).toEqual([]);
    expect(ok("select '--not a comment' as x; -- but this is")).toEqual([]);
  });

  it("strips comments but keeps quoted dashes", () => {
    expect(stripSqlComments("select '--x'; -- y\n/* z */ select 2;")).toBe(
      "select '--x'; \n  select 2;",
    );
  });
});
