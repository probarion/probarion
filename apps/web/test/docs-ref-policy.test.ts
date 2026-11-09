import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CustomRule,
  type DecisionInput,
  decide,
  type MandateView,
  type ModelProposal,
  VAULT_ERROR_CODES,
} from "@probarion/core";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { TABLES } from "@/lib/docs/ref/policy";
import type { RefRow, RefTable } from "@/lib/docs/ref/types";
import { ROOT, readMdx, WEB, walkFiles } from "./docs-helpers";

// The policy rules page, pinned to the code. The rule ids, their effects, the vault codes they mirror, which
// row mirrors which code, and their order are read from packages/core/src/policy.ts,
// contracts/vault/src/checks.rs, the RuleId type, the SDK's sources and the hosted app's custom rules, never
// from the page's own data.

const OUTCOMES = new Set(["pass", "hold", "refuse"]);
const DOTTED = /^[a-z]+\.[a-z_]+$/;
/** Any rule id the SDK could write: the RuleId literals and `custom.${string}`. */
const RULE_ID = /^[a-z]+\.[a-z0-9_.]+$/;
const CUSTOM_ID = /^custom\.[a-z0-9_.]+$/;
const CUSTOM_ROW = "custom.<name>";
const OFF_CHAIN = "None: off-chain only";

const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
const parse = (file: string, text: string) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** The outcome words written as string literals inside an expression. */
function outcomeWords(expr: ts.Node): string[] {
  const out: string[] = [];
  walk(expr, (n) => {
    if (ts.isStringLiteralLike(n) && OUTCOMES.has(n.text)) out.push(n.text);
  });
  return out;
}

/** What a rule does when it fires, in the page's words, from the outcomes the code can give it. */
function effectOf(outcomes: ReadonlySet<string>): string {
  const hold = outcomes.has("hold");
  const refuse = outcomes.has("refuse");
  if (hold && refuse) return "Hold or refuse";
  if (hold) return "Hold";
  if (refuse) return "Refuse";
  return "Note";
}

function add(map: Map<string, Set<string>>, id: string, words: readonly string[]): void {
  const set = map.get(id) ?? new Set<string>();
  for (const w of words) set.add(w);
  map.set(id, set);
}

function propertyOf(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) {
      return p.initializer;
    }
  }
  return undefined;
}

/** A property's value, with a shorthand property (`{ id }`) read as its name. */
function memberOf(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return propertyOf(obj, name);
}

/** The expression under `as`, `satisfies`, `!` and parentheses. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** Every `const NAME = "text"` in the files; a name given two values maps to null. */
function stringConstants(files: readonly ts.SourceFile[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const sf of files) {
    walk(sf, (n) => {
      if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.initializer === undefined) {
        return;
      }
      const list = n.parent;
      if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return;
      const value = unwrap(n.initializer);
      if (!ts.isStringLiteralLike(value)) return;
      const seen = out.get(n.name.text);
      out.set(n.name.text, seen === undefined || seen === value.text ? value.text : null);
    });
  }
  return out;
}

/** What packages/core/src/policy.ts records: every `push(id, outcome, ...)`, read from its syntax tree. */
function policyCode() {
  const file = "packages/core/src/policy.ts";
  const text = read(...file.split("/"));
  const sf = parse(file, text);
  const pushed = new Map<string, Set<string>>();
  const literals = new Set<string>();
  const unreadable: string[] = [];
  let customOutcomes = new Set<string>();
  let runsCustom = false;
  walk(sf, (n) => {
    if (ts.isStringLiteralLike(n) && DOTTED.test(n.text)) literals.add(n.text);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      if (n.expression.text === "runCustomRule") runsCustom = true;
      if (n.expression.text !== "push") return;
      const [id, outcome] = n.arguments;
      const words = outcome === undefined ? [] : outcomeWords(outcome);
      if (id === undefined || !ts.isStringLiteralLike(id) || words.length === 0) {
        unreadable.push(n.getText(sf).slice(0, 120));
        return;
      }
      add(pushed, id.text, words);
    }
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "OUTCOMES" &&
      n.initializer !== undefined
    ) {
      customOutcomes = new Set(outcomeWords(n.initializer));
    }
  });
  const prefixChecked = text.includes('rule.id.startsWith("custom.")');
  return { pushed, literals, unreadable, customOutcomes, runsCustom, prefixChecked };
}

/** The body of `Vault::evaluate` in contracts/vault/src/checks.rs, up to its `Ok(Approved`. */
function evaluateBody(): string {
  const text = read("contracts", "vault", "src", "checks.rs");
  const start = text.indexOf("pub fn evaluate(");
  const end = text.indexOf("Ok(Approved", start);
  expect(start, "checks.rs has no evaluate").toBeGreaterThan(-1);
  expect(end, "evaluate has no Ok(Approved").toBeGreaterThan(start);
  return text.slice(start, end);
}

/** The codes `Vault::evaluate` returns, in the order they first appear (contracts/vault/src/checks.rs). */
function contractOrder(): string[] {
  const codes = [...evaluateBody().matchAll(/ErrorCode::(\w+)/g)].map((m) => m[1] as string);
  return codes.filter((c, at) => codes.indexOf(c) === at);
}

/** The code `evaluate` returns for the one check whose condition contains `condition`: the next `ErrorCode::`. */
function contractCodeFor(condition: string): string {
  const body = evaluateBody();
  const at = body.indexOf(condition);
  expect(at, `evaluate has no ${condition}`).toBeGreaterThan(-1);
  expect(body.indexOf(condition, at + 1), `${condition} is not one check of evaluate`).toBe(-1);
  const code = /ErrorCode::(\w+)/.exec(body.slice(at))?.[1];
  if (code === undefined) throw new Error(`no ErrorCode after ${condition}`);
  return code;
}

/**
 * Rule results the SDK writes itself: every object literal in packages/sdk/src with an `outcome` and either
 * a `detail` or an outcome word, the shape of a `RuleResult` (an RPC execution outcome has an `id` and an
 * `outcome` object, but neither). Its `id` must be a literal, or a `const` holding one, that reads as a
 * rule id, and its `outcome` must name an outcome word: anything else is listed as unreadable, never
 * skipped.
 */
function sdkRules(): { found: Map<string, Set<string>>; unreadable: string[] } {
  const found = new Map<string, Set<string>>();
  const unreadable: string[] = [];
  const files = walkFiles(join(ROOT, "packages", "sdk", "src"), ".ts")
    .filter((f) => !f.endsWith(".test.ts"))
    .map((f) => parse(f, readFileSync(f, "utf8")));
  const constants = stringConstants(files);
  const idOf = (expr: ts.Expression | undefined): string | null => {
    if (expr === undefined) return null;
    const e = unwrap(expr);
    if (ts.isStringLiteralLike(e)) return e.text;
    if (ts.isIdentifier(e)) return constants.get(e.text) ?? null;
    return null;
  };
  for (const sf of files) {
    walk(sf, (n) => {
      if (!ts.isObjectLiteralExpression(n)) return;
      const outcome = memberOf(n, "outcome");
      if (outcome === undefined) return;
      const words = outcomeWords(outcome);
      if (memberOf(n, "detail") === undefined && words.length === 0) return;
      const id = idOf(memberOf(n, "id"));
      if (id === null || !RULE_ID.test(id) || words.length === 0) {
        unreadable.push(`${sf.fileName}: ${n.getText(sf).slice(0, 120)}`);
        return;
      }
      add(found, id, words);
    });
  }
  return { found, unreadable };
}

/**
 * The hosted app's own custom rules: every `custom.*` string in apps/web/src outside tests, with the
 * outcomes of the rule results that file builds under that id (by the literal or the constant holding it).
 */
function appRules(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const src = join(WEB, "src");
  const files = [...walkFiles(src, ".ts"), ...walkFiles(src, ".tsx")].filter(
    (f) => !/\.test\.tsx?$/.test(f),
  );
  for (const f of files) {
    const sf = parse(f, readFileSync(f, "utf8"));
    const ids = new Map<string, string>(); // constant name or literal -> rule id
    walk(sf, (n) => {
      if (!ts.isStringLiteralLike(n) || !CUSTOM_ID.test(n.text)) return;
      ids.set(`"${n.text}"`, n.text);
      let up: ts.Node = n.parent;
      while (ts.isAsExpression(up) || ts.isParenthesizedExpression(up)) up = up.parent;
      if (ts.isVariableDeclaration(up) && ts.isIdentifier(up.name)) ids.set(up.name.text, n.text);
    });
    if (ids.size === 0) continue;
    for (const id of new Set(ids.values())) out.set(id, out.get(id) ?? new Set());
    walk(sf, (n) => {
      if (!ts.isObjectLiteralExpression(n)) return;
      const id = propertyOf(n, "id");
      const outcome = propertyOf(n, "outcome");
      if (id === undefined || outcome === undefined) return;
      const key = ts.isIdentifier(id) ? id.text : ts.isStringLiteralLike(id) ? `"${id.text}"` : "";
      const rule = ids.get(key);
      if (rule !== undefined) add(out, rule, outcomeWords(outcome));
    });
  }
  return out;
}

/** The members of the `RuleId` union in packages/core/src/types.ts. */
function ruleIdType(): { literals: string[]; customTemplate: boolean; unreadable: string[] } {
  const file = "packages/core/src/types.ts";
  const sf = parse(file, read(...file.split("/")));
  const literals: string[] = [];
  const unreadable: string[] = [];
  let customTemplate = false;
  let found = false;
  walk(sf, (n) => {
    if (!ts.isTypeAliasDeclaration(n) || n.name.text !== "RuleId") return;
    found = true;
    const members = ts.isUnionTypeNode(n.type) ? n.type.types : [n.type];
    for (const m of members) {
      if (ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal)) literals.push(m.literal.text);
      else if (ts.isTemplateLiteralTypeNode(m) && m.head.text === "custom.") customTemplate = true;
      else unreadable.push(m.getText(sf));
    }
  });
  expect(found, "types.ts has no RuleId").toBe(true);
  return { literals, customTemplate, unreadable };
}

function tableOf(id: string): RefTable {
  const t = TABLES.find((x) => x.id === id);
  if (t === undefined) throw new Error(`no table ${id} in ref/policy.ts`);
  return t;
}

/** The rule id a row documents: its rule cell is exactly one code name. */
function ruleOf(row: RefRow): string {
  const m = /^`([^`]+)`$/.exec(row.cells.rule ?? "");
  if (!m) throw new Error(`row ${row.id}: the rule cell is not one code name`);
  return m[1] as string;
}

/** The vault codes a row's mirrors cell names. */
const codesOf = (row: RefRow): string[] =>
  [...(row.cells.mirrors ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);

const anchorOf = (prefix: string, rule: string) =>
  rule === CUSTOM_ROW ? `${prefix}-custom` : `${prefix}-${rule.replace(".", "-")}`;

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

const BUILT_IN = tableOf("policy-rules");
const ADDED = tableOf("policy-added");
const builtInIds = BUILT_IN.rows.map(ruleOf).filter((id) => id !== CUSTOM_ROW);

describe("the policy rules of decide()", () => {
  const code = policyCode();

  it("are read from policy.ts without a guess", () => {
    expect(code.unreadable, "a push() whose id or outcome is not a literal").toEqual([]);
    expect(code.pushed.size).toBeGreaterThan(0);
    // A rule id written anywhere but in a push() call would be a rule this test cannot see.
    expect(sorted(code.literals), "a rule id outside push()").toEqual(sorted(code.pushed.keys()));
  });

  it("are every rule id decide() can record, and no other", () => {
    expect(sorted(builtInIds)).toEqual(sorted(code.pushed.keys()));
    expect(builtInIds.length, "a rule documented twice").toBe(new Set(builtInIds).size);
  });

  it("give each rule the effect the code gives it", () => {
    for (const row of BUILT_IN.rows) {
      const rule = ruleOf(row);
      if (rule === CUSTOM_ROW) continue;
      expect(row.cells.effect, rule).toBe(effectOf(code.pushed.get(rule) ?? new Set<string>()));
    }
  });

  it("document the custom rules decide() runs last, with the outcomes it accepts", () => {
    expect(code.runsCustom, "decide() no longer runs custom rules").toBe(true);
    expect(code.prefixChecked, "runCustomRule no longer checks the custom. prefix").toBe(true);
    const rows = BUILT_IN.rows.filter((r) => ruleOf(r) === CUSTOM_ROW);
    expect(rows).toHaveLength(1);
    expect(BUILT_IN.rows.at(-1)?.cells.rule).toBe(`\`${CUSTOM_ROW}\``);
    expect(rows[0]?.cells.effect).toBe(effectOf(code.customOutcomes));
  });

  it("name the vault codes the mirrored rules raise, in the contract's order", () => {
    const mirrored: string[] = [];
    for (const row of BUILT_IN.rows) {
      const cell = row.cells.mirrors ?? "";
      const codes = codesOf(row);
      if (codes.length === 0) {
        expect(cell, ruleOf(row)).toBe(OFF_CHAIN);
        continue;
      }
      for (const c of codes) expect(VAULT_ERROR_CODES as readonly string[], c).toContain(c);
      mirrored.push(...codes);
    }
    // decide() takes the agent key as given, so the contract's first check, NotAgent, has no rule.
    const order = contractOrder();
    expect(order[0]).toBe("NotAgent");
    expect(mirrored).toEqual(order.slice(1));
  });

  it("put each vault code on the row of the rule that refuses where the contract raises it", () => {
    expect(decide(input({ customRules: [] })).verdict, "the clean input is refused or held").toBe(
      "allow",
    );
    const pinned = new Map<string, Set<string>>(); // rule id -> the vault codes it mirrors
    const covered: string[] = [];
    for (const { check, over } of MIRRORED) {
      const code = contractCodeFor(check);
      covered.push(code);
      const refusing = decide(input({ customRules: [], ...over }))
        .rules.filter((r) => r.outcome === "refuse")
        .map((r) => r.id);
      expect(refusing, `${check} (${code}): the rules that refuse`).toHaveLength(1);
      add(pinned, refusing[0] as string, [code]);
    }
    // One case per check of evaluate, but NotAgent, which decide() cannot see.
    expect(sorted(covered)).toEqual(sorted(contractOrder().slice(1)));
    for (const row of BUILT_IN.rows) {
      const rule = ruleOf(row);
      expect(sorted(codesOf(row)), rule).toEqual(sorted(pinned.get(rule) ?? []));
    }
  });

  it("are listed in the order a decision records them", () => {
    const at = (id: string) =>
      BUILT_IN.rows.findIndex((r) => ruleOf(r) === (id.startsWith("custom.") ? CUSTOM_ROW : id));
    const seen = new Set<string>();
    for (const [name, input] of SCENARIOS) {
      const ids = decide(input).rules.map((r) => r.id);
      const places = ids.map(at);
      expect(places, `${name}: an undocumented rule in ${ids.join(", ")}`).not.toContain(-1);
      const rising = places.every((p, i) => i === 0 || p > (places[i - 1] as number));
      expect(rising, `${name}: recorded as ${ids.join(", ")}`).toBe(true);
      for (const p of places) seen.add(ruleOf(BUILT_IN.rows[p] as RefRow));
    }
    // The scenarios between them record every documented rule, so the order of each one is checked.
    expect(sorted(seen)).toEqual(sorted(BUILT_IN.rows.map(ruleOf)));
  });
});

describe("the rule ids recorded outside decide()", () => {
  it("are the ones the SDK and the hosted app write, with their effects", () => {
    const sdk = sdkRules();
    expect(sdk.unreadable, "a rule result in the SDK whose id or outcome cannot be read").toEqual(
      [],
    );
    expect(sdk.found.size).toBeGreaterThan(0);
    const code = new Map([...sdk.found, ...appRules()]);
    const documented = ADDED.rows.map(ruleOf);
    expect(documented.length, "a rule documented twice").toBe(new Set(documented).size);
    expect(sorted(documented)).toEqual(sorted(code.keys()));
    for (const row of ADDED.rows) {
      const rule = ruleOf(row);
      const outcomes = code.get(rule) ?? new Set<string>();
      expect(outcomes.size, `${rule}: no outcome found in the code`).toBeGreaterThan(0);
      expect(row.cells.effect, rule).toBe(effectOf(outcomes));
    }
  });

  it("with decide()'s rules, are every member of the RuleId type", () => {
    const type = ruleIdType();
    expect(type.unreadable).toEqual([]);
    expect(type.customTemplate, "RuleId has no custom template member").toBe(true);
    const named = [...builtInIds, ...ADDED.rows.map(ruleOf)].filter(
      (id) => !id.startsWith("custom."),
    );
    expect(sorted(named)).toEqual(sorted(type.literals));
  });
});

describe("the policy rules page", () => {
  it("anchors each row by its table and rule id", () => {
    for (const row of BUILT_IN.rows) expect(row.id).toBe(anchorOf("policy", ruleOf(row)));
    for (const row of ADDED.rows) expect(row.id).toBe(anchorOf("policy-added", ruleOf(row)));
  });

  it("shows both tables", () => {
    const page = readMdx("build/policy-rules");
    expect(TABLES.map((t) => t.id)).toEqual(["policy-rules", "policy-added"]);
    for (const t of TABLES) expect(page).toContain(`<RefTable id="${t.id}" />`);
  });
});

// ---------- decide() inputs that, between them, record every rule ----------

const PURPOSE = "a".repeat(64);
const AGENT = "ed25519:11111111111111111111111111111111";

const MANDATE: MandateView = {
  id: 1,
  payee: { type: "near", account_id: "shop.testnet" },
  purpose_hash: PURPOSE,
  max_per_payment: "100",
  max_total: "1000",
  spent: "0",
  reserved: "0",
  max_uses: 10,
  uses: 0,
  expires_at_ns: "4102444800000000000",
  approval_above: "50",
  agent_pk: AGENT,
  label: "test",
  status: "active",
  created_at_ns: "0",
};

const PROPOSAL: ModelProposal = {
  action: "pay",
  mandate_id: 1,
  amount: "10",
  payee_hint: null,
  reasoning: "fits the mandate",
  confidence: 0.9,
};

const CUSTOM: CustomRule = {
  id: "custom.test",
  check: () => ({ id: "custom.test", outcome: "pass", detail: "ok" }),
};

function input(over: Partial<DecisionInput>): DecisionInput {
  return {
    vault: "acme.vaults.probarion.testnet",
    agentPk: AGENT,
    now: new Date("2026-11-09T00:00:00Z"),
    invoice: {
      invoice_hash: "b".repeat(64),
      amount: "10",
      po_ref: "PO-1",
      purpose_hash: PURPOSE,
      payee_hint: null,
    },
    proposal: null,
    attestationOk: null,
    mandates: [MANDATE],
    paidInvoiceHashes: new Set(),
    usedRefs: new Set(),
    intentsBalance: null,
    frozen: false,
    confidenceFloor: 0.7,
    customRules: [CUSTOM],
    ref: "INV-1",
    daily: { backstop: "1000", spent_today: "0" },
    ...over,
  };
}

const SCENARIOS: readonly (readonly [string, DecisionInput])[] = [
  // A ref of 0 bytes records contract.check_failed; a trusted proposal records the model rules.
  ["trusted proposal, bad ref", input({ ref: "", proposal: PROPOSAL, attestationOk: true })],
  ["proposal without attestation", input({ proposal: PROPOSAL, attestationOk: false })],
  ["model unavailable", input({ proposal: null, attestationOk: false })],
  ["no mandate", input({ mandates: [] })],
];

// ---------- one decide() case per check of Vault::evaluate (contracts/vault/src/checks.rs) ----------

// `check` is text of the condition in evaluate; `over` changes the clean input the same way, so exactly
// one rule refuses. The code is read from checks.rs, the rule from decide().
const withInvoice = (over: Partial<DecisionInput["invoice"]>): Partial<DecisionInput> => ({
  invoice: { ...input({}).invoice, ...over },
});
const withMandate = (over: Partial<MandateView>): Partial<DecisionInput> => ({
  mandates: [{ ...MANDATE, ...over }],
});

const MIRRORED: readonly { check: string; over: Partial<DecisionInput> }[] = [
  { check: "is_hex64(&req.invoice_hash)", over: withInvoice({ invoice_hash: "B".repeat(64) }) },
  { check: "is_ref(&req.r#ref)", over: { ref: "" } },
  { check: "self.frozen", over: { frozen: true } },
  { check: "self.mandates.get(mandate_idx)", over: { mandates: [] } },
  { check: "m.revoked", over: withMandate({ status: "revoked" }) },
  { check: "now >= m.expires_at_ns", over: withMandate({ expires_at_ns: "1" }) },
  {
    check: "m.agent_pk != *signer_pk",
    over: withMandate({ agent_pk: "ed25519:22222222222222222222222222222222" }),
  },
  { check: "amount == 0", over: withInvoice({ amount: "0" }) },
  { check: "amount > m.max_per_payment", over: withInvoice({ amount: "101" }) },
  { check: "m.uses >= m.max_uses", over: withMandate({ uses: 10 }) },
  { check: "m.spent.saturating_add(m.reserved)", over: withMandate({ spent: "995" }) },
  {
    check: "self.invoices.contains_key(&req.invoice_hash)",
    over: { paidInvoiceHashes: new Set(["b".repeat(64)]) },
  },
  { check: "self.refs.contains(&req.r#ref)", over: { usedRefs: new Set(["INV-1"]) } },
  { check: "self.daily_backstop", over: { daily: { backstop: "1000", spent_today: "995" } } },
];
