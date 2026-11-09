// The browser extension never pays (spec §4.4, §6), held to the source. Every module the extension's routes and its
// queue can load is read with the TypeScript parser, so a comment or a string cannot fake or hide an import.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isSourceFile, walk } from "./deploy-scan";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(WEB, "..", "..");
const SRC = join(WEB, "src");
const posix = (f: string) => relative(WEB, f).replaceAll("\\", "/");
const isFile = (f: string) => existsSync(f) && statSync(f).isFile();

/** The extension's own server code: what a token can reach, with the invoice queue (lib/payables/queue*.ts). */
const ROOTS = [
  ...walk(join(SRC, "lib", "ext")).filter((f) => isSourceFile(f) && !/\.test\.tsx?$/.test(f)),
  ...walk(join(SRC, "app", "api", "ext")).filter((f) => /[\\/]route\.ts$/.test(f)),
  join(SRC, "lib", "payables", "queue.ts"),
  join(SRC, "lib", "payables", "queue-rules.ts"),
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
  // `export * from "./keys.js"`: an Ed25519 signer from a secret key, and the secret key's bytes.
  "@probarion/core": ["createEd25519Signer", "parseSecretKey"],
};
const FORBIDDEN_NAMES = Object.values(FORBIDDEN_EXPORTS).flat();
/**
 * Names too common to refuse from every module, refused from the module where they open a sealed key. (`deriveSubkey`
 * is left to lib/crypto/server.ts, which derives the session's subkey with it; CRYPTO_ONLY refuses it anywhere else.)
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
 * E1b's files exist, so each of these is in use. Removing one is a tightening; widening one is the controller's
 * ruling: it loosens the guard. If its files or imports differ from the plan, the controller rules.
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
const SIGNING_PACKAGES = [
  /^@probarion\/sdk(\/|$)/,
  /^@probarion\/core(\/|$)/,
  /^near-api-js(\/|$)/,
  /^@near-js\//,
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

// Capabilities that no refused name shows: what would open a sealed agent key, sign or send by hand.
/**
 * The subkeys code outside lib/crypto may ask `subkey` (lib/crypto/server.ts) for: the session's, which lib/auth/guard.ts
 * reads the session cookie with. With "agent_keys" a module would hold the key that seals every agent key, and no name it
 * imports would show it.
 */
const SUBKEY_PURPOSES = ["session"];
/** What reads or derives from the master key, or reaches libsodium itself: only modules under lib/crypto may import these. */
const CRYPTO_ONLY: Record<string, string[]> = {
  "src/lib/crypto/sodium.ts": ["getSodium", "parseMasterKey", "deriveSubkey", "tenantInvoiceKey"],
};
/**
 * The raw crypto libraries, which derive a subkey or open a secretbox by hand: only this module may load one, in any
 * form. Not just libsodium and tweetnacl: the pnpm store also holds @noble and @stablelib, which reproduce the same
 * BLAKE2b KDF and xsalsa20-poly1305 secretbox, so a graph module could redo lib/crypto's work through one of them.
 */
const RAW_CRYPTO_HOME = "src/lib/crypto/sodium.ts";
const RAW_CRYPTO =
  /^(libsodium|tweetnacl)([-/]|$)|^@noble\/(ciphers|hashes|curves|post-quantum)([/]|$)|^@stablelib\//;
/** near-api-js and @near-js/*: Account, Signer and every key pair sign; the graph imports none of them, in any form. */
const NEAR_SIGNING_IMPORTS = /^(near-api-js|@near-js\/)/;
/**
 * The master key's environment variable, by name. Only lib/crypto (which parses and uses it), lib/env.ts (which validates
 * it) and lib/log.ts (which redacts it) may name it. This refuses one spelling, not the value: log.ts's secretEnvValues()
 * and sentry-scrub.ts's sentrySecrets() return it for redaction, and getEnv() can be read with a computed key.
 */
const MASTER_ENV = "KEY_ENCRYPTION_SECRET";
const MASTER_ENV_OK = (f: string) =>
  f.startsWith("src/lib/crypto/") || f === "src/lib/env.ts" || f === "src/lib/log.ts";
/**
 * Strings no module may hold: the database functions that return a sealed agent key and the sealed columns themselves
 * (migration 0003), and the RPC methods that send a transaction (the SDK's SEND_METHODS). The first `it` checks the
 * function list and the send-method list against their source, and that the function list is complete.
 */
const SEALED_KEY_FUNCTIONS = ["agent_key_secret", "agent_key_secret_for", "key_rotation_rows"];
const SEALED_COLUMNS = ["secret_ciphertext", "secret_nonce"];
const SEND_METHODS = ["send_tx", "broadcast_tx_commit", "broadcast_tx_async"];
/**
 * The database functions that name the sealed column without returning it: the agent-key insert and the rotation's
 * write-back (migration 0003). The first `it` classifies every migration function that mentions the column, in any
 * shape, as one of these or as a SEALED_KEY_FUNCTIONS entry, so a new one fails until it is ruled on.
 */
const SEALED_KEY_WRITERS = ["agent_key_insert", "key_rotation_apply"];
/**
 * The one module that builds a Supabase client. Its Db port exposes only `rpc`, so the graph reads no table directly,
 * and every `.rpc(` call elsewhere must name its function as a literal, which the sealed-function pin then sees.
 */
const SUPABASE_HOME = "src/lib/db/clients.ts";
const SUPABASE_IMPORTS = /^@supabase\//;
/**
 * The docs' no-pay claim (THREAT_MODEL's extension paragraph, SECURITY.md's extension-token row) in the words that hold
 * only while no exemption is in use. Once the queue's files exist, both docs must say the narrower claim instead: no
 * function that pays, signs or opens a sealed key, and the queue's route reads the master key only to seal the invoice
 * with sealInvoice and to key its duplicate guard.
 */
const NO_PAY_DOCS = ["docs/THREAT_MODEL.md", "SECURITY.md"];
const NO_EXEMPTION_CLAIM = [
  "the app's modules or functions that pay",
  "imports none of masterKey, parseMasterKey, deriveSubkey, tenantInvoiceKey or getSodium",
];
/**
 * Once the queue ships, the docs must also name why loading `secrets.ts` (which imports `open`) is still no-pay: its
 * `open` serves only its own opening functions, which the extension's code never imports. A narrowing that keeps the
 * universal "opens a sealed key" claim without this carve-out is still an overclaim, and fails the docs pin below.
 */
const OPEN_EXCEPTION_CLAIM = "its own opening functions";

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

/** The text of every string and template literal in a file, a template's parts between substitutions included. */
/** Every `.rpc(` call in a file whose first argument is not a string literal, as `line`. */
function computedRpcOf(file: string): string[] {
  const sf = parse(file);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "rpc" &&
      !(n.arguments[0] !== undefined && ts.isStringLiteralLike(n.arguments[0]))
    ) {
      out.push(String(sf.getLineAndCharacterOfPosition(n.getStart()).line + 1));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function stringsOf(file: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isStringLiteralLike(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      out.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(parse(file));
  return out;
}

/**
 * Every use of `subkey` in a file (by its own name or the local name it is imported as), outside its imports, that is
 * not a call with one string literal in SUBKEY_PURPOSES: a computed purpose, a re-export, or `subkey` passed on.
 */
function subkeyMisuseOf(file: string): string[] {
  const sf = parse(file);
  const names = new Set(["subkey"]);
  for (const st of sf.statements) {
    const nb = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (nb && ts.isNamedImports(nb)) {
      for (const e of nb.elements)
        if ((e.propertyName ?? e.name).text === "subkey") names.add(e.name.text);
    }
  }
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isIdentifier(n) && names.has(n.text)) {
      const call = n.parent;
      const arg = ts.isCallExpression(call) ? call.arguments[0] : undefined;
      const allowed =
        ts.isCallExpression(call) &&
        call.expression === n &&
        call.arguments.length === 1 &&
        arg !== undefined &&
        ts.isStringLiteralLike(arg) &&
        SUBKEY_PURPOSES.includes(arg.text);
      if (!allowed) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        out.push(`${line}: ${call.getText().replace(/\s+/g, " ").slice(0, 80)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** An app module's specifier: `@/…` or relative. Anything else is a package. */
const isLocal = (spec: string) => spec.startsWith("@/") || spec.startsWith(".");
/** Whether `f` lies inside directory `dir`. */
const isUnder = (f: string, dir: string) => {
  const r = relative(dir, f);
  return r.length > 0 && !r.startsWith("..") && !/^[a-zA-Z]:/.test(r);
};

/** The real file a local specifier names, wherever it lands (including the pnpm store). Null if it resolves nowhere. */
function localTarget(from: string, spec: string): string | null {
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

/**
 * The app module a local specifier resolves to — only inside the app's own `src/`. A specifier that resolves outside
 * it (a `../…` or `@/../…` reaching node_modules, say) is not an app module: the graph does not follow it, and a pin
 * below refuses the escape, so a secretbox or KDF from the pnpm store cannot be loaded as if it were app code.
 */
function resolveLocal(from: string, spec: string): string | null {
  const t = localTarget(from, spec);
  return t !== null && isUnder(t, SRC) ? t : null;
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

describe("the extension's server code imports nothing that pays or signs, and nothing outside lib/crypto that opens a sealed key", () => {
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
    for (const [from, names] of Object.entries(CRYPTO_ONLY)) {
      for (const n of names)
        expect(exportsOf(join(WEB, from)), `${from} exports ${n}`).toContain(n);
    }
    expect(exportsOf(join(WEB, "src/lib/crypto/server.ts"))).toContain("subkey");
    expect(isFile(join(WEB, RAW_CRYPTO_HOME)), RAW_CRYPTO_HOME).toBe(true);
    const migrations = walk(join(WEB, "supabase", "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const fn of SEALED_KEY_FUNCTIONS) {
      expect(migrations, fn).toContain(`create or replace function public.${fn}(`);
    }
    // Completeness: every migration function whose body mentions the sealed column, in any shape, is either in
    // SEALED_KEY_FUNCTIONS or a known writer, so a new one (another `key_rotation_rows`) cannot slip past the list.
    const sealedReturners = new Set<string>();
    const fnRe = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
    for (let m = fnRe.exec(migrations); m !== null; m = fnRe.exec(migrations)) {
      const rest = migrations.slice(m.index);
      const tag = /\$[a-z_]*\$/i.exec(rest);
      if (tag === null) continue;
      const open = tag.index + tag[0].length;
      const body = rest.slice(open, rest.indexOf(tag[0], open));
      if (/secret_ciphertext/i.test(body)) sealedReturners.add(m[1]);
    }
    expect(
      [...sealedReturners].sort(),
      "every function that mentions the sealed column is in SEALED_KEY_FUNCTIONS or SEALED_KEY_WRITERS",
    ).toEqual([...SEALED_KEY_FUNCTIONS, ...SEALED_KEY_WRITERS].sort());
    expect(isFile(join(WEB, SUPABASE_HOME)), SUPABASE_HOME).toBe(true);
    // The exempted readers of the master key's env var must each still name it, so an exemption is never dead.
    for (const f of ["src/lib/crypto/server.ts", "src/lib/env.ts", "src/lib/log.ts"]) {
      expect(readFileSync(join(WEB, f), "utf8"), `${f} names ${MASTER_ENV}`).toContain(MASTER_ENV);
    }
    // The RPC methods that send a transaction are exactly the SDK's SEND_METHODS.
    const rpc = parse(join(REPO, "packages", "sdk", "src", "rpc.ts"));
    const sends: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteralLike(n)) sends.push(n.text);
      ts.forEachChild(n, visit);
    };
    for (const st of rpc.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === "SEND_METHODS" && d.initializer) {
          visit(d.initializer);
        }
      }
    }
    expect(sends.sort()).toEqual([...SEND_METHODS].sort());
  });

  it("has the roots it is meant to check", () => {
    expect(ROOTS.map(posix)).toEqual(
      expect.arrayContaining([
        "src/lib/ext/auth.ts",
        "src/app/api/ext/pair/route.ts",
        "src/app/api/ext/inbox/route.ts",
        "src/app/api/ext/revoke/route.ts",
        "src/lib/payables/queue.ts",
        "src/lib/payables/queue-rules.ts",
        "src/app/api/ext/invoices/route.ts",
      ]),
    );
  });

  it("follows every app module it imports: none is left out of the check", () => {
    // Unresolvable means the specifier names no file at all; a file outside src/ resolves (localTarget) but is caught
    // by the escape pin below, not counted as missing here.
    const missing = [...g.entries()].flatMap(([f, imps]) =>
      imps
        .filter((i) => !i.typeOnly && isLocal(i.from) && localTarget(f, i.from) === null)
        .map((i) => `${posix(f)}: ${i.from}`),
    );
    expect(missing).toEqual([]);
  });

  it("loads only the app's own source: no local import resolves outside src/", () => {
    // A `../…` or `@/../…` specifier that lands in node_modules would be followed as if it were an app module, so its
    // names would never be checked. The pnpm store holds other BLAKE2b/secretbox implementations (@noble, @stablelib),
    // which reproduce lib/crypto's agent-key derivation and open its output. Refuse the escape.
    const found = [...g.entries()].flatMap(([f, imps]) =>
      imps
        .filter((i) => !i.typeOnly && isLocal(i.from))
        .flatMap((i) => {
          const t = localTarget(f, i.from);
          return t !== null && !isUnder(t, SRC) ? [`${posix(f)}: ${i.from}`] : [];
        }),
    );
    expect(found).toEqual([]);
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

  it("asks lib/crypto for no subkey but the session's, by a literal name", () => {
    const found = [...g.keys()]
      .filter((f) => !posix(f).startsWith("src/lib/crypto/"))
      .flatMap((f) => subkeyMisuseOf(f).map((s) => `${posix(f)}:${s}`));
    expect(found).toEqual([]);
  });

  it("imports nothing, outside lib/crypto, that parses the master key, derives a subkey or reaches libsodium", () => {
    const refused = Object.values(CRYPTO_ONLY).flat();
    const found = [...g.entries()]
      .filter(([f]) => !posix(f).startsWith("src/lib/crypto/"))
      .flatMap(([f, imps]) =>
        imps.flatMap((i) =>
          i.names.filter((n) => refused.includes(n)).map((n) => `${posix(f)}: ${n}`),
        ),
      );
    expect(found).toEqual([]);
  });

  it("loads a raw crypto library (libsodium, tweetnacl, @noble, @stablelib) only through lib/crypto/sodium.ts, in any form", () => {
    // Type-only imports and re-exports count too; import() and require() are refused below.
    const found = [...g.entries()]
      .filter(([f]) => posix(f) !== RAW_CRYPTO_HOME)
      .flatMap(([f, imps]) =>
        imps.filter((i) => RAW_CRYPTO.test(i.from)).map((i) => `${posix(f)}: ${i.from}`),
      );
    expect(found).toEqual([]);
  });

  it("names no database function or sealed column that exposes an agent key, and no RPC method that sends a transaction", () => {
    const refused = [...SEALED_KEY_FUNCTIONS, ...SEALED_COLUMNS, ...SEND_METHODS];
    const found = [...g.keys()].flatMap((f) =>
      stringsOf(f)
        .filter((s) => refused.some((r) => s.includes(r)))
        .map((s) => `${posix(f)}: ${JSON.stringify(s)}`),
    );
    expect(found).toEqual([]);
  });

  it("builds a Supabase client only in lib/db/clients.ts, whose port calls functions and reads no table", () => {
    const found = [...g.entries()]
      .filter(([f]) => posix(f) !== SUPABASE_HOME)
      .flatMap(([f, imps]) =>
        imps.filter((i) => SUPABASE_IMPORTS.test(i.from)).map((i) => `${posix(f)}: ${i.from}`),
      );
    expect(found).toEqual([]);
  });

  it("names every database function it calls as a literal, so the sealed-function pin sees each one", () => {
    const found = [...g.keys()]
      .filter((f) => posix(f) !== SUPABASE_HOME)
      .flatMap((f) => computedRpcOf(f).map((l) => `${posix(f)}:${l}`));
    expect(found).toEqual([]);
  });

  it("names the master key's env var only in lib/crypto, lib/env.ts and lib/log.ts", () => {
    // A plain read of KEY_ENCRYPTION_SECRET (getEnv().KEY_ENCRYPTION_SECRET or process.env) names it. Only the three
    // places that parse, validate or redact it may; the graph has no other. See MASTER_ENV for what this does not stop.
    const found = [...g.keys()]
      .filter((f) => !MASTER_ENV_OK(posix(f)))
      .flatMap((f) => {
        const sf = parse(f);
        const hits: string[] = [];
        const visit = (n: ts.Node): void => {
          const isStr =
            ts.isStringLiteralLike(n) ||
            ts.isTemplateHead(n) ||
            ts.isTemplateMiddle(n) ||
            ts.isTemplateTail(n);
          if (
            (ts.isIdentifier(n) && n.text === MASTER_ENV) ||
            (isStr && n.text.includes(MASTER_ENV))
          ) {
            hits.push(`${posix(f)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
        return hits;
      });
    expect(found).toEqual([]);
  });

  it("imports nothing from near-api-js or @near-js: no Account, Signer or key pair reaches the graph", () => {
    // FORBIDDEN_EXPORTS names four of near-api-js's key pairs, but Account (which signs with a key string),
    // KeyPairSecp256k1, KeyPairMLDSA65 and Signer are not named. Refuse the whole package instead, in any form.
    const found = [...g.entries()].flatMap(([f, imps]) =>
      imps.filter((i) => NEAR_SIGNING_IMPORTS.test(i.from)).map((i) => `${posix(f)}: ${i.from}`),
    );
    expect(found).toEqual([]);
  });

  it("keeps the docs' no-pay claim no wider than the exemptions in use", () => {
    // secrets.ts always exists; the queue's own files exist only once it ships.
    const inUse = EXEMPTIONS.map((e) => e.file).filter(
      (f) => f !== "src/lib/crypto/secrets.ts" && isFile(join(WEB, f)),
    );
    for (const doc of NO_PAY_DOCS) {
      // Backticks dropped and whitespace collapsed, so neither a code span nor a line break hides a phrase.
      const text = readFileSync(join(REPO, doc), "utf8").replaceAll("`", "").replace(/\s+/g, " ");
      for (const claim of NO_EXEMPTION_CLAIM) {
        // Present while no exemption is in use, so that a rewording cannot switch this off; gone once one is.
        expect(text.includes(claim), `${doc}: "${claim}" with ${inUse.length} in use`).toBe(
          inUse.length === 0,
        );
      }
      if (inUse.length > 0) {
        expect(text, `${doc} names sealInvoice`).toContain("sealInvoice");
        // The queue loads secrets.ts (under lib/crypto) for sealInvoice, and secrets.ts imports sodium's `open`. A
        // narrowing that keeps the universal "opens a sealed key" claim without naming that carve-out is still an
        // overclaim, so the honest claim must say `open` serves only its own opening functions.
        expect(text, `${doc} names secrets.ts's open carve-out`).toContain(OPEN_EXCEPTION_CLAIM);
      }
    }
  });

  it("makes a VaultClient only with a contract and an RPC client, never with senders, and passes the class nowhere", () => {
    // A third argument (senders) could sign. Every use of the class, by whatever local name a value import gives it,
    // must be `new VaultClient(a, b)` with two arguments and no spread: an alias, a subclass or a re-export would let
    // a later call add senders out of this test's sight. Types are not values and are skipped; `extends` is not.
    // A re-export straight from another module (`export { VaultClient as VC } from …`) passes the class on under a
    // name this test would not follow, so it is refused where it is written.
    const found: string[] = [];
    for (const f of g.keys()) {
      const sf = parse(f);
      const names = new Set<string>();
      for (const st of sf.statements) {
        if (
          ts.isExportDeclaration(st) &&
          !st.isTypeOnly &&
          st.moduleSpecifier &&
          st.exportClause &&
          ts.isNamedExports(st.exportClause)
        ) {
          for (const e of st.exportClause.elements) {
            if (!e.isTypeOnly && (e.propertyName ?? e.name).text === "VaultClient") {
              found.push(`${posix(f)}:${sf.getLineAndCharacterOfPosition(e.getStart()).line + 1}`);
            }
          }
        }
        const c = ts.isImportDeclaration(st) ? st.importClause : undefined;
        const nb = c && !c.isTypeOnly ? c.namedBindings : undefined;
        if (nb && ts.isNamedImports(nb)) {
          for (const e of nb.elements) {
            if (!e.isTypeOnly && (e.propertyName ?? e.name).text === "VaultClient") {
              names.add(e.name.text);
            }
          }
        }
      }
      if (names.size === 0) continue;
      const visit = (n: ts.Node): void => {
        if (ts.isImportDeclaration(n)) return;
        if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return;
        if (ts.isIdentifier(n) && names.has(n.text)) {
          const p = n.parent;
          const ok =
            ts.isNewExpression(p) &&
            p.expression === n &&
            p.arguments?.length === 2 &&
            !p.arguments.some((a) => ts.isSpreadElement(a));
          if (!ok) {
            found.push(`${posix(f)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(found).toEqual([]);
  });

  it("imports no decide() from @probarion/core: the queue runs the payee check and check_spend, not the cycle", () => {
    const found = loads
      .filter((l) => /^@probarion\/core(\/|$)/.test(l.imp.from) && l.imp.names.includes("decide"))
      .map((l) => `${posix(l.file)}: ${l.imp.from}`);
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
