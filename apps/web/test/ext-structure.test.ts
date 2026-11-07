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

/**
 * Modules that pay, sign or open a key: none may load from the extension's code, unless every import of it is one
 * that EXEMPTIONS lets through.
 */
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
  "src/lib/crypto/secrets.ts": [
    "openAgentSecret",
    "sealAgentSecret",
    "openInvoice",
    "reencryptAgentSecret",
    "reencryptInvoice",
  ],
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
/**
 * The only imports the rules above let through: each is one name, imported by one file, from one module. They are the
 * invoice queue of plan 06 Task 2 (E1b), as the approved plan writes it. The queue's route reads the master key, and
 * the queue seals the invoice under the tenant's invoice key with it (and keys its duplicate guard), as the console
 * upload does. Neither opens anything. secrets.ts's own `open` serves only its opening functions, which every module
 * here is still refused by name, and a test below holds sealInvoice to sealing.
 *
 * Until E1b writes those files, none of these lets anything through. E1b adds its roots and changes nothing here. If
 * its files or imports differ from the plan, the controller rules: widening an exemption loosens the guard.
 */
const EXEMPTIONS: readonly { file: string; from: string; name: string }[] = [
  {
    file: "src/app/api/ext/invoices/route.ts",
    from: "src/lib/crypto/server.ts",
    name: "masterKey",
  },
  { file: "src/lib/payables/queue.ts", from: "src/lib/crypto/secrets.ts", name: "sealInvoice" },
  { file: "src/lib/crypto/secrets.ts", from: "src/lib/crypto/sodium.ts", name: "open" },
];
/** Whether `file` importing `name` from the app module `to` is one of the EXEMPTIONS. */
const isExempt = (file: string, to: string | null, name: string) =>
  to !== null &&
  EXEMPTIONS.some((e) => e.file === posix(file) && e.from === posix(to) && e.name === name);
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
    for (const e of EXEMPTIONS) {
      expect(isFile(join(WEB, e.from)), e.from).toBe(true);
      expect(exportsOf(join(WEB, e.from)), `${e.from} exports ${e.name}`).toContain(e.name);
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
    // Loaded at all only when every import of it names something, and each name it names is exempt.
    const admitted = (f: string) => {
      const into = loads.filter((l) => l.to !== null && posix(l.to) === f);
      return (
        into.length > 0 &&
        into.every(
          (l) => l.imp.names.length > 0 && l.imp.names.every((n) => isExempt(l.file, l.to, n)),
        )
      );
    };
    expect(
      [...g.keys()].map(posix).filter((f) => FORBIDDEN_FILES.includes(f) && !admitted(f)),
    ).toEqual([]);
  });

  it("imports none of their functions from anywhere", () => {
    const found = [...g.entries()].flatMap(([f, imps]) =>
      imps.flatMap((i) =>
        i.names
          .filter((n) => FORBIDDEN_NAMES.includes(n) && !isExempt(f, resolveLocal(f, i.from), n))
          .map((n) => `${posix(f)}: ${n}`),
      ),
    );
    expect(found).toEqual([]);
  });

  it("imports no key-opening function from the module that has it", () => {
    const found = loads.flatMap((l) => {
      const refused = l.to === null ? [] : (FORBIDDEN_FROM[posix(l.to)] ?? []);
      return l.imp.names
        .filter((n) => refused.includes(n) && !isExempt(l.file, l.to, n))
        .map((n) => `${posix(l.file)}: ${n}`);
    });
    expect(found).toEqual([]);
  });

  it("lets through only the queue's sealing and its master key, one name in one file each, and sealing opens nothing", () => {
    const SECRETS = "src/lib/crypto/secrets.ts";
    const secrets = parse(join(WEB, SECRETS));
    // sealInvoice, the one name that may come out of secrets.ts, names its parameters, seal and tenantInvoiceKey, and
    // nothing else: it seals, and it opens nothing.
    const sealInvoice = secrets.statements.find(
      (st): st is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(st) && st.name?.text === "sealInvoice",
    );
    expect(sealInvoice?.body, "secrets.ts declares sealInvoice").toBeDefined();
    const params = (sealInvoice?.parameters ?? []).flatMap((p) =>
      ts.isIdentifier(p.name) ? [p.name.text] : [],
    );
    const named = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) named.add(n.text);
      ts.forEachChild(n, visit);
    };
    if (sealInvoice?.body) visit(sealInvoice.body);
    expect([...named].sort()).toEqual([...params, "seal", "tenantInvoiceKey"].sort());
    // Every other export of secrets.ts but the number KEY_VERSION opens a key or seals an agent's, and each one is
    // refused by name, so no module can carry one in.
    expect(
      exportsOf(join(WEB, SECRETS))
        .filter((n) => n !== "sealInvoice" && n !== "KEY_VERSION")
        .sort(),
    ).toEqual([...(FORBIDDEN_EXPORTS[SECRETS] ?? [])].sort());
    for (const e of EXEMPTIONS) {
      // From a key module under lib/crypto, never from a module that pays or signs.
      expect(e.from.startsWith("src/lib/crypto/"), e.from).toBe(true);
      // Once its file is in the graph, the file imports that name from that module: an unused exemption is removed.
      if (![...g.keys()].some((f) => posix(f) === e.file)) continue;
      expect(
        loads.some(
          (l) =>
            posix(l.file) === e.file &&
            l.to !== null &&
            posix(l.to) === e.from &&
            l.imp.names.includes(e.name),
        ),
        `${e.file} imports ${e.name} from ${e.from}`,
      ).toBe(true);
    }
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
