import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

// The community files GitHub shows on the repository page: the pull request template, the issue
// forms, CONTRIBUTING.md, CODE_OF_CONDUCT.md and the social preview image.

const repoRoot = new URL("../", import.meta.url);
const inRepo = (path) => new URL(path, repoRoot);
const read = (path) => readFileSync(inRepo(path), "utf8").replace(/\r\n/g, "\n");

// ---------- a strict reader for the YAML the issue forms are written in ----------
//
// No YAML parser is a root devDependency, so this reads the subset the forms use and refuses
// everything else, naming the line: block mappings and lists indented by two spaces, plain, quoted
// and literal (|) scalars, flow lists of simple scalars, and whole-line comments. No tabs, no
// trailing spaces, no anchors, tags, folded scalars, flow mappings or trailing comments.

const isMap = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function parseYamlSubset(text) {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((raw, i) => ({ raw, n: i + 1 }));
  const fail = (line, message) => {
    throw new Error(`line ${line.n}: ${message}`);
  };
  for (const line of lines) {
    if (line.raw.includes("\t")) fail(line, "a tab");
    if (/\s$/.test(line.raw)) fail(line, "trailing whitespace");
  }
  const indentOf = (line) => line.raw.length - line.raw.trimStart().length;
  const skippable = (line) => line.raw === "" || /^\s*#/.test(line.raw);
  let pos = 0;
  const peek = () => {
    while (pos < lines.length && skippable(lines[pos])) pos++;
    return lines[pos];
  };

  function scalar(text, line) {
    if (text.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"$/.test(text)) {
        fail(line, "a malformed double-quoted string");
      }
      return JSON.parse(text);
    }
    if (text.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(text)) fail(line, "a malformed single-quoted string");
      return text.slice(1, -1).replace(/''/g, "'");
    }
    if (text.startsWith("[")) {
      const inner = /^\[(.*)\]$/.exec(text)?.[1];
      if (inner === undefined) fail(line, "a malformed flow list");
      if (inner.trim() === "") return [];
      return inner.split(",").map((item) => {
        const t = item.trim();
        if (!/^("[^"\\]*"|[\w./@-]+)$/.test(t))
          fail(line, `a flow list item that is not simple: ${t}`);
        return t.startsWith('"') ? t.slice(1, -1) : t;
      });
    }
    if (/^[-?:,\]{}#&*!|>%@`]/.test(text)) {
      fail(line, `a plain value that starts with a YAML indicator; quote it: ${text}`);
    }
    if (/: |:$| #/.test(text))
      fail(line, `a plain value with ": " or " #" in it; quote it: ${text}`);
    if (text === "true") return true;
    if (text === "false") return false;
    if (/^(null|~|yes|no|on|off|y|n)$/i.test(text) || /^[-+]?\.?\d/.test(text)) {
      fail(line, `an ambiguous plain value; quote it: ${text}`);
    }
    return text;
  }

  // The lines after a "key: |", indented deeper than the key, as text with one newline at the end.
  function literal(keyIndent, line) {
    const body = [];
    while (pos < lines.length && (lines[pos].raw === "" || indentOf(lines[pos]) > keyIndent)) {
      body.push(lines[pos].raw);
      pos++;
    }
    while (body.length > 0 && body.at(-1) === "") body.pop();
    if (body.length === 0) fail(line, "an empty literal block");
    const cut = Math.min(
      ...body.filter((l) => l !== "").map((l) => l.length - l.trimStart().length),
    );
    return `${body.map((l) => l.slice(cut)).join("\n")}\n`;
  }

  function value(rest, keyIndent, line) {
    if (rest === undefined) {
      const next = peek();
      if (!next || indentOf(next) <= keyIndent) fail(line, "a key with no value");
      if (indentOf(next) !== keyIndent + 2) {
        fail(next, "indentation that is not two spaces deeper than its key");
      }
      return block(keyIndent + 2);
    }
    if (rest === "|") return literal(keyIndent, line);
    return scalar(rest, line);
  }

  function block(indent) {
    return /^\s*-( |$)/.test(peek().raw) ? sequence(indent) : mapping(indent);
  }

  // A mapping whose keys stand at `indent`. `first` is set when it starts on a "- " line.
  function mapping(indent, first) {
    const out = {};
    const entry = (text, line) => {
      const m = /^([A-Za-z_][\w-]*):(?: (.+))?$/.exec(text);
      if (!m) fail(line, `expected "key: value", found: ${text}`);
      if (Object.hasOwn(out, m[1])) fail(line, `a duplicate key "${m[1]}"`);
      out[m[1]] = value(m[2], indent, line);
    };
    if (first) {
      pos++;
      entry(first.text, first.line);
    }
    for (let line = peek(); line && indentOf(line) >= indent; line = peek()) {
      if (indentOf(line) > indent) fail(line, "unexpected indentation");
      if (/^\s*-( |$)/.test(line.raw)) fail(line, "a list item where a key was expected");
      pos++;
      entry(line.raw.slice(indent), line);
    }
    return out;
  }

  function sequence(indent) {
    const out = [];
    for (let line = peek(); line && indentOf(line) >= indent; line = peek()) {
      if (indentOf(line) > indent) fail(line, "unexpected indentation");
      const text = /^\s*- (.+)$/.exec(line.raw)?.[1];
      if (text === undefined) fail(line, "a key or an empty item where a list item was expected");
      if (/^[A-Za-z_][\w-]*:( |$)/.test(text)) {
        out.push(mapping(indent + 2, { text, line }));
      } else {
        pos++;
        out.push(scalar(text, line));
      }
    }
    return out;
  }

  const start = peek();
  if (!start) throw new Error("an empty file");
  if (indentOf(start) !== 0) fail(start, "the first key must not be indented");
  const doc = mapping(0);
  const rest = peek();
  if (rest) fail(rest, "content after the top-level mapping");
  return doc;
}

// ---------- the issue forms ----------

const FIELD_TYPES = ["markdown", "input", "textarea", "dropdown", "checkboxes"];
const FORM_KEYS = [
  "name",
  "description",
  "title",
  "labels",
  "assignees",
  "projects",
  "type",
  "body",
];

/** Every way an issue form differs from what GitHub accepts; the empty list means none. */
function issueFormProblems(text) {
  let form;
  try {
    form = parseYamlSubset(text);
  } catch (error) {
    return [`not YAML this check reads: ${error.message}`];
  }
  const problems = [];
  const fail = (message) => problems.push(message);
  for (const key of Object.keys(form)) {
    if (!FORM_KEYS.includes(key)) fail(`an unknown top-level key "${key}"`);
  }
  for (const key of ["name", "description"]) {
    if (typeof form[key] !== "string" || form[key].trim() === "") {
      fail(`"${key}" must be a non-empty string`);
    }
  }
  if (!Array.isArray(form.body) || form.body.length === 0) {
    fail('"body" must be a non-empty list');
    return problems;
  }
  const ids = new Set();
  let fields = 0;
  for (const [i, item] of form.body.entries()) {
    const at = `body[${i}]`;
    if (!isMap(item) || !FIELD_TYPES.includes(item.type)) {
      fail(`${at}: "type" must be one of ${FIELD_TYPES.join(", ")}`);
      continue;
    }
    const attrs = item.attributes;
    if (!isMap(attrs)) {
      fail(`${at}: "attributes" must be a mapping`);
      continue;
    }
    if (item.type === "markdown") {
      if (typeof attrs.value !== "string" || attrs.value.trim() === "") {
        fail(`${at}: a markdown block needs attributes.value`);
      }
      continue;
    }
    fields++;
    if (typeof item.id !== "string" || !/^[a-z0-9_-]+$/.test(item.id)) {
      fail(`${at}: "id" must be lower-case letters, digits, - or _`);
    } else if (ids.has(item.id)) {
      fail(`${at}: a duplicate id "${item.id}"`);
    } else {
      ids.add(item.id);
    }
    if (typeof attrs.label !== "string" || attrs.label.trim() === "") {
      fail(`${at}: attributes.label is required`);
    }
    if (
      item.type === "dropdown" &&
      (!Array.isArray(attrs.options) ||
        attrs.options.length === 0 ||
        attrs.options.some((o) => typeof o !== "string" || o === ""))
    ) {
      fail(`${at}: a dropdown needs a list of options`);
    }
    if (
      item.validations !== undefined &&
      (!isMap(item.validations) || typeof item.validations.required !== "boolean")
    ) {
      fail(`${at}: validations.required must be true or false`);
    }
  }
  if (fields === 0) fail("a form needs at least one field besides markdown");
  return problems;
}

const FORMS = [
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/feature.yml",
  ".github/ISSUE_TEMPLATE/pilot.yml",
  ".github/ISSUE_TEMPLATE/report-payee.yml",
];

test("the YAML reader returns what YAML means for the subset it reads", () => {
  const sample = [
    "# a comment",
    "name: Bug report",
    'title: "Bug: "',
    'labels: ["bug", docs]',
    "body:",
    "  - type: markdown",
    "    attributes:",
    "      value: |",
    "        **Bold** line",
    "",
    "          indented: kept",
    "  - type: dropdown",
    "    id: network",
    "    attributes:",
    "      options:",
    "        - testnet",
    "        - 'it''s'",
    "    validations:",
    "      required: true",
    "",
  ].join("\n");
  assert.deepEqual(parseYamlSubset(sample), {
    name: "Bug report",
    title: "Bug: ",
    labels: ["bug", "docs"],
    body: [
      { type: "markdown", attributes: { value: "**Bold** line\n\n  indented: kept\n" } },
      {
        type: "dropdown",
        id: "network",
        attributes: { options: ["testnet", "it's"] },
        validations: { required: true },
      },
    ],
  });
});

test("each issue form parses and has a name, a description and a body GitHub accepts", () => {
  for (const path of FORMS) {
    assert.deepEqual(issueFormProblems(read(path)), [], path);
  }
});

// Each edit of bug.yml is a mistake that would break the form on GitHub, or change what it means.
const formMutations = [
  ["a tab for indentation", (t) => t.replace("    id: version", "\tid: version"), "a tab"],
  [
    "three-space indentation",
    (t) => t.replace("    id: version", "     id: version"),
    "indentation",
  ],
  ["no name", (t) => t.replace(/^name: .*\n/, ""), '"name" must be a non-empty string'],
  ["no description", (t) => t.replace(/^description: .*\n/m, ""), '"description"'],
  ["no body", (t) => t.slice(0, t.indexOf("body:")), '"body" must be a non-empty list'],
  [
    "an unquoted value with a colon",
    (t) => t.replace("label: Vault account", "label: Vault: account"),
    "quote it: Vault: account",
  ],
  [
    "a value that a # would cut short",
    (t) => t.replace("label: What you expected", "label: What you expected #1"),
    '" #"',
  ],
  ["a duplicate id", (t) => t.replace("id: expected", "id: version"), 'a duplicate id "version"'],
  ["a field without a label", (t) => t.replace("      label: Network\n", ""), "attributes.label"],
  [
    "a dropdown without options",
    (t) => t.replace(/ {6}options:\n( {8}- .*\n)+/, ""),
    "a dropdown needs a list of options",
  ],
  [
    "an unknown field type",
    (t) => t.replace("type: textarea", "type: text"),
    '"type" must be one of',
  ],
  [
    "an unknown top-level key",
    (t) => t.replace("body:", "template: x\nbody:"),
    'unknown top-level key "template"',
  ],
  [
    "a duplicate key",
    (t) => t.replace('labels: ["bug"]', 'labels: ["bug"]\nlabels: ["x"]'),
    "a duplicate key",
  ],
  [
    "trailing whitespace",
    (t) => t.replace("label: Network", "label: Network "),
    "trailing whitespace",
  ],
  [
    "required as a string",
    (t) => t.replace("required: true", 'required: "yes"'),
    "validations.required",
  ],
  ["a folded scalar", (t) => t.replace("value: |", "value: >"), "indicator"],
];

for (const [name, mutate, reason] of formMutations) {
  test(`the issue form check refuses: ${name}`, () => {
    const bug = read(".github/ISSUE_TEMPLATE/bug.yml");
    const mutated = mutate(bug);
    assert.notEqual(mutated, bug, `the mutation "${name}" changed nothing`);
    const problems = issueFormProblems(mutated);
    assert.ok(
      problems.some((p) => p.includes(reason)),
      `"${name}" not refused for "${reason}": ${problems.join(" | ")}`,
    );
  });
}

test("the bug form asks for the commit, the network, the vault, what happened and the verifier output, and warns about keys", () => {
  const form = parseYamlSubset(read(".github/ISSUE_TEMPLATE/bug.yml"));
  const field = (id) => form.body.find((item) => item.id === id);
  assert.match(field("version").attributes.label, /version or commit/i);
  assert.equal(field("version").validations.required, true);
  assert.deepEqual(field("network").attributes.options.slice(0, 2), ["testnet", "mainnet"]);
  assert.match(field("vault").attributes.label, /vault account/i);
  assert.equal(field("what-happened").validations.required, true);
  assert.equal(field("expected").validations.required, true);
  assert.match(field("verify-output").attributes.description, /probarion verify --json/);
  assert.equal(field("verify-output").attributes.render, "json");
  const warning = form.body[0];
  assert.equal(warning.type, "markdown");
  assert.match(warning.attributes.value, /Never paste a private key/);
  assert.match(warning.attributes.value, /SECURITY\.md/);
});

test("config.yml turns blank issues off and links the private report and the X account", () => {
  const config = parseYamlSubset(read(".github/ISSUE_TEMPLATE/config.yml"));
  assert.deepEqual(Object.keys(config), ["blank_issues_enabled", "contact_links"]);
  assert.equal(config.blank_issues_enabled, false);
  for (const link of config.contact_links) {
    assert.deepEqual(Object.keys(link), ["name", "url", "about"]);
    assert.match(link.url, /^https:\/\//);
    assert.ok(link.about.length > 0 && link.about.length <= 200, `about too long: ${link.name}`);
  }
  const [security, x] = config.contact_links;
  assert.equal(security.name, "Report a vulnerability privately");
  assert.equal(security.url, "https://github.com/probarion/probarion/security/advisories/new");
  assert.equal(x.url, "https://x.com/probarionhq");
  // The wording offers only what SECURITY.md offers: the X DM and the GitHub form, which is on (2026-11-09).
  const policy = read("SECURITY.md");
  assert.match(policy, /\[@probarionhq\]\(https:\/\/x\.com\/probarionhq\)/);
  assert.ok(
    policy.includes(`[**Security → Report a vulnerability**](${security.url})`),
    "SECURITY.md links the private advisory form",
  );
  assert.doesNotMatch(policy, /switched on/);
  assert.match(security.about, /SECURITY\.md/);
  assert.match(security.about, /@probarionhq/);
  assert.match(security.about, /use this private form/);
  assert.doesNotMatch(security.about, /switched on/);
});

// ---------- the pull request template ----------

const PR_SECTIONS = [
  "Summary",
  "Why",
  "What changed",
  "Safety",
  "Tests",
  "Docs",
  "Review",
  "Checklist",
];

test("the pull request template has every section, in order, and the six checklist items", () => {
  const template = read(".github/PULL_REQUEST_TEMPLATE.md");
  const headings = [...template.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, PR_SECTIONS);
  const items = template.split("\n").filter((l) => l.startsWith("- [ ] "));
  const expected = [
    "One focused change",
    "`pnpm verify` passes",
    "`contracts/code-hashes.json`",
    "No secrets, keys or local paths",
    "no task ids",
    "the OWNER signs every mainnet transaction",
  ];
  assert.equal(items.length, expected.length);
  for (const [i, phrase] of expected.entries()) {
    assert.ok(items[i].includes(phrase), `item ${i + 1}: ${phrase}`);
  }
  assert.match(template, /none" and the reason/);
  assert.match(template, /If there was no review, say so plainly/);
});

// ---------- CONTRIBUTING.md and CODE_OF_CONDUCT.md ----------

/** The text inside the code spans and fenced code blocks of a Markdown file. */
function codeIn(markdown) {
  const fenced = [...markdown.matchAll(/^```\w*\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
  const inline = [...markdown.replace(/^```[\s\S]*?^```$/gm, "").matchAll(/`([^`\n]+)`/g)].map(
    (m) => m[1],
  );
  return [...fenced, ...inline];
}

/** A GitHub heading anchor: lower case, punctuation dropped, spaces as hyphens. */
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s/g, "-");

/** Every relative link of a Markdown file that names a missing file or heading. */
function brokenLinks(path) {
  const broken = [];
  for (const [, target] of read(path).matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [file, anchor] = target.split("#");
    if (file && !existsSync(inRepo(file))) {
      broken.push(target);
      continue;
    }
    if (anchor && file.endsWith(".md")) {
      const anchors = [...read(file).matchAll(/^#+ (.+)$/gm)].map((m) => slug(m[1]));
      if (!anchors.includes(anchor)) broken.push(target);
    }
  }
  return broken;
}

test("every pnpm command in CONTRIBUTING.md is a root script", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  const commands = codeIn(read("CONTRIBUTING.md"))
    .flatMap((code) => code.split("\n"))
    .map((line) => /^pnpm (?:run )?([\w:-]+)/.exec(line.trim())?.[1])
    .filter(Boolean);
  assert.ok(commands.includes("verify") && commands.includes("verify:ts"), commands.join(", "));
  const builtIn = ["install"];
  for (const command of commands) {
    assert.ok(builtIn.includes(command) || Object.hasOwn(scripts, command), `pnpm ${command}`);
  }
});

test("CONTRIBUTING.md states the toolchain the repository pins", () => {
  const contributing = read("CONTRIBUTING.md");
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.engines.node, ">=24");
  assert.equal(manifest.engines.pnpm, ">=10 <11");
  assert.equal(read(".nvmrc").trim(), "24");
  assert.match(read("rust-toolchain.toml"), /^channel = "1\.99\.1"$/m);
  assert.match(contributing, /Node\.js 24/);
  assert.match(contributing, /pnpm 10/);
  assert.match(contributing, /Rust 1\.99\.1/);
  // Releases come from main, through the release workflow it names.
  assert.match(read(".github/workflows/release.yml"), /tags: \["sdk-v\*"\]/);
  assert.match(contributing, /`sdk-v\*` tag/);
});

test("the community files link only files and headings that exist", () => {
  for (const path of [
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "SECURITY.md",
  ]) {
    assert.deepEqual(brokenLinks(path), [], path);
  }
});

test("CODE_OF_CONDUCT.md is short, names Contributor Covenant 2.1 and says how to report", () => {
  const conduct = read("CODE_OF_CONDUCT.md");
  assert.ok(conduct.trim().split("\n").length <= 20, "keep it to about 15 lines");
  assert.match(
    conduct,
    /\[Contributor Covenant, version 2\.1\]\(https:\/\/www\.contributor-covenant\.org\/version\/2\/1\/code_of_conduct\/\)/,
  );
  assert.match(conduct, /direct message to \[@probarionhq\]\(https:\/\/x\.com\/probarionhq\)/);
});

// ---------- the social preview ----------

test("docs/assets/social-preview.png is exactly 1280 x 640 and under GitHub's 1 MB limit", () => {
  const path = "docs/assets/social-preview.png";
  const png = readFileSync(inRepo(path));
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert.deepEqual([...png.subarray(0, 8)], signature, "not a PNG");
  assert.equal(png.toString("latin1", 12, 16), "IHDR");
  assert.equal(png.readUInt32BE(16), 1280, "width");
  assert.equal(png.readUInt32BE(20), 640, "height");
  assert.ok(statSync(inRepo(path)).size < 1024 * 1024, "GitHub takes a social preview under 1 MB");
  const svg = read("docs/assets/social-preview.svg");
  assert.match(
    svg,
    /^<svg role="img" aria-label="[^"]+" [^>]*width="1280" height="640" viewBox="0 0 1280 640"><title>/,
  );
});
