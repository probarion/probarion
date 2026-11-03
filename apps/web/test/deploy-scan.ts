// Scanners behind the deploy guardrails in deploy.test.ts. Each takes a root directory (or plain text), so
// deploy-scan.test.ts can prove it fails on a deliberately broken tree. Nothing here reads the network.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** R11: paths are compared with "/" on every platform. */
export const toPosix = (p: string): string => p.split(sep).join("/");

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "coverage"]);

/** Every file under `dir`, sorted, as absolute paths. A missing directory has no files. */
export function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export const isTestFile = (f: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
export const isSourceFile = (f: string): boolean =>
  /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts") && !isTestFile(f);

/** The directive prologue of a module ("use client", "use server"), read past leading comments. */
export function directives(src: string): string[] {
  const out: string[] = [];
  let s = src;
  for (;;) {
    s = s.replace(/^\s+/, "");
    if (s.startsWith("//")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1);
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      if (end === -1) return out;
      s = s.slice(end + 2);
    } else {
      const m = /^(["'])([^"'\n]*)\1\s*;?/.exec(s);
      if (!m) return out;
      out.push(m[2] ?? "");
      s = s.slice(m[0].length);
    }
  }
}

export interface Import {
  spec: string;
  /** `import type …` or an import whose every specifier is `type X`: erased by the compiler. */
  typeOnly: boolean;
}

/**
 * The module specifiers a source file loads: static import and re-export, side-effect import, dynamic
 * `import("x")` and `require("x")`. Statements must start their line, so a commented-out import is not seen.
 */
export function importsOf(src: string): Import[] {
  const out: Import[] = [];
  const staticRe = /^[ \t]*(?:import|export)\s+([\w\s,{}*$]+?)\s*\bfrom\s*(["'])([^"'\n]+)\2/gm;
  for (const m of src.matchAll(staticRe)) {
    const clause = (m[1] ?? "").trim();
    const named = (/\{([^}]*)\}/.exec(clause)?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const inlineAllTypes =
      named.length > 0 &&
      named.every((s) => /^type\s/.test(s)) &&
      clause.replace(/\{[^}]*\}/, "").trim() === "";
    out.push({ spec: m[3] ?? "", typeOnly: /^type\s/.test(clause) || inlineAllTypes });
  }
  for (const m of src.matchAll(/^[ \t]*import\s*(["'])([^"'\n]+)\1/gm)) {
    out.push({ spec: m[2] ?? "", typeOnly: false });
  }
  for (const m of src.matchAll(/\b(?:import|require)\(\s*(["'])([^"'\n]+)\1\s*\)/g)) {
    out.push({ spec: m[2] ?? "", typeOnly: false });
  }
  return out;
}

const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx"];

/** Resolves a relative or `@/` specifier to a file under the web app, or null for a package. */
export function resolveLocal(spec: string, fromFile: string, srcRoot: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(srcRoot, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) base = join(dirname(fromFile), spec);
  else return null;
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// --- client boundary ------------------------------------------------------------------------------

/** Modules that must never reach the browser even if a file forgets its `server-only` import. */
const SERVER_ONLY_PATHS: readonly RegExp[] = [
  /^lib\/env$/,
  /^lib\/db\/clients$/,
  /^lib\/crypto\/server$/,
  /^lib\/auth\/guard$/,
  /^lib\/near\/server$/,
  /^lib\/sdk\//,
];

/** Packages and built-ins that only exist (or only make sense) on the server. */
const SERVER_ONLY_PACKAGES: readonly RegExp[] = [
  /^server-only$/,
  /^node:/,
  /^next\/headers$/,
  /^libsodium(-wrappers)?$/,
  /^pdf-parse$/,
  /^resend$/,
];

function stripExt(p: string): string {
  return p.replace(/(\/index)?\.[cm]?[jt]sx?$/, "");
}

/** `process.env.X` names a module reads, `*` for a computed `process.env[...]`. */
export function processEnvReads(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1] ?? "");
  for (const m of src.matchAll(/\bprocess\.env\[\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g)) {
    out.add(m[2] ?? "");
  }
  if (/\bprocess\.env\[\s*(?!["'][A-Za-z_][A-Za-z0-9_]*["']\s*\])/.test(src)) out.add("*");
  return [...out].sort();
}

const BROWSER_ENV = (name: string): boolean =>
  name === "NODE_ENV" || name.startsWith("NEXT_PUBLIC_");

/**
 * For every `"use client"` module under `<webDir>/src`, follows its imports (relative and `@/`, transitively,
 * type-only imports skipped) and reports each path that reaches server-only code or a server-only secret.
 * A `"use server"` module is a boundary: the compiler replaces its exports with action references, so what it
 * imports never ships to the browser.
 */
export function clientBoundaryViolations(webDir: string): string[] {
  const srcRoot = join(webDir, "src");
  const files = walk(srcRoot).filter(isSourceFile);
  const rel = (f: string) => toPosix(relative(webDir, f));
  const text = new Map<string, string>();
  const read = (f: string): string => {
    let s = text.get(f);
    if (s === undefined) {
      s = readFileSync(f, "utf8");
      text.set(f, s);
    }
    return s;
  };

  const problems: string[] = [];
  for (const entry of files) {
    if (!directives(read(entry)).includes("use client")) continue;
    const parent = new Map<string, string | null>([[entry, null]]);
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      const src = read(file);
      const chain = (): string => {
        const names: string[] = [];
        for (let f: string | null | undefined = file; f; f = parent.get(f)) names.unshift(rel(f));
        return names.join(" -> ");
      };
      const why: string[] = [];
      if (SERVER_ONLY_PATHS.some((re) => re.test(stripExt(toPosix(relative(srcRoot, file)))))) {
        why.push("is a server-only module");
      }
      for (const name of processEnvReads(src)) {
        if (name === "*") why.push("reads process.env by a computed name");
        else if (!BROWSER_ENV(name))
          why.push(`reads process.env.${name}, which the browser never gets`);
      }
      const next: string[] = [];
      for (const imp of importsOf(src)) {
        if (imp.typeOnly) continue;
        if (SERVER_ONLY_PACKAGES.some((re) => re.test(imp.spec))) {
          why.push(`imports "${imp.spec}"`);
          continue;
        }
        const target = resolveLocal(imp.spec, file, srcRoot);
        if (target === null || !/\.(ts|tsx)$/.test(target) || parent.has(target)) continue;
        parent.set(target, file);
        if (!directives(read(target)).includes("use server")) next.push(target);
      }
      if (why.length > 0) problems.push(`${chain()}: ${why.join("; ")}`);
      else queue.push(...next);
    }
  }
  return problems;
}

// --- routes and links -----------------------------------------------------------------------------

/** A `src/app` route pattern such as `/console/[vault]/keys`, from every `page.*` and `route.*` file. */
export function appRoutes(webDir: string): string[] {
  const appRoot = join(webDir, "src", "app");
  const routes = new Set<string>();
  for (const f of walk(appRoot)) {
    const base = toPosix(relative(appRoot, f));
    const m = /^(?:(.*)\/)?(page|route)\.(?:tsx?|jsx?|mdx)$/.exec(base);
    if (!m) continue;
    const segments = (m[1] ?? "")
      .split("/")
      .filter(Boolean)
      // (group) and @slot folders add nothing to the URL; _private folders are not routable.
      .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    if (segments.some((s) => s.startsWith("_"))) continue;
    routes.add(`/${segments.join("/")}`);
  }
  return [...routes].sort();
}

/** Files served as-is from `public/`, as URL paths. */
export function publicPaths(webDir: string): string[] {
  const root = join(webDir, "public");
  return walk(root).map((f) => `/${toPosix(relative(root, f))}`);
}

const DYNAMIC = "\u0000";

/**
 * Does `href` land on a page, a route handler or a public file? A `${…}` hole or a `[param]` segment in
 * `href` stands for a value, and matches only a dynamic segment of the pattern.
 */
export function hrefResolves(
  href: string,
  patterns: readonly string[],
  files: readonly string[],
): boolean {
  const path = href.replace(/[?#].*$/, "");
  if (files.includes(path)) return true;
  const segs = path
    .replace(/\$\{[^}]*\}|\[[^\]/]*\]/g, DYNAMIC)
    .split("/")
    .filter(Boolean);
  return patterns.some((pattern) => {
    const want = pattern.split("/").filter(Boolean);
    for (let i = 0; i < want.length; i++) {
      const w = want[i] ?? "";
      if (/^\[\[\.\.\..+\]\]$/.test(w)) return true; // optional catch-all: zero or more segments
      if (/^\[\.\.\..+\]$/.test(w)) return segs.length > i; // catch-all: one or more
      const got = segs[i];
      if (got === undefined) return false;
      if (/^\[.+\]$/.test(w)) continue; // a dynamic segment takes any single segment
      if (got.includes(DYNAMIC) || got !== w) return false;
    }
    return segs.length === want.length;
  });
}

export interface LinkRef {
  kind: "href" | "redirect" | "route";
  value: string;
  /** For the address a <RouteLink> shows: the route that decides whether it is clickable at all. */
  via?: string;
}

const attr = (name: string, flags = "") =>
  new RegExp(`\\b${name}\\s*=\\s*(?:\\{\\s*)?(["'\`])([^"'\`]*)\\1`, flags);

/**
 * The internal links a component or page spells out: `href="/x"`, `href={"/x"}`, ``href={`/x/${id}`}``,
 * `redirect("/x")` and `<RouteLink route="/x">`. Anything computed is skipped; so is anything that is not an
 * absolute path on this site (external URLs, `mailto:`, `#anchors`, `data:`).
 */
export function linksIn(src: string): LinkRef[] {
  const out: LinkRef[] = [];
  const add = (kind: LinkRef["kind"], raw: string, via?: string) => {
    if (!raw.startsWith("/") || raw.startsWith("//")) return;
    out.push(via === undefined ? { kind, value: raw } : { kind, value: raw, via });
  };
  let rest = src;
  for (const tag of src.matchAll(/<RouteLink\b([^>]*)>/g)) {
    rest = rest.replace(tag[0], " ");
    const attrs = tag[1] ?? "";
    // A computed route (a ${…} hole) cannot be read here; deploy.test.ts checks the tables that feed it.
    const route = attr("route").exec(attrs)?.[2];
    const literal = route !== undefined && !route.includes("${") ? route : undefined;
    if (literal !== undefined) add("route", literal);
    const href = attr("href").exec(attrs)?.[2];
    if (href !== undefined) add("href", href, literal);
  }
  for (const m of rest.matchAll(attr("href", "g"))) add("href", m[2] ?? "");
  for (const m of rest.matchAll(/\b(?:permanentRedirect|redirect)\(\s*(["'`])([^"'`]*)\1/g)) {
    add("redirect", m[2] ?? "");
  }
  return out;
}

/** Every internal link under `src/app` and `src/components` that points at nothing. */
export function deadLinks(webDir: string, planned: readonly string[]): string[] {
  const patterns = appRoutes(webDir);
  const files = publicPaths(webDir);
  const problems: string[] = [];
  for (const sub of ["app", "components"]) {
    for (const f of walk(join(webDir, "src", sub)).filter(isSourceFile)) {
      for (const link of linksIn(readFileSync(f, "utf8"))) {
        // A planned page is not linked yet: <RouteLink> shows plain text for it.
        if (link.kind === "route" && planned.includes(link.value)) continue;
        if (link.via !== undefined && planned.includes(link.via)) continue;
        if (!hrefResolves(link.value, patterns, files)) {
          problems.push(
            `${toPosix(relative(webDir, f))}: ${link.kind} "${link.value}" has no page`,
          );
        }
      }
    }
  }
  return problems;
}

// --- crons ----------------------------------------------------------------------------------------

export interface Cron {
  path: string;
  schedule: string;
}

const CRON_FIELD = /^(\*|\d+|\d+-\d+|\*\/\d+|\d+-\d+\/\d+|\d+(,\d+)+)$/;

/** Problems with the crons in a parsed vercel.json; `[]` when it has none or all are sound. */
export function cronProblems(webDir: string, config: { crons?: Cron[] }): string[] {
  const problems: string[] = [];
  const srcRoot = join(webDir, "src");
  const seen = new Set<string>();
  for (const c of config.crons ?? []) {
    if (!c.path.startsWith("/api/")) problems.push(`${c.path}: a cron path must start with /api/`);
    if (seen.has(c.path)) problems.push(`${c.path}: listed twice`);
    seen.add(c.path);
    if (
      c.schedule.trim().split(/\s+/).length !== 5 ||
      !c.schedule
        .trim()
        .split(/\s+/)
        .every((f) => CRON_FIELD.test(f))
    ) {
      problems.push(`${c.path}: schedule "${c.schedule}" is not a five-field cron expression`);
    }
    const dir = join(srcRoot, "app", ...c.path.split("/").filter(Boolean));
    const route = ["route.ts", "route.tsx", "route.js"].map((n) => join(dir, n)).find(existsSync);
    if (route === undefined) {
      problems.push(`${c.path}: no route handler at src/app${c.path}/route.ts`);
      continue;
    }
    const src = readFileSync(route, "utf8");
    if (!/export\s+(?:async\s+)?function\s+GET\b|export\s+const\s+GET\b/.test(src)) {
      problems.push(`${c.path}: the route does not export GET (Vercel crons send GET)`);
    }
    if (!reaches(route, srcRoot, (s) => /\bCRON_SECRET\b/.test(s))) {
      problems.push(
        `${c.path}: the route never checks CRON_SECRET (Vercel sends it as a bearer token)`,
      );
    }
  }
  return problems;
}

/**
 * Does `start` or any module it imports (relative or `@/`) satisfy `test`? The env loader names every
 * variable, so it never counts: a route must read `CRON_SECRET` itself or through a helper.
 */
function reaches(start: string, srcRoot: string, test: (src: string) => boolean): boolean {
  const loader = join(srcRoot, "lib", "env.ts");
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const src = readFileSync(file, "utf8");
    if (file !== loader && test(src)) return true;
    for (const imp of importsOf(src)) {
      const target = resolveLocal(imp.spec, file, srcRoot);
      if (target !== null && /\.(ts|tsx)$/.test(target) && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return false;
}

// --- package scripts ------------------------------------------------------------------------------

/** The files a package's scripts run through `tsx` or `node`, with the script that runs each. */
export function scriptTargets(scripts: Record<string, string>): { script: string; file: string }[] {
  const out: { script: string; file: string }[] = [];
  for (const [script, cmd] of Object.entries(scripts)) {
    for (const m of cmd.matchAll(
      /\b(?:tsx|node)\s+(?:[^\s&|;]+\s+)*?([^\s&|;"']+\.[cm]?[jt]s)(?=\s|$|[&|;])/g,
    )) {
      out.push({ script, file: m[1] ?? "" });
    }
  }
  return out;
}

// --- environment variables ------------------------------------------------------------------------

/** `NAME=value` lines of a dotenv file. Commented lines are not variables. */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out.set(m[1] ?? "", (m[2] ?? "").trim());
  }
  return out;
}

/** The variable names in the first column of the interfaces spec's section 14 table. */
export function specEnvNames(spec: string): string[] {
  const start = spec.search(/^## 14\. Environment variables/m);
  if (start === -1) throw new Error("interfaces spec: section 14 not found");
  const rest = spec.slice(start + 1);
  const end = rest.search(/^## /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const names = new Set<string>();
  for (const row of section.split("\n")) {
    if (!row.startsWith("|")) continue;
    const first = row.split("|")[1] ?? "";
    for (const m of first.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) names.add(m[1] ?? "");
  }
  return [...names];
}

/**
 * Environment variable names the web app reads: `process.env.X`, the keys of the `Env` interface that
 * `loadEnv` fills, reads off an env-like parameter (`src.X`, `env.X`, `env["X"]`), and string lists named
 * `*NAMES` (the names a script requires or a logger masks).
 */
export function envNamesRead(webDir: string): Map<string, string[]> {
  const found = new Map<string, Set<string>>();
  const note = (name: string, file: string) => {
    if (!/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(name)) return;
    let set = found.get(name);
    if (set === undefined) {
      set = new Set();
      found.set(name, set);
    }
    set.add(file);
  };
  const files = [
    ...walk(join(webDir, "src")),
    ...walk(join(webDir, "scripts")),
    join(webDir, "next.config.ts"),
  ].filter((f) => existsSync(f) && isSourceFile(f));
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const rel = toPosix(relative(webDir, f));
    for (const name of processEnvReads(src)) if (name !== "*") note(name, rel);
    for (const m of src.matchAll(/\b(?:src|env|source)\.([A-Z][A-Z0-9_]+)\b/g))
      note(m[1] ?? "", rel);
    for (const m of src.matchAll(/\b(?:src|env|source)\[\s*(["'])([A-Z][A-Z0-9_]+)\1\s*\]/g)) {
      note(m[2] ?? "", rel);
    }
    for (const m of src.matchAll(/\b\w*NAMES\b[^=\n]*=\s*\[([^\]]*)\]/g)) {
      for (const s of (m[1] ?? "").matchAll(/(["'])([A-Z][A-Z0-9_]+)\1/g)) note(s[2] ?? "", rel);
    }
    const iface = /export interface Env \{([\s\S]*?)\n\}/.exec(src)?.[1];
    if (iface !== undefined) {
      for (const m of iface.matchAll(/^\s+([A-Z][A-Z0-9_]+)\??:/gm)) note(m[1] ?? "", rel);
    }
  }
  return new Map([...found].map(([name, from]) => [name, [...from].sort()]));
}

/** Every `NEXT_PUBLIC_` name spelled anywhere in `text`. */
export function nextPublicNames(text: string): string[] {
  return [...new Set([...text.matchAll(/\bNEXT_PUBLIC_[A-Z0-9_]+/g)].map((m) => m[0]))].sort();
}

// --- migrations -----------------------------------------------------------------------------------

export interface MigrationFile {
  name: string;
  sql: string;
}

/** Extensions a migration may create: none, because a bare PGlite has no contrib extension to offer. */
export const ALLOWED_EXTENSIONS: readonly string[] = [];

const NAME_RE = /^(\d{8})(\d{6})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/** The SQL with `--` and block comments removed (text inside quotes is left alone). */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => {
      let quote = "";
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === "'" || c === '"') quote = c;
        else if (c === "-" && line[i + 1] === "-") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

const NOT_PORTABLE: readonly [RegExp, string][] = [
  [/\bowner\s+to\b/i, "sets an owner (OWNER TO): the hosted owner is not the local one"],
  [/\b(?:create|alter|drop)\s+role\b/i, "creates or changes a role: Supabase owns the roles"],
  [
    /\bset\s+session\s+authorization\b|\bset\s+(?:local\s+|session\s+)?role\s+(?!=)\S/i,
    "switches role or session authorization",
  ],
  [
    /\b(?:supabase_admin|supabase_auth_admin|supabase_storage_admin|supabase_functions_admin|dashboard_user|pgbouncer)\b/i,
    "names a Supabase-internal role",
  ],
  [/\b(?:to|from|authorization)\s+"?postgres"?\b|\bpostgres\.\w+/i, "hard-codes the postgres role"],
  [/\bcron\.schedule\b|\bnet\.http_/i, "uses pg_cron or pg_net (the cron host is Vercel)"],
  [
    /\bauth\.(?:uid|jwt|role|email)\s*\(/i,
    "calls Supabase Auth helpers (sign-in is a NEAR signature, claims come from the JWT)",
  ],
  [
    /\bauth\.users\b|\bstorage\.(?:objects|buckets)\b|\brealtime\.\w|\bvault\.(?:secrets|decrypted_secrets|create_secret)\b/i,
    "uses a schema only a hosted Supabase has",
  ],
];

/** Problems with a migrations folder's names, order and content; `[]` when they are fine. */
export function migrationProblems(files: readonly MigrationFile[]): string[] {
  const problems: string[] = [];
  const parsed: { name: string; prefix: string; seq: number }[] = [];
  for (const f of files) {
    const m = NAME_RE.exec(f.name);
    if (!m) {
      problems.push(`${f.name}: name must be <YYYYMMDD><6-digit sequence>_<snake_case>.sql`);
      continue;
    }
    parsed.push({ name: f.name, prefix: `${m[1]}${m[2]}`, seq: Number(m[2]) });
  }
  const bySeq = [...parsed].sort((a, b) => a.seq - b.seq || a.prefix.localeCompare(b.prefix));
  bySeq.forEach((p, i) => {
    if (p.seq !== i + 1)
      problems.push(
        `${p.name}: sequence ${p.seq} where ${i + 1} was expected (no gaps, no repeats)`,
      );
    const prev = bySeq[i - 1];
    if (prev && p.prefix <= prev.prefix) {
      problems.push(`${p.name}: version ${p.prefix} does not sort after ${prev.name}`);
    }
  });
  for (const f of files) {
    const sql = stripSqlComments(f.sql);
    for (const m of sql.matchAll(
      /\bcreate\s+extension\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_-]+)"?/gi,
    )) {
      const ext = (m[1] ?? "").toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext))
        problems.push(`${f.name}: creates extension "${ext}", which is not on the allowed list`);
    }
    for (const [re, why] of NOT_PORTABLE) if (re.test(sql)) problems.push(`${f.name}: ${why}`);
  }
  return problems;
}
