// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures spell out JSX and template-literal source text
// The scanners behind the deploy guardrails must fail on a broken tree, or a green deploy.test.ts proves nothing.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appRoutes,
  clientBoundaryViolations,
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
  scriptTargets,
  specEnvNames,
  stripSqlComments,
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
});

describe("cronProblems", () => {
  const route = (body: string) => ({ "src/app/api/cron/watch/route.ts": body });
  const cron = [{ path: "/api/cron/watch", schedule: "* * * * *" }];

  it("accepts no crons, and a cron whose GET route checks CRON_SECRET", () => {
    expect(cronProblems(tree({}), {})).toEqual([]);
    expect(cronProblems(tree({}), { crons: [] })).toEqual([]);
    const ok = tree(
      route(
        'export async function GET(req: Request) { return req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}` ? new Response("ok") : new Response(null, { status: 401 }); }',
      ),
    );
    expect(cronProblems(ok, { crons: cron })).toEqual([]);
  });

  it("accepts a route that checks the secret through a helper it imports", () => {
    const dir = tree({
      ...route(
        'import { authorized } from "@/lib/cron";\nexport const GET = async (r: Request) => authorized(r);',
      ),
      "src/lib/cron.ts":
        "export const authorized = (r: Request, s = process.env.CRON_SECRET) => !!s && !!r;",
    });
    expect(cronProblems(dir, { crons: cron })).toEqual([]);
  });

  it("flags a cron with no route, a route without GET, and one that never checks the secret", () => {
    expect(cronProblems(tree({}), { crons: cron })).toEqual([
      "/api/cron/watch: no route handler at src/app/api/cron/watch/route.ts",
    ]);
    expect(cronProblems(tree(route("export async function POST() {}")), { crons: cron })).toEqual([
      "/api/cron/watch: the route does not export GET (Vercel crons send GET)",
      "/api/cron/watch: the route never checks CRON_SECRET (Vercel sends it as a bearer token)",
    ]);
    expect(
      cronProblems(tree(route("export async function GET() { return new Response(); }")), {
        crons: cron,
      }),
    ).toEqual([
      "/api/cron/watch: the route never checks CRON_SECRET (Vercel sends it as a bearer token)",
    ]);
  });

  it("does not count the env loader, which names every variable, as a check", () => {
    const dir = tree({
      ...route(
        'import { getEnv } from "@/lib/env";\nexport async function GET() { getEnv(); return new Response(); }',
      ),
      "src/lib/env.ts": "export const getEnv = () => ({ CRON_SECRET: process.env.CRON_SECRET });",
    });
    expect(cronProblems(dir, { crons: cron })).toEqual([
      "/api/cron/watch: the route never checks CRON_SECRET (Vercel sends it as a bearer token)",
    ]);
  });

  it("flags a duplicate path, a path outside /api and a bad schedule", () => {
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
      "src/lib/log.ts": 'const SECRET_ENV_NAMES = [\n  "MASKED_ONE",\n  "MASKED_TWO",\n] as const;',
      "scripts/run.ts": 'const NAMES = ["SCRIPT_INPUT"] as const;',
      "src/lib/a.test.ts": "process.env.IN_A_TEST_ONLY;",
      "next.config.ts": "export default { env: { NEXT_PUBLIC_X: process.env.FROM_NEXT_CONFIG } };",
    });
    expect([...envNamesRead(dir).keys()].sort()).toEqual([
      "CRON_SECRET",
      "DIRECT",
      "FROM_ENV",
      "FROM_NEXT_CONFIG",
      "FROM_SRC",
      "MASKED_ONE",
      "MASKED_TWO",
      "NEAR_NETWORK",
      "OPTIONAL_THING",
      "QUOTED",
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
