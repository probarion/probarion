import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// What the extension may call, and what it may say about money. The extension queues an invoice for the owner's
// wallet-signed Confirm. It can't pay or approve, and nothing it shows may say or suggest that it does.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const list = (dir: string, ext: string) =>
  readdirSync(join(root, dir), { recursive: true })
    .map((f) => `${dir}/${String(f).replaceAll("\\", "/")}`)
    .filter((f) => f.endsWith(ext));

const sources = list("src", ".ts");

/** The source without its comments (a `//` after a colon is a URL's). */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The string literals of a source file, with their quotes. */
const literals = (text: string) => code(text).match(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];

/** Every file whose words a reader of the store, the README or the checklist sees. */
const PROSE = [
  "README.md",
  "TESTING.md",
  "package.json",
  "scripts/manifest.mjs",
  ...list("store", ".md"),
  ...list("store/preview", ".html"),
];

/** A prose file's text as a reader sees it: no markup, no comments in the build scripts. */
const shown = (path: string) =>
  read(path)
    .replace(/<(style|script)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(path.startsWith("scripts/") ? /\/\*[\s\S]*?\*\/|\/\/.*$/gm : /(?!)/g, "");

/** The sentences of a prose file: a wrapped line joins the one before it, a list item or a blank line starts a new one. */
function sentences(path: string): string[] {
  const units: string[] = [];
  for (const line of shown(path)
    .replace(/`[^`\n]*`/g, " ")
    .split("\n")) {
    const text = line.trim();
    const last = units.length - 1;
    if (text === "") units.push("");
    else if (last < 0 || units[last] === "" || /^(?:[-*]\s|\d+\.\s|\|)/.test(text))
      units.push(text);
    else units[last] += ` ${text}`;
  }
  return units.flatMap((u) => u.split(/(?<=[.!?])\s+/)).filter((s) => s !== "");
}

describe("the server paths the client calls", () => {
  it("are the pairing, inbox, invoices and revoke routes and nothing else", () => {
    const paths = new Set<string>();
    for (const f of sources) {
      for (const m of read(f).matchAll(/["'`](\/api\/[^"'`]*)["'`]/g)) paths.add(m[1] ?? "");
    }
    expect([...paths].sort()).toEqual([
      "/api/ext/inbox",
      "/api/ext/invoices",
      "/api/ext/pair",
      "/api/ext/revoke",
    ]);
  });

  it("are asked for from one place, api.ts, which sends no cookies", () => {
    expect(read("src/api.ts")).toContain(`credentials: "omit"`);
    // The other requests: a captured file from the page's own site (capture.ts), and the two places that hand
    // `fetch` to the code that makes them.
    const callers = sources.filter((f) => /\b(?:fetchFn|fetch)\(/.test(code(read(f)))).sort();
    expect(callers).toEqual(["src/api.ts", "src/capture.ts", "src/popup/main.ts", "src/worker.ts"]);
  });
});

/** Why a sentence breaks the rule that the extension queues and doesn't pay or approve; empty when it doesn't. */
function claimProblems(sentence: string): string[] {
  const problems: string[] = [];
  const says = /\b(?:pay|pays|paying|paid|approve|approves|approved|approval)\b/i.test(sentence);
  const safe =
    /\b(?:can't|cannot|can not|does not|do not|nothing|not)\b|\bconfirm|\bsign|\bvault\b|\bProbarion pays\b/i;
  if (says && !safe.test(sentence)) {
    problems.push("says money moves, with no negation, confirmation or vault");
  }
  if (/\bpay only when you sign\b/i.test(sentence)) {
    problems.push("reads as if paying happens in the browser");
  }
  if (
    /\b(?:the extension|the popup|this extension)\s+(?:pays|paid|approves|approved)\b(?!\s+nothing)/i.test(
      sentence,
    )
  ) {
    problems.push("says the extension pays or approves");
  }
  if (
    /\b(?:queued|sent)\b[^.\n]*\bis paid\b(?![^.\n]*\b(?:only|until|after|when)\b)/i.test(sentence)
  ) {
    problems.push("calls a queued invoice paid");
  }
  if (/\b(?:pay|approve)\s+(?:now|this invoice|the invoice)\b/i.test(sentence)) {
    problems.push("offers a pay or approve action");
  }
  return problems;
}

describe("what the extension says about money", () => {
  it("flags a sentence that says the extension or a queued invoice pays", () => {
    for (const bad of [
      "Send invoices from the browser. Pay only when you sign.",
      "The extension pays your invoices.",
      "Your queued invoice is paid.",
      "Pay now",
      "Approve this invoice",
      "Pay invoices from your browser.",
    ]) {
      expect(claimProblems(bad), bad).not.toEqual([]);
    }
    for (const good of [
      "It can't pay or approve.",
      "The vault pays it on testnet; the extension paid nothing.",
      "Nothing is paid from the browser.",
      "A queued invoice is paid only when the vault's owner confirms it in the console with their wallet.",
      "the vault already paid this invoice or is holding a payment for it.",
      "Queue invoices from the browser. Confirm them in the console.",
    ]) {
      expect(claimProblems(good), good).toEqual([]);
    }
  });

  it("is said in the popup only by the sentences that say nothing is paid here, or name the vault", () => {
    const verbs = /\b(?:pay|pays|paying|paid|approve|approves|approved)\b/i;
    const found = new Set<string>();
    for (const f of sources.filter((x) => x.startsWith("src/popup/") || x === "src/api.ts")) {
      for (const lit of literals(read(f))) if (verbs.test(lit)) found.add(lit.slice(1, -1));
    }
    expect([...found].sort()).toEqual([
      "Nothing is paid from the browser. It waits until the vault's owner confirms it in the console with their wallet.",
      "Nothing is paid from the browser. It waits until you confirm it in the console with your wallet.",
      "paying it would pass the vault's daily limit.",
      "the vault already paid this invoice or is holding a payment for it.",
    ]);
  });

  it.each(PROSE)("%s claims nothing like that", (path) => {
    for (const s of sentences(path)) expect(claimProblems(s), `${path}: ${s}`).toEqual([]);
  });

  it("claims nothing like that in any string the code shows", () => {
    for (const f of sources) {
      for (const lit of literals(read(f))) {
        expect(claimProblems(lit.slice(1, -1)), `${f}: ${lit}`).toEqual([]);
      }
    }
  });
});

describe("the words of every page and string a person reads", () => {
  const texts = [
    ...PROSE.map((path) => ({ path, text: shown(path) })),
    ...sources.flatMap((f) =>
      literals(read(f)).map((lit) => ({ path: f, text: lit.slice(1, -1) })),
    ),
  ];

  it.each([
    ["please", /\bplease\b/i],
    ["an exclamation mark", /[A-Za-z)]!(?:\s|$)/],
    ["guarantee", /\bguarantee/i],
    ["100%", /100\s?%/],
    ["unhackable", /unhackable/i],
    ["never", /\bnever\b/i],
  ])("have no %s", (_name, pattern) => {
    for (const { path, text } of texts) expect(text, path).not.toMatch(pattern);
  });
});
