// The console asks for confirmation with its own dialog (components/ConfirmDialog.tsx), never with the browser's
// `window.confirm`: that box looks foreign, cannot say which action it guards, and blocks browser automation. This
// scans every source file under src (test files excluded) and fails on a use of the browser's `confirm`, however it is
// spelled. A file's own `confirm` (a prop, a parameter, a method such as `d.confirm(...)`) is a different thing and is
// not flagged. This is a tripwire against accidents, not a security control: deliberate evasion is out of scope.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isSourceFile, toPosix, walk } from "./deploy-scan";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(WEB, "src");

const GLOBALS = new Set(["window", "globalThis", "self", "top", "parent", "frames"]);

/**
 * Where `source` uses the browser's confirm: `window.confirm`, `globalThis["confirm"]`, a `confirm(...)` call or
 * reference to a `confirm` that nothing in the file declares (so it can only be the global one). Comments and strings
 * are not code, so naming it in either is fine. Returns 1-based line numbers.
 */
function nativeConfirmLines(source: string, fileName = "file.tsx"): number[] {
  const kind = fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const bare = new Set<ts.Node>();
  let declares = false;
  const hits: ts.Node[] = [];

  const isConfirm = (n: ts.Node | undefined) => !!n && ts.isIdentifier(n) && n.text === "confirm";
  const declaresConfirm = (n: ts.Node): boolean =>
    (ts.isParameter(n) ||
      ts.isVariableDeclaration(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isBindingElement(n) ||
      ts.isImportSpecifier(n) ||
      ts.isImportClause(n) ||
      ts.isNamespaceImport(n)) &&
    isConfirm(n.name);

  const visit = (n: ts.Node) => {
    if (declaresConfirm(n)) declares = true;
    // window.confirm / globalThis?.confirm
    if (ts.isPropertyAccessExpression(n) && n.name.text === "confirm") {
      if (ts.isIdentifier(n.expression) && GLOBALS.has(n.expression.text)) hits.push(n);
    }
    // window["confirm"]
    if (
      ts.isElementAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      GLOBALS.has(n.expression.text) &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      n.argumentExpression.text === "confirm"
    ) {
      hits.push(n);
    }
    // a bare confirm(...) or `const c = confirm`: judged once the whole file has been seen
    if (isConfirm(n) && isBareUse(n)) bare.add(n);
    ts.forEachChild(n, visit);
  };

  /** An identifier read as a value: not a property name, a member, a declaration or a type. */
  function isBareUse(id: ts.Node): boolean {
    const p = id.parent;
    if (!p) return false;
    if (ts.isPropertyAccessExpression(p) && p.name === id) return false; // d.confirm
    if (ts.isQualifiedName(p) || ts.isTypeReferenceNode(p)) return false;
    if (
      (ts.isPropertyAssignment(p) ||
        ts.isPropertySignature(p) ||
        ts.isMethodSignature(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isPropertyDeclaration(p) ||
        ts.isJsxAttribute(p)) &&
      p.name === id
    ) {
      return false; // { confirm: ... }, confirm(...): Promise<...>; in an interface, <X confirm="..." />
    }
    if (ts.isShorthandPropertyAssignment(p)) return false; // { confirm }: a local
    if (
      (ts.isParameter(p) || ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p)) &&
      p.name === id
    ) {
      return false; // a declaration of its own
    }
    if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
    if (ts.isImportSpecifier(p) || ts.isImportClause(p)) return false;
    if (ts.isExportSpecifier(p)) return false;
    return true;
  }

  visit(file);
  if (!declares) hits.push(...bare);
  return hits.map((n) => file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1).sort();
}

describe("nativeConfirmLines (the scanner finds the browser's confirm, and only that)", () => {
  const flagged = (src: string) => nativeConfirmLines(src).length > 0;

  it("flags window.confirm, however it is reached", () => {
    expect(flagged('if (!window.confirm("Sure?")) return;')).toBe(true);
    expect(flagged('globalThis.confirm("Sure?")')).toBe(true);
    expect(flagged('self.confirm("Sure?")')).toBe(true);
    expect(flagged('window["confirm"]("Sure?")')).toBe(true);
    expect(flagged("const ask = window.confirm;")).toBe(true);
    expect(flagged('window\n  .confirm("Sure?")')).toBe(true);
  });

  it("flags a bare confirm(...) that nothing in the file declares", () => {
    expect(flagged('if (!confirm("Sure?")) return;')).toBe(true);
    expect(flagged('const ok = await Promise.resolve(confirm("Sure?"));')).toBe(true);
    expect(flagged("const ask = confirm;")).toBe(true);
  });

  it("reports the line", () => {
    expect(nativeConfirmLines('const a = 1;\n\nwindow.confirm("x");\n')).toEqual([3]);
  });

  it("does not flag a confirm the file declares or a method of something else", () => {
    expect(flagged("d.confirm(nonce, signed)")).toBe(false);
    expect(flagged("props.confirm && go()")).toBe(false);
    expect(flagged("function f(confirm: () => void) { confirm(); }")).toBe(false);
    expect(flagged("const f = ({ confirm }: P) => confirm();")).toBe(false);
    expect(flagged("interface D { confirm(nonce: string): Promise<void>; }")).toBe(false);
    expect(flagged('const x = { confirm: (r) => go(r) }; <B confirm="Sure?" />;')).toBe(false);
    expect(flagged("const { confirm } = useConfirm(); confirm();")).toBe(false);
    expect(flagged('import { confirm } from "./dialog"; confirm();')).toBe(false);
  });

  it("does not flag the word in a comment or a string", () => {
    expect(flagged("// never call window.confirm here\nconst a = 1;")).toBe(false);
    expect(flagged('/* confirm("x") */ const a = 1;')).toBe(false);
    expect(flagged('const s = "window.confirm(x)";')).toBe(false);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is part of the source text under test
    expect(flagged("const s = `confirm(${x})`;")).toBe(false);
  });
});

describe("the console's source", () => {
  const files = walk(SRC).filter(isSourceFile);

  it("finds the source it is meant to scan", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith("TxButton.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("ConfirmInvoicePanel.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
  });

  it("never opens the browser's confirm box", () => {
    const found = files.flatMap((f) =>
      nativeConfirmLines(readFileSync(f, "utf8"), f).map(
        (line) => `${toPosix(relative(WEB, f))}:${line}`,
      ),
    );
    expect(found).toEqual([]);
  });
});
