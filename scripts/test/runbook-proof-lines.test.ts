import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { main } from "../proof.js";

/**
 * The runbooks in docs/runbooks are the real callers of `pnpm proof`. Every
 * `pnpm proof add-tx ...` and `pnpm proof set ...` command they contain (fenced blocks and
 * inline code) must be accepted by the CLI, with the shell placeholders replaced by valid values.
 */

const RUNBOOK_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "runbooks",
);
const NOW = new Date("2026-11-04T10:00:00.000Z");

const NEAR_TX_HASH = "8qkFz1q7mJpQd9wZ3yX4hT6uV2bN5cR1sE7gK3aL9mP";
const BASE_TX_HASH = `0x${"ab".repeat(32)}`;
const CODE_HASH = "5Rk2nWdQ8vYbT3gH7jL4mN9pS6uX1zA2cE5fG8hJ3kM";
const OWNER_ID = "owner.near";
const ACCOUNTS: Record<string, string> = {
  OWNER_ID,
  VAULT: "v0.probarion.near",
  FACTORY: "vaults.probarion.near",
  ROOT: "probarion.near",
  GLOBAL_SIGNER: "probarion.near",
  GLOBAL_RECEIVER: "vaults.probarion.near",
};

// ---- a small shell-word splitter: single quotes, double quotes, $NAME, ${NAME}, $(...) ----

type Part = { lit: string } | { name: string } | { cmd: string };
type Word = Part[];

/** The inner text and the end index of the `$(...)` that starts at `start` (the `$`). */
function readCommandSubstitution(s: string, start: number): { inner: string; end: number } {
  let depth = 0;
  for (let i = start + 1; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "\\") {
      i++;
    } else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) break;
      i = close;
    } else if (c === '"') {
      let j = i + 1;
      while (j < s.length && s.charAt(j) !== '"') j += s.charAt(j) === "\\" ? 2 : 1;
      i = j;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return { inner: s.slice(start + 2, i), end: i + 1 };
    }
  }
  throw new Error(`unterminated $( in: ${s}`);
}

/** A `$NAME`, `${NAME}` or `$(...)` at `i`, or null when the `$` is a plain character. */
function readDollar(s: string, i: number): { part: Part; end: number } | null {
  const next = s.charAt(i + 1);
  if (next === "(") {
    const { inner, end } = readCommandSubstitution(s, i);
    return { part: { cmd: inner }, end };
  }
  if (next === "{") {
    const close = s.indexOf("}", i + 2);
    if (close < 0) throw new Error(`unterminated \${ in: ${s}`);
    return { part: { name: s.slice(i + 2, close) }, end: close + 1 };
  }
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i + 1));
  return m ? { part: { name: m[0] }, end: i + 1 + m[0].length } : null;
}

function splitWords(s: string): Word[] {
  const words: Word[] = [];
  let current: Word | null = null;
  const open = (): Word => {
    current ??= [];
    return current;
  };
  const addLit = (text: string) => {
    const w = open();
    const last = w[w.length - 1];
    if (last && "lit" in last) last.lit += text;
    else w.push({ lit: text });
  };
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === " " || c === "\t" || c === "\n") {
      if (current) words.push(current);
      current = null;
      i++;
    } else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) throw new Error(`unterminated ' in: ${s}`);
      open();
      addLit(s.slice(i + 1, close));
      i = close + 1;
    } else if (c === '"') {
      open();
      i++;
      for (;;) {
        const d = s.charAt(i);
        if (d === "") throw new Error(`unterminated " in: ${s}`);
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\" && '"\\$`'.includes(s.charAt(i + 1)) && i + 1 < s.length) {
          addLit(s.charAt(i + 1));
          i += 2;
          continue;
        }
        const dollar = d === "$" ? readDollar(s, i) : null;
        if (dollar) {
          open().push(dollar.part);
          i = dollar.end;
        } else {
          addLit(d);
          i++;
        }
      }
    } else if (c === "\\") {
      addLit(s.charAt(i + 1));
      i += 2;
    } else {
      const dollar = c === "$" ? readDollar(s, i) : null;
      if (dollar) {
        open().push(dollar.part);
        i = dollar.end;
      } else {
        addLit(c);
        i++;
      }
    }
  }
  if (current) words.push(current);
  return words;
}

// ---- placeholder values ----

/** A value that is valid for the flag (or, for `set`, the section) a leftover `$NAME` stands in for. */
function genericStandIn(flag: string | undefined, setKey: string | undefined): string {
  switch (flag) {
    case "--hash":
      return NEAR_TX_HASH;
    case "--signer":
    case "--receiver":
      return OWNER_ID;
    case "--base-tx":
      return BASE_TX_HASH;
    case "--signed-by":
      return "owner";
    case "--kind":
      return "other";
    case "--spend-id":
      return "1";
    case "--amount":
      return "1.00";
    case "--error-code":
      return "NoMandate";
    case "--network":
      return "mainnet";
    case "--expect":
      return "success";
    case "--id":
      return "stand_in_id";
    case undefined:
      break;
    default:
      return "stand-in text";
  }
  switch (setKey?.split(".")[0]) {
    case "accounts":
      return OWNER_ID;
    case "code_hashes":
      return CODE_HASH;
    case "versions":
      return "0.1.0";
    case "links":
      return "https://example.com/stand-in";
    default:
      return "stand-in";
  }
}

function standIn(name: string, flag: string | undefined, setKey: string | undefined): string {
  if (name === "H" || name.endsWith("_TX")) return NEAR_TX_HASH;
  if (name === "BASE_H") return BASE_TX_HASH;
  const account = ACCOUNTS[name];
  if (account) return account;
  if (name === "GLOBAL_SIGNED_BY") return "owner";
  if (name.endsWith("HASH") || name === "RECORDED") return CODE_HASH;
  return genericStandIn(flag, setKey);
}

function commandSubstitution(cmd: string): string {
  // mainnet-v0.md calls `node.exe`: an interactive Git Bash aliases a bare `node` to winpty.
  if (/^node(?:\.exe)? scripts\/code-hash\.mjs hash\b/.test(cmd)) return CODE_HASH;
  throw new Error(`no stand-in for the command substitution $(${cmd})`);
}

/** The CLI arguments (everything after `pnpm proof`) with every placeholder replaced. */
function toArgv(command: string): string[] {
  const [pnpm, proof, ...words] = splitWords(command);
  expect([pnpm, proof]).toEqual([[{ lit: "pnpm" }], [{ lit: "proof" }]]);
  const argv: string[] = [];
  for (const word of words) {
    const prev = argv[argv.length - 1];
    const flag = prev?.startsWith("--") ? prev : undefined;
    const setKey = argv[0] === "set" ? argv[1] : undefined;
    argv.push(
      word
        .map((part) => {
          if ("lit" in part) return part.lit;
          if ("name" in part) return standIn(part.name, flag, setKey);
          return commandSubstitution(part.cmd);
        })
        .join(""),
    );
  }
  return argv;
}

// ---- extracting the commands from the runbooks ----

interface ProofCommand {
  file: string;
  line: number;
  text: string;
  /** The whole (continuation-joined) line the command was found on. */
  context: string;
}

interface RunbookScan {
  commands: ProofCommand[];
  exempt: ProofCommand[];
  /** Every `pnpm proof add-tx` / `pnpm proof set` occurrence in the file, however it is written. */
  raw: number;
}

/**
 * Prose that names a command without being one. Listed by file and line content (not line
 * number), so a runbook edit that moves the line does not break this and a new mention does.
 */
const EXEMPT_MENTIONS: readonly { file: string; contains: string }[] = [
  { file: "mainnet-v0.md", contains: "runs the `pnpm proof add-tx …` line given in the step" },
];

/** The runbooks that call the CLI, and how many commands each must contribute at least. */
const MIN_COMMANDS: Record<string, number> = { "factory.md": 11, "mainnet-v0.md": 13 };

function scanRunbook(file: string, markdown: string): RunbookScan {
  const lines = markdown.replaceAll("\r", "").split("\n");
  const commands: ProofCommand[] = [];
  const exempt: ProofCommand[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    let logical = lines[i] ?? "";
    while (logical.endsWith("\\") && i + 1 < lines.length) {
      i++;
      logical = `${logical.slice(0, -1)} ${(lines[i] ?? "").trim()}`;
    }
    // a command at the start of a line (fenced block) or inside an inline code span
    for (const m of logical.matchAll(/(?:^\s*|`)(pnpm proof (?:add-tx|set)\b[^`]*)/g)) {
      const found: ProofCommand = { file, line, text: (m[1] ?? "").trim(), context: logical };
      const isListedMention =
        /^pnpm proof (?:add-tx|set)\s*…$/.test(found.text) &&
        EXEMPT_MENTIONS.some((e) => e.file === file && logical.includes(e.contains));
      (isListedMention ? exempt : commands).push(found);
    }
  }
  const raw = (markdown.match(/pnpm proof (?:add-tx|set)\b/g) ?? []).length;
  return { commands, exempt, raw };
}

const SCANS = new Map<string, RunbookScan>(
  readdirSync(RUNBOOK_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => [f, scanRunbook(f, readFileSync(join(RUNBOOK_DIR, f), "utf8"))]),
);
const COMMANDS: ProofCommand[] = [...SCANS.values()].flatMap((s) => s.commands);

/** Runs the CLI on a fresh, initialised proof file; returns its exit code and stderr. */
function runOnFreshFile(argv: string[]): { code: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "proof-runbook-"));
  const path = join(dir, "mainnet-proof.json");
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    stderr.push(a.join(" "));
  });
  try {
    expect(main(["init"], NOW, path)).toBe(0);
    return { code: main(argv, NOW, path), stderr: stderr.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("shell-word splitter used for the runbook lines", () => {
  it("handles quotes, bare and braced names and a nested command substitution", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell ${NAME} syntax is the input under test
    const input = 'a "b $(node x.mjs "q r") c" \'d $E\' "$F-${G}" "esc \\" \\$H" $I';
    const words = splitWords(input);
    expect(words).toEqual([
      [{ lit: "a" }],
      [{ lit: "b " }, { cmd: 'node x.mjs "q r"' }, { lit: " c" }],
      [{ lit: "d $E" }],
      [{ name: "F" }, { lit: "-" }, { name: "G" }],
      [{ lit: 'esc " $H' }],
      [{ name: "I" }],
    ]);
  });

  it("gives an unknown $NAME a value that is valid for its flag or section", () => {
    expect(toArgv('pnpm proof add-tx --signer "$WHO" --kind "$K" --hash "$X"')).toEqual([
      "add-tx",
      "--signer",
      OWNER_ID,
      "--kind",
      "other",
      "--hash",
      NEAR_TX_HASH,
    ]);
    expect(toArgv('pnpm proof set code_hashes.vault "$SOMETHING" --source "$SRC"')).toEqual([
      "set",
      "code_hashes.vault",
      CODE_HASH,
      "--source",
      "stand-in text",
    ]);
  });
});

describe("pnpm proof lines in docs/runbooks", () => {
  it("finds at least the known number of commands in each runbook", () => {
    for (const [file, min] of Object.entries(MIN_COMMANDS)) {
      expect(SCANS.get(file)?.commands.length ?? 0, file).toBeGreaterThanOrEqual(min);
    }
  });

  it("accounts for every `pnpm proof add-tx|set` occurrence: a command under test or a listed mention", () => {
    for (const [file, scan] of SCANS) {
      expect(
        scan.commands.length + scan.exempt.length,
        `${file}: ${scan.raw} occurrences of "pnpm proof add-tx|set" but ${scan.commands.length} extracted commands and ${scan.exempt.length} exempt mentions; ` +
          "a command written as `$ pnpm proof …`, `- pnpm proof …`, `X=1 pnpm proof …` or `cd x && pnpm proof …` is not extracted",
      ).toBe(scan.raw);
    }
  });

  it("uses every listed exemption exactly once", () => {
    const exempt = [...SCANS.values()].flatMap((s) => s.exempt);
    expect(exempt).toHaveLength(EXEMPT_MENTIONS.length);
  });

  it("the cross-check notices commands the extractor cannot read (negative control)", () => {
    const md = [
      "```bash",
      'pnpm proof set accounts.aa_bb x.near --source "s" \\',
      "  --type string",
      '$ pnpm proof set accounts.cc_dd x.near --source "s"',
      "- pnpm proof set accounts.ee_ff x.near --source s",
      "FOO=1 pnpm proof add-tx --id gg_hh",
      "cd docs && pnpm proof set accounts.ii_jj x.near --source s",
      "```",
      "see `pnpm proof add-tx …` here",
    ].join("\n");
    const scan = scanRunbook("synthetic.md", md);
    expect(scan.raw).toBe(6);
    // the continued command is joined into one; the unlisted prose mention counts as a command
    expect(scan.commands.map((c) => c.line)).toEqual([2, 9]);
    expect(scan.commands[0]?.text).toBe(
      'pnpm proof set accounts.aa_bb x.near --source "s"  --type string',
    );
    expect(scan.exempt).toHaveLength(0);
    expect(scan.commands.length + scan.exempt.length).toBeLessThan(scan.raw);
  });

  it("the harness fails a command the CLI refuses (negative control)", () => {
    const argv = toArgv(
      'pnpm proof add-tx --id x_tx --hash "$H" --signer "$VAULT" --receiver "$VAULT" --kind teleport --signed-by owner --what "an unknown kind"',
    );
    const r = runOnFreshFile(argv);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/kind must be one of/);
  });

  it("uses each add-tx id once across all runbooks", () => {
    const ids = COMMANDS.map((c) => toArgv(c.text))
      .filter((argv) => argv[0] === "add-tx")
      .map((argv) => argv[argv.indexOf("--id") + 1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(COMMANDS.map((c) => [`${c.file}:${c.line} ${c.text.slice(0, 80)}`, c] as const))(
    "%s",
    (_title, c) => {
      const r = runOnFreshFile(toArgv(c.text));
      expect(r.code, `${c.file}:${c.line}: ${c.text}\n${r.stderr}`).toBe(0);
    },
  );
});
