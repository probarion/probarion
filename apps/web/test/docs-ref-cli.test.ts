// The CLI reference (/docs/build/cli-reference) against the CLI itself. The test builds the program with
// buildProgram(io), walks its commands and options, runs a few of them in-process (no network, no keys), and reads
// packages/cli/src/commands for the calls they print. It never reads the page's data to learn what the code has, so
// a command, an option, a default, a signer or an exit code that changes in the code fails it until the page follows.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { TABLES } from "@/lib/docs/ref/cli";
import type { RefRow, RefTable } from "@/lib/docs/ref/types";
import { ROOT, readMdx, walkFiles } from "./docs-helpers";

/**
 * The parts of commander's Command and Option this test reads. The program is loaded from a computed path, as in
 * test/proof-parity.test.ts, so the web typecheck does not pull the CLI's sources and commander into its program.
 */
interface CliOption {
  readonly flags: string;
  readonly long?: string;
  readonly mandatory: boolean;
  readonly defaultValue?: unknown;
}

interface CliArgument {
  name(): string;
  readonly required: boolean;
  readonly variadic: boolean;
}

interface CliCommand {
  name(): string;
  description(): string;
  readonly commands: readonly CliCommand[];
  readonly options: readonly CliOption[];
  readonly registeredArguments: readonly CliArgument[];
  createHelp(): {
    visibleOptions(command: CliCommand): readonly CliOption[];
    visibleCommands(command: CliCommand): readonly CliCommand[];
  };
}

/** packages/cli/src/io.ts `CliIo`, without the optional members. */
interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  now(): Date;
  setExitCode(code: number): void;
}

interface CliModule {
  buildProgram(io: CliIo): CliCommand;
  runCli(argv: readonly string[], io: CliIo): Promise<number>;
}

const CLI_SRC = join(ROOT, "packages", "cli", "src");
const COMMANDS_DIR = join(CLI_SRC, "commands");
const PROGRAM_TS = join(CLI_SRC, "program.ts");
const PAGE = "build/cli-reference";

const loadCli = async () => (await import(/* @vite-ignore */ PROGRAM_TS)) as CliModule;

/** A CliIo that records what the CLI writes, with an empty environment and a fixed clock. */
function recorder(cwd: string) {
  const seen = { out: "", err: "" };
  const io: CliIo = {
    out: (text) => {
      seen.out += text;
    },
    err: (text) => {
      seen.err += text;
    },
    env: {},
    cwd,
    now: () => new Date("2026-11-09T00:00:00.000Z"),
    setExitCode: () => {},
  };
  return { io, seen };
}

/**
 * Every command under `command` by its full path ("vault create"): the leaves, the groups that hold them, and the
 * `help [command]` that commander adds on its own to a command with subcommands and no action. That one is in the
 * help's visibleCommands, not in `commands`, so the walk reads both.
 */
function walk(command: CliCommand, prefix: readonly string[] = []) {
  const leaves = new Map<string, CliCommand>();
  const groups = new Map<string, CliCommand>();
  const helps = new Map<string, CliCommand>();
  const implicit = command
    .createHelp()
    .visibleCommands(command)
    .filter((c) => !command.commands.includes(c));
  for (const sub of [...command.commands, ...implicit]) {
    const path = [...prefix, sub.name()];
    if (implicit.includes(sub)) {
      helps.set(path.join(" "), sub);
      continue;
    }
    if (sub.commands.length === 0) {
      leaves.set(path.join(" "), sub);
      continue;
    }
    groups.set(path.join(" "), sub);
    const inner = walk(sub, path);
    for (const [p, c] of inner.leaves) leaves.set(p, c);
    for (const [p, c] of inner.groups) groups.set(p, c);
    for (const [p, c] of inner.helps) helps.set(p, c);
  }
  return { leaves, groups, helps };
}

/** The program's commands. The program's own `help` is a leaf with a row; a group's `help` is named in that row. */
async function program() {
  const { buildProgram } = await loadCli();
  const root = buildProgram(recorder(ROOT).io);
  const { leaves, groups, helps } = walk(root);
  const help = helps.get("help");
  if (help) leaves.set("help", help);
  return { root, leaves, groups, helps };
}

/** A command as its help names it: the path, then each argument, `<name>` when required, `[name]` when not. */
const commandTerm = (path: string, command: CliCommand) =>
  [
    path,
    ...command.registeredArguments.map((a) => {
      const name = `${a.name()}${a.variadic ? "..." : ""}`;
      return a.required ? `<${name}>` : `[${name}]`;
    }),
  ].join(" ");

/** A valid value for each flag that `runtimeRequired` supplies, so that the next run reports the next missing flag. */
const SAMPLE: Readonly<Record<string, string>> = {
  "--pk": "ed25519:11111111111111111111111111111111",
  "--mandate": "1",
  "--spend": "1",
  "--amount": "1",
  "--token": "base",
};

/**
 * The flags that a printed call refuses to run without although commander does not mark them mandatory: the call
 * reads them through `required(o.<x>, "<flag>")` at run time. It runs the command in-process in an empty folder,
 * with only `--vault`, and each time the command stops with "error: <flag> is required" it adds that flag with its
 * SAMPLE value and runs it again, until the command prints its call. Nothing it runs reads the chain.
 */
async function runtimeRequired(path: string, problems: string[]): Promise<string[]> {
  const { runCli } = await loadCli();
  const found: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "probarion-cli-required-"));
  try {
    for (;;) {
      const given = found.flatMap((f) => [f, SAMPLE[f] ?? ""]);
      const { io, seen } = recorder(dir);
      if ((await runCli([...path.split(" "), "--vault", "x.testnet", ...given], io)) === 0) {
        return found;
      }
      const flag = /^error: (--[a-z][a-z0-9-]*) is required\n$/.exec(seen.err)?.[1];
      if (flag === undefined || found.includes(flag) || SAMPLE[flag] === undefined) {
        problems.push(
          `${path}: stopped with ${JSON.stringify(seen.err)} (give SAMPLE a valid value for the flag)`,
        );
        return found;
      }
      found.push(flag);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the page's data -----------------------------------------------------------------------------

const cell = (row: RefRow, key: string) => row.cells[key] ?? "";

/** The code spans of a cell, in order. */
const codeSpans = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

/** The long flags that a cell's code spans name. */
const longFlags = (text: string) =>
  codeSpans(text).flatMap((span) =>
    [...span.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)].map((m) => m[0]),
  );

/** An options cell entry by entry: the flags in backticks, and the note in parentheses after them. */
const optionEntries = (text: string) =>
  [...text.matchAll(/`(--[^`]+)`(?: \(([^)]*)\))?/g)].map((m) => ({
    flags: m[1] ?? "",
    note: m[2] ?? "",
  }));

const COMMAND_TABLES = TABLES.filter((t) => t.id.startsWith("cli-commands-"));
/** The command's path, without its arguments: "`help [command]`" is the command `help`. */
const commandOf = (row: RefRow) =>
  (codeSpans(cell(row, "command"))[0] ?? "").replace(/ [[<].*$/, "");
const rowOf = (path: string) =>
  COMMAND_TABLES.flatMap((t) => t.rows).find((r) => commandOf(r) === path);

function tableOf(id: string): RefTable {
  const table = TABLES.find((t) => t.id === id);
  if (!table) throw new Error(`no table ${id}`);
  return table;
}

// --- the code ------------------------------------------------------------------------------------

type Deposit = "one-yocto" | "none" | "near";

/**
 * Each call the commands print, read from packages/cli/src/commands: its method, its prepaid gas, and its deposit
 * (1 yoctoNEAR, none, or an amount of NEAR the command works out). printOwnerTx calls write `method`, `gasTgas` and
 * `deposit`; the OWNER_CALLS rows write `method`, `gasTgas` and `oneYocto`.
 */
function printedCalls(): Map<string, { gas: string; deposit: Deposit }> {
  const calls = new Map<string, { gas: string; deposit: Deposit }>();
  const CALL =
    /method: "([a-z_]+)",[\s\S]*?gasTgas: "([0-9.]+)",\s*(deposit: ONE_YOCTO\b|oneYocto: (?:true|false))?/g;
  let methods = 0;
  for (const file of walkFiles(COMMANDS_DIR, ".ts").filter((f) => !f.endsWith(".test.ts"))) {
    const src = readFileSync(file, "utf8");
    methods += [...src.matchAll(/method: "/g)].length;
    for (const m of src.matchAll(CALL)) {
      const how = m[3] ?? "";
      const deposit: Deposit =
        how === "" ? "near" : how === "oneYocto: false" ? "none" : "one-yocto";
      calls.set(m[1] ?? "", { gas: m[2] ?? "", deposit });
    }
  }
  // A call written another way would be skipped, or read with the next call's gas: teach this test the new shape.
  expect(calls.size, 'every method: "..." in the commands has its own gasTgas').toBe(methods);
  return calls;
}

/** The exit codes a command's help lists under "Exit codes:", in order. */
function helpExitCodes(help: string): string[] {
  const at = help.indexOf("Exit codes:");
  if (at < 0) return [];
  const codes: string[] = [];
  for (const line of help.slice(at).split("\n").slice(1)) {
    const m = /^\s+(\d+)\s{2,}\S/.exec(line);
    if (!m) break;
    codes.push(m[1] ?? "");
  }
  return codes;
}

// --- the tests -----------------------------------------------------------------------------------

describe("the CLI reference", () => {
  // The first import of the CLI source can take longer than a test, on a busy machine; later ones are cached.
  beforeAll(async () => {
    await loadCli();
  }, 180_000);

  it("has a row for every command the program builds, and for no other", async () => {
    const { leaves, groups } = await program();
    const code = [...leaves.keys()].sort();
    const docs = COMMAND_TABLES.flatMap((t) => t.rows.map(commandOf)).sort();
    expect(
      code.filter((p) => !docs.includes(p)),
      "commands with no row",
    ).toEqual([]);
    expect(
      docs.filter((p) => !code.includes(p)),
      "rows with no command",
    ).toEqual([]);
    expect(docs, "a command has two rows").toEqual(code);
    // A group only holds commands: an option of its own would need a row of its own.
    expect(
      [...groups].filter(([, g]) => g.options.length > 0).map(([p]) => p),
      "groups with options of their own",
    ).toEqual([]);
  });

  it("anchors each row at its command, in the table of its group, with the command's arguments", async () => {
    const { leaves } = await program();
    for (const table of COMMAND_TABLES) {
      for (const row of table.rows) {
        const path = commandOf(row);
        expect(row.id, path).toBe(`cli-${path.replaceAll(" ", "-")}`);
        expect(table.id, path).toBe(`cli-commands-${path.split(" ")[0] ?? ""}`);
        const command = leaves.get(path);
        if (!command) continue; // the first test names it
        // The page says only `help` takes a positional argument: each cell spells the command's own.
        expect(codeSpans(cell(row, "command"))[0], path).toBe(commandTerm(path, command));
      }
    }
  });

  it("lists each command's options as the program spells them, with what is required and each default", async () => {
    const { leaves } = await program();
    const problems: string[] = [];
    for (const [path, command] of leaves) {
      const row = rowOf(path);
      if (!row) continue; // the first test names it
      const text = cell(row, "options");
      const entries = optionEntries(text);
      const written = entries.map((e) => e.flags);
      const code = command.options.map((o) => o.flags);
      for (const f of code) if (!written.includes(f)) problems.push(`${path}: ${f} has no entry`);
      for (const f of written) if (!code.includes(f)) problems.push(`${path}: ${f} is no option`);
      if (new Set(written).size !== written.length) problems.push(`${path}: an option twice`);
      if (longFlags(text).length !== entries.length) {
        problems.push(`${path}: a flag in the options cell outside an entry of its own`);
      }
      // The page says every command but `help` also takes --help.
      const takesHelp = command
        .createHelp()
        .visibleOptions(command)
        .some((o) => o.long === "--help");
      if (takesHelp !== (path !== "help")) problems.push(`${path}: --help is ${takesHelp}`);
      // "(required)" both ways: an option commander marks mandatory, or one a printed call refuses to run without.
      // A printed call with no mandatory option is run to find the second kind (runtimeRequired); a command with a
      // mandatory option stops on it first, so there only the mandatory options count.
      const printsCall = /\b(?:OWNER|APPROVER) to sign\b/.test(command.description());
      const mandatory = command.options.filter((o) => o.mandatory).map((o) => o.flags);
      const atRunTime =
        printsCall && mandatory.length === 0 && command.options.some((o) => o.long === "--vault")
          ? (await runtimeRequired(path, problems)).map(
              (long) => command.options.find((o) => o.long === long)?.flags ?? long,
            )
          : [];
      const required = [...mandatory, ...atRunTime];
      const marked = entries.filter((e) => /\brequired\b/.test(e.note)).map((e) => e.flags);
      for (const f of required) if (!marked.includes(f)) problems.push(`${path}: ${f} is required`);
      for (const f of marked)
        if (!required.includes(f)) problems.push(`${path}: ${f} is not required`);
      for (const o of command.options) {
        const note = entries.find((e) => e.flags === o.flags)?.note;
        if (note === undefined) continue;
        const fallback =
          o.defaultValue === undefined ? null : `default \`${String(o.defaultValue)}\``;
        if (fallback !== null && !note.includes(fallback)) {
          problems.push(`${path}: ${o.flags} has the ${fallback}`);
        }
        if (fallback === null && /\bdefault\b/.test(note)) {
          problems.push(`${path}: ${o.flags} has no default`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("documents the program's own options once, in their own table", async () => {
    const { root } = await program();
    const code = new Set(
      [...root.options, ...root.createHelp().visibleOptions(root)].flatMap((o) =>
        o.long === undefined ? [] : [o.long],
      ),
    );
    const table = tableOf("cli-program-options");
    const docs = table.rows.flatMap((r) => longFlags(cell(r, "option")));
    expect([...docs].sort()).toEqual([...code].sort());
    for (const r of table.rows) {
      const [long = ""] = longFlags(cell(r, "option"));
      expect(r.id, long).toBe(`cli-option-${long.slice(2)}`);
    }
    for (const t of COMMAND_TABLES) {
      for (const r of t.rows) {
        for (const f of longFlags(cell(r, "options"))) {
          expect(code.has(f), `${r.id} lists the program option ${f}`).toBe(false);
        }
      }
    }
  });

  it("documents the help command that commander adds to the program and to each group", async () => {
    const { helps } = await program();
    expect(helps.has("help"), "the program's own help [command]").toBe(true);
    const does = cell(rowOf("help") ?? { cells: {} }, "does");
    const inGroups = [...helps.keys()].filter((p) => p !== "help");
    expect(inGroups.length).toBeGreaterThan(0);
    for (const [p, h] of helps) {
      // Each is the same command as the program's: no options, one optional argument.
      expect(commandTerm(p, h), p).toBe(`${p} [command]`);
      expect(h.options, p).toEqual([]);
      if (p !== "help") expect(does, `the help row names ${p}`).toContain(`\`${p}\``);
    }
    // What the row says it prints: the help that --help prints, and exit 0.
    const { runCli } = await loadCli();
    const run = async (argv: readonly string[]) => {
      const { io, seen } = recorder(ROOT);
      return { code: await runCli(argv, io), out: seen.out, err: seen.err };
    };
    for (const [help, flag] of [
      [["help"], ["--help"]],
      [
        ["help", "verify"],
        ["verify", "--help"],
      ],
      [
        ["vault", "help", "create"],
        ["vault", "create", "--help"],
      ],
    ] as const) {
      const viaHelp = await run(help);
      expect(viaHelp.code, help.join(" ")).toBe(0);
      expect(viaHelp.out.length, help.join(" ")).toBeGreaterThan(0);
      expect(viaHelp, help.join(" ")).toEqual(await run(flag));
    }
    expect(does).toContain("`help verify`");
    expect(does).toContain("`vault help create`");
  });

  it("gives the version the program prints", async () => {
    const { runCli } = await loadCli();
    const { io, seen } = recorder(ROOT);
    expect(await runCli(["--version"], io)).toBe(0);
    const version = seen.out.trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const row = tableOf("cli-program-options").rows.find((r) => r.id === "cli-option-version");
    expect(cell(row ?? { cells: {} }, "does")).toContain(`\`${version}\``);
    expect(readMdx(PAGE)).toContain(`version ${version}`);
  });

  it("says who signs each printed call, with the call, its gas and its deposit", async () => {
    const { leaves } = await program();
    const calls = printedCalls();
    const named = new Set<string>();
    const problems: string[] = [];
    for (const [path, command] of leaves) {
      const row = rowOf(path);
      if (!row) continue;
      const signs = cell(row, "signs");
      const description = command.description();
      const signer = /\bOWNER to sign\b/.test(description)
        ? "The owner"
        : /\bAPPROVER to sign\b/.test(description)
          ? "An approver"
          : null;
      if (!signs.startsWith(signer ?? "Nothing")) {
        problems.push(`${path}: Who signs starts with "${signer ?? "Nothing"}"`);
      }
      if (signer === null) continue;
      const methods = [...calls.keys()].filter((m) =>
        new RegExp(`(?<![\\w])${m}(?![\\w])`).test(description),
      );
      if (methods.length !== 1) {
        problems.push(`${path}: its help names ${methods.length} printed calls (${methods})`);
        continue;
      }
      const method = methods[0] ?? "";
      named.add(method);
      const call = calls.get(method);
      if (!call) continue;
      if (!cell(row, "does").includes(`\`${method}\``)) {
        problems.push(`${path}: What it does names \`${method}\``);
      }
      if (!signs.includes(`\`${call.gas} Tgas\``)) problems.push(`${path}: ${call.gas} Tgas`);
      const oneYocto = signs.includes("1 yoctoNEAR");
      const none = /\bno deposit\b/.test(signs);
      if (call.deposit === "one-yocto" && (!oneYocto || none)) {
        problems.push(`${path}: 1 yoctoNEAR`);
      }
      if (call.deposit === "none" && (!none || oneYocto)) problems.push(`${path}: no deposit`);
      if (call.deposit === "near" && (oneYocto || none || !/\bdeposit\b/.test(signs))) {
        problems.push(`${path}: a deposit in NEAR`);
      }
    }
    expect(
      [...calls.keys()].filter((m) => !named.has(m)),
      "printed calls that no command's help names",
    ).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("lists the exit codes that check and verify give, and the 0 and 1 of every other command", async () => {
    const { runCli } = await loadCli();
    const table = tableOf("cli-exit-codes");
    const codeOf = (r: RefRow) => codeSpans(cell(r, "code"))[0] ?? "";
    for (const r of table.rows) expect(r.id).toBe(`cli-exit-${codeOf(r)}`);
    const column = (key: string) =>
      table.rows
        .filter((r) => cell(r, key) !== "None")
        .map(codeOf)
        .sort();
    for (const name of ["check", "verify"]) {
      const { io, seen } = recorder(ROOT);
      expect(await runCli([name, "--help"], io), `${name} --help`).toBe(0);
      const codes = helpExitCodes(seen.out);
      expect(codes.length, `${name} --help lists its exit codes`).toBeGreaterThan(0);
      expect(column(name), name).toEqual([...codes].sort());
    }
    // Only check and verify set an exit code of their own, or turn a usage error into 64.
    const own = walkFiles(COMMANDS_DIR, ".ts")
      .filter((f) => /\b(?:setExitCode|usageExitCodes)\(/.test(readFileSync(f, "utf8")))
      .map((f) => basename(f))
      .sort();
    expect(own).toEqual(["check.ts", "verify.ts"]);
    expect(column("other")).toEqual(["0", "1"]);
    // A missing required option: 1 for every other command, 64 for check.
    expect(await runCli(["vault", "create"], recorder(ROOT).io)).toBe(1);
    expect(await runCli(["check"], recorder(ROOT).io)).toBe(64);
  });

  it("shows the output the CLI prints for the page's example, exactly", async () => {
    const mdx = readMdx(PAGE).replace(/\r\n/g, "\n");
    const m = /```bash\n(npx probarion [^\n]+)\n```\n\n```text\n([\s\S]*?)\n```/.exec(mdx);
    expect(m, "a bash fence with one npx probarion line, then a text fence").not.toBeNull();
    const argv = (m?.[1] ?? "").slice("npx probarion ".length).split(" ");
    const dir = mkdtempSync(join(tmpdir(), "probarion-cli-reference-"));
    try {
      const { runCli } = await loadCli();
      const { io, seen } = recorder(dir);
      expect(await runCli(argv, io)).toBe(0);
      expect(seen.err).toBe("");
      expect(seen.out).toBe(`${m?.[2] ?? ""}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows every table once, with the signing callout above each table that holds a signed call", () => {
    const mdx = readMdx(PAGE);
    const shown = [...mdx.matchAll(/<RefTable id="([^"]+)" \/>/g)].map((m) => m[1] ?? "");
    expect([...shown].sort()).toEqual(TABLES.map((t) => t.id).sort());
    for (const t of COMMAND_TABLES) {
      const at = mdx.indexOf(`<RefTable id="${t.id}" />`);
      const section = mdx.slice(mdx.lastIndexOf("\n## ", at), at);
      const signers = new Set(t.rows.map((r) => cell(r, "signs").split(/[.:]/)[0]));
      if (signers.has("The owner")) {
        expect(section, `${t.id}: owner-signs above it`).toContain('<Callout kind="owner-signs">');
      }
      if (signers.has("An approver")) {
        expect(section, `${t.id}: approver-signs above it`).toContain(
          '<Callout kind="approver-signs">',
        );
      }
    }
  });

  it("writes cells as short Rich text: balanced backticks, no < or { outside them, no em dash", () => {
    for (const t of TABLES) {
      for (const r of t.rows) {
        for (const [key, value] of Object.entries(r.cells)) {
          const where = `${t.id} ${r.id ?? "?"} ${key}`;
          expect((value.match(/`/g) ?? []).length % 2, where).toBe(0);
          expect(/[<{]/.test(value.split(/`[^`]+`/).join("")), where).toBe(false);
          expect(value.includes("—"), where).toBe(false);
        }
      }
    }
  });
});
