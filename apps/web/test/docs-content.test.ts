import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { slug } from "github-slugger";
import type { Code, List, Root, RootContent } from "mdast";
import { describe, expect, it } from "vitest";
import { changelogTree } from "@/lib/docs/changelog";
import { headingsOf } from "@/lib/docs/headings";
import { MDX_COMPONENT_NAMES } from "@/lib/docs/markdown";
import { attrOf, childrenOf, jsxNodes, parseMdx } from "@/lib/docs/mdast";
import { PAGES, sectionOf } from "@/lib/docs/registry";
import { pageMarkdown } from "@/lib/docs/twins";
import { CLI_ON_NPM, CLI_SETUP_LINES, cli } from "@/lib/proof/cli";
import { linksIn } from "./deploy-scan";
import { fileOf, linkProblem, ROOT, readMdx, WEB, walkFiles } from "./docs-helpers";

const ORIGIN = "https://probarion.xyz";

/** A page's tree. A parse error names the file: micromark's own message gives only a position. */
function parsePage(path: string): Root {
  try {
    return parseMdx(readMdx(path));
  } catch (e) {
    throw new Error(`${fileOf(path)}: ${(e as Error).message}`, { cause: e });
  }
}

const TREES = new Map(PAGES.map((p) => [p.path, parsePage(p.path)]));

function treeOf(path: string): Root {
  const tree = TREES.get(path);
  if (!tree) throw new Error(`no tree for ${path}`);
  return tree;
}

/** Every node under the root, depth first, in document order (JSX children included). */
function nodesOf(tree: Root): RootContent[] {
  const out: RootContent[] = [];
  const visit = (node: Root | RootContent) => {
    if (node.type !== "root") out.push(node);
    for (const child of childrenOf(node)) visit(child);
  };
  visit(tree);
  return out;
}

const codesOf = (tree: Root) => nodesOf(tree).filter((n): n is Code => n.type === "code");

// --- links ---------------------------------------------------------------------------------------
// linkProblem (docs-helpers.ts) holds the guide's link rules; docs-ref.test.ts runs the
// changelog's rendered links through it too.

/**
 * Markdown links, images and definitions, plus every JSX `href` or `...Href` attribute. An image's
 * URL meets the same rules: a site path must be a public file or a route, an https URL must pass
 * the same form checks.
 */
function mdxLinks(tree: Root): string[] {
  const out: string[] = [];
  for (const node of nodesOf(tree)) {
    if (node.type === "link" || node.type === "image" || node.type === "definition") {
      out.push(node.url);
    }
    if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
      for (const a of node.attributes) {
        if (
          a.type === "mdxJsxAttribute" &&
          (a.name === "href" || a.name.endsWith("Href")) &&
          typeof a.value === "string"
        ) {
          out.push(a.value);
        }
      }
    }
  }
  return out;
}

describe("docs links", () => {
  it("on every page resolve to a page, an anchor, a site route or a repository file", () => {
    const problems: string[] = [];
    for (const p of PAGES) {
      for (const url of mdxLinks(treeOf(p.path))) {
        const why = linkProblem(url, p.path);
        if (why) problems.push(`${fileOf(p.path)}: ${url}: ${why}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("in every TSX file under src/app and src/components resolve too", () => {
    const files = [join(WEB, "src", "app"), join(WEB, "src", "components")]
      .flatMap((dir) => walkFiles(dir, ".tsx"))
      .filter((f) => !f.endsWith(".test.tsx"));
    const problems: string[] = [];
    for (const f of files) {
      for (const link of linksIn(readFileSync(f, "utf8"))) {
        if (link.kind !== "href" || !link.value.startsWith("/docs") || link.value.includes("${")) {
          continue;
        }
        const why = linkProblem(link.value, "");
        if (why) problems.push(`${f}: ${link.value}: ${why}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

// --- copy ----------------------------------------------------------------------------------------

const BANNED: readonly [RegExp, string][] = [
  [/\bguarantee/i, "guarantee"],
  [/100\s?%/, "100%"],
  [/\bunhackable\b/i, "unhackable"],
  [/\bpnpm add\b|\byarn add\b/i, "a pnpm or yarn install of the packages"],
  [/\bsecurity@|\bsupport@/i, "a contact mailbox"],
  [/status\.probarion\.xyz/i, "the status host"],
  [/\u2014/, "an em dash"],
  [/\bplease\b/i, "please"],
];

/** The packages release 0.1.0 published to npm: the only ones an install line may name. */
const PUBLISHED = ["@probarion/core", "@probarion/sdk", "probarion"];
const NPM_INSTALL = /(?<![\w-])npm (?:install|i)\b([^\n`]*)/gi;

/** The npm installs in the text that name anything but the published packages (or `-g`). */
function npmInstallProblems(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NPM_INSTALL)) {
    const names = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
    const other = names.filter((w) => w !== "-g" && !PUBLISHED.includes(w));
    if (names.length === 0 || other.length > 0) out.push(`an npm install of ${m[0].trim()}`);
  }
  return out;
}

/** What npmInstallProblems reports for a bare `npm install`, which names no package. */
const BARE_NPM_INSTALL = "an npm install of npm install";

const bans = (text: string) => [
  ...BANNED.filter(([re]) => re.test(text)).map(([, name]) => name),
  ...npmInstallProblems(text),
];

const DOCS_CODE = [join(WEB, "src", "lib", "docs"), join(WEB, "src", "components", "docs")]
  .flatMap((dir) => [...walkFiles(dir, ".ts"), ...walkFiles(dir, ".tsx")])
  .filter((f) => !/\.test\.tsx?$/.test(f));

describe("copy rules", () => {
  it("hold in every page, every Markdown twin and the docs code", async () => {
    const found: string[] = [];
    for (const p of PAGES) {
      for (const b of bans(readMdx(p.path))) found.push(`${fileOf(p.path)}: ${b}`);
      // The changelog page renders CHANGELOG.md, which quotes a bare `npm install` as it was run:
      // its twin keeps every other rule.
      const quoted = p.path === "resources/changelog" ? [BARE_NPM_INSTALL] : [];
      for (const b of bans(await pageMarkdown(p, ORIGIN))) {
        if (!quoted.includes(b)) found.push(`twin of /docs/${p.path}: ${b}`);
      }
    }
    for (const f of DOCS_CODE)
      for (const b of bans(readFileSync(f, "utf8"))) found.push(`${f}: ${b}`);
    expect(found).toEqual([]);
  });

  it("keep exclamation marks out of prose", () => {
    const found: string[] = [];
    for (const p of PAGES) {
      // Registry fields are prose too: the page head, the sidebar, search and llms.txt show them.
      const entry = `src/lib/docs/pages/${sectionOf(p.path) ?? "home"}.ts`;
      for (const field of [p.title, p.nav, p.description, p.lede]) {
        if (field?.includes("!")) found.push(`${entry}: ${field}`);
      }
      for (const n of nodesOf(treeOf(p.path))) {
        if (n.type === "text" && n.value.includes("!")) found.push(`${fileOf(p.path)}: ${n.value}`);
        if (n.type !== "mdxJsxFlowElement" && n.type !== "mdxJsxTextElement") continue;
        // A string prop renders as prose as well: a Callout, Door or Card title, a Door's go.
        for (const a of n.attributes) {
          if (
            a.type === "mdxJsxAttribute" &&
            typeof a.value === "string" &&
            a.value.includes("!")
          ) {
            found.push(`${fileOf(p.path)}: <${n.name}> ${a.name}="${a.value}"`);
          }
        }
      }
    }
    // The changelog page's prose is CHANGELOG.md's, which no MDX tree above holds.
    for (const n of nodesOf(changelogTree())) {
      if (n.type === "text" && n.value.includes("!")) found.push(`CHANGELOG.md: ${n.value}`);
    }
    expect(found).toEqual([]);
  });

  it("name only the published packages in an npm install", () => {
    expect(npmInstallProblems("`npm install @probarion/sdk @probarion/core`")).toEqual([]);
    expect(npmInstallProblems("npm install -g probarion\nnpm i @probarion/core")).toEqual([]);
    expect(npmInstallProblems("npm installs it")).toEqual([]);
    expect(npmInstallProblems("`npm install @probarion/mcp`")).toHaveLength(1);
    expect(npmInstallProblems("npm install\n")).toHaveLength(1);
    // The one problem the changelog's twin may have: anything else after the install still fails.
    expect(npmInstallProblems("then `npm install`.")).toEqual([BARE_NPM_INSTALL]);
    expect(npmInstallProblems("`npm install left-pad`")).not.toEqual([BARE_NPM_INSTALL]);
  });

  it("say what the site prints: npx probarion, while CLI_ON_NPM is true", () => {
    // build/install says the proof page, the security page and the console's CLI fallback print
    // `npx probarion` commands. When CLI_ON_NPM flips back, rewrite that note first, then this test.
    expect(CLI_ON_NPM).toBe(true);
    expect(cli("verify --offline x.json")).toBe("npx probarion verify --offline x.json");
    expect(readMdx("build/install")).toContain(
      "The proof page, the security page and the console's CLI fallback need none of this: they print `npx probarion` commands.",
    );
  });
});

// --- CLI commands and code fences ----------------------------------------------------------------

/**
 * The CLI's commands (packages/cli/src/commands). The first test below keeps this list equal to
 * the source.
 */
const CLI_TREE: Readonly<Record<string, readonly string[]>> = {
  vault: ["create", "freeze", "unfreeze", "withdraw", "withdraw-intents"],
  mandate: ["create", "revoke"],
  agent: ["keygen", "add", "remove"],
  ledger: ["set-key", "export"],
  spend: ["approve", "reject"],
  check: [],
  verify: [],
};

const BIN = "node packages/cli/dist/bin.js";
/** The ways a page runs the CLI: built in a clone, or from npm (installed, or through npx). */
const CLI_RUNS = [BIN, "npx probarion", "probarion"];

/** What follows the CLI on a line that runs it, or null when the line does not run it. */
function cliRun(line: string): string | null {
  const run = CLI_RUNS.find((r) => line === r || line.startsWith(`${r} `));
  return run === undefined ? null : line.slice(run.length).trim();
}

const FENCE_LANGS = ["bash", "text", "ts", "tsx", "js", "json", "rust", "md", "toml"];

/** A fence's text with every backslash line continuation joined into one line, one space wide. */
const joinContinuations = (code: string) => code.replace(/[ \t]*\\\r?\n[ \t]*/g, " ");

/** A fence's commands: one per line once continuations are joined, without a `$ ` prompt. */
const commandLines = (code: string) =>
  joinContinuations(code)
    .split("\n")
    .map((l) => l.trim().replace(/^\$\s*/, ""));

/** A literal `.command("x")`, and the same call made on `program`, which makes x a top command. */
const COMMAND = /\.command\("([a-z][\w-]*)"\)/g;
const TOP_COMMAND = /\bprogram\s*\.command\("([a-z][\w-]*)"\)/g;
/** A row of the OWNER_CALLS table in commands/owner-calls.ts: a group and one subcommand of it. */
const OWNER_CALL_ROW = /group: "([a-z][\w-]*)",\s*name: "([a-z][\w-]*)"/g;

const CLI_SRC = join(ROOT, "packages", "cli", "src");
const COMMANDS_DIR = join(CLI_SRC, "commands");
const OWNER_CALLS_SRC = readFileSync(join(COMMANDS_DIR, "owner-calls.ts"), "utf8");
/** Where registerOwnerCalls starts: the options it gives every row come after this. */
const REGISTER_AT = OWNER_CALLS_SRC.indexOf("export function registerOwnerCalls");

/** A literal option in the CLI's source: `"--flag ` or `"--flag"`. */
const LITERAL_FLAG = /"(--[a-z][\w-]*)(?=[ "])/g;
const literalFlags = (src: string) => [...src.matchAll(LITERAL_FLAG)].map((m) => m[1] ?? "");

/** Each OWNER_CALLS row's own text, by "group name": its options are literals in it. */
const OWNER_ROWS: ReadonlyMap<string, string> = (() => {
  const rows = [...OWNER_CALLS_SRC.slice(0, REGISTER_AT).matchAll(OWNER_CALL_ROW)];
  return new Map(
    rows.map((m, i) => [
      `${m[1]} ${m[2]}`,
      OWNER_CALLS_SRC.slice(m.index ?? 0, rows[i + 1]?.index ?? REGISTER_AT),
    ]),
  );
})();

/**
 * The options a CLI line may give after its command words: the program's (program.ts), the ones
 * in the command's own file and, for an OWNER_CALLS row, that row's and the ones registerOwnerCalls
 * gives every row. Commander adds --help.
 */
function cliFlags(top: string, sub: string): Set<string> {
  const flags = new Set([
    "--help",
    ...literalFlags(readFileSync(join(CLI_SRC, "program.ts"), "utf8")),
  ]);
  const own = join(COMMANDS_DIR, `${top}.ts`);
  if (existsSync(own)) for (const f of literalFlags(readFileSync(own, "utf8"))) flags.add(f);
  const row = OWNER_ROWS.get(`${top} ${sub}`);
  if (row !== undefined) {
    for (const f of [...literalFlags(row), ...literalFlags(OWNER_CALLS_SRC.slice(REGISTER_AT))]) {
      flags.add(f);
    }
  }
  return flags;
}

/**
 * What is wrong with what follows the CLI on one line: its command, then each `--flag` after the
 * command words. The site may put the program options first: bin.js --network testnet vault
 * create ... A `#` comment at the end is not part of the command.
 */
function cliLineProblems(run: string): string[] {
  const words = run
    .replace(/\s#.*$/, "")
    .split(/\s+/)
    .filter(Boolean);
  while (words[0] === "--network" || words[0] === "--rpc") words.splice(0, 2);
  const [top = "", sub = ""] = words;
  if (top.startsWith("-")) {
    return ["--help", "--version"].includes(top) ? [] : [`no command, only ${top}`];
  }
  const list = CLI_TREE[top];
  if (!list) return [`no command "${top}"`];
  if (list.length > 0 && sub === "--help") return [];
  if (list.length > 0 && !list.includes(sub)) return [`no command "${top} ${sub}"`];
  const command = list.length > 0 ? `${top} ${sub}` : top;
  const flags = cliFlags(top, sub);
  return words
    .slice(list.length > 0 ? 2 : 1)
    .filter((w) => w.startsWith("--"))
    .map((w) => w.split("=")[0] ?? w)
    .filter((f) => !flags.has(f))
    .map((f) => `"${command}" has no option ${f}`);
}

/** A command tree with its subcommands sorted, so two trees compare by content. */
function sortedTree(tree: Iterable<[string, Iterable<string>]>): Record<string, string[]> {
  return Object.fromEntries([...tree].map(([top, subs]) => [top, [...subs].sort()]));
}

describe("CLI commands", () => {
  const cliSrc = join(ROOT, "packages", "cli", "src");
  const commandsDir = join(cliSrc, "commands");
  const cliFiles = walkFiles(cliSrc, ".ts").filter((f) => !f.endsWith(".test.ts"));

  it("in CLI_TREE are the commands packages/cli/src defines, no more and no fewer", () => {
    // Each commands/*.ts registers one top command: its first literal .command("x"), the only
    // literal one called on `program`. Its later literal .command("y") calls are x's subcommands.
    // owner-calls.ts adds subcommands from its table rows. A second top in one file, or a
    // literal command outside commands/, fails here by file name: teach this test the new shape.
    const tree = new Map<string, Set<string>>();
    const subsOf = (top: string): Set<string> => {
      const subs = tree.get(top) ?? new Set<string>();
      tree.set(top, subs);
      return subs;
    };
    const problems: string[] = [];
    for (const f of cliFiles) {
      const src = readFileSync(f, "utf8");
      const names = [...src.matchAll(COMMAND)].map((m) => m[1] ?? "");
      if (dirname(f) !== commandsDir) {
        if (names.length > 0) problems.push(`${f}: a command outside packages/cli/src/commands`);
        continue;
      }
      for (const m of src.matchAll(OWNER_CALL_ROW)) subsOf(m[1] ?? "").add(m[2] ?? "");
      const [top, ...subs] = names;
      if (!top) continue;
      const tops = [...src.matchAll(TOP_COMMAND)].map((m) => m[1] ?? "");
      if (tops.length !== 1 || tops[0] !== top) {
        problems.push(`${f}: one top command per file, and it comes first (${tops.join(", ")})`);
      }
      const own = subsOf(top);
      for (const sub of subs) own.add(sub);
    }
    expect(problems).toEqual([]);
    expect(sortedTree(tree)).toEqual(sortedTree(Object.entries(CLI_TREE)));
  });

  it("on every page exist, written the way the site writes them", () => {
    const problems: string[] = [];
    for (const p of PAGES) {
      for (const c of codesOf(treeOf(p.path)).filter((x) => x.lang === "bash")) {
        for (const line of commandLines(c.value)) {
          const run = cliRun(line);
          if (run === null) {
            // A command that runs the bin some other way (an env prefix, `cd ... &&`, `./`) is not
            // the site's form and would escape the checks below. A `#` comment may name it.
            if (/\bbin\.js\b|(?:^|\s)probarion\s+[-a-z]/.test(line) && !line.startsWith("#")) {
              problems.push(
                `${fileOf(p.path)}: start the line with "${CLI_RUNS.join('" or "')}": ${line}`,
              );
            }
            continue;
          }
          for (const problem of cliLineProblems(run)) {
            problems.push(`${fileOf(p.path)}: ${problem}: ${line}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("know each command's options from the CLI's source, so a made-up flag fails", () => {
    expect(cliLineProblems("mandate create --vault v --max-per 5 --sign-as a.testnet")).toEqual([]);
    expect(cliLineProblems("mandate create --vault v --max-per-payment 5")).toEqual([
      '"mandate create" has no option --max-per-payment',
    ]);
    expect(cliLineProblems("--network testnet spend approve --spend 2 --out-dir tx")).toEqual([]);
    expect(cliLineProblems("spend approve --mandate 2")).toEqual([
      '"spend approve" has no option --mandate',
    ]);
    expect(cliLineProblems("verify --vault v0.probarion.testnet --burn-tx 2=abc")).toEqual([]);
    expect(cliLineProblems("verify --offline x.json # --bogus is a comment")).toEqual([]);
    expect(cliLineProblems("verify --bogus")).toEqual(['"verify" has no option --bogus']);
    expect(cliLineProblems("vault frobnicate")).toEqual(['no command "vault frobnicate"']);
    expect(cliLineProblems("--version")).toEqual([]);
    expect(cliLineProblems("--vault v")).toEqual(["no command, only --vault"]);
  });

  it("set up from a clone with exactly the site's steps", () => {
    const problems: string[] = [];
    for (const p of PAGES) {
      for (const c of codesOf(treeOf(p.path)).filter((x) => x.value.includes("git clone"))) {
        const lines = commandLines(c.value);
        const at = lines.indexOf(CLI_SETUP_LINES[0] ?? "");
        const got = at < 0 ? [] : lines.slice(at, at + CLI_SETUP_LINES.length);
        if (got.join("\n") !== CLI_SETUP_LINES.join("\n")) {
          problems.push(
            `${fileOf(p.path)}: needs the ${CLI_SETUP_LINES.length} CLI_SETUP_LINES, ` +
              `consecutive, in order: ${CLI_SETUP_LINES.join(" | ")}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("code fences", () => {
  it("name one of the known languages", () => {
    const problems = PAGES.flatMap((p) =>
      codesOf(treeOf(p.path))
        .filter((c) => !FENCE_LANGS.includes(c.lang ?? ""))
        .map((c) => `${fileOf(p.path)}: fence language "${c.lang ?? ""}"`),
    );
    expect(problems).toEqual([]);
  });
});

// --- components and page shape -------------------------------------------------------------------

describe("components", () => {
  it("are only the ones with a Markdown form, with plain-string props", () => {
    const problems: string[] = [];
    for (const p of PAGES) {
      for (const node of jsxNodes(treeOf(p.path))) {
        const name = node.name ?? "<fragment>";
        if (!MDX_COMPONENT_NAMES.includes(name)) problems.push(`${fileOf(p.path)}: <${name}>`);
        for (const a of node.attributes) {
          if (a.type !== "mdxJsxAttribute" || (a.value !== null && typeof a.value !== "string")) {
            problems.push(`${fileOf(p.path)}: <${name}> has an expression prop`);
          }
        }
      }
      for (const n of nodesOf(treeOf(p.path))) {
        if (
          n.type === "mdxjsEsm" ||
          n.type === "mdxFlowExpression" ||
          n.type === "mdxTextExpression"
        ) {
          problems.push(`${fileOf(p.path)}: ${n.type}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

/**
 * The headings whose id is not the slug of their own text: rehype-slug added a number because an
 * earlier heading took that slug.
 */
function numberedHeadings(source: string): string[] {
  return headingsOf(source)
    .filter((h) => h.id !== slug(h.text))
    .map((h) => `${h.text} (#${h.id})`);
}

describe("page shape", () => {
  it("leaves the H1 to the page head and uses only H2 and H3", () => {
    for (const p of PAGES) {
      const off = headingsOf(readMdx(p.path)).filter((h) => h.depth < 2 || h.depth > 3);
      expect(off, fileOf(p.path)).toEqual([]);
    }
  });

  it("gives no two headings the same text, so no anchor needs a number", () => {
    for (const p of PAGES) {
      expect(numberedHeadings(readMdx(p.path)), fileOf(p.path)).toEqual([]);
    }
  });

  it("counts a heading as numbered only when its text repeats", () => {
    // "HTTP 402" slugs to http-402 by itself: no number was added, so it is not a repeat.
    expect(numberedHeadings("## HTTP\n\n### HTTP 402\n")).toEqual([]);
    expect(numberedHeadings("## Refusals\n\n### Refusals\n")).toEqual(["Refusals (#refusals-1)"]);
  });

  it("ends every explanation with what it does not do", () => {
    for (const p of PAGES.filter((x) => x.type === "explanation")) {
      const h2 = headingsOf(readMdx(p.path)).filter((h) => h.depth === 2);
      expect(h2.at(-1)?.text, fileOf(p.path)).toBe("What this does not do");
    }
  });

  it("gives every tutorial its steps, at most 7 to a list", () => {
    for (const p of PAGES.filter((x) => x.type === "tutorial")) {
      const steps = jsxNodes(treeOf(p.path)).filter((n) => n.name === "Steps");
      expect(steps.length, fileOf(p.path)).toBeGreaterThan(0);
      for (const s of steps) {
        const lists = (s.children as RootContent[]).filter((c): c is List => c.type === "list");
        expect(lists, fileOf(p.path)).toHaveLength(1);
        expect(lists[0]?.children.length ?? 0, fileOf(p.path)).toBeLessThanOrEqual(7);
      }
    }
  });
});

// --- who signs -----------------------------------------------------------------------------------

/** A row of OWNER_CALLS, with who signs it. */
const SIGNED_ROW = /group: "([a-z][\w-]*)",\s*name: "([a-z][\w-]*)",[\s\S]*?signer: "([^"]*)"/g;

/** A call's text, from its name to its closing parenthesis. */
function callText(src: string, at: number): string {
  let depth = 0;
  for (let i = src.indexOf("(", at); i >= 0 && i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

/**
 * The CLI commands each signer signs, from the CLI's own source: every OWNER_CALLS row by its
 * `signer`, and every command whose action calls printOwnerTx in its own commands/*.ts file, which
 * the owner signs unless the call names another signer. A signer this test does not know, or one
 * it cannot read, is a problem.
 */
function signedCommands(ownerCallsSrc: string, commandSrcs: readonly string[]) {
  const owner: string[] = [];
  const approver: string[] = [];
  const problems: string[] = [];
  const add = (signer: string, command: string) => {
    if (signer === "owner") owner.push(command);
    else if (signer === "approver") approver.push(command);
    else problems.push(`${command}: unknown signer "${signer}"`);
  };
  for (const m of ownerCallsSrc.matchAll(SIGNED_ROW)) add(m[3] ?? "", `${m[1]} ${m[2]}`);
  for (const src of commandSrcs) {
    const names = [...src.matchAll(COMMAND)];
    const top = names[0]?.[1] ?? "";
    for (const call of src.matchAll(/\bprintOwnerTx\(/g)) {
      const at = call.index ?? 0;
      const sub = names.filter((n) => (n.index ?? 0) < at).at(-1)?.[1] ?? "";
      const named = /\bsigner:\s*(?:"([^"]*)"|([\w.]+))/.exec(callText(src, at));
      add(named === null ? "owner" : (named[1] ?? named[2] ?? ""), `${top} ${sub}`);
    }
  }
  return { owner, approver, problems };
}

const SIGNED = signedCommands(
  OWNER_CALLS_SRC,
  walkFiles(COMMANDS_DIR, ".ts")
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith("owner-calls.ts"))
    .map((f) => readFileSync(f, "utf8")),
);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = (commands: readonly string[]) =>
  commands.map((c) => c.split(" ").map(escapeRe).join("\\s+")).join("|");
// A CLI line runs the built bin or the CLI from npm, and may put the program options first:
// bin.js --network testnet vault create ... Any run of white space may sit between the words.
const CLI_START = String.raw`(?:\bbin\.js|(?:^|\s)(?:npx\s+)?probarion)\s+(?:--(?:network|rpc)\s+\S+\s+)*`;
const OWNER_CLI = new RegExp(`${CLI_START}(?:${alternation(SIGNED.owner)})\\b`, "m");
const APPROVER_CLI = new RegExp(`${CLI_START}(?:${alternation(SIGNED.approver)})\\b`, "m");
const OWNER_CALL =
  /\bcall-function\b.*\b(?:create_vault|create_mandate|revoke_mandate|add_agent|remove_agent|set_ledger_key|freeze|unfreeze|withdraw|withdraw_intents)\b/;
const APPROVER_CALL = /\bcall-function\b.*\b(?:approve|reject)\b/;

describe("signing callouts", () => {
  it("know who signs each command, from the CLI's own source", () => {
    expect(SIGNED.problems).toEqual([]);
    expect([...SIGNED.owner].sort()).toEqual([
      "agent add",
      "agent remove",
      "ledger set-key",
      "mandate create",
      "mandate revoke",
      "vault create",
      "vault freeze",
      "vault unfreeze",
      "vault withdraw",
      "vault withdraw-intents",
    ]);
    expect([...SIGNED.approver].sort()).toEqual(["spend approve", "spend reject"]);
    // A signer this test does not know fails it, from a row or from a printOwnerTx call.
    expect(
      signedCommands('group: "vault",\n    name: "burn",\n    signer: "agent",', []).problems,
    ).toEqual(['vault burn: unknown signer "agent"']);
    const byName = 'program.command("x").command("y"); await printOwnerTx(io, { signer: who });';
    expect(signedCommands("", [byName]).problems).toEqual(['x y: unknown signer "who"']);
  });

  it("catch a signed command however the CLI is run", () => {
    for (const line of [
      "node packages/cli/dist/bin.js vault freeze --vault v",
      "npx probarion mandate revoke --mandate 1",
      "probarion --network testnet agent add --pk ed25519:...",
      "node packages/cli/dist/bin.js --rpc https://rpc.example  ledger  set-key --pk k",
    ]) {
      expect(OWNER_CLI.test(line), line).toBe(true);
      expect(APPROVER_CLI.test(line), line).toBe(false);
    }
    for (const line of [
      "npx probarion spend approve --spend 1",
      "probarion spend reject --spend 1",
    ]) {
      expect(APPROVER_CLI.test(line), line).toBe(true);
      expect(OWNER_CLI.test(line), line).toBe(false);
    }
    for (const line of [
      "node packages/cli/dist/bin.js verify --vault v",
      "npx probarion agent keygen",
      "cd probarion\npnpm install",
    ]) {
      expect(OWNER_CLI.test(line), line).toBe(false);
      expect(APPROVER_CLI.test(line), line).toBe(false);
    }
  });

  it("sit on every page that shows a call the owner or an approver signs", () => {
    const problems: string[] = [];
    for (const p of PAGES) {
      const tree = treeOf(p.path);
      // A line that ends in a backslash goes on in the next one: join them, so a command wrapped
      // before its method or subcommand still counts as that call.
      const code = codesOf(tree)
        .map((c) => joinContinuations(c.value))
        .join("\n");
      const kinds = new Set(
        jsxNodes(tree)
          .filter((n) => n.name === "Callout")
          .map((n) => attrOf(n, "kind", fileOf(p.path))),
      );
      if ((OWNER_CLI.test(code) || OWNER_CALL.test(code)) && !kinds.has("owner-signs")) {
        problems.push(`${fileOf(p.path)}: needs <Callout kind="owner-signs">`);
      }
      if ((APPROVER_CLI.test(code) || APPROVER_CALL.test(code)) && !kinds.has("approver-signs")) {
        problems.push(`${fileOf(p.path)}: needs <Callout kind="approver-signs">`);
      }
    }
    expect(problems).toEqual([]);
  });
});
