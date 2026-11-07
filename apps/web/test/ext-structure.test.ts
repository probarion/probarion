// The browser extension never pays (spec §4.4, §6), held to the source. Every module the extension's routes and its
// queue can load is read with the TypeScript parser, so a comment or a string cannot fake or hide an import.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isSourceFile, walk } from "./deploy-scan";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(WEB, "src");
const posix = (f: string) => relative(WEB, f).replaceAll("\\", "/");
const isFile = (f: string) => existsSync(f) && statSync(f).isFile();

/** The extension's own server code: what a token can reach. Task E1b adds the queue. */
const ROOTS = [
  ...walk(join(SRC, "lib", "ext")).filter((f) => isSourceFile(f) && !/\.test\.tsx?$/.test(f)),
  ...walk(join(SRC, "app", "api", "ext")).filter((f) => /[\\/]route\.ts$/.test(f)),
];

/** Modules that pay, sign or open a key: none may load from the extension's code. */
const FORBIDDEN_FILES = [
  "src/lib/payables/pipeline.ts",
  "src/lib/payables/confirm.ts",
  "src/lib/sdk/factory.ts",
  "src/lib/keys/open.ts",
  "src/lib/keys/service.ts",
];
/** Values none of that code may import, from any module. */
const FORBIDDEN_NAMES = [
  "Probarion",
  "makeTenantProbarion",
  "processInvoice",
  "confirmInvoice",
  "openKey",
  "loadActiveSecret",
  "loadActiveSecretFor",
  "openAgentSecret",
];
/** The cookie session: the extension's routes use the bearer token alone. */
const SESSION_NAMES = [
  "cookies",
  "getSession",
  "requireSession",
  "requireMember",
  "memberForApi",
  "sessionForAction",
  "memberForAction",
  "assertSameOrigin",
];

interface Imp {
  from: string;
  names: string[];
  typeOnly: boolean;
}

function importsOf(file: string): Imp[] {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: Imp[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const c = st.importClause;
      const names: string[] = [];
      if (c?.name) names.push("default");
      const nb = c?.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const e of nb.elements) if (!e.isTypeOnly) names.push((e.propertyName ?? e.name).text);
      }
      if (nb && ts.isNamespaceImport(nb)) names.push("*");
      // Only `import type …` is skipped; `import { type X }` is still followed, which is stricter than the compiler.
      out.push({ from: st.moduleSpecifier.text, names, typeOnly: c?.isTypeOnly === true });
    } else if (
      ts.isExportDeclaration(st) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier)
    ) {
      const names =
        st.exportClause && ts.isNamedExports(st.exportClause)
          ? st.exportClause.elements
              .filter((e) => !e.isTypeOnly)
              .map((e) => (e.propertyName ?? e.name).text)
          : ["*"];
      out.push({ from: st.moduleSpecifier.text, names, typeOnly: st.isTypeOnly });
    }
  }
  return out;
}

/** Every `import(…)` and `require(…)` in a file: the graph cannot follow them, so the extension's code may have none. */
function dynamicLoadsOf(file: string): string[] {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === "require"))
    ) {
      const arg = n.arguments[0];
      out.push(arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : "(computed)");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? join(SRC, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null;
  if (base === null) return null;
  for (const c of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (isFile(c)) return c;
  }
  return null;
}

/** Every app module the roots load, with its imports (type-only imports load nothing). */
function graph(roots: string[]): Map<string, Imp[]> {
  const seen = new Map<string, Imp[]>();
  const todo = [...roots];
  while (todo.length > 0) {
    const f = todo.pop();
    if (f === undefined || seen.has(f)) continue;
    const imps = importsOf(f);
    seen.set(f, imps);
    for (const i of imps) {
      if (i.typeOnly) continue;
      const next = resolveLocal(f, i.from);
      if (next !== null && !seen.has(next)) todo.push(next);
    }
  }
  return seen;
}

describe("the extension's server code never pays", () => {
  const g = graph(ROOTS);

  it("has the roots it is meant to check", () => {
    expect(ROOTS.map(posix)).toEqual(
      expect.arrayContaining([
        "src/lib/ext/auth.ts",
        "src/app/api/ext/pair/route.ts",
        "src/app/api/ext/inbox/route.ts",
        "src/app/api/ext/revoke/route.ts",
      ]),
    );
  });

  it("loads no module that pays, signs or opens a key", () => {
    expect([...g.keys()].map(posix).filter((f) => FORBIDDEN_FILES.includes(f))).toEqual([]);
  });

  it("imports none of their functions from anywhere", () => {
    const found = [...g.entries()].flatMap(([f, imps]) =>
      imps.flatMap((i) =>
        i.names.filter((n) => FORBIDDEN_NAMES.includes(n)).map((n) => `${posix(f)}: ${n}`),
      ),
    );
    expect(found).toEqual([]);
  });

  it("loads nothing through import() or require(), which this graph cannot follow", () => {
    const found = [...g.keys()].flatMap((f) => dynamicLoadsOf(f).map((s) => `${posix(f)}: ${s}`));
    expect(found).toEqual([]);
  });

  it("authenticates by the bearer token alone: no cookie session, no Origin check", () => {
    const found = ROOTS.flatMap((f) =>
      importsOf(f).flatMap((i) =>
        i.names.filter((n) => SESSION_NAMES.includes(n)).map((n) => `${posix(f)}: ${n}`),
      ),
    );
    expect(found).toEqual([]);
  });

  it("checks the token in every route but pairing, and sends no CORS header", () => {
    const routes = ROOTS.filter((f) => /[\\/]route\.ts$/.test(f));
    for (const f of routes) {
      const src = readFileSync(f, "utf8");
      expect(/access-control-/i.test(src), posix(f)).toBe(false);
      if (posix(f) !== "src/app/api/ext/pair/route.ts") {
        expect(
          importsOf(f).some((i) => i.from === "@/lib/ext/auth" && i.names.includes("extAuth")),
          posix(f),
        ).toBe(true);
      }
    }
  });
});
