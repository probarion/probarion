// Deploy guardrails. They describe the tree as it is, so they stay green as tasks add routes, crons,
// migrations and variables, and go red when one of them would break the first deploy.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FOOTER_NAV, PLANNED_ROUTES, SITE_NAV, VAULT_TABS } from "@/lib/routes";
import { freshDb } from "./db/harness";
import {
  appRoutes,
  builtPlannedRoutes,
  clientBoundaryViolations,
  cronProblems,
  deadLinks,
  directives,
  envNamesRead,
  hrefResolves,
  isSourceFile,
  migrationProblems,
  nextPublicNames,
  parseDotenv,
  scriptTargets,
  specEnvNames,
  walk,
} from "./deploy-scan";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "..", "..");
const text = (...p: string[]) => readFileSync(join(...p), "utf8");

const ENV_EXAMPLE = text(ROOT, ".env.example");
const SPEC = text(ROOT, "docs", "specs", "2026-10-21-probarion-interfaces.md");
const PACKAGE = JSON.parse(text(WEB, "package.json")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};
const VERCEL = JSON.parse(text(WEB, "vercel.json")) as {
  framework?: string;
  regions?: string[];
  installCommand?: string;
  buildCommand?: string;
  headers?: unknown;
  crons?: { path: string; schedule: string }[];
};

/** Set by Vercel or Node, not by us: never listed in .env.example. */
const platformVariable = (name: string) =>
  name === "NODE_ENV" || name === "NEXT_RUNTIME" || name === "CI" || name.startsWith("VERCEL_");
/** Inputs of the one-off `rotate-keys` command: they must not sit in an .env file next to the live key. */
const ROTATION_INPUTS = ["OLD_KEY_ENCRYPTION_SECRET", "NEW_KEY_ENCRYPTION_SECRET"];
/** An input of the one-off `telegram-webhook` script (docs/ops/alerts.md). The app itself never reads it: it takes its origin from Vercel. */
const SCRIPT_INPUTS = ["APP_ORIGIN"];
/** Public by design (§14, and the two next.config.ts derives from SENTRY_DSN and NEAR_NETWORK). */
const PUBLIC_ALLOWED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SENTRY_DSN",
  "NEXT_PUBLIC_NEAR_NETWORK",
];
const SECRET_NAME = /SECRET|KEY|TOKEN|JWT|PASSWORD|DSN|HEARTBEAT/;

describe("environment variables", () => {
  const example = parseDotenv(ENV_EXAMPLE);

  it("lists every interfaces §14 variable in .env.example", () => {
    const spec = specEnvNames(SPEC);
    expect(spec.length).toBeGreaterThan(20);
    expect(spec.filter((n) => !example.has(n))).toEqual([]);
  });

  it("lists every variable the web app reads in .env.example", () => {
    const read = envNamesRead(WEB);
    expect(read.size).toBeGreaterThan(15);
    // next.config.ts derives NEXT_PUBLIC_SENTRY_DSN and NEXT_PUBLIC_NEAR_NETWORK from variables listed here.
    const derived = nextPublicNames(text(WEB, "next.config.ts"));
    const missing = [...read]
      .filter(
        ([n]) =>
          !platformVariable(n) &&
          !ROTATION_INPUTS.includes(n) &&
          !SCRIPT_INPUTS.includes(n) &&
          !derived.includes(n) &&
          !example.has(n),
      )
      .map(([n, files]) => `${n} (read in ${files.join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("names every .env.example variable in the OWNER deploy runbook", () => {
    const runbook = text(ROOT, "docs", "runbooks", "web-deploy.md");
    expect([...example.keys()].filter((n) => !runbook.includes(n))).toEqual([]);
  });

  it("keeps the key-rotation inputs out of .env.example and in the runbook", () => {
    const runbook = text(ROOT, "docs", "ops", "key-rotation.md");
    const rotateCli = text(WEB, "src", "lib", "keys", "rotate-cli.ts");
    for (const name of ROTATION_INPUTS) {
      expect(example.has(name), `${name} in .env.example`).toBe(false);
      expect(runbook, name).toContain(name);
      expect(rotateCli, `${name} read by rotate-keys`).toContain(name);
    }
  });

  it("keeps the Telegram setup script's own input out of .env.example, read by that script alone, and in its runbook", () => {
    const runbook = text(ROOT, "docs", "ops", "alerts.md");
    for (const name of SCRIPT_INPUTS) {
      expect(example.has(name), `${name} in .env.example`).toBe(false);
      expect(runbook, name).toContain(name);
      expect(envNamesRead(WEB).get(name), `where ${name} is read`).toEqual([
        "src/lib/alerts/webhook-setup.ts",
      ]);
    }
  });

  it("requires KEY_ENCRYPTION_SECRET and lists each variable once, with every secret empty", () => {
    expect(example.has("KEY_ENCRYPTION_SECRET")).toBe(true);
    const lines = ENV_EXAMPLE.split(/\r?\n/).flatMap(
      (l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1] ?? [],
    );
    expect(lines.filter((n, i) => lines.indexOf(n) !== i)).toEqual([]);
    const filled = [...example].filter(([n, v]) => SECRET_NAME.test(n) && v !== "").map(([n]) => n);
    expect(filled).toEqual([]);
  });
});

describe("NEXT_PUBLIC_ exposure", () => {
  const shipped = [
    ...walk(join(WEB, "src")).filter(isSourceFile),
    ...walk(join(WEB, "scripts")).filter(isSourceFile),
    join(WEB, "next.config.ts"),
    join(WEB, "vercel.json"),
    join(ROOT, ".env.example"),
    join(ROOT, "docs", "runbooks", "web-deploy.md"),
  ].filter(existsSync);
  const used = new Map<string, string[]>();
  for (const f of shipped) {
    for (const n of nextPublicNames(readFileSync(f, "utf8"))) {
      used.set(n, [...(used.get(n) ?? []), f.slice(ROOT.length + 1)]);
    }
  }

  it("exposes only the public names", () => {
    const leaked = [...used]
      .filter(([n]) => !PUBLIC_ALLOWED.includes(n))
      .map(([n, f]) => `${n} in ${f.join(", ")}`);
    expect(leaked).toEqual([]);
  });

  it("never lets a secret-looking variable onto the allowed list", () => {
    expect(
      PUBLIC_ALLOWED.filter(
        (n) =>
          SECRET_NAME.test(n) &&
          n !== "NEXT_PUBLIC_SUPABASE_ANON_KEY" &&
          n !== "NEXT_PUBLIC_SENTRY_DSN",
      ),
    ).toEqual([]);
  });

  it("gives no variable in .env.example, nor the master key or its previous value, a NEXT_PUBLIC_ form", () => {
    const secrets = [...parseDotenv(ENV_EXAMPLE).keys()].filter((n) => SECRET_NAME.test(n));
    const names = [...secrets, "KEY_ENCRYPTION_SECRET", "KEY_ENCRYPTION_SECRET_PREVIOUS"].map(
      (n) => `NEXT_PUBLIC_${n}`,
    );
    const exposed = names.filter((n) => used.has(n) && !PUBLIC_ALLOWED.includes(n));
    expect(exposed).toEqual([]);
  });
});

describe("migrations", () => {
  const dir = join(WEB, "supabase", "migrations");
  const files = walk(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ name: f.slice(dir.length + 1), sql: readFileSync(f, "utf8") }));

  it("are ordered, gap-free and portable to a hosted Supabase", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(migrationProblems(files)).toEqual([]);
  });

  it("apply, in order, to a fresh database", async () => {
    const pg = await freshDb();
    try {
      const r = await pg.query<{ n: number }>(
        "select count(*)::int as n from pg_tables where schemaname = 'public'",
      );
      expect(r.rows[0]?.n ?? 0).toBeGreaterThan(0);
    } finally {
      await pg.close();
    }
  });
});

describe("vercel.json", () => {
  it("builds Next.js in one region", () => {
    expect(VERCEL.framework).toBe("nextjs");
    expect(VERCEL.regions?.length ?? 0).toBeGreaterThan(0);
  });

  it("leaves the install command alone: an override makes Vercel use the oldest pnpm", () => {
    expect(VERCEL.installCommand).toBeUndefined();
  });

  it("pins pnpm through packageManager, and the runbook sets the Corepack switch that makes Vercel read it", () => {
    // Vercel documents Corepack plus packageManager as the way to name the pnpm of a build. Without the
    // variable, builders pick a pnpm 10 on their own (from the pin, or from the project's creation date):
    // that is not documented, and not necessarily the pinned version.
    const root = JSON.parse(text(ROOT, "package.json")) as { packageManager?: string };
    const version = /^pnpm@(10\.\d+\.\d+)$/.exec(root.packageManager ?? "")?.[1];
    expect(version, "root package.json packageManager is pnpm@10.x.y").toBeDefined();
    const runbook = text(ROOT, "docs", "runbooks", "web-deploy.md");
    expect(runbook).toContain("ENABLE_EXPERIMENTAL_COREPACK");
    expect(runbook, "the build-log check names the pinned version").toContain(`pnpm ${version}`);
    // Every pnpm version the page names is the pinned one, so a bump cannot leave a stale mention.
    const named = [...runbook.matchAll(/pnpm[@ ]v?(10\.\d+\.\d+)/g)].map((m) => m[1]);
    expect(named.length, "the runbook names the pinned version").toBeGreaterThan(0);
    expect(
      named.filter((v) => v !== version),
      `pnpm versions on the page other than ${version}`,
    ).toEqual([]);
    // A Vercel build setting the console never reads: .env.example lists what the console reads.
    expect(parseDotenv(ENV_EXAMPLE).has("ENABLE_EXPERIMENTAL_COREPACK")).toBe(false);
  });

  it("builds the workspace packages that the app loads from dist, before next build", () => {
    const build = VERCEL.buildCommand ?? "";
    expect(PACKAGE.scripts.build).toBe("next build");
    expect(/(^|&&\s*)(pnpm run build|pnpm build|next build)$/.test(build.trim())).toBe(true);
    for (const name of Object.entries(PACKAGE.dependencies)
      .filter(([, v]) => v.startsWith("workspace:"))
      .map(([n]) => n)) {
      const covered =
        build.includes("@probarion/web^...") ||
        build.includes(`--filter ${name}`) ||
        /\s(-r|--recursive)\s/.test(build);
      expect(covered, `buildCommand builds ${name}`).toBe(true);
    }
  });

  it("leaves headers to next.config.ts, the single place the security headers are defined", () => {
    expect(VERCEL.headers).toBeUndefined();
  });

  it("gives every cron a GET route that reads CRON_SECRET", () => {
    expect(cronProblems(WEB, VERCEL)).toEqual([]);
  });

  it("runs the watcher and the usage numbers once a day, the most the Vercel Hobby plan accepts", () => {
    // The Hobby plan rejects a more frequent schedule when it deploys. The per-minute watcher is a Supabase Cron job the
    // OWNER turns on (docs/ops/watcher.md); a project on a paid plan changes these two lines and this test on purpose.
    expect(VERCEL.crons).toEqual([
      { path: "/api/cron/watch", schedule: "0 0 * * *" },
      { path: "/api/cron/metrics", schedule: "10 0 * * *" },
    ]);
  });
});

describe("client components", () => {
  it("find at least one client component to check", () => {
    const clients = walk(join(WEB, "src"))
      .filter(isSourceFile)
      .filter((f) => directives(readFileSync(f, "utf8")).includes("use client"));
    expect(clients.length).toBeGreaterThan(5);
  });

  it("never reach a server-only module or a server secret, directly or through what they import", () => {
    expect(clientBoundaryViolations(WEB)).toEqual([]);
  });
});

describe("package scripts", () => {
  /** Scripts whose file a later task adds. Delete the entry when it lands: the test below says so. */
  const KNOWN_GAPS: Record<string, string> = {
    "test:e2e": "Task 22 (smoke e2e) adds playwright.config.ts",
  };
  const exists = (rel: string) => existsSync(join(WEB, rel));
  const unresolved = (): string[] => {
    const out = new Set<string>();
    for (const t of scriptTargets(PACKAGE.scripts)) if (!exists(t.file)) out.add(t.script);
    for (const [script, cmd] of Object.entries(PACKAGE.scripts)) {
      if (
        /\bplaywright\s+test\b/.test(cmd) &&
        !["ts", "js", "mjs"].some((e) => exists(`playwright.config.${e}`))
      ) {
        out.add(script);
      }
    }
    return [...out].sort();
  };

  it("point at files that exist, apart from the known gaps", () => {
    expect(unresolved().filter((s) => !(s in KNOWN_GAPS))).toEqual([]);
  });

  it("list only gaps that are still gaps", () => {
    expect(Object.keys(KNOWN_GAPS).filter((s) => !unresolved().includes(s))).toEqual([]);
  });

  for (const [script, owner] of Object.entries(KNOWN_GAPS)) it.todo(`${script}: ${owner}`);
});

describe("links", () => {
  const patterns = appRoutes(WEB);

  it("find the app's pages", () => {
    expect(patterns).toContain("/");
    expect(patterns).toContain("/login");
    expect(patterns).toContain("/console/[vault]");
  });

  it("point at a page, a route handler or a public file", () => {
    expect(deadLinks(WEB, PLANNED_ROUTES)).toEqual([]);
  });

  it("are planned only while their page does not exist", () => {
    const built = builtPlannedRoutes(WEB, PLANNED_ROUTES);
    expect(
      built,
      `these planned pages are built, so delete these lines from PLANNED_ROUTES in src/lib/routes.ts: ${built.join(", ")}`,
    ).toEqual([]);
  });

  it("are listed in the navigation only when they exist or are planned", () => {
    const routes = [
      ...SITE_NAV.map((i) => i.route),
      ...FOOTER_NAV.map((i) => i.route),
      ...VAULT_TABS.map((t) => `/console/[vault]${t.path}`),
    ];
    expect(
      routes.filter((r) => !PLANNED_ROUTES.includes(r) && !hrefResolves(r, patterns, [])),
    ).toEqual([]);
  });
});
