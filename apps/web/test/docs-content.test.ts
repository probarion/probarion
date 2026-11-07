import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Code, List, Root, RootContent } from "mdast";
import { describe, expect, it } from "vitest";
import { anchorsOf, headingsOf } from "@/lib/docs/headings";
import { MDX_COMPONENT_NAMES } from "@/lib/docs/markdown";
import { attrOf, childrenOf, jsxNodes, parseMdx } from "@/lib/docs/mdast";
import { findPage, PAGES, pageFile, sectionOf } from "@/lib/docs/registry";
import { pageMarkdown } from "@/lib/docs/twins";
import { CLI_ON_NPM, CLI_SETUP_LINES } from "@/lib/proof/cli";
import { appRoutes, hrefResolves, linksIn, publicPaths } from "./deploy-scan";
import { ROOT, readMdx, WEB, walkFiles } from "./docs-helpers";

const ORIGIN = "https://probarion.xyz";
const fileOf = (path: string) => `content/docs/${pageFile(path)}.mdx`;

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

/**
 * Pages that exist but that the phase-1 docs do not link: the Canary's page and the extension's
 * connect page.
 */
const NOT_LINKED = ["/canary", "/extension"];
const PATTERNS = appRoutes(WEB);
const FILES = publicPaths(WEB);

/** Why `url`, written on the page at `from`, is a bad link; null when it is fine. */
function linkProblem(url: string, from: string): string | null {
  if (url.startsWith("#")) {
    return anchorsOf(readMdx(from), fileOf(from)).has(decodeURIComponent(url.slice(1)))
      ? null
      : `no ${url} on this page`;
  }
  if (/^mailto:/i.test(url)) return "no mailto links";
  if (/^http:/i.test(url)) return "use https";
  if (/^https:/i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "malformed URL";
    }
    const repoFile =
      parsed.hostname === "github.com"
        ? /^\/probarion\/probarion\/(?:blob|tree)\/(?:main|dev)\/(.+)$/.exec(parsed.pathname)?.[1]
        : undefined;
    if (repoFile && !existsSync(join(ROOT, decodeURIComponent(repoFile)))) {
      return `no ${repoFile} in the repository`;
    }
    return null;
  }
  if (!url.startsWith("/")) return "relative link: start it with /";
  const [rawPath = "", hash = ""] = url.split("#");
  const path = rawPath.replace(/\?.*$/, "");
  if (NOT_LINKED.some((r) => path === r || path.startsWith(`${r}/`))) {
    return "the phase-1 docs do not link this page";
  }
  if (path === "/docs.md") return null;
  if (path === "/docs" || path.startsWith("/docs/")) {
    const pagePath = (path.endsWith(".md") ? path.slice(0, -3) : path).replace(/^\/docs\/?/, "");
    const page = findPage(pagePath);
    if (!page) return `no docs page at ${path}`;
    if (hash && !anchorsOf(readMdx(page.path), fileOf(page.path)).has(decodeURIComponent(hash))) {
      return `no #${hash} on ${path}`;
    }
    return null;
  }
  return hrefResolves(path, PATTERNS, FILES) ? null : `no page or file at ${path}`;
}

/** Markdown links and definitions, plus every JSX `href` or `...Href` attribute. */
function mdxLinks(tree: Root): string[] {
  const out: string[] = [];
  for (const node of nodesOf(tree)) {
    if (node.type === "link" || node.type === "definition") out.push(node.url);
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
  [
    /(?<![\w-])npm (?:install|i)\b|\bpnpm add\b|\byarn add\b|\bnpx probarion\b/i,
    "an install of the unpublished packages",
  ],
  [/\bsecurity@|\bsupport@/i, "a contact mailbox"],
  [/status\.probarion\.xyz/i, "the status host"],
  [/\u2014/, "an em dash"],
  [/\bplease\b/i, "please"],
];

const bans = (text: string) => BANNED.filter(([re]) => re.test(text)).map(([, name]) => name);

const DOCS_CODE = [join(WEB, "src", "lib", "docs"), join(WEB, "src", "components", "docs")]
  .flatMap((dir) => [...walkFiles(dir, ".ts"), ...walkFiles(dir, ".tsx")])
  .filter((f) => !/\.test\.tsx?$/.test(f));

describe("copy rules", () => {
  it("hold in every page, every Markdown twin and the docs code", async () => {
    const found: string[] = [];
    for (const p of PAGES) {
      for (const b of bans(readMdx(p.path))) found.push(`${fileOf(p.path)}: ${b}`);
      for (const b of bans(await pageMarkdown(p, ORIGIN)))
        found.push(`twin of /docs/${p.path}: ${b}`);
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
    expect(found).toEqual([]);
  });

  it("say build from source while the packages are not on npm", () => {
    // When CLI_ON_NPM flips, rewrite build/install and the quickstarts first, then this line.
    expect(CLI_ON_NPM).toBe(false);
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
const FENCE_LANGS = ["bash", "text", "ts", "tsx", "js", "json", "rust", "md", "toml"];

/** A literal `.command("x")`, and the same call made on `program`, which makes x a top command. */
const COMMAND = /\.command\("([a-z][\w-]*)"\)/g;
const TOP_COMMAND = /\bprogram\s*\.command\("([a-z][\w-]*)"\)/g;
/** A row of the OWNER_CALLS table in commands/owner-calls.ts: a group and one subcommand of it. */
const OWNER_CALL_ROW = /group: "([a-z][\w-]*)",\s*name: "([a-z][\w-]*)"/g;

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
        for (const raw of c.value.split("\n")) {
          const line = raw.trim().replace(/^\$\s*/, "");
          if (/^probarion\s/.test(line)) problems.push(`${fileOf(p.path)}: write "${BIN} ..."`);
          if (!line.startsWith(`${BIN} `)) continue;
          // The site puts the program options first: bin.js --network testnet vault create ...
          const words = line.slice(BIN.length + 1).split(/\s+/);
          while (words[0] === "--network" || words[0] === "--rpc") words.splice(0, 2);
          const [top = "", sub = ""] = words;
          if (top.startsWith("-")) {
            if (!["--help", "--version"].includes(top)) problems.push(`${fileOf(p.path)}: ${line}`);
            continue;
          }
          const list = CLI_TREE[top];
          if (!list) problems.push(`${fileOf(p.path)}: no command "${top}"`);
          else if (list.length > 0 && sub !== "--help" && !list.includes(sub)) {
            problems.push(`${fileOf(p.path)}: no command "${top} ${sub}"`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("set up from a clone with exactly the site's steps", () => {
    for (const p of PAGES) {
      for (const c of codesOf(treeOf(p.path)).filter((x) => x.value.includes("git clone"))) {
        const lines = c.value.split("\n").map((l) => l.trim());
        const at = lines.indexOf(CLI_SETUP_LINES[0] ?? "");
        expect(at, fileOf(p.path)).toBeGreaterThanOrEqual(0);
        expect(lines.slice(at, at + CLI_SETUP_LINES.length), fileOf(p.path)).toEqual([
          ...CLI_SETUP_LINES,
        ]);
      }
    }
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

describe("page shape", () => {
  it("leaves the H1 to the page head and uses only H2 and H3", () => {
    for (const p of PAGES) {
      const off = headingsOf(readMdx(p.path)).filter((h) => h.depth < 2 || h.depth > 3);
      expect(off, fileOf(p.path)).toEqual([]);
    }
  });

  it("gives no two headings the same text, so no anchor needs a number", () => {
    for (const p of PAGES) {
      const ids = headingsOf(readMdx(p.path)).map((h) => h.id);
      const numbered = ids.filter(
        (id) => /-\d+$/.test(id) && ids.includes(id.replace(/-\d+$/, "")),
      );
      expect(numbered, fileOf(p.path)).toEqual([]);
    }
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

// A CLI line may put the program options first: bin.js --network testnet vault create ...
const OWNER_CLI =
  /\bbin\.js (?:--(?:network|rpc) \S+ )*(?:vault (?:create|freeze|unfreeze|withdraw|withdraw-intents)|mandate (?:create|revoke)|agent (?:add|remove)|ledger set-key)\b/;
const APPROVER_CLI = /\bbin\.js (?:--(?:network|rpc) \S+ )*spend (?:approve|reject)\b/;
const OWNER_CALL =
  /\bcall-function\b.*\b(?:create_vault|create_mandate|revoke_mandate|add_agent|remove_agent|set_ledger_key|freeze|unfreeze|withdraw|withdraw_intents)\b/;
const APPROVER_CALL = /\bcall-function\b.*\b(?:approve|reject)\b/;

describe("signing callouts", () => {
  it("sit on every page that shows a call the owner or an approver signs", () => {
    const problems: string[] = [];
    for (const p of PAGES) {
      const tree = treeOf(p.path);
      // A line that ends in a backslash goes on in the next one: join them, so a near-cli call
      // wrapped before its method name still counts as that call.
      const code = codesOf(tree)
        .map((c) => c.value)
        .join("\n")
        .replace(/\\\r?\n[ \t]*/g, " ");
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
