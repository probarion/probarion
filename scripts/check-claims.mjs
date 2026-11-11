#!/usr/bin/env node
// Checks that README.md (and AGENTS.md) claim only what this repository records.
//
// It runs straight after `git clone`: Node 20 or newer, built-in modules only, no install, no build
// and, unless --online is given, no network.
//
//   node scripts/check-claims.mjs             the offline checks
//   node scripts/check-claims.mjs --online    also re-reads a few facts from public endpoints (GET and
//                                             read-only RPC only: nothing is signed or sent)
//   node scripts/check-claims.mjs --verbose   also says what each check covered
//   node scripts/check-claims.mjs --root DIR  checks another checkout
//
// Exit 0: every claim checked out. Exit 1: a claim does not match the repository (or, with --online,
// the chain or a public endpoint); each one is printed as file:line [check] what is wrong. Exit 2: the
// checker could not run, or with --online an endpoint did not answer, so a claim stayed unchecked.
//
// Offline checks, over README.md and AGENTS.md (links also over SECURITY.md, CONTRIBUTING.md and the
// Markdown files under docs/evidence):
//   links     each relative link or image resolves to a file of the repository (git's file list, so
//             case matters as on GitHub), each #anchor to a heading (GitHub's slug) and each #Lnn to a
//             line the file has.
//   paths     each repository path in inline code or a code block exists, each `pnpm` script and
//             --filter package exists, each `node scripts/x.mjs <command>` names a command the script
//             handles, and each `grep -n <text> <file>` finds its text.
//   hashes    each NEAR tx hash in an explorer link, and each other 32-byte base58 value, is
//             well-formed and recorded: a testnet tx in contracts/deployments/testnet.json,
//             docs/mainnet-proof.json or docs/evidence/**, a mainnet tx in contracts/deployments/
//             mainnet.json or docs/mainnet-proof.json, a code hash in contracts/code-hashes.json. A
//             shortened hash must match its link or the one record it abbreviates.
//   accounts  each account in an explorer link is a NEAR account id of that link's network and is
//             recorded in the deployment records or the evidence.
//   status    each row of the README's Status table has a known marker in bold (Shipped, Built, In
//             progress, Planned, Live, optionally "on NEAR testnet") and points at a path that exists;
//             a row "on NEAR testnet" cites a recorded account, a transaction or an evidence file.
//   facts     numbers and versions the README states that the repository can derive: code hashes and
//             their commits, npm and toolchain versions, the MCP tools, the extension's permissions,
//             the docs page count, the threat model's attacks, the factory mode, the mainnet record,
//             verify outputs, anchor counts and ledger entries in the evidence, sums of test counts, the
//             first commit and the commit trailers, the table of contents.
//
// --online (read-only, time-limited, one retry): the vaults and the factory the README names exist on
// testnet with their recorded code hash and no full-access key; the README's own `chain.mjs` comments
// still hold; each cited tx exists, has the expected signer and shows the outcome its row claims; the
// global vault code is unpublished while the README says so; probarion.xyz/api/health answers ok on
// testnet; the Chrome Web Store item is live or not as the README says; npm has each version the
// README says is on npm, and not the packages it says are not.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLAIM_DOCS = ["README.md", "AGENTS.md"];
const LINK_ONLY_DOCS = ["SECURITY.md", "CONTRIBUTING.md"];

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_RUN = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{43,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const ACCOUNT_TOKEN = /(?<![\w.-])(?:[a-z\d][a-z\d_-]*\.)+(?:testnet|near)(?![\w.-])/g;
const EXPLORER_TX = [
  /^https?:\/\/(testnet\.)?nearblocks\.io\/txns?\/([^/?#\s]+)/,
  /^https?:\/\/explorer\.(testnet\.)?near\.org\/transactions\/([^/?#\s]+)/,
];
const EXPLORER_ACCOUNT = [
  /^https?:\/\/(testnet\.)?nearblocks\.io\/address\/([^/?#\s]+)/,
  /^https?:\/\/explorer\.(testnet\.)?near\.org\/accounts\/([^/?#\s]+)/,
];
const STATUS_MARKER = /^(Shipped|Built|In progress|Planned|Live)(?: on NEAR (testnet|mainnet))?$/;
const NUMBER_WORDS = Object.fromEntries(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
    .split(" ")
    .map((w, i) => [w, i]),
);
const PNPM_BUILTINS = new Set(
  "add audit bin config create dedupe deploy dlx env exec fetch help i import init install licenses link list ls outdated pack patch prune publish rebuild remove rm root setup store unlink update up why".split(
    " ",
  ),
);

// ---------------------------------------------------------------------------------------------
// Small helpers

/** The number of bytes a base58 string decodes to, or -1 when it is not base58. */
export function base58Length(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return -1;
    n = n * 58n + BigInt(i);
  }
  let len = 0;
  while (n > 0n) {
    n >>= 8n;
    len++;
  }
  for (const c of s) {
    if (c !== "1") break;
    len++;
  }
  return len;
}

/** True for a base58 value of 32 bytes: a NEAR tx hash, a code hash or a block hash. */
export const isHash32 = (s) =>
  typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && base58Length(s) === 32;

/** GitHub's anchor for a heading: rendered text, lower case, punctuation dropped, spaces to "-". */
export function githubSlug(heading) {
  const text = heading
    .replace(/<[^>]*>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|\*/g, "");
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/** "eleven" -> 11, "10,767" -> 10767, anything else -> NaN. */
export function toNumber(word) {
  const w = String(word).toLowerCase();
  if (w in NUMBER_WORDS) return NUMBER_WORDS[w];
  return /^\d{1,3}(,\d{3})*$|^\d+$/.test(w) ? Number(w.replace(/,/g, "")) : Number.NaN;
}

/** Compares two x.y.z versions: negative, 0 or positive. */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when a README version ("16", "4.6", "0.11.4") is the leading part of a manifest spec. */
export function versionMatches(claimed, spec) {
  const base = String(spec)
    .trim()
    .replace(/^(?:workspace:|npm:)?[\^~>=<v\s]*/, "")
    .split(/[\s,|]/)[0];
  if (!/^\d+(\.\d+)*/.test(base)) return null;
  const c = claimed.split(".");
  const b = base.split(/[.-]/);
  return c.every((part, i) => part === b[i]);
}

const camelToSnake = (s) => s.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase());

function tableCells(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim());
}

/** The lines GitHub shows for a file: a final newline does not start another line. */
const lineCount = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

const isDelimiterRow = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const stripTicks = (s) => s.replace(/`/g, "").trim();

// ---------------------------------------------------------------------------------------------
// The repository: its files, as git would check them out

// git's answers, kept for the life of the process: the checkout does not change while it runs, and
// the tests run the checker many times over the same one.
const gitAnswers = new Map();

function gitOut(root, args) {
  const key = JSON.stringify([resolve(root), args]);
  if (!gitAnswers.has(key)) {
    try {
      const out = execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      });
      gitAnswers.set(key, { out });
    } catch (error) {
      gitAnswers.set(key, { error });
    }
  }
  const answer = gitAnswers.get(key);
  if (answer.error) throw answer.error;
  return answer.out;
}

function sameDir(a, b) {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

const WALK_SKIP = new Set([".git", ".keys", "node_modules", "dist", "target", ".next", "coverage"]);

function walkFiles(root, rel = "", out = []) {
  for (const name of readdirSync(join(root, rel))) {
    if (WALK_SKIP.has(name)) continue;
    const path = rel ? `${rel}/${name}` : name;
    if (statSync(join(root, path)).isDirectory()) walkFiles(root, path, out);
    else out.push(path);
  }
  return out;
}

/** The files of the checkout: tracked plus untracked-but-not-ignored, or a plain walk without git. */
function listFiles(root) {
  try {
    const top = gitOut(root, ["rev-parse", "--show-toplevel"]).trim();
    if (sameDir(top, root)) {
      const listed = gitOut(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .split("\0")
        .filter((p) => p !== "" && existsSync(join(root, p)));
      return { files: listed, git: true };
    }
  } catch {
    // not a git checkout: walk the directory instead
  }
  return { files: walkFiles(root), git: false };
}

/**
 * The checkout at root. `overrides` maps a path to the text it should have instead (a test edits a
 * claim in memory this way), or to null to leave the file out.
 */
export function loadRepo(root, overrides = {}) {
  const listed = listFiles(root);
  const git = listed.git;
  const files = listed.files.filter((f) => overrides[f] !== null);
  for (const [f, v] of Object.entries(overrides)) {
    if (typeof v === "string" && !files.includes(f)) files.push(f);
  }
  const fileSet = new Set(files);
  const dirSet = new Set([""]);
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
  }
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) {
      const text =
        typeof overrides[rel] === "string" ? overrides[rel] : readFileSync(join(root, rel), "utf8");
      cache.set(rel, text.replace(/\r\n?/g, "\n"));
    }
    return cache.get(rel);
  };
  const isFile = (rel) => fileSet.has(rel);
  const isDir = (rel) => dirSet.has(rel);
  const json = (rel) => (isFile(rel) ? JSON.parse(read(rel)) : null);
  const under = (dir) => files.filter((f) => f.startsWith(`${dir}/`));
  let shallow = null;
  const history = () => {
    if (!git) return false;
    if (shallow === null) {
      try {
        shallow = gitOut(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
      } catch {
        shallow = true;
      }
    }
    return !shallow;
  };
  return {
    root,
    files,
    isFile,
    isDir,
    read,
    json,
    under,
    git,
    history,
    gitOut: (a) => gitOut(root, a),
    overridden: Object.keys(overrides),
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown: lines, fences, headings, blocks, inline code and links

export function parseMarkdown(text) {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const lines = [];
  let fence = null;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const n = i + 1;
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(t);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        lines.push({ n, text: t, kind: "fence" });
        fence = null;
      } else {
        lines.push({ n, text: t, kind: "code", lang: fence.lang, fenceStart: fence.start });
      }
      continue;
    }
    const open = /^\s{0,4}(`{3,}|~{3,})\s*([\w+-]*)/.exec(t);
    if (open) {
      fence = { char: open[1][0], len: open[1].length, lang: open[2], start: n };
      lines.push({ n, text: t, kind: "fence" });
      continue;
    }
    lines.push({ n, text: t, kind: "text" });
  }

  const headings = [];
  const seen = new Map();
  for (const l of lines) {
    if (l.kind !== "text") continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l.text);
    if (!m) continue;
    const base = githubSlug(m[2]);
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    headings.push({ level: m[1].length, text: m[2], slug: k ? `${base}-${k}` : base, n: l.n });
  }
  const anchors = new Set(headings.map((h) => h.slug));
  for (const m of text.matchAll(/<a\s[^>]*\b(?:id|name)="([^"]+)"/g)) anchors.add(m[1]);

  // Blocks: a paragraph or list item (its lines joined), a table row, a heading or one code line.
  const blocks = [];
  let cur = null;
  const sectionAt = (n) => {
    let s = null;
    for (const h of headings) if (h.n <= n) s = h;
    return s;
  };
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  for (const l of lines) {
    if (l.kind === "code") {
      flush();
      blocks.push({ kind: "code", text: l.text, starts: [[0, l.n]], n: l.n, lang: l.lang });
      continue;
    }
    if (l.kind === "fence" || l.text.trim() === "") {
      flush();
      continue;
    }
    const isRow = /^\s*\|/.test(l.text);
    const isHeading = /^#{1,6}\s/.test(l.text);
    const isItem = /^\s*([-*+]|\d+\.)\s/.test(l.text);
    if (isRow || isHeading) {
      flush();
      blocks.push({
        kind: isRow ? "row" : "heading",
        text: l.text,
        starts: [[0, l.n]],
        n: l.n,
      });
      continue;
    }
    if (isItem) flush();
    if (!cur) cur = { kind: isItem ? "item" : "para", text: "", starts: [], n: l.n };
    if (cur.text) cur.text += " ";
    cur.starts.push([cur.text.length, l.n]);
    cur.text += l.text.trim().replace(/^>\s?/, "");
  }
  flush();
  for (const b of blocks) b.section = sectionAt(b.n);
  return { lines, headings, anchors, blocks, lineCount: raw.length };
}

/** The source line of a character offset in a block. */
export function lineAt(block, offset) {
  let n = block.n;
  for (const [start, line] of block.starts) if (start <= offset) n = line;
  return n;
}

/** Inline code spans of a text, outside fences. */
function codeSpans(text) {
  return [...text.matchAll(/(?<!`)`([^`]+)`(?!`)/g)].map((m) => ({ code: m[1], index: m.index }));
}

/** Links of a text: Markdown links and images, HTML src/href, reference definitions. */
export function extractLinks(text) {
  // Code spans that hold link syntax are code, not links.
  const masked = text.replace(/`[^`]*`/g, (s) => (s.includes("](") ? " ".repeat(s.length) : s));
  const out = [];
  const md =
    /\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*(<[^>]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+"[^"]*")?\s*\)/g;
  for (const m of masked.matchAll(md)) {
    out.push({ text: m[1], target: m[2].replace(/^<|>$/g, ""), index: m.index });
  }
  for (const m of masked.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    out.push({ text: "", target: m[1], index: m.index });
  }
  const ref = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(masked);
  if (ref) out.push({ text: "", target: ref[1], index: 0 });
  return out;
}

// ---------------------------------------------------------------------------------------------
// What the repository records

function walkJson(value, visit, key = "", parent = null) {
  if (Array.isArray(value)) {
    for (const v of value) walkJson(v, visit, key, value);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walkJson(v, visit, k, value);
  } else {
    visit(key, value, parent);
  }
}

const networkOfAccount = (id) =>
  id.endsWith(".testnet") ? "testnet" : id.endsWith(".near") ? "mainnet" : null;

export function loadRecords(repo) {
  const tx = { testnet: new Map(), mainnet: new Map() };
  const accounts = { testnet: new Map(), mainnet: new Map() };
  const signerOf = new Map();
  const codeHashes = new Map();
  const accountCodeHash = new Map();
  const keyless = new Map();
  const note = (map, k, where) => {
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(where);
  };
  const noteAccount = (id, where, net = networkOfAccount(id)) => {
    if (net && NEAR_ACCOUNT_RE.test(id)) note(accounts[net], id, where);
  };

  const ch = repo.json("contracts/code-hashes.json");
  for (const e of ch?.entries ?? []) if (isHash32(e.code_hash)) codeHashes.set(e.code_hash, e);

  for (const file of repo.files.filter((f) => /^contracts\/deployments\/[^/]+\.json$/.test(f))) {
    const doc = repo.json(file);
    const net =
      doc?.network === "mainnet" ? "mainnet" : doc?.network === "testnet" ? "testnet" : null;
    if (!net) continue;
    walkJson(doc, (key, value) => {
      if (typeof value !== "string") return;
      if (/(^|_)tx$/.test(key) && isHash32(value)) note(tx[net], value, file);
      if (NEAR_ACCOUNT_RE.test(value) && (value.includes(".") || /^[0-9a-f]{64}$/.test(value))) {
        if (value.includes(".")) noteAccount(value, file);
        else note(accounts[net], value, file);
      }
    });
    const acc = doc.accounts ?? {};
    for (const [k, id] of Object.entries(acc)) {
      if (doc[k]?.code_hash && isHash32(doc[k].code_hash))
        accountCodeHash.set(id, doc[k].code_hash);
    }
    const visitObjects = (o) => {
      if (Array.isArray(o)) for (const v of o) visitObjects(v);
      else if (o && typeof o === "object") {
        const id = o.account ?? o.account_id;
        if (typeof id === "string" && isHash32(o.code_hash)) accountCodeHash.set(id, o.code_hash);
        for (const v of Object.values(o)) visitObjects(v);
      }
    };
    visitObjects(doc);
    const factory = doc.factory;
    for (const v of factory?.smoke_vaults ?? []) {
      const ver = (factory.versions ?? []).find((x) => x.index === v.version);
      if (ver && isHash32(ver.code_hash)) accountCodeHash.set(v.account, ver.code_hash);
      if (v.access_keys === 0) keyless.set(v.account, { zeroKeys: true, where: file });
    }
    const v0 = acc.vault_v0;
    if (v0 && doc.vault_v0?.locked === true) keyless.set(v0, { zeroKeys: false, where: file });
  }

  const proof = repo.json("docs/mainnet-proof.json");
  for (const t of Object.values(proof?.txs ?? {})) {
    if (t && (t.network === "testnet" || t.network === "mainnet") && isHash32(t.hash)) {
      note(tx[t.network], t.hash, "docs/mainnet-proof.json");
      if (t.signer_id) signerOf.set(t.hash, t.signer_id);
    }
  }
  for (const id of Object.values(proof?.accounts ?? {})) {
    if (typeof id === "string") noteAccount(id, "docs/mainnet-proof.json");
  }

  for (const file of repo.under("docs/evidence")) {
    if (!/\.(md|txt|json|jsonl)$/.test(file)) continue;
    const text = repo.read(file);
    const net = /mainnet/.test(file) ? "mainnet" : "testnet";
    for (const m of text.matchAll(B58_RUN)) {
      const h = m[0];
      if (!isHash32(h) || codeHashes.has(h)) continue;
      if (/(ed25519|secp256k1):$/.test(text.slice(Math.max(0, m.index - 10), m.index))) continue;
      const link = /(testnet\.)?nearblocks\.io\/txns?\/$/.exec(text.slice(m.index - 40, m.index));
      note(tx[link ? (link[1] ? "testnet" : "mainnet") : net], h, file);
    }
    for (const m of text.matchAll(ACCOUNT_TOKEN)) noteAccount(m[0], file);
    if (file.endsWith(".md")) {
      for (const line of text.split("\n")) {
        const m =
          /`((?:[a-z\d][a-z\d_-]*\.)+(?:testnet|near))`[^|]*code hash `([1-9A-HJ-NP-Za-km-z]{43,44})`/.exec(
            line,
          );
        if (m && isHash32(m[2]) && !accountCodeHash.has(m[1])) accountCodeHash.set(m[1], m[2]);
        const owner = /^\|\s*(?:Owner|Approver|Payee)\s*\|\s*`([0-9a-f]{64})`/.exec(line);
        if (owner) note(accounts[net], owner[1], file);
      }
    }
    const header = /^Probarion verify: (\S+) \((testnet|mainnet)\)/m.exec(text);
    if (header && /^f\s+vault-locked\s+PASS\s+no FullAccess key/m.test(text)) {
      if (!keyless.has(header[1])) keyless.set(header[1], { zeroKeys: false, where: file });
    }
  }
  return { tx, accounts, signerOf, codeHashes, accountCodeHash, keyless };
}

/** The workspace packages: name -> { dir, json }. */
export function loadPackages(repo) {
  const out = new Map();
  const ws = repo.isFile("pnpm-workspace.yaml") ? repo.read("pnpm-workspace.yaml") : "";
  const globs = [...ws.matchAll(/^\s*-\s*["']?([^"'\s#]+)["']?/gm)].map((m) => m[1]);
  const dirs = new Set();
  for (const g of globs) {
    if (g.endsWith("/*")) {
      const base = g.slice(0, -2);
      for (const f of repo.under(base)) {
        const m = new RegExp(`^${base}/([^/]+)/package\\.json$`).exec(f);
        if (m) dirs.add(`${base}/${m[1]}`);
      }
    } else if (repo.isFile(`${g}/package.json`)) dirs.add(g);
  }
  for (const dir of dirs) {
    const json = repo.json(`${dir}/package.json`);
    if (json?.name) out.set(json.name, { dir, json });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The checks

class Report {
  constructor() {
    this.problems = [];
    this.unreachable = [];
    this.counts = new Map();
    this.facts = new Map();
    this.distinct = new Map();
  }
  /** Counts a value once however often it is cited. */
  once(what, value) {
    if (!this.distinct.has(what)) this.distinct.set(what, new Set());
    this.distinct.get(what).add(value);
  }
  fail(check, file, line, message) {
    this.problems.push({ check, file, line, message });
  }
  count(what, n = 1) {
    this.counts.set(what, (this.counts.get(what) ?? 0) + n);
  }
  fact(id, n = 1) {
    this.facts.set(id, (this.facts.get(id) ?? 0) + n);
  }
}

function resolveTarget(fromDoc, target) {
  const [beforeHash, ...rest] = target.split("#");
  const anchor = rest.length ? rest.join("#") : undefined;
  let path = beforeHash.split("?")[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return { error: "is not a valid URL escape" };
  }
  if (path === "") return { path: fromDoc, anchor };
  const joined = path.startsWith("/")
    ? posix.normalize(path.slice(1))
    : posix.normalize(posix.join(posix.dirname(fromDoc), path));
  const clean = joined === "." ? "" : joined.replace(/\/+$/, "");
  if (clean === ".." || clean.startsWith("../")) return { error: "points outside the repository" };
  return { path: clean, anchor };
}

function checkLinks(ctx, doc, model) {
  const { repo, report } = ctx;
  for (const b of model.blocks) {
    if (b.kind === "code") continue;
    for (const link of extractLinks(b.text)) {
      const line = lineAt(b, link.index);
      const t = link.target.trim();
      if (t === "" || /^[a-z][a-z\d+.-]*:/i.test(t) || t.startsWith("//")) {
        if (/^https?:/i.test(t)) report.count("external links (not fetched offline)");
        continue;
      }
      report.count("links");
      const r = resolveTarget(doc, t);
      if (r.error) {
        report.fail("links", doc, line, `link ${t} ${r.error}`);
        continue;
      }
      if (!repo.isFile(r.path) && !repo.isDir(r.path)) {
        report.fail("links", doc, line, `link ${t}: ${r.path} is not a file of the repository`);
        continue;
      }
      const shown = stripTicks(link.text);
      if (
        /^[\w.-]+\/[\w./[\]-]+$/.test(shown) &&
        shown !== r.path &&
        (repo.isFile(shown) || repo.isDir(shown))
      ) {
        report.fail("links", doc, line, `link text ${shown} names another path than ${r.path}`);
      }
      checkLinkName(ctx, doc, line, link.text, r);
      if (r.anchor === undefined || r.anchor === "") continue;
      report.count("anchors");
      const lineRange = /^L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/.exec(r.anchor);
      if (lineRange) {
        if (!repo.isFile(r.path)) {
          report.fail("links", doc, line, `link ${t}: a line anchor on a directory`);
          continue;
        }
        const count = lineCount(repo.read(r.path));
        const a = Number(lineRange[1]);
        const z = Number(lineRange[2] ?? lineRange[1]);
        if (a < 1 || z < a || z > count) {
          report.fail("links", doc, line, `link ${t}: ${r.path} has ${count} lines`);
        }
        continue;
      }
      let md = r.path;
      if (repo.isDir(md) && repo.isFile(`${md}/README.md`)) md = `${md}/README.md`;
      if (!md.endsWith(".md")) {
        report.fail("links", doc, line, `link ${t}: #${r.anchor} on a file that has no headings`);
        continue;
      }
      const target = md === doc ? model : parseMarkdown(repo.read(md));
      if (!target.anchors.has(r.anchor.toLowerCase()) && !target.anchors.has(r.anchor)) {
        report.fail(
          "links",
          doc,
          line,
          `link ${t}: ${md} has no heading whose anchor is #${r.anchor}`,
        );
      }
    }
  }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A link whose whole text is code names what it links: [`keys.rs`](contracts/vault/src/keys.rs) is
 * that file's name, and [`decide()`](packages/core/src/policy.ts) a symbol the file holds, within the
 * lines of a #Lnn-Lmm anchor when it has one.
 */
function checkLinkName(ctx, doc, line, text, r) {
  const { repo, report } = ctx;
  const code = /^`([^`]+)`$/.exec(text.trim())?.[1];
  if (!code || code.includes("/") || r.path === doc) return;
  const base = posix.basename(r.path);
  if (code === base) return;
  if (/^[\w-]+\.[a-z\d]{1,5}$/i.test(code)) {
    report.fail("links", doc, line, `link text ${code} is not the name of ${r.path}`);
    return;
  }
  const name = code.replace(/\(\)$/, "").split(/[.:]+/).pop();
  if (!/^[A-Za-z_]\w*$/.test(name) || !repo.isFile(r.path)) return;
  report.count("link symbols");
  let body = repo.read(r.path);
  const range = /^L(\d+)(?:-L(\d+))?$/.exec(r.anchor ?? "");
  if (range) {
    body = body
      .split("\n")
      .slice(Number(range[1]) - 1, Number(range[2] ?? range[1]))
      .join("\n");
  }
  if (!new RegExp(`\\b${escapeRegExp(name)}\\b`).test(body)) {
    const where = range ? `lines ${range[1]} to ${range[2] ?? range[1]} of ${r.path}` : r.path;
    report.fail("links", doc, line, `link text ${code}: ${where} has no ${name}`);
  }
}

function explorerTx(url) {
  for (const re of EXPLORER_TX) {
    const m = re.exec(url);
    if (m) return { network: m[1] ? "testnet" : "mainnet", hash: decodeURIComponent(m[2]) };
  }
  return null;
}

function explorerAccount(url) {
  for (const re of EXPLORER_ACCOUNT) {
    const m = re.exec(url);
    if (m) return { network: m[1] ? "testnet" : "mainnet", id: decodeURIComponent(m[2]) };
  }
  return null;
}

/** Each tx hash a claim doc cites: { hash, network, doc, line, block }. */
function citedTxs(doc, model) {
  const out = [];
  for (const b of model.blocks) {
    if (b.kind === "code") {
      for (const m of b.text.matchAll(/\btx\s+([1-9A-HJ-NP-Za-km-z]{43,44})\b/g)) {
        const net = /testnet/.test(b.text) || /testnet/.test(b.lang ?? "") ? "testnet" : null;
        out.push({ hash: m[1], network: net, doc, line: b.n, block: b, code: true });
      }
      continue;
    }
    for (const link of extractLinks(b.text)) {
      const t = explorerTx(link.target);
      if (t) out.push({ ...t, doc, line: lineAt(b, link.index), block: b, text: link.text });
    }
  }
  return out;
}

function checkHashes(ctx, doc, model) {
  const { report, records } = ctx;
  const cited = citedTxs(doc, model);
  const fenceText = new Map();
  for (const l of model.lines) {
    if (l.kind === "code")
      fenceText.set(l.fenceStart, `${fenceText.get(l.fenceStart) ?? ""}${l.text}\n`);
  }
  for (const c of cited) {
    if (c.code && !c.network) {
      const fence = model.lines.find((l) => l.n === c.line)?.fenceStart;
      c.network = /testnet/.test(fenceText.get(fence) ?? "") ? "testnet" : "mainnet";
    }
    report.count("tx hashes");
    report.once("tx hashes", `${c.network}:${c.hash}`);
    if (!isHash32(c.hash)) {
      report.fail("hashes", doc, c.line, `${c.hash} is not a NEAR tx hash (32 bytes in base58)`);
      continue;
    }
    const other = c.network === "testnet" ? "mainnet" : "testnet";
    if (records.codeHashes.has(c.hash)) {
      report.fail("hashes", doc, c.line, `${c.hash} is a recorded code hash, not a transaction`);
    } else if (!records.tx[c.network].has(c.hash)) {
      const where = records.tx[other].has(c.hash) ? `; it is recorded on ${other} only` : "";
      const files =
        c.network === "mainnet"
          ? "contracts/deployments/mainnet.json or docs/mainnet-proof.json"
          : "contracts/deployments/testnet.json, docs/mainnet-proof.json or docs/evidence";
      report.fail(
        "hashes",
        doc,
        c.line,
        `${c.network} tx ${c.hash} is not recorded in ${files}${where}`,
      );
    }
    if (c.text !== undefined) {
      const shown = stripTicks(c.text);
      const short = /^([1-9A-HJ-NP-Za-km-z]{4,})(?:\u2026|\.\.\.)([1-9A-HJ-NP-Za-km-z]*)$/.exec(
        shown,
      );
      if (short && !(c.hash.startsWith(short[1]) && c.hash.endsWith(short[2]))) {
        report.fail("hashes", doc, c.line, `link text ${shown} does not match its hash ${c.hash}`);
      } else if (/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(shown) && shown !== c.hash) {
        report.fail("hashes", doc, c.line, `link text ${shown} is not its hash ${c.hash}`);
      }
    }
  }
  ctx.cited.push(...cited.filter((c) => isHash32(c.hash)));

  // Every other 32-byte base58 value: a recorded transaction or a recorded code hash.
  const citedSet = new Set(cited.map((c) => c.hash));
  for (const b of model.blocks) {
    const masked = b.text.replace(/\]\([^)]*\)/g, (s) => " ".repeat(s.length));
    for (const m of masked.matchAll(B58_RUN)) {
      const h = m[0];
      if (!isHash32(h) || citedSet.has(h)) continue;
      if (/(ed25519|secp256k1):$/.test(masked.slice(Math.max(0, m.index - 10), m.index))) continue;
      report.count("other hashes");
      if (records.codeHashes.has(h) || records.tx.testnet.has(h) || records.tx.mainnet.has(h))
        continue;
      report.fail(
        "hashes",
        doc,
        lineAt(b, m.index),
        `${h} is neither a recorded transaction nor a code hash in contracts/code-hashes.json`,
      );
    }
    // A shortened value outside a link: the one record it abbreviates.
    const plain = b.text.replace(/\[[^\]]*\]\([^)]*\)/g, (s) => " ".repeat(s.length));
    for (const m of plain.matchAll(/`([1-9A-HJ-NP-Za-km-z]{6,42})\u2026`/g)) {
      report.count("other hashes");
      const all = [
        ...records.codeHashes.keys(),
        ...records.tx.testnet.keys(),
        ...records.tx.mainnet.keys(),
      ];
      const hits = new Set(all.filter((h) => h.startsWith(m[1])));
      if (hits.size !== 1) {
        report.fail(
          "hashes",
          doc,
          lineAt(b, m.index),
          `${m[1]}\u2026 matches ${hits.size} recorded hashes, not exactly one`,
        );
      }
    }
  }
}

function checkAccounts(ctx, doc, model) {
  const { report, records } = ctx;
  for (const b of model.blocks) {
    if (b.kind === "code") continue;
    for (const link of extractLinks(b.text)) {
      const a = explorerAccount(link.target);
      if (!a) continue;
      const line = lineAt(b, link.index);
      report.count("accounts");
      report.once("accounts", `${a.network}:${a.id}`);
      if (!NEAR_ACCOUNT_RE.test(a.id)) {
        report.fail("accounts", doc, line, `${a.id} is not a NEAR account id`);
        continue;
      }
      const net = networkOfAccount(a.id);
      if (a.id.includes(".") && net !== a.network) {
        report.fail("accounts", doc, line, `${a.id} is linked on the ${a.network} explorer`);
      }
      if (!records.accounts[a.network].has(a.id)) {
        report.fail(
          "accounts",
          doc,
          line,
          `${a.network} account ${a.id} is not in contracts/deployments or docs/evidence`,
        );
      }
      const shown = stripTicks(link.text);
      if (/^[a-z\d_.-]+\.(testnet|near)$/.test(shown) && shown !== a.id) {
        report.fail("accounts", doc, line, `link text ${shown} is not its account ${a.id}`);
      }
    }
  }
}

function checkStatus(ctx, doc, model) {
  const { report, repo, records } = ctx;
  const h = model.headings.find((x) => x.level === 2 && x.text.trim() === "Status");
  if (!h) {
    if (doc === "README.md") report.fail("status", doc, 1, "README.md has no ## Status section");
    return;
  }
  const next = model.headings.find((x) => x.n > h.n && x.level <= 2);
  const rows = model.lines.filter(
    (l) => l.kind === "text" && l.n > h.n && (!next || l.n < next.n) && /^\s*\|/.test(l.text),
  );
  if (rows.length < 3) {
    report.fail("status", doc, h.n, "the Status section has no table");
    return;
  }
  const header = tableCells(rows[0].text);
  const si = header.findIndex((c) => /^status$/i.test(c));
  const wi = header.findIndex((c) => /^where$/i.test(c));
  if (si < 0 || wi < 0) {
    report.fail("status", doc, rows[0].n, "the Status table needs a Status and a Where column");
    return;
  }
  for (const row of rows.slice(1)) {
    if (isDelimiterRow(row.text)) continue;
    report.count("status rows");
    const cells = tableCells(row.text);
    if (cells.length !== header.length) {
      report.fail(
        "status",
        doc,
        row.n,
        `row has ${cells.length} cells, the header ${header.length} (an unescaped | in a cell?)`,
      );
      continue;
    }
    const marker = /^\*\*([^*]+)\*\*/.exec(cells[si]);
    if (!marker) {
      report.fail("status", doc, row.n, "the Status cell does not start with a bold marker");
      continue;
    }
    const mk = STATUS_MARKER.exec(marker[1].trim());
    if (!mk) {
      report.fail("status", doc, row.n, `unknown status marker "${marker[1]}"`);
      continue;
    }
    const where = extractLinks(cells[wi])
      .map((l) => l.target)
      .filter((t) => !/^[a-z][a-z\d+.-]*:/i.test(t));
    const existing = where
      .map((t) => resolveTarget(doc, t))
      .filter((r) => {
        return !r.error && (repo.isFile(r.path) || repo.isDir(r.path));
      });
    if (existing.length === 0) {
      report.fail("status", doc, row.n, `"${marker[1]}" row points at no path of the repository`);
    }
    const links = extractLinks(row.text);
    if (mk[2]) {
      const net = mk[2];
      const cites =
        links.some((l) => explorerTx(l.target)?.network === net) ||
        links.some((l) => /docs\/evidence/.test(l.target)) ||
        [...row.text.matchAll(ACCOUNT_TOKEN)].some((m) => records.accounts[net].has(m[0]));
      if (!cites) {
        report.fail(
          "status",
          doc,
          row.n,
          `"${marker[1]}" row cites no recorded ${net} account, tx or evidence`,
        );
      }
    }
    if (mk[1] === "Planned" && links.some((l) => explorerTx(l.target))) {
      report.fail("status", doc, row.n, `"Planned" row links a transaction`);
    }
  }
}

function scriptCommands(repo, path) {
  if (!repo.isFile(path)) return null;
  const src = repo.read(path);
  const words = new Set();
  for (const m of src.matchAll(/case "([a-z][\w-]*)"|\b(?:cmd|command) === "([a-z][\w-]*)"/g)) {
    words.add(m[1] ?? m[2]);
  }
  return words;
}

/** Splits a shell command line into words, keeping quoted words whole. */
function shellWords(s) {
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

function checkPnpm(ctx, doc, line, cmd) {
  const { report, repo, packages } = ctx;
  const words = shellWords(cmd.split(/&&|\|\||[|;#]/)[0]);
  const filters = [];
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    if (words[i] === "--filter" || words[i] === "-F") {
      filters.push(words[i + 1] ?? "");
      i += 2;
    } else if (words[i].startsWith("--filter=")) {
      filters.push(words[i].slice(9));
      i++;
    } else if (/^(-r|--recursive|-w|--workspace-root|--if-present|-s|--silent)$/.test(words[i])) {
      i++;
    } else return;
  }
  let script = words[i];
  if (!script) return;
  let exec = false;
  if (script === "run") script = words[i + 1];
  else if (script === "exec") exec = true;
  else if (PNPM_BUILTINS.has(script)) return;
  if (!script) return;
  report.count("pnpm commands");
  const targets = [];
  for (const f of filters) {
    if (/^\{?\.?\.?\/?[\w-]+\/[\w./-]+\}?(\.\.\.)?$/.test(f) && !f.startsWith("@")) {
      const dir = f.replace(/^\{|\}?(\.\.\.)?$/g, "").replace(/^\.\//, "");
      if (!repo.isDir(dir))
        report.fail("paths", doc, line, `pnpm --filter ${f}: no directory ${dir}`);
      continue;
    }
    const pkg = packages.get(f.replace(/\.\.\.$/, ""));
    if (!pkg) {
      report.fail("paths", doc, line, `pnpm --filter ${f}: no workspace package of that name`);
      continue;
    }
    targets.push(pkg);
  }
  if (exec) {
    for (const pkg of targets) {
      for (const w of words.slice(i + 2)) {
        if (/^[\w.-]+(\/[\w.[\]-]+)+\.\w+$/.test(w) && !repo.isFile(`${pkg.dir}/${w}`)) {
          report.fail(
            "paths",
            doc,
            line,
            `pnpm --filter ${pkg.json.name} exec: no file ${pkg.dir}/${w}`,
          );
        }
      }
    }
    return;
  }
  if (filters.length === 0) {
    const scripts = repo.json("package.json")?.scripts ?? {};
    if (!(script in scripts)) {
      report.fail("paths", doc, line, `pnpm ${script}: the root package.json has no such script`);
    }
    return;
  }
  for (const pkg of targets) {
    if (!(script in (pkg.json.scripts ?? {}))) {
      report.fail("paths", doc, line, `pnpm --filter ${pkg.json.name} ${script}: no such script`);
    }
  }
}

function checkPaths(ctx, doc, model) {
  const { report, repo } = ctx;
  const tops = repo.files
    .map((f) => f.split("/")[0])
    .filter(
      (t, i, all) =>
        all.indexOf(t) === i && repo.isDir(t) && (t === ".github" || !t.startsWith(".")),
    );
  const pathRe = new RegExp(
    `(?<![\\w./$@~-])((?:${tops.map((t) => t.replace(".", "\\.")).join("|")})/[\\w.\\-\\[\\]%/]*[\\w\\]/-])(?::(\\d+)(?:-(\\d+))?)?`,
    "g",
  );
  const pieces = [];
  for (const b of model.blocks) {
    if (b.kind === "code") pieces.push({ text: b.text, line: b.n, code: true });
    else {
      for (const s of codeSpans(b.text)) {
        // The code text of a link, [`path`](path), is checked with the link.
        const end = s.index + s.code.length + 2;
        if (b.text[s.index - 1] === "[" && b.text.startsWith("](", end)) continue;
        pieces.push({ text: s.code, line: lineAt(b, s.index) });
      }
    }
  }
  for (const p of pieces) {
    if (tops.length) {
      for (const m of p.text.matchAll(pathRe)) {
        const after = p.text[m.index + m[0].length] ?? "";
        let path = m[1].replace(/[/.]+$/, "");
        if (
          /(^|\/)(dist|target|node_modules|coverage)(\/|$)/.test(path) ||
          /[<*{\u2026]/.test(after)
        ) {
          continue;
        }
        if (path.includes("%")) {
          try {
            path = decodeURIComponent(path);
          } catch {
            // keep it as written
          }
        }
        report.count("paths");
        if (!repo.isFile(path) && !repo.isDir(path)) {
          report.fail("paths", doc, p.line, `${path} does not exist in the repository`);
          continue;
        }
        if (m[2] && repo.isFile(path)) {
          const count = lineCount(repo.read(path));
          if (Number(m[3] ?? m[2]) > count) {
            report.fail("paths", doc, p.line, `${m[0]}: ${path} has ${count} lines`);
          }
        }
      }
    }
    for (const m of p.text.matchAll(/(?:^|[\s;&|(`])(pnpm\s[^\n`]*)/g))
      checkPnpm(ctx, doc, p.line, m[1]);
    for (const m of p.text.matchAll(/\bnode\s+(?:--\S+\s+)*([\w./-]+\.m?js)\s+([a-z][\w-]*)/g)) {
      if (/(^|\/)dist\//.test(m[1])) continue;
      const words = scriptCommands(repo, m[1].replace(/^\.\//, ""));
      if (!words || words.size === 0) continue;
      report.count("script commands");
      if (!words.has(m[2])) {
        report.fail(
          "paths",
          doc,
          p.line,
          `${m[1]} has no command "${m[2]}" (it handles ${[...words].join(", ")})`,
        );
      }
    }
    if (p.code) {
      const g = /\bgrep\s+(?:-\w+\s+)*([^\s'"|]+|'[^']*'|"[^"]*")\s+([\w./-]+)(?=\s|$)/.exec(
        p.text,
      );
      if (g && !/[[\]*.^$\\]/.test(g[1].replace(/^['"]|['"]$/g, "").replace(/\./g, ""))) {
        const needle = g[1].replace(/^['"]|['"]$/g, "");
        if (repo.isFile(g[2])) {
          report.count("grep lines");
          if (!repo.read(g[2]).includes(needle)) {
            report.fail("paths", doc, p.line, `grep finds no "${needle}" in ${g[2]}`);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Facts: what the README states that the repository can derive

/** README/AGENTS phrases that name a version, and where the repository pins it. */
const VERSION_CLAIMS = [
  { re: /\bnear-sdk (\d+\.\d+\.\d+)/g, cargo: "near-sdk" },
  { re: /\bnear-contract-standards (\d+\.\d+\.\d+)/g, cargo: "near-contract-standards" },
  { re: /\bnear-workspaces (\d+\.\d+\.\d+)/g, cargo: "near-workspaces" },
  {
    re: /`?cargo-near`? (\d+\.\d+\.\d+)/g,
    file: ".github/workflows/ci.yml",
    pin: /cargo-near-v(\d+\.\d+\.\d+)/,
  },
  {
    re: /\bgitleaks (\d+\.\d+\.\d+)/g,
    file: ".github/workflows/ci.yml",
    pin: /gitleaks:v(\d+\.\d+\.\d+)/,
  },
  {
    re: /\bRust (\d+\.\d+\.\d+)|pinned (\d+\.\d+\.\d+) from `rust-toolchain\.toml`/g,
    file: "rust-toolchain.toml",
    pin: /channel = "([\d.]+)"/,
  },
  {
    re: /`?near-cli-rs`? (\d+\.\d+\.\d+)/g,
    file: "docs/specs/2026-10-21-probarion-interfaces.md",
    pin: /\| near-cli-rs \| `([\d.]+)` \|/,
  },
  { re: /\bNode(?:\.js)? (\d+)\b/g, file: ".nvmrc", pin: /^v?(\d+)/ },
  { re: /\bpnpm (\d+)\b/g, file: "package.json", pin: /"packageManager": "pnpm@([\d.]+)"/ },
  { re: /\bnear-api-js (\d+)\b/g, pkg: "@probarion/sdk", dep: "near-api-js" },
  {
    re: /`@hot-labs\/near-connect`\)? (\d+\.\d+\.\d+)/g,
    pkg: "@probarion/web",
    dep: "@hot-labs/near-connect",
  },
  {
    re: /`@defuse-protocol\/one-click-sdk-typescript` (\d+\.\d+\.\d+)/g,
    pkg: "@probarion/web",
    dep: "@defuse-protocol/one-click-sdk-typescript",
  },
  { re: /`libsodium-wrappers` (\d+\.\d+\.\d+)/g, pkg: "@probarion/web", dep: "libsodium-wrappers" },
  { re: /`pdf-parse` (\d+\.\d+\.\d+)/g, pkg: "@probarion/web", dep: "pdf-parse" },
  { re: /\bShiki (\d+(?:\.\d+)*)/g, pkg: "@probarion/web", dep: "shiki" },
  { re: /\bMiniSearch (\d+(?:\.\d+)*)/g, pkg: "@probarion/web", dep: "minisearch" },
  { re: /\bNext\.js (\d+)\b/g, pkg: "@probarion/web", dep: "next" },
  { re: /\bReact (\d+)\b/g, pkg: "@probarion/web", dep: "react" },
  { re: /\bTailwind CSS (\d+)\b/g, pkg: "@probarion/web", dep: "@tailwindcss/postcss" },
  { re: /\bResend (\d+)\b/g, pkg: "@probarion/web", dep: "resend" },
  { re: /`@sentry\/nextjs` (\d+)\b/g, pkg: "@probarion/web", dep: "@sentry/nextjs" },
  { re: /\bcommander (\d+)\b/g, pkg: "probarion", dep: "commander" },
  {
    re: /`@modelcontextprotocol\/sdk` (\d+(?:\.\d+)*)/g,
    pkg: "@probarion/mcp",
    dep: "@modelcontextprotocol/sdk",
  },
  { re: /\bzod (\d+)\b/g, pkg: "@probarion/mcp", dep: "zod" },
  { re: /\bviem (\d+)\b/g, pkg: "@probarion/core", dep: "viem" },
  { re: /\bVitest (\d+)\b/g, pkg: ".", dep: "vitest" },
  { re: /\bTypeScript (\d+(?:\.\d+)?)\b/g, pkg: ".", dep: "typescript" },
  { re: /\bBiome (\d+)\b/g, pkg: ".", dep: "@biomejs/biome" },
];

function pinnedVersion(ctx, claim) {
  const { repo, packages } = ctx;
  if (claim.cargo) {
    if (!repo.isFile("contracts/Cargo.toml")) return { where: "contracts/Cargo.toml" };
    const m = new RegExp(
      `^${claim.cargo}\\s*=\\s*(?:\\{[^}]*version\\s*=\\s*)?"=?([\\d.]+)"`,
      "m",
    ).exec(repo.read("contracts/Cargo.toml"));
    return { where: "contracts/Cargo.toml", spec: m?.[1] };
  }
  if (claim.file) {
    if (!repo.isFile(claim.file)) return { where: claim.file };
    return { where: claim.file, spec: claim.pin.exec(repo.read(claim.file))?.[1] };
  }
  const pkg =
    claim.pkg === "." ? { dir: ".", json: repo.json("package.json") } : packages.get(claim.pkg);
  const where = `${pkg?.dir ?? claim.pkg}/package.json`;
  const j = pkg?.json ?? {};
  const spec = {
    ...j.peerDependencies,
    ...j.optionalDependencies,
    ...j.devDependencies,
    ...j.dependencies,
  }[claim.dep];
  return { where, spec };
}

function factVersions(ctx, doc, model) {
  for (const b of model.blocks) {
    for (const claim of VERSION_CLAIMS) {
      for (const m of b.text.matchAll(claim.re)) {
        const v = m[1] ?? m[2];
        const { where, spec } = pinnedVersion(ctx, claim);
        ctx.report.fact("versions");
        const ok = spec ? versionMatches(v, spec) : false;
        if (!ok) {
          ctx.report.fail(
            "facts",
            doc,
            lineAt(b, m.index),
            `"${m[0].trim()}": ${where} ${spec ? `pins ${spec}` : "pins no such version"}`,
          );
        }
      }
    }
  }
}

function changelogReleases(repo) {
  const out = new Map();
  if (!repo.isFile("CHANGELOG.md")) return out;
  for (const m of repo
    .read("CHANGELOG.md")
    .matchAll(/^## \[?(\d+\.\d+\.\d+)\]?(?: - (\d{4}-\d{2}-\d{2}))?/gm)) {
    out.set(m[1], m[2] ?? null);
  }
  return out;
}

function factNpm(ctx, doc, model) {
  const { report, packages, repo } = ctx;
  const releases = changelogReleases(repo);
  const released = (b, m, v) => {
    if (!releases.has(v)) {
      report.fail(
        "facts",
        doc,
        lineAt(b, m.index),
        `release ${v}: CHANGELOG.md has no "## ${v}" heading`,
      );
    }
  };
  for (const b of model.blocks) {
    for (const m of b.text.matchAll(/on npm as `([@\w/.-]+)` (\d+\.\d+\.\d+)/g)) {
      report.fact("npm versions");
      ctx.npmClaims.push({ name: m[1], version: m[2], doc, line: lineAt(b, m.index) });
      const pkg = packages.get(m[1]);
      if (!pkg) {
        report.fail("facts", doc, lineAt(b, m.index), `${m[1]} is not a package of this workspace`);
        continue;
      }
      if (compareVersions(pkg.json.version ?? "0", m[2]) < 0) {
        report.fail(
          "facts",
          doc,
          lineAt(b, m.index),
          `${m[1]} ${m[2]}: ${pkg.dir}/package.json is at ${pkg.json.version}`,
        );
      }
      released(b, m, m[2]);
    }
    for (const m of b.text.matchAll(/\b[Rr]elease (\d+\.\d+\.\d+)\b/g)) {
      report.fact("npm versions");
      released(b, m, m[1]);
    }
    for (const m of b.text.matchAll(/tag `[\w-]*?v(\d+\.\d+\.\d+)`/g)) {
      report.fact("npm versions");
      released(b, m, m[1]);
    }
    for (const m of b.text.matchAll(/\bnpx (?:-y )?((?:@[\w-]+\/)?[\w-]+)@(\d+\.\d+\.\d+)/g)) {
      report.fact("npm versions");
      if (!packages.has(m[1]))
        report.fail("facts", doc, lineAt(b, m.index), `npx ${m[1]}: not a package here`);
      released(b, m, m[2]);
    }
    const shipped = /release (\d+\.\d+\.\d+)[^|]*\|\s*\*\*Shipped\*\* on (\d{4}-\d{2}-\d{2})/.exec(
      b.text,
    );
    if (shipped) {
      report.fact("npm versions");
      const date = releases.get(shipped[1]);
      if (date !== shipped[2]) {
        report.fail(
          "facts",
          doc,
          b.n,
          `release ${shipped[1]} shipped on ${shipped[2]}: CHANGELOG.md dates it ${date ?? "nowhere"}`,
        );
      }
    }
    for (const m of b.text.matchAll(/`([@\w/.-]+)`[^.]{0,60}?\bnot on npm yet/g)) {
      if (packages.has(m[1])) ctx.notOnNpm.push({ name: m[1], doc, line: lineAt(b, m.index) });
    }
  }
}

function factCodeHashes(ctx, doc, model) {
  const { report, records } = ctx;
  const resolveHash = (h) => {
    if (isHash32(h)) return records.codeHashes.has(h) ? [h] : [];
    return [...records.codeHashes.keys()].filter((x) => x.startsWith(h));
  };
  for (const b of model.blocks) {
    // a) each "code hash `H`" names a recorded reproducible build
    for (const m of b.text.matchAll(
      /code[ _]hash(?:es)?[^`.]{0,20}`([1-9A-HJ-NP-Za-km-z]{6,44})(\u2026)?`/gi,
    )) {
      report.fact("code hashes");
      const hits = resolveHash(m[1]);
      if (hits.length !== 1) {
        report.fail(
          "facts",
          doc,
          lineAt(b, m.index),
          `code hash ${m[1]}${m[2] ?? ""} is not one recorded build in contracts/code-hashes.json`,
        );
      }
    }
    // b) each "commit `c`" next to a code hash is the commit that build is recorded for
    const fulls = [...b.text.matchAll(B58_RUN)].filter((m) => records.codeHashes.has(m[0]));
    for (const m of b.text.matchAll(/\bcommit `([0-9a-f]{7,40})`/g)) {
      ctx.commits.push({ sha: m[1], doc, line: lineAt(b, m.index) });
      if (fulls.length === 0) continue;
      const near = fulls.reduce((a, x) =>
        Math.abs(x.index - m.index) < Math.abs(a.index - m.index) ? x : a,
      );
      report.fact("code hashes");
      const e = records.codeHashes.get(near[0]);
      if (!e.commit?.startsWith(m[1])) {
        report.fail(
          "facts",
          doc,
          lineAt(b, m.index),
          `commit ${m[1]}: contracts/code-hashes.json records ${near[0]} for commit ${e.commit}`,
        );
      }
    }
    // c) a table row about one account: its "code hash" is the one recorded for that account
    if (b.kind === "row") {
      const first = tableCells(b.text)[0] ?? "";
      const acct = /`((?:[a-z\d][a-z\d_-]*\.)+(?:testnet|near))`/.exec(first)?.[1];
      const recorded = acct && records.accountCodeHash.get(acct);
      if (recorded) {
        for (const m of b.text.matchAll(/code hash `([1-9A-HJ-NP-Za-km-z]{6,44})(\u2026)?`/gi)) {
          report.fact("code hashes");
          if (!recorded.startsWith(m[1])) {
            report.fail(
              "facts",
              doc,
              b.n,
              `${acct}: the records give code hash ${recorded}, the row says ${m[1]}`,
            );
          }
        }
      }
    }
    // d) `chain.mjs code-hash <account>  # <hash>`
    if (b.kind === "code") {
      const m = /chain\.mjs code-hash ([a-z\d_.-]+)\s+#\s*([1-9A-HJ-NP-Za-km-z]{43,44})/.exec(
        b.text,
      );
      if (m) {
        report.fact("code hashes");
        const recorded = records.accountCodeHash.get(m[1]);
        if (recorded !== m[2]) {
          report.fail(
            "facts",
            doc,
            b.n,
            `${m[1]}: the records give code hash ${recorded ?? "none"}, the comment says ${m[2]}`,
          );
        }
        ctx.chainComments.push({ cmd: "code-hash", account: m[1], expect: m[2], doc, line: b.n });
      }
      const k = /chain\.mjs (full-access-keys|key-count) ([a-z\d_.-]+)\s+#\s*(.*)$/.exec(b.text);
      if (k) ctx.chainComments.push({ cmd: k[1], account: k[2], expect: k[3], doc, line: b.n });
    }
  }
  // e) every code hash a deployment record names is a recorded reproducible build
  if (doc === "README.md") {
    for (const [acct, h] of records.accountCodeHash) {
      report.fact("code hashes");
      if (!records.codeHashes.has(h)) {
        report.fail(
          "facts",
          "contracts/code-hashes.json",
          1,
          `${acct} runs ${h} by the records, which is not a recorded build`,
        );
      }
    }
  }
}

function factKeyless(ctx, doc, model) {
  const { report, records } = ctx;
  for (const b of model.blocks) {
    if (b.kind !== "row") continue;
    const claim = /no full-access key|\blocked\b|no access keys/i.exec(b.text);
    if (!claim) continue;
    const acct = [...b.text.matchAll(ACCOUNT_TOKEN)].map((m) => m[0])[0];
    if (!acct) continue;
    report.fact("keyless vaults");
    const rec = records.keyless.get(acct);
    if (!rec) {
      report.fail(
        "facts",
        doc,
        b.n,
        `${acct} is said to be keyless ("${claim[0]}"), and no deployment record or verify output says so`,
      );
    } else if (/no access keys/i.test(claim[0]) && !rec.zeroKeys) {
      report.fail(
        "facts",
        doc,
        b.n,
        `${acct} is said to have no access keys; ${rec.where} records only that it has no full-access key`,
      );
    }
  }
}

function factMcpTools(ctx, doc, model) {
  const { report, repo } = ctx;
  const server = "packages/mcp/src/server.ts";
  for (const b of model.blocks) {
    if (!/@probarion\/mcp|MCP server/.test(b.text)) continue;
    for (const m of b.text.matchAll(/\b(\w+) tools\b(?: \(([^)]*)\))?/g)) {
      const n = toNumber(m[1]);
      if (Number.isNaN(n)) continue;
      report.fact("MCP tools");
      if (!repo.isFile(server)) {
        report.fail("facts", doc, lineAt(b, m.index), `"${m[0]}": ${server} does not exist`);
        continue;
      }
      const tools = [...repo.read(server).matchAll(/registerTool\(\s*"([\w-]+)"/g)].map(
        (x) => x[1],
      );
      if (tools.length !== n) {
        report.fail(
          "facts",
          doc,
          lineAt(b, m.index),
          `"${m[1]} tools": ${server} registers ${tools.length} (${tools.join(", ")})`,
        );
      }
      if (m[2]) {
        const named = [...m[2].matchAll(/`([\w-]+)`/g)].map((x) => x[1]);
        const missing = tools.filter((t) => !named.includes(t));
        const extra = named.filter((t) => !tools.includes(t));
        if (missing.length || extra.length) {
          report.fail(
            "facts",
            doc,
            lineAt(b, m.index),
            `MCP tools: README lists ${named.join(", ")}; ${server} registers ${tools.join(", ")}`,
          );
        }
      }
    }
  }
}

function factExtension(ctx, doc, model) {
  const { report, repo } = ctx;
  const file = "apps/extension/scripts/manifest.mjs";
  for (const b of model.blocks) {
    if (!/extension/i.test(b.text)) continue;
    const src = repo.isFile(file) ? repo.read(file) : null;
    const perm = /asks for (\w+) permissions \(([^)]*)\)/.exec(b.text);
    if (perm) {
      report.fact("extension manifest");
      const listed = [
        ...(src?.match(/PERMISSIONS = Object\.freeze\(\[([^\]]*)\]/)?.[1] ?? "").matchAll(
          /"([^"]+)"/g,
        ),
      ].map((x) => x[1]);
      const named = [...perm[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
      if (toNumber(perm[1]) !== listed.length || named.join() !== listed.join()) {
        report.fail(
          "facts",
          doc,
          lineAt(b, perm.index),
          `"${perm[0]}": ${file} asks for ${listed.join(", ") || "nothing"}`,
        );
      }
      const hosts = /and Probarion's (\w+) addresses/.exec(b.text);
      if (hosts) {
        report.fact("extension manifest");
        const origins = [
          ...(src?.match(/PROD_ORIGINS = Object\.freeze\(\[([^\]]*)\]/)?.[1] ?? "").matchAll(
            /"([^"]+)"/g,
          ),
        ];
        if (toNumber(hosts[1]) !== origins.length) {
          report.fail(
            "facts",
            doc,
            lineAt(b, hosts.index),
            `"${hosts[0]}": ${file} lists ${origins.length} origins`,
          );
        }
      }
    }
    const chrome = /\bChrome (\d+) or newer/.exec(b.text);
    if (chrome) {
      report.fact("extension manifest");
      const min = src?.match(/minimum_chrome_version: "(\d+)"/)?.[1];
      if (min !== chrome[1]) {
        report.fail(
          "facts",
          doc,
          lineAt(b, chrome.index),
          `"${chrome[0]}": ${file} sets minimum_chrome_version ${min ?? "nowhere"}`,
        );
      }
    }
    for (const m of b.text.matchAll(/\bitem `([a-p]{32})`/g)) {
      report.fact("extension manifest");
      const store = "apps/extension/store/README.md";
      if (!repo.isFile(store) || !repo.read(store).includes(m[1])) {
        report.fail(
          "facts",
          doc,
          lineAt(b, m.index),
          `Chrome Web Store item ${m[1]} is not recorded in ${store}`,
        );
      }
      ctx.storeItems.push({
        id: m[1],
        pending: /pending Chrome Web Store review/.test(b.text),
        doc,
        line: lineAt(b, m.index),
      });
    }
  }
}

function factDocsPages(ctx, doc, model) {
  const { report, repo } = ctx;
  const base = "apps/web/content/docs";
  for (const b of model.blocks) {
    const m = /\b([\w,]+) pages in (\w+) sections\b/.exec(b.text);
    if (!m || !/\/docs|Docs Center/.test(b.text)) continue;
    report.fact("docs pages");
    const pages = repo.under(base).filter((f) => f.endsWith(".mdx")).length;
    const sections = new Set(
      repo
        .under(base)
        .map((f) => f.slice(base.length + 1).split("/"))
        .filter((p) => p.length > 1)
        .map((p) => p[0]),
    ).size;
    if (toNumber(m[1]) !== pages || toNumber(m[2]) !== sections) {
      report.fail(
        "facts",
        doc,
        lineAt(b, m.index),
        `"${m[0]}": ${base} has ${pages} .mdx pages in ${sections} folders`,
      );
    }
  }
}

function factThreatModel(ctx, doc, model) {
  const { report, repo } = ctx;
  const file = "docs/THREAT_MODEL.md";
  for (const b of model.blocks) {
    if (!b.text.includes("THREAT_MODEL.md")) continue;
    const m = /\((\w+)\s+attacks\b/.exec(b.text);
    if (!m) continue;
    report.fact("threat model");
    let rows = 0;
    if (repo.isFile(file)) {
      const tm = parseMarkdown(repo.read(file));
      const h = tm.headings.find((x) => x.text === "Attacks");
      const next = tm.headings.find((x) => h && x.n > h.n && x.level <= h.level);
      rows = tm.lines.filter(
        (l) => h && l.n > h.n && (!next || l.n < next.n) && /^\|\s*\d+\s*\|/.test(l.text),
      ).length;
    }
    if (toNumber(m[1]) !== rows) {
      report.fail(
        "facts",
        doc,
        lineAt(b, m.index),
        `"${m[1]} attacks": the Attacks table of ${file} has ${rows} rows`,
      );
    }
  }
}

function factMainnet(ctx, doc, model) {
  const { report, repo } = ctx;
  for (const b of model.blocks) {
    if (!/makes no\s+mainnet claim|hold no transactions/.test(b.text)) continue;
    report.fact("mainnet record");
    const txs = [];
    walkJson(repo.json("contracts/deployments/mainnet.json") ?? {}, (k, v) => {
      if (/(^|_)tx$/.test(k) && v !== null) txs.push(`contracts/deployments/mainnet.json ${k}`);
    });
    for (const [id, t] of Object.entries(repo.json("docs/mainnet-proof.json")?.txs ?? {})) {
      if (t?.network === "mainnet") txs.push(`docs/mainnet-proof.json txs.${id}`);
    }
    const links = ctx.cited.filter((c) => c.network === "mainnet");
    if (txs.length) {
      report.fail(
        "facts",
        doc,
        b.n,
        `the README says mainnet has no transactions, and ${txs.length} are recorded (${txs.slice(0, 3).join("; ")})`,
      );
    }
    if (links.length && /makes no\s+mainnet claim/.test(b.text)) {
      report.fail(
        "facts",
        doc,
        links[0].line,
        "the README says it makes no mainnet claim, and links a mainnet transaction",
      );
    }
  }
}

function factFactoryMode(ctx, doc, model) {
  const { report, repo } = ctx;
  const factory = repo.json("contracts/deployments/testnet.json")?.factory;
  for (const b of model.blocks) {
    const notGlobal =
      /global version (?:is |and a mainnet factory are )?not deployed|The global version waits/.exec(
        b.text,
      );
    if (notGlobal) {
      report.fact("factory mode");
      ctx.globalUnpublished = true;
      const global = (factory?.versions ?? []).filter((v) => v.mode !== "embedded");
      if (!factory || global.length) {
        report.fail(
          "facts",
          doc,
          lineAt(b, notGlobal.index),
          `"${notGlobal[0]}": contracts/deployments/testnet.json ${factory ? `records ${global.length} version(s) not embedded` : "has no factory"}`,
        );
      }
    }
    const one = /\bserves one version\b/.exec(b.text);
    if (one) {
      report.fact("factory mode");
      if ((factory?.versions ?? []).length !== 1) {
        report.fail(
          "facts",
          doc,
          lineAt(b, one.index),
          `"serves one version": contracts/deployments/testnet.json records ${(factory?.versions ?? []).length}`,
        );
      }
    }
    for (const m of b.text.matchAll(
      /Version (\d+): the vault build `([1-9A-HJ-NP-Za-km-z]{6,44})\u2026?`, (embedded|global)/g,
    )) {
      report.fact("factory mode");
      const v = (factory?.versions ?? []).find((x) => x.index === Number(m[1]));
      if (!v?.code_hash?.startsWith(m[2]) || v.mode !== m[3]) {
        report.fail(
          "facts",
          doc,
          lineAt(b, m.index),
          `"${m[0]}": contracts/deployments/testnet.json records ${v ? `${v.code_hash}, ${v.mode}` : "no such version"}`,
        );
      }
    }
  }
}

/** The README's sections: each heading with the blocks under it, up to the next heading. */
function sections(model) {
  const out = [];
  for (const b of model.blocks) {
    const key = b.section?.n ?? 0;
    if (!out.length || out[out.length - 1].key !== key)
      out.push({ key, heading: b.section, blocks: [] });
    out[out.length - 1].blocks.push(b);
  }
  return out;
}

function factEvidence(ctx, doc, model) {
  const { report, repo } = ctx;
  for (const s of sections(model)) {
    const linked = new Set();
    for (const b of s.blocks) {
      for (const l of extractLinks(b.text)) {
        const r = resolveTarget(doc, l.target);
        if (!r.error && r.path.startsWith("docs/evidence/")) linked.add(r.path);
      }
    }
    const verifyFiles = [...linked].filter((p) => /\/verify-[^/]+\.txt$/.test(p) && repo.isFile(p));
    const dirs = new Set([...linked].map((p) => (repo.isDir(p) ? p : posix.dirname(p))));
    const ledgers = [...dirs].flatMap((d) =>
      repo.under(d).filter((f) => /\/ledger-[^/]+\.jsonl$/.test(f)),
    );
    for (const b of s.blocks) {
      if (verifyFiles.length) {
        const outputs = verifyFiles.map((f) => repo.read(f));
        const any = (pred) => outputs.some(pred);
        for (const m of b.text.matchAll(
          /`(\d+ passed, \d+ failed, \d+ unproven|RESULT: [A-Z]+)`/g,
        )) {
          report.fact("evidence");
          if (!any((o) => o.includes(m[1]))) {
            report.fail(
              "facts",
              doc,
              lineAt(b, m.index),
              `"${m[1]}" is in none of ${verifyFiles.join(", ")}`,
            );
          }
        }
        for (const m of b.text.matchAll(/\b(passes|fails) checks? ([a-i])(?: to ([a-i]))?\b/g)) {
          report.fact("evidence");
          const want = m[1] === "passes" ? "PASS" : "FAIL";
          const from = m[2].charCodeAt(0);
          const to = (m[3] ?? m[2]).charCodeAt(0);
          for (let c = from; c <= to; c++) {
            const id = String.fromCharCode(c);
            const re = new RegExp(`^${id}\\s+\\S+\\s+${want}\\b`, "m");
            if (!any((o) => re.test(o))) {
              report.fail(
                "facts",
                doc,
                lineAt(b, m.index),
                `"${m[0]}": check ${id} is not ${want} in ${verifyFiles.join(", ")}`,
              );
            }
          }
        }
        for (const m of b.text.matchAll(
          /\b(?:the chain's|holds the|anchored the ledger) (\w+) (?:anchors|times)\b/g,
        )) {
          const n = toNumber(m[1]);
          if (Number.isNaN(n)) continue;
          report.fact("evidence");
          if (!any((o) => new RegExp(`^entries \\d+, anchors ${n}\\b`, "m").test(o))) {
            report.fail(
              "facts",
              doc,
              lineAt(b, m.index),
              `"${m[0]}": ${verifyFiles.join(", ")} reports another anchor count`,
            );
          }
        }
      }
      for (const m of b.text.matchAll(/rule `([\w.]+)`, ledger entry (\d+)/g)) {
        report.fact("evidence");
        const seq = Number(m[2]);
        const hit = ledgers.some((f) =>
          repo
            .read(f)
            .split("\n")
            .filter(Boolean)
            .some((line) => {
              try {
                const body = JSON.parse(line).body;
                return (
                  body?.seq === seq &&
                  (body.rules ?? []).some((r) => r.id === m[1] && r.outcome === "refuse")
                );
              } catch {
                return false;
              }
            }),
        );
        if (!hit) {
          report.fail(
            "facts",
            doc,
            lineAt(b, m.index),
            `"${m[0]}": no ledger in ${[...dirs].join(", ") || "the linked evidence"} has entry ${seq} refused by ${m[1]}`,
          );
        }
      }
    }
  }
}

function factSums(ctx, doc, model) {
  for (const b of model.blocks) {
    for (const m of b.text.matchAll(/\b([\d,]+) ([A-Z][\w]*) tests: ([^.]*(?:\.\d[^.]*)*)\./g)) {
      const parts = [...m[3].matchAll(/(?<![\w.@/-])(\d{1,3}(?:,\d{3})+|\d+)(?![\w.,]\d)/g)].map(
        (x) => toNumber(x[1]),
      );
      if (parts.length < 2) continue;
      ctx.report.fact("test sums");
      const sum = parts.reduce((a, x) => a + x, 0);
      if (sum !== toNumber(m[1])) {
        ctx.report.fail(
          "facts",
          doc,
          lineAt(b, m.index),
          `"${m[1]} ${m[2]} tests": the parts add up to ${sum}`,
        );
      }
    }
  }
}

function factGit(ctx, doc, model) {
  const { report, repo } = ctx;
  const text = model.blocks.map((b) => b.text).join("\n");
  const wants =
    /first commit (?:was made )?on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2}) UTC/.test(text) ||
    /Every commit other than a merge carries/.test(text) ||
    ctx.commits.some((c) => c.doc === doc);
  if (!wants) return;
  if (!repo.history()) {
    report.count("git facts skipped (no full git history)");
    return;
  }
  for (const b of model.blocks) {
    const first =
      /first commit(?:,| was made)? on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2}) UTC(, is empty)?/.exec(
        b.text,
      );
    if (first) {
      report.fact("git history");
      const roots = repo.gitOut(["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n");
      const at = roots.map((r) =>
        new Date(repo.gitOut(["show", "-s", "--format=%aI", r]).trim()).toISOString(),
      );
      const want = `${first[1]}T${first[2]}`;
      if (!at.some((x) => x.startsWith(want))) {
        report.fail(
          "facts",
          doc,
          lineAt(b, first.index),
          `first commit at ${first[1]} ${first[2]} UTC: git says ${at.join(", ")}`,
        );
      }
      if (first[3]) {
        const empty = roots.every(
          (r) => repo.gitOut(["ls-tree", "-r", "--name-only", r]).trim() === "",
        );
        if (!empty)
          report.fail(
            "facts",
            doc,
            lineAt(b, first.index),
            "the first commit is said to be empty, and it holds files",
          );
      }
    }
    const trailer = /Every commit other than a merge carries a `([^`]+)` trailer/.exec(b.text);
    if (trailer) {
      report.fact("git history");
      const log = repo.gitOut(["log", "--no-merges", "--format=%H%x00%B%x01", "HEAD"]);
      const missing = log
        .split("\x01")
        .map((x) => x.trim())
        .filter((x) => x && !x.toLowerCase().includes(trailer[1].toLowerCase()))
        .map((x) => x.slice(0, 12));
      if (missing.length) {
        report.fail(
          "facts",
          doc,
          lineAt(b, trailer.index),
          `${missing.length} commit(s) other than merges have no "${trailer[1]}" trailer: ${missing.slice(0, 5).join(", ")}`,
        );
      }
    }
  }
  for (const c of ctx.commits.filter((x) => x.doc === doc)) {
    report.fact("git history");
    try {
      repo.gitOut(["cat-file", "-e", `${c.sha}^{commit}`]);
    } catch {
      report.fail("facts", doc, c.line, `commit ${c.sha} is not in this repository's history`);
    }
  }
}

function factToc(ctx, doc, model) {
  const toc = model.headings.find((h) => h.level === 2 && h.text === "Contents");
  if (!toc) return;
  const next = model.headings.find((h) => h.n > toc.n && h.level <= 2);
  const listed = model.lines
    .filter((l) => l.kind === "text" && l.n > toc.n && (!next || l.n < next.n))
    .map((l) => /^\s*[-*]\s+\[[^\]]+\]\(#([^)]+)\)/.exec(l.text)?.[1])
    .filter(Boolean);
  const h2 = model.headings.filter((h) => h.level === 2 && h.n > toc.n).map((h) => h.slug);
  ctx.report.fact("contents");
  if (listed.join() !== h2.join()) {
    const missing = h2.filter((s) => !listed.includes(s));
    const extra = listed.filter((s) => !h2.includes(s));
    const detail =
      missing.length || extra.length
        ? `missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}`
        : "the order differs";
    ctx.report.fail(
      "facts",
      doc,
      toc.n,
      `Contents does not list the ## sections in order: ${detail}`,
    );
  }
}

/** The claim ids of the interfaces spec (section 17), and the line of each: `I1`-`I9` is nine ids. */
export function claimIds(repo) {
  const file = repo.files.find((f) => /^docs\/specs\/[^/]*interfaces[^/]*\.md$/.test(f));
  if (!file) return null;
  const md = parseMarkdown(repo.read(file));
  const h = md.headings.find((x) => /^17\.\s*Claim markers/i.test(x.text));
  if (!h) return null;
  const next = md.headings.find((x) => x.n > h.n && x.level <= h.level);
  const ids = new Map();
  for (const l of md.lines) {
    if (l.n <= h.n || (next && l.n >= next.n) || !/^\s*\|/.test(l.text)) continue;
    const first = tableCells(l.text)[0] ?? "";
    for (const m of first.matchAll(/`([A-Z][A-Z0-9-]*)`(?:\s*-\s*`([A-Z][A-Z0-9-]*)`)?/g)) {
      const a = /^(.*?)(\d+)$/.exec(m[1]);
      const z = m[2] && /^(.*?)(\d+)$/.exec(m[2]);
      if (a && z && a[1] === z[1]) {
        for (let i = Number(a[2]); i <= Number(z[2]); i++) ids.set(`${a[1]}${i}`, l.n);
      } else {
        ids.set(m[1], l.n);
        if (m[2]) ids.set(m[2], l.n);
      }
    }
  }
  return { file, ids };
}

const isMarkerSource = (f) =>
  /^(contracts|packages|apps|eval)\//.test(f) &&
  /\.(rs|ts|tsx|js|mjs|cjs|sql|sh|py|toml|ya?ml)$/.test(f);
// A scan reads about a thousand files; a test runs the checker many times over one checkout, so
// the scan of a root is kept unless the run edits one of those files in memory.
const markerScans = new Map();

/** Where each `probarion-claim: <ID>` comment is, in the dirs section 17 names: the code and its tests. */
function claimMarkers(repo) {
  const key = repo.overridden.some(isMarkerSource) ? null : repo.root;
  if (key !== null && markerScans.has(key)) return markerScans.get(key);
  const out = new Map();
  if (key !== null) markerScans.set(key, out);
  for (const f of repo.files.filter(isMarkerSource)) {
    const text = repo.read(f);
    if (!text.includes("probarion-claim:")) continue;
    for (const m of text.matchAll(/(?:\/\/|--|#|\*)\s*probarion-claim:\s*([A-Z][A-Z0-9-]*)/g)) {
      const line = text.slice(0, m.index).split("\n").length;
      if (!out.has(m[1])) out.set(m[1], []);
      out.get(m[1]).push({ file: f, line });
    }
  }
  return out;
}

/**
 * Interfaces section 17: each claim id has exactly one marker, and no marker names another id. A README
 * or AGENTS.md row that cites an id must link the file that holds its marker.
 */
function factMarkers(ctx, doc, model) {
  const { report, repo } = ctx;
  if (!ctx.claims) {
    const spec = claimIds(repo);
    ctx.claims = spec
      ? { ...spec, markers: claimMarkers(repo) }
      : { ids: new Map(), markers: new Map() };
    if (spec) {
      for (const [id, n] of spec.ids) {
        report.fact("claim markers");
        const at = ctx.claims.markers.get(id) ?? [];
        if (at.length === 0) {
          report.fail(
            "facts",
            spec.file,
            n,
            `claim ${id} has no "probarion-claim: ${id}" marker in the code or its tests`,
          );
        } else if (at.length > 1) {
          report.fail(
            "facts",
            spec.file,
            n,
            `claim ${id} has ${at.length} markers (${at.map((x) => `${x.file}:${x.line}`).join(", ")}); section 17 wants exactly one`,
          );
        }
      }
      for (const [id, at] of ctx.claims.markers) {
        if (!spec.ids.has(id)) {
          report.fail(
            "facts",
            at[0].file,
            at[0].line,
            `marker probarion-claim: ${id} names no claim id of ${spec.file} section 17`,
          );
        }
      }
    }
  }
  const { ids, markers } = ctx.claims;
  if (!ids.size) return;
  for (const b of model.blocks) {
    if (b.kind === "code") continue;
    const linked = extractLinks(b.text)
      .map((l) => l.target.trim())
      .filter((t) => t && !/^[a-z][a-z\d+.-]*:/i.test(t) && !t.startsWith("#"))
      .map((t) => resolveTarget(doc, t))
      .filter((r) => !r.error && r.path !== doc);
    for (const s of codeSpans(b.text)) {
      if (!ids.has(s.code)) continue;
      report.fact("claim markers");
      const at = markers.get(s.code) ?? [];
      const line = lineAt(b, s.index);
      if (at.length === 0) {
        report.fail(
          "facts",
          doc,
          line,
          `cites claim ${s.code}, which has no marker in the code or its tests`,
        );
      } else if (b.kind === "row" && linked.length) {
        const hit = at.some((x) =>
          linked.some((r) => x.file === r.path || x.file.startsWith(`${r.path}/`)),
        );
        if (!hit) {
          report.fail(
            "facts",
            doc,
            line,
            `cites claim ${s.code}; its marker is in ${at[0].file}, which the row does not link`,
          );
        }
      }
    }
  }
}

const FACTS = [
  factMarkers,
  factVersions,
  factNpm,
  factCodeHashes,
  factKeyless,
  factMcpTools,
  factExtension,
  factDocsPages,
  factThreatModel,
  factFactoryMode,
  factEvidence,
  factSums,
  factToc,
];

// ---------------------------------------------------------------------------------------------
// Online: public endpoints, read-only

const RPC = {
  testnet: ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"],
  mainnet: ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"],
};
const ARCHIVAL = {
  testnet: [
    "https://archival-rpc.testnet.fastnear.com",
    "https://archival-rpc.testnet.fastnear.com",
  ],
  mainnet: [
    "https://archival-rpc.mainnet.fastnear.com",
    "https://archival-rpc.mainnet.fastnear.com",
  ],
};

/** The time all online checks may take together; each request also has its own limit. */
const ONLINE_BUDGET_MS = 150_000;

class Unreachable extends Error {}

/** fetch with a time limit and one retry (on another host when given two). */
async function fetchRetry(urls, init, { timeoutMs = 12000, fetchImpl = fetch, deadline } = {}) {
  const list = Array.isArray(urls) ? urls : [urls, urls];
  let last;
  for (const url of list.slice(0, 2)) {
    if (deadline && Date.now() > deadline)
      throw new Unreachable("the online checks ran out of time");
    try {
      const res = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      return { res, text: await res.text(), url };
    } catch (e) {
      last = e;
    }
  }
  throw new Unreachable(`${list[0]}: ${last instanceof Error ? last.message : last}`);
}

async function rpcCall(ctx, urls, method, params) {
  const { text } = await fetchRetry(
    urls,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "check-claims", method, params }),
    },
    ctx.net,
  );
  try {
    return { reply: JSON.parse(text), text };
  } catch {
    throw new Unreachable(`${method}: the RPC answered something other than JSON`);
  }
}

async function onlineAccounts(ctx) {
  const { report, records } = ctx;
  const named = new Map();
  for (const doc of ctx.docs) {
    for (const b of doc.model.blocks) {
      for (const m of b.text.matchAll(ACCOUNT_TOKEN)) {
        const id = m[0];
        if (
          /^v0\.probarion\.testnet$|\.vaults\.probarion\.testnet$|^vaults\.probarion\.testnet$/.test(
            id,
          ) &&
          !named.has(id)
        ) {
          named.set(id, { doc: doc.name, line: lineAt(b, m.index) });
        }
      }
    }
  }
  const vaultHashes = new Set(
    [...records.codeHashes.values()]
      .filter((e) => e.crate === "probarion-vault")
      .map((e) => e.code_hash),
  );
  for (const [id, at] of named) {
    report.count("online accounts");
    const { reply } = await rpcCall(ctx, RPC.testnet, "query", {
      request_type: "view_account",
      finality: "final",
      account_id: id,
    });
    if (!reply.result) {
      report.fail(
        "online",
        at.doc,
        at.line,
        `${id} does not exist on testnet (${reply.error?.cause?.name ?? "no result"})`,
      );
      continue;
    }
    const recorded = records.accountCodeHash.get(id);
    const isVault = id !== "vaults.probarion.testnet";
    if (recorded && reply.result.code_hash !== recorded) {
      report.fail(
        "online",
        at.doc,
        at.line,
        `${id} runs code hash ${reply.result.code_hash}; the records say ${recorded}`,
      );
    } else if (!recorded && isVault && !vaultHashes.has(reply.result.code_hash)) {
      report.fail(
        "online",
        at.doc,
        at.line,
        `${id} runs code hash ${reply.result.code_hash}, which is not a recorded vault build`,
      );
    }
    if (isVault) {
      const keys = await rpcCall(ctx, RPC.testnet, "query", {
        request_type: "view_access_key_list",
        finality: "final",
        account_id: id,
      });
      const list = keys.reply.result?.keys ?? [];
      const full = list.filter((k) => k.access_key?.permission === "FullAccess");
      if (full.length)
        report.fail(
          "online",
          at.doc,
          at.line,
          `vault ${id} has a full-access key: ${full[0].public_key}`,
        );
      const rec = records.keyless.get(id);
      if (rec?.zeroKeys && list.length)
        report.fail(
          "online",
          at.doc,
          at.line,
          `${id} is recorded with no access keys and has ${list.length}`,
        );
      for (const k of list) {
        const p = k.access_key?.permission;
        const methods = p?.FunctionCall?.method_names ?? [];
        if (
          p !== "FullAccess" &&
          (p?.FunctionCall?.receiver_id !== id ||
            methods.length !== 1 ||
            !["spend", "anchor"].includes(methods[0]))
        ) {
          report.fail(
            "online",
            at.doc,
            at.line,
            `${id}: key ${k.public_key} is not a spend-only or anchor-only key on the vault`,
          );
        }
      }
    }
  }
  for (const c of ctx.chainComments) {
    report.count("online chain.mjs comments");
    if (c.cmd === "code-hash") {
      const { reply } = await rpcCall(ctx, RPC.testnet, "query", {
        request_type: "view_account",
        finality: "final",
        account_id: c.account,
      });
      if (reply.result?.code_hash !== c.expect) {
        report.fail(
          "online",
          c.doc,
          c.line,
          `chain.mjs code-hash ${c.account} prints ${reply.result?.code_hash ?? "an error"}, the comment says ${c.expect}`,
        );
      }
      continue;
    }
    const { reply } = await rpcCall(ctx, RPC.testnet, "query", {
      request_type: "view_access_key_list",
      finality: "final",
      account_id: c.account,
    });
    const keys = reply.result?.keys ?? [];
    if (c.cmd === "full-access-keys") {
      const full = keys.filter((k) => k.access_key?.permission === "FullAccess");
      if (/empty|no full-access/.test(c.expect) && full.length) {
        report.fail(
          "online",
          c.doc,
          c.line,
          `${c.account} has ${full.length} full-access key(s); the comment says none`,
        );
      }
    } else {
      const n = toNumber(/^(\w+)/.exec(c.expect)?.[1] ?? "");
      if (!Number.isNaN(n) && keys.length !== n) {
        report.fail(
          "online",
          c.doc,
          c.line,
          `${c.account} has ${keys.length} access key(s); the comment says ${n}`,
        );
      }
    }
  }
  if (ctx.globalUnpublished) {
    const factory = ctx.repo.json("contracts/deployments/testnet.json")?.factory;
    for (const v of factory?.versions ?? []) {
      report.count("online global code");
      const { reply } = await rpcCall(ctx, RPC.testnet, "query", {
        request_type: "view_global_contract_code",
        finality: "final",
        code_hash: v.code_hash,
      });
      if (reply.result) {
        report.fail(
          "online",
          "README.md",
          1,
          `the README says the global version is not deployed, and ${v.code_hash} is published as global code on testnet`,
        );
      } else if (reply.error?.cause?.name !== "NO_GLOBAL_CONTRACT_CODE") {
        throw new Unreachable(
          `view_global_contract_code: ${JSON.stringify(reply.error).slice(0, 200)}`,
        );
      }
    }
  }
}

/** Tokens in a "Transaction" table row that the chain must show: error codes, events, memos. */
function outcomeVocabulary(repo) {
  const words = new Set(["ft_transfer", "ft_burn", "mt_burn", "ft_withdraw", "ft_mint"]);
  if (repo.isFile("contracts/vault/src/errors.rs")) {
    const enumBody =
      /pub enum ErrorCode \{([\s\S]*?)\n\}/.exec(repo.read("contracts/vault/src/errors.rs"))?.[1] ??
      "";
    for (const m of enumBody.matchAll(/^\s+([A-Z][A-Za-z]+),/gm)) words.add(m[1]);
  }
  if (repo.isFile("contracts/vault/src/events.rs")) {
    const enumBody =
      /pub enum VaultEvent \{([\s\S]*?)\n\}/.exec(
        repo.read("contracts/vault/src/events.rs"),
      )?.[1] ?? "";
    for (const m of enumBody.matchAll(/^ {4}([A-Z][A-Za-z]+)\b/gm)) words.add(camelToSnake(m[1]));
  }
  return words;
}

async function onlineTxs(ctx) {
  const { report, records, repo } = ctx;
  const vocab = outcomeVocabulary(repo);
  const known = new Set([...records.accounts.testnet.keys(), ...records.accounts.mainnet.keys()]);
  const seen = new Map();
  for (const c of ctx.cited) {
    const key = `${c.network}:${c.hash}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(c);
  }
  const results = new Map();
  for (const [key, uses] of seen) {
    const { network, hash } = uses[0];
    report.count("online txs");
    let sender = records.signerOf.get(hash);
    let readmeSender = null;
    for (const u of uses) {
      if (!u.code) continue;
      const doc = ctx.docs.find((d) => d.name === u.doc);
      const fenceStart = doc.model.lines.find((l) => l.n === u.line)?.fenceStart;
      const fence = doc.model.lines
        .filter((l) => l.fenceStart === fenceStart)
        .map((l) => l.text)
        .join("\n");
      readmeSender = /sender_account_id\\?":\\?"([a-z\d_.-]+)/.exec(fence)?.[1] ?? readmeSender;
    }
    sender = sender ?? readmeSender ?? (network === "testnet" ? "probarion.testnet" : "near");
    const { reply, text } = await rpcCall(ctx, ARCHIVAL[network], "EXPERIMENTAL_tx_status", {
      tx_hash: hash,
      sender_account_id: sender,
      wait_until: "NONE",
    });
    const at = uses[0];
    const t = reply.result?.transaction;
    if (!t || t.hash !== hash) {
      report.fail(
        "online",
        at.doc,
        at.line,
        `${network} tx ${hash} was not found (${reply.error?.cause?.name ?? reply.error?.name ?? "no result"})`,
      );
      continue;
    }
    results.set(key, text);
    const expect = records.signerOf.get(hash) ?? readmeSender;
    const methods = (t.actions ?? []).map((a) => a.FunctionCall?.method_name).filter(Boolean);
    if (expect && t.signer_id !== expect) {
      report.fail(
        "online",
        at.doc,
        at.line,
        `tx ${hash} was signed by ${t.signer_id}, not ${expect}`,
      );
    } else if (methods.includes("spend") && t.signer_id !== t.receiver_id) {
      report.fail(
        "online",
        at.doc,
        at.line,
        `spend ${hash} was signed by ${t.signer_id}, not by the vault's own agent key (${t.receiver_id})`,
      );
    } else if (!known.has(t.signer_id)) {
      report.fail(
        "online",
        at.doc,
        at.line,
        `tx ${hash} was signed by ${t.signer_id}, an account the records do not name`,
      );
    }
    // The README's own `tx <hash> | grep -o '<re>' | sort -u   # <expected>` lines.
    for (const u of uses.filter((x) => x.code)) {
      const g = /grep -o '([^']+)'.*#\s*(\S+)/.exec(u.block.text);
      if (!g) continue;
      report.count("online grep lines");
      const found = [...new Set([...text.matchAll(new RegExp(g[1], "g"))].map((x) => x[0]))].sort();
      if (found.length === 0) {
        report.fail("online", u.doc, u.line, `grep -o '${g[1]}' finds nothing in tx ${hash}`);
      } else if (new RegExp(`^(?:${g[1]})$`).test(g[2]) && found.join(" ") !== g[2]) {
        report.fail(
          "online",
          u.doc,
          u.line,
          `grep -o '${g[1]}' prints ${found.join(" ")}; the comment says ${g[2]}`,
        );
      }
    }
  }
  // The outcome each "Transaction" table row claims.
  for (const doc of ctx.docs) {
    let header = null;
    let prev = -1;
    for (const b of doc.model.blocks) {
      const adjacent = b.n === prev + 1;
      prev = b.n;
      if (b.kind !== "row") {
        header = null;
        continue;
      }
      if (!header || !adjacent) {
        header = tableCells(b.text);
        continue;
      }
      if (isDelimiterRow(b.text) || !header.some((h) => /^transactions?$/i.test(h))) continue;
      const txs = extractLinks(b.text)
        .map((l) => explorerTx(l.target))
        .filter(Boolean);
      const texts = txs.map((x) => results.get(`${x.network}:${x.hash}`)).filter(Boolean);
      if (!texts.length) continue;
      for (const s of codeSpans(b.text)) {
        const token = s.code;
        const known2 =
          /^PROBARION:[A-Za-z]+$/.test(token) ||
          /^WITHDRAW_TO:0x[0-9a-fA-F]{40}$/.test(token) ||
          vocab.has(token);
        if (!known2) continue;
        report.count("online outcomes");
        if (!texts.some((x) => x.includes(token))) {
          report.fail(
            "online",
            doc.name,
            lineAt(b, s.index),
            `${token} is not in the result of ${txs.map((x) => x.hash.slice(0, 8)).join(", ")}`,
          );
        }
      }
    }
  }
}

async function onlineHttp(ctx) {
  const { report } = ctx;
  const readme = ctx.docs.find((d) => d.name === "README.md");
  if (readme && /probarion\.xyz/.test(readme.text)) {
    report.count("online http");
    const { res, text } = await fetchRetry("https://probarion.xyz/api/health", {}, ctx.net);
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // reported below
    }
    const wantTestnet = /run at\s+\[probarion\.xyz\]\(https:\/\/probarion\.xyz\) on testnet/.test(
      readme.text.replace(/\n/g, " "),
    );
    if (res.status !== 200 || body?.ok !== true) {
      report.fail(
        "online",
        "README.md",
        1,
        `https://probarion.xyz/api/health answered ${res.status} ${text.slice(0, 120)}`,
      );
    } else if (wantTestnet && body.network !== "testnet") {
      report.fail(
        "online",
        "README.md",
        1,
        `probarion.xyz is said to run on testnet; /api/health says ${body.network}`,
      );
    }
  }
  const src = ctx.repo.isFile("apps/extension/scripts/manifest.mjs")
    ? ctx.repo.read("apps/extension/scripts/manifest.mjs")
    : "";
  const description = /DESCRIPTION =\s*"([^"]{20,})/.exec(src)?.[1]?.slice(0, 40) ?? null;
  for (const item of ctx.storeItems) {
    report.count("online http");
    const { res, text, url } = await fetchRetry(
      `https://chromewebstore.google.com/detail/${item.id}`,
      {},
      ctx.net,
    );
    // The store answers 200 for any id; an item that is not public redirects to an "empty-title" page.
    const live =
      res.status === 200 &&
      !/\/empty-title\//.test(res.url || url) &&
      (!description || text.includes(description));
    if (item.pending && live) {
      report.fail(
        "online",
        item.doc,
        item.line,
        `the README says item ${item.id} is pending Chrome Web Store review, and its listing is live: ${res.url || url}`,
      );
    } else if (!item.pending && !live) {
      report.fail(
        "online",
        item.doc,
        item.line,
        `Chrome Web Store item ${item.id} has no public listing`,
      );
    }
  }
  const npm = async (name) => {
    const { res, text } = await fetchRetry(
      `https://registry.npmjs.org/${name.replace("/", "%2f")}`,
      {},
      ctx.net,
    );
    if (res.status === 404) return [];
    return Object.keys(JSON.parse(text).versions ?? {});
  };
  const cache = new Map();
  for (const c of ctx.npmClaims) {
    report.count("online npm");
    if (!cache.has(c.name)) cache.set(c.name, await npm(c.name));
    if (!cache.get(c.name).includes(c.version)) {
      report.fail("online", c.doc, c.line, `npm has no ${c.name}@${c.version}`);
    }
  }
  for (const c of ctx.notOnNpm) {
    report.count("online npm");
    if (!cache.has(c.name)) cache.set(c.name, await npm(c.name));
    if (cache.get(c.name).length) {
      report.fail(
        "online",
        c.doc,
        c.line,
        `the README says ${c.name} is not on npm yet; npm has ${cache.get(c.name).join(", ")}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Running it

/**
 * Runs every check over a checkout. Returns { problems, unreachable, counts, facts }; a problem is
 * { check, file, line, message }.
 */
export async function checkClaims({
  root = DEFAULT_ROOT,
  online = false,
  net = {},
  overrides = {},
} = {}) {
  const repo = loadRepo(root, overrides);
  const report = new Report();
  const ctx = {
    repo,
    report,
    records: loadRecords(repo),
    packages: loadPackages(repo),
    net: { deadline: Date.now() + ONLINE_BUDGET_MS, ...net },
    docs: [],
    cited: [],
    commits: [],
    chainComments: [],
    npmClaims: [],
    notOnNpm: [],
    storeItems: [],
    globalUnpublished: false,
  };
  if (!repo.isFile("README.md")) {
    report.fail("links", "README.md", 1, "there is no README.md");
    return report;
  }
  const linkDocs = [
    ...CLAIM_DOCS,
    ...LINK_ONLY_DOCS,
    ...repo.under("docs/evidence").filter((f) => f.endsWith(".md")),
  ].filter((f) => repo.isFile(f));
  for (const name of linkDocs) {
    const text = repo.read(name);
    const model = parseMarkdown(text);
    checkLinks(ctx, name, model);
    if (CLAIM_DOCS.includes(name)) ctx.docs.push({ name, text, model });
  }
  for (const { name, model } of ctx.docs) {
    checkHashes(ctx, name, model);
    checkAccounts(ctx, name, model);
    checkPaths(ctx, name, model);
    if (name === "README.md") checkStatus(ctx, name, model);
  }
  for (const { name, model } of ctx.docs) {
    for (const fact of FACTS) fact(ctx, name, model);
  }
  for (const { name, model } of ctx.docs) {
    factMainnet(ctx, name, model);
    factGit(ctx, name, model);
  }
  if (online) {
    for (const step of [onlineAccounts, onlineTxs, onlineHttp]) {
      try {
        await step(ctx);
      } catch (e) {
        if (e instanceof Unreachable || e?.name === "TimeoutError" || e instanceof TypeError) {
          report.unreachable.push(`${step.name}: ${e.message}`);
        } else {
          throw e;
        }
      }
    }
  }
  return report;
}

function summary(report, online) {
  const c = (k) => report.counts.get(k) ?? 0;
  const d = (k) => report.distinct.get(k)?.size ?? 0;
  const facts = [...report.facts.values()].reduce((a, x) => a + x, 0);
  const parts = [
    `${c("links")} links (${c("anchors")} anchors)`,
    `${d("tx hashes")} tx hashes`,
    `${d("accounts")} accounts`,
    `${c("status rows")} status rows`,
    `${c("paths") + c("pnpm commands") + c("script commands") + c("grep lines")} paths and commands`,
    `${facts} facts`,
  ];
  if (online) {
    const o = [
      "online accounts",
      "online chain.mjs comments",
      "online txs",
      "online grep lines",
      "online outcomes",
      "online global code",
      "online http",
      "online npm",
    ]
      .map(c)
      .reduce((a, x) => a + x, 0);
    parts.push(`${o} online checks`);
  }
  return parts.join(", ");
}

export async function main(argv) {
  const online = argv.includes("--online");
  const verbose = argv.includes("--verbose");
  const ri = argv.indexOf("--root");
  const root = ri >= 0 ? resolve(argv[ri + 1] ?? ".") : DEFAULT_ROOT;
  const unknown = argv.filter(
    (a, i) =>
      a.startsWith("-") &&
      !["--online", "--verbose", "--root"].includes(a) &&
      argv[i - 1] !== "--root",
  );
  if (unknown.length) {
    console.error(
      `check-claims: unknown option ${unknown[0]} (use --online, --verbose, --root DIR)`,
    );
    return 2;
  }
  const report = await checkClaims({ root, online });
  if (verbose) {
    for (const [k, v] of report.counts) console.log(`  ${k}: ${v}`);
    for (const [k, v] of report.facts) console.log(`  fact ${k}: ${v}`);
  }
  for (const p of report.problems) console.log(`${p.file}:${p.line} [${p.check}] ${p.message}`);
  for (const u of report.unreachable) console.log(`unchecked [online] ${u}`);
  const mode = online ? "offline and online" : "offline";
  if (report.problems.length) {
    console.log(
      `check-claims: ${report.problems.length} claim(s) do not match (${summary(report, online)}; ${mode})`,
    );
    return 1;
  }
  if (report.unreachable.length) {
    console.log(
      `check-claims: ${report.unreachable.length} online check(s) could not run; the rest passed (${summary(report, online)})`,
    );
    return 2;
  }
  console.log(`check-claims: ok. ${summary(report, online)} (${mode})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`check-claims: ${e instanceof Error ? e.stack : e}`);
      process.exitCode = 2;
    },
  );
}
