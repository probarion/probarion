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
  "src/lib/crypto/secrets.ts",
];
/**
 * Values none of that code may import, from any module: what pays, what signs and what opens a key, each under the
 * module that exports it (the first `it` below checks that each one still does).
 */
const FORBIDDEN_EXPORTS: Record<string, string[]> = {
  "@probarion/sdk": ["Probarion", "NearApiJsSender"],
  "near-api-js": ["KeyPair", "KeyPairEd25519", "KeyPairSigner", "MultiKeySigner"],
  "src/lib/sdk/factory.ts": ["makeTenantProbarion"],
  "src/lib/payables/pipeline.ts": ["processInvoice"],
  "src/lib/payables/confirm.ts": ["confirmInvoice"],
  "src/lib/keys/open.ts": ["openKey"],
  "src/lib/keys/service.ts": ["loadActiveSecret", "loadActiveSecretFor"],
  "src/lib/crypto/secrets.ts": ["openAgentSecret", "sealAgentSecret", "openInvoice"],
  "src/lib/crypto/server.ts": ["masterKey"],
};
const FORBIDDEN_NAMES = Object.values(FORBIDDEN_EXPORTS).flat();
/**
 * Names too common to refuse from every module, refused from the module where they open a sealed key. (`deriveSubkey`
 * stays allowed: the session check in lib/auth/guard.ts derives its subkey through lib/crypto/server.ts.)
 */
const FORBIDDEN_FROM: Record<string, string[]> = {
  "src/lib/crypto/sodium.ts": ["open"],
};
/** Packages that hold a signer: a namespace or default import of one would reach it as a property. */
const SIGNING_PACKAGES = [/^@probarion\/sdk(\/|$)/, /^near-api-js(\/|$)/, /^@near-js\//];
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

function parse(file: string): ts.SourceFile {
  const kind = /\.tsx$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(file)
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

function importsOf(file: string): Imp[] {
  const sf = parse(file);
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

/** The names an app module exports itself: its exported declarations and its `export { … }` lists. */
function exportsOf(file: string): string[] {
  const out: string[] = [];
  for (const st of parse(file).statements) {
    const exported =
      ts.canHaveModifiers(st) &&
      (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
      out.push(st.name.text);
    } else if (exported && ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.push(d.name.text);
      }
    } else if (
      ts.isExportDeclaration(st) &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const e of st.exportClause.elements) out.push(e.name.text);
    }
  }
  return out;
}

/**
 * Every `import(…)`, `require(…)`, `x.require`, `createRequire` and `import x = require(…)` in a file: the graph cannot
 * follow them, so the extension's code may have none.
 */
function dynamicLoadsOf(file: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === "require"))
    ) {
      const arg = n.arguments[0];
      out.push(arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : "(computed)");
    } else if (ts.isPropertyAccessExpression(n) && n.name.text === "require") {
      out.push(".require");
    } else if (
      ts.isElementAccessExpression(n) &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      n.argumentExpression.text === "require"
    ) {
      out.push('["require"]');
    } else if (ts.isIdentifier(n) && n.text === "createRequire") {
      out.push("createRequire");
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression;
      out.push(`import = require(${ts.isStringLiteralLike(e) ? e.text : "(computed)"})`);
    }
    ts.forEachChild(n, visit);
  };
  visit(parse(file));
  return out;
}

/** An app module's specifier: `@/…` or relative. Anything else is a package. */
const isLocal = (spec: string) => spec.startsWith("@/") || spec.startsWith(".");

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? join(SRC, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null;
  if (base === null) return null;
  // `moduleResolution: bundler` with `allowJs`: a `./x.js` specifier may name x.ts, and a module may be JavaScript.
  const noJs = base.replace(/\.[cm]?jsx?$/, "");
  for (const c of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${noJs}.ts`,
    `${noJs}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.js"),
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
  /** Every import that loads something, with the module it names and the app file it resolves to, if any. */
  const loads = [...g.entries()].flatMap(([f, imps]) =>
    imps.filter((i) => !i.typeOnly).map((i) => ({ file: f, imp: i, to: resolveLocal(f, i.from) })),
  );

  it("names only modules and exports that exist, so a rename cannot switch a check off", async () => {
    for (const f of [...FORBIDDEN_FILES, ...Object.keys(FORBIDDEN_FROM)]) {
      expect(isFile(join(WEB, f)), f).toBe(true);
    }
    for (const [from, names] of [
      ...Object.entries(FORBIDDEN_EXPORTS),
      ...Object.entries(FORBIDDEN_FROM),
    ]) {
      const exported = from.startsWith("src/")
        ? exportsOf(join(WEB, from))
        : Object.keys((await import(/* @vite-ignore */ from)) as Record<string, unknown>);
      for (const n of names) expect(exported, `${from} exports ${n}`).toContain(n);
    }
  });

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

  it("follows every app module it imports: none is left out of the check", () => {
    const missing = loads
      .filter((l) => isLocal(l.imp.from) && l.to === null)
      .map((l) => `${posix(l.file)}: ${l.imp.from}`);
    expect(missing).toEqual([]);
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

  it("imports no key-opening function from the module that has it", () => {
    const found = loads.flatMap((l) => {
      const refused = l.to === null ? [] : (FORBIDDEN_FROM[posix(l.to)] ?? []);
      return l.imp.names.filter((n) => refused.includes(n)).map((n) => `${posix(l.file)}: ${n}`);
    });
    expect(found).toEqual([]);
  });

  it("reaches nothing as a property: no namespace or export * of an app module, nor a whole signing package", () => {
    const found = loads
      .filter(
        (l) =>
          (l.imp.names.includes("*") && (isLocal(l.imp.from) || l.to !== null)) ||
          (SIGNING_PACKAGES.some((p) => p.test(l.imp.from)) &&
            l.imp.names.some((n) => n === "*" || n === "default")),
      )
      .map((l) => `${posix(l.file)}: ${l.imp.from}`);
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
