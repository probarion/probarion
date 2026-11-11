// Tests for scripts/check-claims.mjs: the helpers, a small fake repository with one defect at a
// time, and the real repository (as checked out, then with one claim edited in memory).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  base58Length,
  checkClaims,
  extractLinks,
  githubSlug,
  isHash32,
  main,
  parseMarkdown,
  toNumber,
  versionMatches,
} from "./check-claims.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TX1 = "3DFV2thBU9V4b5w7kM691poLJ8SWiCqp46LKBn1Fy9cX";
const TX2 = "AkjyVPmb6LdMES7ykpzJQR7EXXGvw3kYH6Nhem9YdzgY";
const UNRECORDED = "4715d4nbYn6cq981nmLU5y8efCoX2w3SbgW8PPq4Vsr1";

const problems = (report) =>
  report.problems.map((p) => `${p.file}:${p.line} [${p.check}] ${p.message}`);

// ---------------------------------------------------------------------------------------------
// Helpers

test("githubSlug makes GitHub's heading anchors", () => {
  assert.equal(
    githubSlug("How to evaluate Probarion in 5 minutes"),
    "how-to-evaluate-probarion-in-5-minutes",
  );
  assert.equal(githubSlug("NEAR technology used, and how"), "near-technology-used-and-how");
  assert.equal(githubSlug("3.5 Both networks in one project"), "35-both-networks-in-one-project");
  assert.equal(githubSlug("The `set_ledger_key` fix"), "the-set_ledger_key-fix");
  assert.equal(githubSlug("Verify & trust"), "verify--trust");
  assert.equal(
    githubSlug("Agent key's allowance nearly used up"),
    "agent-keys-allowance-nearly-used-up",
  );
  assert.equal(githubSlug("**Bold** [link](x.md)"), "bold-link");
  // Underscore emphasis renders as plain text; underscores inside a word or in code stay.
  assert.equal(githubSlug("_Italic_ heading"), "italic-heading");
  assert.equal(githubSlug("__Bold__ and *it*"), "bold-and-it");
  assert.equal(githubSlug("KEY_ENCRYPTION_SECRET rotation"), "key_encryption_secret-rotation");
  assert.equal(githubSlug("The `__init__` hook"), "the-__init__-hook");
});

test("runs as a script through a symlinked or junction path too, not as a silent pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-claims-link-"));
  try {
    const link = join(dir, "scripts");
    symlinkSync(join(ROOT, "scripts"), link, process.platform === "win32" ? "junction" : "dir");
    const r = spawnSync(process.execPath, [join(link, "check-claims.mjs"), "--bogus"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /unknown option --bogus/);
  } finally {
    // Removes the link, not what it points at.
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseMarkdown numbers duplicate headings like GitHub and skips fenced code", () => {
  const md = parseMarkdown("# A\n\n## Setup\n\n```bash\n# not a heading\n```\n\n## Setup\n");
  assert.deepEqual(
    md.headings.map((h) => h.slug),
    ["a", "setup", "setup-1"],
  );
  assert.equal(md.blocks.find((b) => b.kind === "code")?.text, "# not a heading");
});

test("parseMarkdown reads CRLF text the same as LF", () => {
  const lf = "# T\n\nOne line\nand the next.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.deepEqual(parseMarkdown(crlf).blocks, parseMarkdown(lf).blocks);
});

test("extractLinks finds Markdown links, images, HTML src/href and links whose text is code", () => {
  const links = extractLinks(
    '[![CI](https://img/x.svg)](https://ci) [`a.md`](docs/a.md#top) <img src="b.png"> `[not](a-link)`',
  ).map((l) => l.target);
  assert.deepEqual(links, ["https://ci", "docs/a.md#top", "b.png"]);
});

test("base58Length and isHash32 accept only 32-byte base58 values", () => {
  assert.equal(base58Length(TX1), 32);
  assert.equal(isHash32(TX1), true);
  assert.equal(isHash32(`${TX1.slice(0, -1)}0`), false, "0 is not base58");
  assert.equal(isHash32(TX1.slice(0, 30)), false);
  assert.equal(isHash32("11111111111111111111111111111111"), true, "32 zero bytes");
});

test("versionMatches compares the README's version with the leading part of a pin", () => {
  assert.equal(versionMatches("16", "^16.4.2"), true);
  assert.equal(versionMatches("4.6", "4.6.0"), true);
  assert.equal(versionMatches("0.11.4", "0.11.4"), true);
  assert.equal(versionMatches("5.29.1", "=5.29.1"), true);
  assert.equal(versionMatches("1.32", "^1.32.2"), true);
  assert.equal(versionMatches("1.3", "^1.32.2"), false);
  assert.equal(versionMatches("15", "^14.0.0"), false);
});

test("toNumber reads digits, thousands and number words", () => {
  assert.equal(toNumber("eleven"), 11);
  assert.equal(toNumber("Five"), 5);
  assert.equal(toNumber("10,767"), 10767);
  assert.equal(toNumber("34"), 34);
  assert.ok(Number.isNaN(toNumber("several")));
});

// ---------------------------------------------------------------------------------------------
// A small fake repository: one defect at a time

const FIXTURE_README = `# Demo

## Contents

- [Status](#status)
- [Proof](#proof)

## Status

| Component | Status | Where |
| --- | --- | --- |
| Vault | **Shipped on NEAR testnet** as \`v0.demo.testnet\` | [\`contracts/vault\`](contracts/vault) |
| Guide | **Built** | [\`docs/guide.md\`](docs/guide.md) |
| Mainnet | **Planned** | [\`docs\`](docs) |

## Proof

Read [the setup](docs/guide.md#setup), [its second line](docs/guide.md#L2) and \`docs/guide.md\`.
Run \`pnpm verify\`.

| What | Transaction | Result |
| --- | --- | --- |
| The agent key called \`spend\` | [\`3DFV2thB\u2026Fy9cX\`](https://testnet.nearblocks.io/txns/${TX1}) | paid |

The vault is [\`v0.demo.testnet\`](https://testnet.nearblocks.io/address/v0.demo.testnet).
`;

const FIXTURE = {
  "README.md": FIXTURE_README,
  "docs/guide.md": "# Guide\n\n## Setup\n\nInstall it.\n",
  "contracts/vault/src/lib.rs": "// the vault\n",
  "package.json": JSON.stringify({ name: "demo", scripts: { verify: "true" } }),
  "contracts/deployments/testnet.json": JSON.stringify({
    network: "testnet",
    accounts: { vault_v0: "v0.demo.testnet" },
    smoke: { near_payment_tx: TX1, no_mandate_tx: TX2 },
  }),
};

describe("a fake repository", () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "check-claims-"));
    for (const [path, text] of Object.entries(FIXTURE)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const run = async (readme) =>
    problems(
      await checkClaims({ root, overrides: readme === undefined ? {} : { "README.md": readme } }),
    );
  const runWith = async (overrides) => problems(await checkClaims({ root, overrides }));
  const edit = (from, to) => {
    assert.ok(FIXTURE_README.includes(from), `the fixture has ${from}`);
    return FIXTURE_README.replace(from, to);
  };

  test("passes as written, with LF or CRLF line ends", async () => {
    assert.deepEqual(await run(), []);
    assert.deepEqual(await run(FIXTURE_README.replace(/\n/g, "\r\n")), []);
    const report = await checkClaims({ root });
    assert.equal(report.counts.get("links"), 7);
    assert.equal(report.counts.get("tx hashes"), 1);
    assert.equal(report.counts.get("status rows"), 3);
  });

  test("a README with a broken link, a bad hash and a missing marker path fails on exactly those", async () => {
    const readme = FIXTURE_README.replace("(docs/guide.md#L2)", "(docs/gude.md)")
      .replace(`txns/${TX1}`, `txns/${TX1.slice(0, -1)}0`)
      .replace("[`docs/guide.md`](docs/guide.md) |", "[`docs/old.md`](docs/old.md) |");
    const got = await run(readme);
    assert.deepEqual(
      got.map((p) => p.replace(/^README\.md:\d+ /, "")),
      [
        "[links] link docs/old.md: docs/old.md is not a file of the repository",
        "[links] link docs/gude.md: docs/gude.md is not a file of the repository",
        `[hashes] ${TX1.slice(0, -1)}0 is not a NEAR tx hash (32 bytes in base58)`,
        '[status] "Built" row points at no path of the repository',
      ],
    );
    assert.match(got[0], /^README\.md:13 /);
    assert.match(got[3], /^README\.md:13 /);
  });

  test("an anchor must be a heading of the target, a line anchor a line it has", async () => {
    assert.deepEqual(await run(edit("guide.md#setup)", "guide.md#install)")), [
      "README.md:18 [links] link docs/guide.md#install: docs/guide.md has no heading whose anchor is #install",
    ]);
    assert.deepEqual(await run(edit("#L2)", "#L4-L9)")), [
      "README.md:18 [links] link docs/guide.md#L4-L9: docs/guide.md has 5 lines",
    ]);
    assert.deepEqual(await run(edit("- [Proof](#proof)", "- [Proof](#proofs)")), [
      "README.md:6 [links] link #proofs: README.md has no heading whose anchor is #proofs",
      "README.md:3 [facts] Contents does not list the ## sections in order: missing proof; extra proofs",
    ]);
  });

  test("a path's case must match, as it does on GitHub", async () => {
    const got = await run(edit("(docs/guide.md#setup)", "(Docs/Guide.md#setup)"));
    assert.deepEqual(got, [
      "README.md:18 [links] link Docs/Guide.md#setup: Docs/Guide.md is not a file of the repository",
    ]);
  });

  test("a tx hash must be recorded, on the network its link names", async () => {
    assert.deepEqual(await run(edit(`txns/${TX1}`, `txns/${UNRECORDED}`)), [
      `README.md:23 [hashes] testnet tx ${UNRECORDED} is not recorded in contracts/deployments/testnet.json, docs/mainnet-proof.json or docs/evidence`,
      `README.md:23 [hashes] link text 3DFV2thB\u2026Fy9cX does not match its hash ${UNRECORDED}`,
    ]);
    assert.deepEqual(
      await run(edit("https://testnet.nearblocks.io/txns/", "https://nearblocks.io/txns/")),
      [
        `README.md:23 [hashes] mainnet tx ${TX1} is not recorded in contracts/deployments/mainnet.json or docs/mainnet-proof.json; it is recorded on testnet only`,
      ],
    );
  });

  test("any other 32-byte base58 value must be a recorded transaction or code hash", async () => {
    assert.deepEqual(
      await run(
        edit("Run `pnpm verify`.", `Run \`pnpm verify\`. Then ${TX2}, then ${UNRECORDED}.`),
      ),
      [
        `README.md:19 [hashes] ${UNRECORDED} is neither a recorded transaction nor a code hash in contracts/code-hashes.json`,
      ],
    );
  });

  test("an explorer account must be of the link's network and recorded", async () => {
    assert.deepEqual(await run(edit("address/v0.demo.testnet", "address/v1.demo.testnet")), [
      "README.md:25 [accounts] testnet account v1.demo.testnet is not in contracts/deployments or docs/evidence",
      "README.md:25 [accounts] link text v0.demo.testnet is not its account v1.demo.testnet",
    ]);
    assert.deepEqual(
      await run(edit("https://testnet.nearblocks.io/address/", "https://nearblocks.io/address/")),
      [
        "README.md:25 [accounts] v0.demo.testnet is linked on the mainnet explorer",
        "README.md:25 [accounts] mainnet account v0.demo.testnet is not in contracts/deployments or docs/evidence",
      ],
    );
  });

  test("a status row needs a known bold marker, and a network row a record", async () => {
    assert.deepEqual(await run(edit("**Built**", "**Done**")), [
      'README.md:13 [status] unknown status marker "Done"',
    ]);
    assert.deepEqual(await run(edit("**Built**", "Built")), [
      "README.md:13 [status] the Status cell does not start with a bold marker",
    ]);
    assert.deepEqual(
      await run(edit("as `v0.demo.testnet`", "as `v9.demo.testnet`")),
      [
        "[accounts] testnet account v9.demo.testnet is not in contracts/deployments or docs/evidence",
        '[status] "Shipped on NEAR testnet" row cites no recorded testnet account, tx or evidence',
      ].map((m) => `README.md:12 ${m}`),
    );
    assert.deepEqual(
      await run(
        edit("| **Planned** |", `| **Planned** [tx](https://testnet.nearblocks.io/txns/${TX2}) |`),
      ),
      ['README.md:14 [status] "Planned" row links a transaction'],
    );
  });

  test("a row on NEAR mainnet needs a mainnet record: testnet evidence is not one", async () => {
    const evidence = {
      "docs/evidence/demo/README.md": `# Demo\n\n[\`3DFV2thB\u2026\`](https://testnet.nearblocks.io/txns/${TX1})\n`,
    };
    const row = (marker) =>
      edit("| Guide | **Built** |", `| Guide | **${marker}**, [evidence](docs/evidence/demo) |`);
    assert.deepEqual(await runWith({ "README.md": row("Live on NEAR testnet"), ...evidence }), []);
    assert.deepEqual(await runWith({ "README.md": row("Live on NEAR mainnet"), ...evidence }), [
      'README.md:13 [status] "Live on NEAR mainnet" row cites no recorded mainnet account, tx or evidence',
    ]);
  });

  test("a README that makes no mainnet claim has no Status row on NEAR mainnet", async () => {
    const mainnet = {
      "contracts/deployments/mainnet.json": JSON.stringify({
        network: "mainnet",
        accounts: { vault_v0: "v0.demo.near" },
      }),
    };
    const readme = edit("| **Planned** |", "| **Live on NEAR mainnet** as `v0.demo.near` |");
    assert.deepEqual(await runWith({ "README.md": readme, ...mainnet }), []);
    const claimless = readme.replace(
      "Run `pnpm verify`.",
      "Run `pnpm verify`. This README makes no mainnet claim.",
    );
    assert.deepEqual(await runWith({ "README.md": claimless, ...mainnet }), [
      'README.md:14 [facts] the README says it makes no mainnet claim, and its Status row is marked "Live on NEAR mainnet"',
    ]);
  });

  test("an account in inline code must be recorded, like one in an explorer link", async () => {
    assert.deepEqual(
      await run(edit("The vault is [", "The approver is `approver.demo.testnet`. The vault is [")),
      [
        "README.md:25 [accounts] testnet account approver.demo.testnet is not in contracts/deployments or docs/evidence",
      ],
    );
  });

  test("a link text that names a repository path names its own target", async () => {
    assert.deepEqual(
      await run(edit("[`docs/guide.md`](docs/guide.md) |", "[`docs/guides.md`](docs/guide.md) |")),
      ["README.md:13 [links] link text docs/guides.md names another path than docs/guide.md"],
    );
    assert.deepEqual(
      await run(
        edit("[`contracts/vault`](contracts/vault)", "[`contracts/vaults`](contracts/vault)"),
      ),
      ["README.md:12 [links] link text contracts/vaults names another path than contracts/vault"],
    );
  });

  test("an anchor is matched after percent-decoding, as GitHub does", async () => {
    const guide = "# Guide\n\n## Setup\n\nInstall it.\n\n## \u00dcber uns\n\n## _Italic_ heading\n";
    const links =
      "Run `pnpm verify`. See [a](docs/guide.md#%C3%BCber-uns), [b](docs/guide.md#\u00fcber-uns) and [c](docs/guide.md#italic-heading).";
    assert.deepEqual(
      await runWith({
        "README.md": edit("Run `pnpm verify`.", links),
        "docs/guide.md": guide,
      }),
      [],
    );
    assert.deepEqual(
      await run(edit("Run `pnpm verify`.", "Run `pnpm verify`. See [a](docs/guide.md#%E0%A4%A).")),
      ["README.md:19 [links] link docs/guide.md#%E0%A4%A is not a valid URL escape"],
    );
  });

  test("evidence records a tx only where it says so, not a block hash or a cut hex digest", async () => {
    const BLOCK = "8aceRZeBsVZ4URvpRotyhWMXdpAUzcKCeAm8oSu2ZEGG";
    const HEX = "a77febaed98dd2b6923778a57a83d8293d1244e51bb0fcf6483bc65d233e19bf";
    const HEX43 = HEX.slice(0, 43);
    assert.ok(isHash32(BLOCK) && isHash32(HEX43), "both look like 32-byte base58 values");
    const evidence = {
      "docs/evidence/demo/ledger.jsonl": [
        JSON.stringify({ note: `FullAccess at final block 276915992 ${BLOCK}` }),
        JSON.stringify({ link: HEX }),
        JSON.stringify({ contract: { code: null, tx_hash: UNRECORDED } }),
      ].join("\n"),
    };
    const readme = edit(
      "Run `pnpm verify`.",
      `Run \`pnpm verify\`. Then ${UNRECORDED}, ${BLOCK} and [this](https://testnet.nearblocks.io/txns/${HEX43}).`,
    );
    assert.deepEqual(await runWith({ "README.md": readme, ...evidence }), [
      `README.md:19 [hashes] testnet tx ${HEX43} is not recorded in contracts/deployments/testnet.json, docs/mainnet-proof.json or docs/evidence`,
      `README.md:19 [hashes] ${BLOCK} is neither a recorded transaction nor a code hash in contracts/code-hashes.json`,
    ]);
  });

  test("a path in code must exist, and a pnpm script must be in package.json", async () => {
    assert.deepEqual(await run(edit("and `docs/guide.md`.", "and `docs/guides.md`.")), [
      "README.md:18 [paths] docs/guides.md does not exist in the repository",
    ]);
    assert.deepEqual(await run(edit("Run `pnpm verify`.", "Run `pnpm verify:all`.")), [
      "README.md:19 [paths] pnpm verify:all: the root package.json has no such script",
    ]);
  });

  test("main prints one ok line and exits 0, or the problems and exits 1", async () => {
    const lines = [];
    const log = console.log;
    console.log = (s) => lines.push(String(s));
    try {
      assert.equal(await main(["--root", root]), 0);
      assert.equal(lines.length, 1);
      assert.match(
        lines[0],
        /^check-claims: ok\. 7 links \(4 anchors\), 1 tx hashes, 1 accounts, 3 status rows, \d+ paths and commands, \d+ facts \(offline\)$/,
      );
      writeFileSync(
        join(root, "README.md"),
        FIXTURE_README.replace("(docs/guide.md#L2)", "(docs/gude.md)"),
      );
      lines.length = 0;
      assert.equal(await main(["--root", root]), 1);
      assert.match(lines[0], /^README\.md:18 \[links\] link docs\/gude\.md/);
      assert.match(lines.at(-1), /^check-claims: 1 claim\(s\) do not match/);
      assert.equal(await main(["--root", root, "--bogus"]), 2);
    } finally {
      console.log = log;
      writeFileSync(join(root, "README.md"), FIXTURE_README);
    }
  });

  test("a quoted summary line has the shape main() prints, with <n> for each count", async () => {
    const SHAPE =
      "check-claims: ok. <n> links (<n> anchors), <n> tx hashes, <n> accounts, <n> status rows, <n> paths and commands, <n> facts";
    const quoting = (line) => `${FIXTURE_README}\nIts last line:\n\n\`\`\`text\n${line}\n\`\`\`\n`;
    const report = await checkClaims({
      root,
      overrides: { "README.md": quoting(`${SHAPE} (offline)`) },
    });
    assert.deepEqual(problems(report), []);
    assert.equal(report.facts.get("summary line"), 1);
    // The online line has one more count, and an indented copy (in a list item) is read the same.
    assert.deepEqual(await run(quoting(`   ${SHAPE}, <n> online checks (offline and online)`)), []);
    const wrong = (line) =>
      `README.md:30 [facts] the quoted summary line is not the shape the checker prints (a <n> for each count, which changes with the README): ${line}`;
    // Counts go stale as the README changes, so a line with today's numbers is refused.
    assert.deepEqual(
      await run(quoting(SHAPE.replace("<n> links", "279 links").concat(" (offline)"))),
      [wrong(`${SHAPE} (offline)`)],
    );
    assert.deepEqual(
      await run(quoting(SHAPE.replace("tx hashes", "hashes").concat(" (offline)"))),
      [wrong(`${SHAPE} (offline)`)],
    );
    assert.deepEqual(await run(quoting(`${SHAPE} (offline and online)`)), [
      wrong(`${SHAPE}, <n> online checks (offline and online)`),
    ]);
  });

  test("git-history claims in a copy without full history: the ok line says they went unchecked", async () => {
    const lines = [];
    const log = console.log;
    console.log = (s) => lines.push(String(s));
    try {
      // The fixture is not a git checkout, so it has no history to check the trailer claim against.
      writeFileSync(
        join(root, "README.md"),
        FIXTURE_README.replace(
          "Run `pnpm verify`.",
          "Run `pnpm verify`. Every commit other than a merge carries a `Co-Authored-By: Claude` trailer.",
        ),
      );
      assert.equal(await main(["--root", root]), 0);
      assert.equal(lines.length, 1);
      assert.match(
        lines[0],
        /^check-claims: ok\. .*, \d+ facts, git history claims unchecked \(no full history\) \(offline\)$/,
      );
      // A README that makes no git-history claim has nothing to skip, and says nothing about it.
      writeFileSync(join(root, "README.md"), FIXTURE_README);
      lines.length = 0;
      assert.equal(await main(["--root", root]), 0);
      assert.doesNotMatch(lines[0], /git history/);
    } finally {
      console.log = log;
      writeFileSync(join(root, "README.md"), FIXTURE_README);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Claim markers (interfaces section 17) and the names that code-only link texts give

describe("claim markers and link names", () => {
  const SPEC = "docs/specs/2026-01-01-demo-interfaces.md";
  const README = [
    "# M",
    "",
    "| Claim | Test |",
    "| --- | --- |",
    "| A changed proof fails (`V-TAMPER`) | [`verify.test.ts`](packages/core/test/verify.test.ts) |",
    "",
    "See [`decide()`](packages/core/src/policy.ts#L1-L3) and [`policy.ts`](packages/core/src/policy.ts).",
    "",
    "## Status",
    "",
    "| Part | Status | Where |",
    "| --- | --- | --- |",
    "| Core | **Built** | [`packages/core`](packages/core) |",
    "",
  ].join("\n");
  const FILES = {
    "README.md": README,
    [SPEC]: [
      "# Interfaces",
      "",
      "## 17. Claim markers",
      "",
      "| IDs | Owner |",
      "|---|---|",
      "| `I1`-`I3`, `V-TAMPER` | plan 02 |",
      "",
      "## 18. Next",
      "",
      "| `NOT-A-CLAIM` | x |",
      "",
    ].join("\n"),
    "contracts/vault/tests/inv.rs":
      "// probarion-claim: I1\nfn a() {}\n// probarion-claim: I2\nfn b() {}\n// probarion-claim: I3\nfn c() {}\n",
    "packages/core/test/verify.test.ts": "// probarion-claim: V-TAMPER\ntest('x', () => {});\n",
    "packages/core/src/policy.ts": "export function decide() {\n  return 1;\n}\n",
  };
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "check-claims-markers-"));
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const run = async (overrides = {}) => problems(await checkClaims({ root, overrides }));
  const readme = (from, to) => {
    assert.ok(README.includes(from), `the fixture has ${from}`);
    return { "README.md": README.replace(from, to) };
  };

  test("passes as written, and reads `I1`-`I3` as three ids", async () => {
    assert.deepEqual(await run(), []);
    const report = await checkClaims({ root });
    // Four ids of section 17, and the one the README row cites.
    assert.equal(report.facts.get("claim markers"), 5);
    assert.equal(report.counts.get("link symbols"), 1);
  });

  test("each claim id has exactly one marker, and each marker a claim id", async () => {
    assert.deepEqual(
      await run({
        "contracts/vault/tests/inv.rs": "// probarion-claim: I1\n// probarion-claim: I2\n",
      }),
      [`${SPEC}:7 [facts] claim I3 has no "probarion-claim: I3" marker in the code or its tests`],
    );
    assert.deepEqual(
      await run({
        "packages/core/src/policy.ts":
          "// probarion-claim: V-TAMPER\nexport function decide() {\n}\n",
      }),
      [
        `${SPEC}:7 [facts] claim V-TAMPER has 2 markers (packages/core/src/policy.ts:1, packages/core/test/verify.test.ts:1); section 17 wants exactly one`,
      ],
    );
    assert.deepEqual(
      await run({
        "packages/core/src/policy.ts": "export function decide() {\n  -- probarion-claim: I9\n}\n",
      }),
      [
        `packages/core/src/policy.ts:2 [facts] marker probarion-claim: I9 names no claim id of ${SPEC} section 17`,
      ],
    );
  });

  test("a row that cites a claim id links the file that holds its marker", async () => {
    assert.deepEqual(
      await run(
        readme(
          "[`verify.test.ts`](packages/core/test/verify.test.ts)",
          "[`policy.ts`](packages/core/src/policy.ts)",
        ),
      ),
      [
        "README.md:5 [facts] cites claim V-TAMPER; its marker is in packages/core/test/verify.test.ts, which the row does not link",
      ],
    );
    assert.deepEqual(await run(readme("(`V-TAMPER`)", "(`V-TAMPER`, `ATTEST`)")), []);
  });

  test("a code-only link text is the file's name, or a symbol in the lines it links", async () => {
    assert.deepEqual(await run(readme("[`verify.test.ts`](packages", "[`verify.ts`](packages")), [
      "README.md:5 [links] link text verify.ts is not the name of packages/core/test/verify.test.ts",
    ]);
    assert.deepEqual(await run(readme("[`decide()`]", "[`judge()`]")), [
      "README.md:7 [links] link text judge(): lines 1 to 3 of packages/core/src/policy.ts has no judge",
    ]);
    assert.deepEqual(await run(readme("policy.ts#L1-L3", "policy.ts#L2-L3")), [
      "README.md:7 [links] link text decide(): lines 2 to 3 of packages/core/src/policy.ts has no decide",
    ]);
    assert.deepEqual(await run(readme("[`decide()`]", "[`policy.decide`]")), []);
  });
});

// ---------------------------------------------------------------------------------------------
// The real repository

// Claims that are wrong today, each to be fixed where it is written (not here). The test allows
// these and nothing else, so the fix can land in any order: once it has, delete the entry. Empty:
// every claim the checker reads checks out.
const KNOWN_PROBLEMS = [];
const isKnown = (p) => KNOWN_PROBLEMS.some((k) => p.endsWith(k));
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("the real repository", () => {
  let report;
  before(async () => {
    report = await checkClaims({ root: ROOT });
  });

  const readme = readFileSync(join(ROOT, "README.md"), "utf8").replace(/\r\n/g, "\n");
  const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8").replace(/\r\n/g, "\n");
  const json = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

  test("passes offline, but for any claim KNOWN_PROBLEMS lists for a fix where it is written", () => {
    assert.deepEqual(
      problems(report).filter((p) => !isKnown(p)),
      [],
    );
  });

  test("covers every kind of check the README gives it something for", () => {
    for (const k of [
      "links",
      "anchors",
      "tx hashes",
      "accounts",
      "status rows",
      "paths",
      "pnpm commands",
    ]) {
      assert.ok((report.counts.get(k) ?? 0) > 0, `no ${k} were checked`);
    }
    // Each fact check, and a looser phrase that says the README still makes that kind of claim.
    // A claim reworded so that its check no longer reads it fails here: update the check. A claim
    // the README no longer makes (the mainnet sentence, once mainnet runs) needs no check.
    const facts = {
      versions: /\bnear-sdk \d|\bNode(?:\.js)? \d/,
      "npm versions": /\bon npm as `|\b[Rr]elease \d+\.\d+\.\d+/,
      "code hashes": /\bcode[ _]hash/i,
      "keyless vaults": /no full-access key|no access keys/i,
      "MCP tools": /\b(?:@probarion\/mcp|MCP server)\b[^\n]*\b\w+ tools\b/,
      "extension manifest": /\bChrome \d+ or newer|\basks for \w+ permissions|\bitem `[a-p]{32}`/,
      "docs pages": /\b[\w,]+ pages in \w+ sections\b/,
      "threat model": /THREAT_MODEL\.md[^\n]*\(\w+\s+attacks|\(\w+\s+attacks/,
      "factory mode": /\bserves \w+ versions?\b|\bglobal version\b|\bVersion \d+: the vault build/,
      evidence: /`\d+ passed, \d+ failed, \d+ unproven`|\bledger entry \d+/,
      "test sums": /\b[\d,]+ [A-Z]\w* tests: /,
      contents: /^## Contents$/m,
      "mainnet record": /makes no\s+mainnet claim|hold no transactions/,
      "claim markers": /^/,
      "summary line": /^\s*check-claims: ok\b/m,
    };
    for (const [f, said] of Object.entries(facts)) {
      if (!said.test(`${readme}\n${agents}`)) continue;
      assert.ok((report.facts.get(f) ?? 0) > 0, `fact check "${f}" matched nothing`);
    }
    // A shallow local clone may skip the git-history claims; CI checks out the full history
    // (fetch-depth: 0, pinned by scripts/ci-workflow.test.mjs), so there they are checked.
    const skipped = report.counts.has("git facts skipped (no full git history)");
    if (process.env.GITHUB_ACTIONS === "true") {
      assert.ok(!skipped, "CI checked out a shallow clone: the git-history claims went unchecked");
    }
    if (!skipped) {
      assert.ok((report.facts.get("git history") ?? 0) > 0, "no git history fact was checked");
    }
  });

  /** Runs the checker with one change and returns the problems not already known. */
  const withChange = async (overrides) =>
    problems(await checkClaims({ root: ROOT, overrides })).filter((p) => !isKnown(p));

  // Each case finds today's claim by a pattern, not by its exact words, so a correct README update
  // does not fail CI: when the README no longer makes the claim at all, the case is skipped.
  const statusSection = (() => {
    const s = readme.search(/^## Status$/m);
    if (s < 0) return [0, 0];
    const next = readme.slice(s + 1).search(/^## /m);
    return [s, next < 0 ? readme.length : s + 1 + next];
  })();
  /** The README text from the heading above `at` to the next heading: a section of factEvidence. */
  const sectionOf = (at) => {
    const from = readme.lastIndexOf("\n#", at);
    const next = readme.indexOf("\n#", at);
    return readme.slice(Math.max(from, 0), next < 0 ? readme.length : next);
  };
  const lineOf = (at) => readme.slice(readme.lastIndexOf("\n", at) + 1, readme.indexOf("\n", at));
  /**
   * The first match of `re` (one that `ok` accepts, in the Status section when `status`), with the
   * span of its group `group`: the part a case changes.
   */
  const findClaim = (re, { status = false, ok = () => true, group = 1 } = {}) => {
    const [from, to] = status ? statusSection : [0, readme.length];
    const flags = [...new Set(`${re.flags}dg`)].join("");
    for (const m of readme.slice(from, to).matchAll(new RegExp(re.source, flags))) {
      const at = from + m.index;
      if (!ok(m, at)) continue;
      const [a, z] = m.indices[group];
      return { m, at, start: from + a, end: from + z, value: m[group] };
    }
    return null;
  };
  // A case's `to` gives the new text of the matched group, and `expect` the problem it must cause;
  // both get the hit: { value, m, at, to }.
  const bumpLast = ({ value }) => value.replace(/\d+$/, (d) => String(Number(d) + 1));
  const plusOne = ({ value }) => String(toNumber(value) + 1);
  const isCount = (m) => !Number.isNaN(toNumber(m[1]));
  const inVerifiedSection = (at) => /verify-[^)\s]*\.txt\)/.test(sectionOf(at));
  const codeHashes = json("contracts/code-hashes.json").entries.map((e) => e.code_hash);

  const cases = [
    {
      what: "a toolchain version",
      re: /\bnear-sdk (\d+\.\d+\.\d+)/,
      to: bumpLast,
      expect: ({ to }) => new RegExp(`near-sdk ${esc(to)}": contracts/Cargo\\.toml pins`),
    },
    {
      what: "a library version",
      re: /`@hot-labs\/near-connect`\)? (\d+\.\d+\.\d+)/,
      to: bumpLast,
      expect: () => /apps\/web\/package\.json pins/,
    },
    {
      what: "the reproducible-build image",
      re: /\bsourcescan\/cargo-near:([\w.-]*\w)/,
      to: () => "0.0.1-rust-1.0.0",
      expect: () =>
        /"sourcescan\/cargo-near:0\.0\.1-rust-1\.0\.0": contracts\/vault\/Cargo\.toml pins/,
    },
    {
      what: "an npm version",
      re: /\bon npm as `@probarion\/core` (\d+\.\d+\.\d+)/,
      to: ({ value }) => `${Number(value.split(".")[0]) + 10}.0.0`,
      expect: () => /packages\/core\/package\.json is at/,
    },
    {
      what: "the MCP tool count",
      re: /\b(\w+) tools \(`/,
      ok: isCount,
      to: plusOne,
      expect: ({ to }) => new RegExp(`"${to} tools": packages/mcp/src/server\\.ts registers`),
    },
    {
      what: "the threat model's attacks",
      re: /\((\w+)\s+attacks\b/,
      ok: isCount,
      to: plusOne,
      expect: ({ to }) =>
        new RegExp(`"${to} attacks": the Attacks table of docs/THREAT_MODEL\\.md`),
    },
    {
      what: "the docs page count",
      re: /\b(\d+) pages in \w+ sections\b/,
      to: plusOne,
      expect: () => /apps\/web\/content\/docs has \d+ \.mdx pages/,
    },
    {
      what: "the extension's Chrome version",
      re: /\bChrome (\d+) or newer/,
      to: plusOne,
      expect: () => /sets minimum_chrome_version/,
    },
    {
      what: "a ledger entry",
      re: /\brule `[\w.]+`, ledger entry (\d+)/,
      to: plusOne,
      expect: ({ to }) => new RegExp(`has entry ${to} refused by`),
    },
    {
      what: "a verify output",
      re: /`(\d+) passed, \d+ failed, \d+ unproven`/,
      to: ({ value }) => String(Number(value) + 100),
      expect: () => /" is in none of docs\/evidence\//,
    },
    {
      what: "a check a verify output passes or fails",
      re: /\b(passes|fails) checks? [a-i](?: to [a-i])?\b/,
      ok: (_m, at) => inVerifiedSection(at),
      to: ({ value }) => (value === "passes" ? "fails" : "passes"),
      expect: () => /check [a-i] is not (?:PASS|FAIL) in docs\/evidence\//,
    },
    {
      what: "an anchor count",
      re: /\b(?:the chain's|holds the|anchored the ledger) (\w+) (?:anchors|times)\b/,
      ok: (m, at) => isCount(m) && inVerifiedSection(at),
      to: plusOne,
      expect: () => /reports another anchor count/,
    },
    {
      what: "a code hash commit",
      re: /\brecorded for commit `([0-9a-f]{7,40})`/,
      ok: (_m, at) => /[1-9A-HJ-NP-Za-km-z]{43,44}/.test(lineOf(at)),
      to: () => "fffffff",
      expect: () => /commit fffffff: contracts\/code-hashes\.json records/,
    },
    {
      what: "an account's code hash in a chain.mjs comment",
      re: /chain\.mjs code-hash ([a-z\d_.-]+)\s+#\s*([1-9A-HJ-NP-Za-km-z]{43,44})/,
      group: 2,
      ok: (m) => codeHashes.some((h) => h !== m[2]),
      to: ({ value }) => codeHashes.find((h) => h !== value),
      expect: ({ value, m }) => new RegExp(`${esc(m[1])}: the records give code hash ${value}`),
    },
    {
      what: "the code hash of the factory's vaults",
      re: /\b[Vv]aults?\b[^.;|]*\bfactory\b[^.;|]*?code hash `([1-9A-HJ-NP-Za-km-z]{6,44})\u2026?`/,
      ok: (m) => codeHashes.some((h) => !h.startsWith(m[1])),
      to: ({ value }) => codeHashes.find((h) => !h.startsWith(value)).slice(0, value.length),
      expect: () => /is said to run on the factory's vaults/,
    },
    {
      what: "the number of factory versions",
      re: /\bserves (\w+) versions?\b/,
      ok: isCount,
      to: plusOne,
      expect: () => /serves \w+ versions?": contracts\/deployments\/testnet\.json records/,
    },
    {
      what: "a factory version's index",
      re: /\bVersion (\d+): the vault build `/,
      to: ({ value }) => String(Number(value) + 100),
      expect: () => /contracts\/deployments\/testnet\.json records no such version/,
    },
    {
      what: "a global version said to be live",
      re: /\b(global version (?:is |and a mainnet factory are )?not deployed|global version waits)/,
      to: () => "global version is live",
      expect: () => /"global version is live": contracts\/deployments\/testnet\.json records no/,
    },
    {
      what: "the summary line it quotes, with a count that goes stale",
      re: /^\s*check-claims: ok\. (<n>) links/m,
      to: () => "279",
      expect: () => /the quoted summary line is not the shape the checker prints/,
    },
    {
      what: "a status marker",
      re: /\| \*\*(Planned|Built|Shipped|In progress|Live)\*\*/,
      status: true,
      to: () => "Soon",
      expect: () => /unknown status marker "Soon"/,
    },
    {
      what: "a status row's network, on testnet evidence",
      re: /\*\*(?:Live|Shipped|Built) on NEAR (testnet)\*\*/,
      status: true,
      ok: (_m, at) => lineOf(at).includes("](docs/evidence/"),
      to: () => "mainnet",
      expect: () => /row cites no recorded mainnet account, tx or evidence/,
    },
    {
      what: "a Where path",
      re: /\[(`([\w./-]+)`\]\(\2)\) \|$/m,
      status: true,
      to: ({ m }) => `\`${m[2]}-missing\`](${m[2]}-missing`,
      expect: ({ m }) => new RegExp(`${esc(m[2])}-missing is not a file of the repository`),
    },
    {
      what: "the path a link text names",
      re: /\[`((?:contracts|packages|apps|docs)\/[\w./-]+)`\]\(\1\)/,
      to: ({ value }) => `${value}-old`,
      expect: ({ value, to }) =>
        new RegExp(`link text ${esc(to)} names another path than ${esc(value)}`),
    },
    {
      what: "an account in inline code",
      re: /`((?:[a-z\d][a-z\d_-]*\.)+testnet)`/,
      ok: (_m, at) => readme[at - 1] !== "[",
      to: ({ value }) => `x${value}`,
      expect: ({ to }) => new RegExp(`testnet account ${esc(to)} is not in contracts/deployments`),
    },
    {
      what: "the shortened hash of a link",
      re: /\[`([1-9A-HJ-NP-Za-km-z]{6,})\u2026([1-9A-HJ-NP-Za-km-z]*)`\]\(https:\/\/testnet\.nearblocks\.io\/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})\)/,
      ok: (m) => m[3].startsWith(m[1]) && m[3].endsWith(m[2]),
      to: ({ value }) => value.slice(0, -1) + (value.endsWith("z") ? "y" : "z"),
      expect: ({ to, m }) => new RegExp(`link text ${esc(to)}\u2026${esc(m[2])} does not match`),
    },
    {
      what: "a pnpm package filter",
      re: /\bpnpm --filter (@probarion\/[\w-]+)/,
      to: ({ value }) => `${value}-missing`,
      expect: ({ to }) => new RegExp(`--filter ${esc(to)}: no workspace package`),
    },
    {
      what: "a script command",
      re: /\bnode (scripts\/[\w./-]+\.mjs) ([a-z][\w-]*)/,
      group: 2,
      ok: (m) =>
        new RegExp(`case "${m[2]}"|\\b(?:cmd|command) === "${m[2]}"`).test(
          readFileSync(join(ROOT, m[1]), "utf8"),
        ),
      to: () => "no-such-command",
      expect: ({ m }) => new RegExp(`${esc(m[1])} has no command "no-such-command"`),
    },
  ];
  for (const c of cases) {
    test(`fails when README.md misstates ${c.what}`, async (t) => {
      const hit = findClaim(c.re, c);
      if (!hit) {
        t.skip(`README.md no longer states ${c.what}`);
        return;
      }
      hit.to = c.to(hit);
      const changed = readme.slice(0, hit.start) + hit.to + readme.slice(hit.end);
      const expected = c.expect(hit);
      const got = await withChange({ "README.md": changed });
      assert.ok(
        got.some((p) => expected.test(p)),
        `${hit.value} -> ${hit.to}: expected ${expected} in:\n${got.join("\n")}`,
      );
    });
  }

  // The record cases change a copy of a record file, found by what it holds today.
  const testnetJson = json("contracts/deployments/testnet.json");
  /** Every file under a directory of the checkout, as one text. */
  const treeText = (dir) =>
    readdirSync(join(ROOT, dir), { withFileTypes: true })
      .map((f) =>
        f.isDirectory()
          ? treeText(`${dir}/${f.name}`)
          : readFileSync(join(ROOT, dir, f.name), "utf8"),
      )
      .join("\n");
  const evidenceText = treeText("docs/evidence");

  test("fails when the records drop a transaction the README cites", async (t) => {
    // A tx key of testnet.json whose hash the README cites and no other record holds.
    let hit = null;
    const visit = (o, path) => {
      for (const [k, v] of Object.entries(o ?? {})) {
        if (hit) return;
        if (v && typeof v === "object") visit(v, [...path, k]);
        else if (
          /(^|_)tx$/.test(k) &&
          typeof v === "string" &&
          readme.includes(v) &&
          !evidenceText.includes(v) &&
          !JSON.stringify(json("docs/mainnet-proof.json")).includes(v)
        ) {
          hit = { path: [...path, k], hash: v };
        }
      }
    };
    visit(testnetJson, []);
    if (!hit) {
      t.skip("README.md cites no tx that only contracts/deployments/testnet.json records");
      return;
    }
    const copy = structuredClone(testnetJson);
    const parent = hit.path.slice(0, -1).reduce((o, k) => o[k], copy);
    delete parent[hit.path.at(-1)];
    const got = await withChange({ "contracts/deployments/testnet.json": JSON.stringify(copy) });
    assert.ok(
      got.some((p) => p.includes(`testnet tx ${hit.hash} is not recorded`)),
      got.join("\n"),
    );
  });

  test("fails when a global factory version is recorded and the README says there is none", async (t) => {
    if (
      !/global version (?:is |and a mainnet factory are )?not deployed|The global version waits/.test(
        readme,
      )
    ) {
      t.skip("README.md no longer says the global version is not deployed");
      return;
    }
    const copy = structuredClone(testnetJson);
    if (!copy.factory?.versions?.length) {
      t.skip("contracts/deployments/testnet.json records no factory version");
      return;
    }
    copy.factory.versions[0].mode = "global";
    const got = await withChange({ "contracts/deployments/testnet.json": JSON.stringify(copy) });
    assert.ok(
      got.some((p) => /records 1 version\(s\) not embedded/.test(p)),
      got.join("\n"),
    );
  });

  test("fails when a mainnet transaction is recorded and the README says there is none", async () => {
    const mainnet = json("contracts/deployments/mainnet.json");
    mainnet.check_claims_test_tx = UNRECORDED;
    const change = { "contracts/deployments/mainnet.json": JSON.stringify(mainnet) };
    // Since the mainnet v0 run of 2026-11-11 the README makes no such claim, so the case adds one.
    if (!/hold no transactions|makes no\s+mainnet claim/.test(readme)) {
      change["README.md"] = `${readme}\nThe mainnet records hold no transactions yet.\n`;
    }
    const got = await withChange(change);
    assert.ok(
      got.some((p) => /says mainnet has no transactions, and \d+ are recorded/.test(p)),
      got.join("\n"),
    );
  });

  test("fails when a vault said to have no full-access key has no record of it", async (t) => {
    const v0 = testnetJson.accounts?.vault_v0;
    const row = readme
      .split("\n")
      .find(
        (l) =>
          l.startsWith("|") && v0 && l.includes(v0) && /no full-access key|\blocked\b/i.test(l),
      );
    if (
      testnetJson.vault_v0?.locked !== true ||
      !row ||
      evidenceText.includes(`Probarion verify: ${v0} `)
    ) {
      t.skip("README.md has no keyless claim that only contracts/deployments/testnet.json backs");
      return;
    }
    const copy = structuredClone(testnetJson);
    copy.vault_v0.locked = false;
    const got = await withChange({ "contracts/deployments/testnet.json": JSON.stringify(copy) });
    assert.ok(
      got.some((p) => p.includes(`${v0} is said to be keyless`)),
      got.join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// --online, against a fake network: the same steps, with canned answers

describe("--online", () => {
  const ITEM = "hhadnmnjdlamihjjoejphkimnbcfidmn";
  const README = `# X

## Status

| Part | Status | Where |
| --- | --- | --- |
| Extension | **Built**; pending Chrome Web Store review (item \`${ITEM}\`) | [\`apps/extension\`](apps/extension) |

## Proof

| What | Transaction | Result |
| --- | --- | --- |
| \`spend\` on mandate 999 | [\`AkjyVPmb\u2026\`](https://testnet.nearblocks.io/txns/${TX2}) | \`PROBARION:NoMandate\` |

## Packages

The SDK is on npm as \`@demo/sdk\` 0.1.0. The console runs at [probarion.xyz](https://probarion.xyz) on testnet.
`;
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "check-claims-online-"));
    const files = {
      "README.md": README,
      "apps/extension/store/README.md": `Submitted as item ${ITEM}.\n`,
      "apps/extension/scripts/manifest.mjs":
        'export const DESCRIPTION =\n  "Queue invoices into Probarion and see what waits for your signature.";\n',
      "contracts/deployments/testnet.json": JSON.stringify({
        network: "testnet",
        accounts: { vault_v0: "v0.demo.testnet" },
        smoke: { no_mandate_tx: TX2 },
      }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/sdk/package.json": JSON.stringify({ name: "@demo/sdk", version: "0.1.0" }),
      "CHANGELOG.md": "# Changelog\n\n## 0.1.0 - 2026-11-09\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  /** A fake fetch: the chain signs the tx as `signer` and fails it with `panic`; the store page is `listing`. */
  const network =
    ({ signer = "v0.demo.testnet", panic = "PROBARION:NoMandate", listing = "unlisted" } = {}) =>
    async (url, init) => {
      if (init?.method === "POST") {
        const { method } = JSON.parse(init.body);
        const result =
          method === "EXPERIMENTAL_tx_status"
            ? {
                transaction: {
                  hash: TX2,
                  signer_id: signer,
                  receiver_id: "v0.demo.testnet",
                  actions: [{ FunctionCall: { method_name: "spend" } }],
                },
                status: {
                  Failure: {
                    ActionError: {
                      kind: {
                        FunctionCallError: { ExecutionError: `Smart contract panicked: ${panic}` },
                      },
                    },
                  },
                },
              }
            : null;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      }
      if (url.includes("/api/health")) {
        return new Response(JSON.stringify({ ok: true, network: "testnet" }));
      }
      if (url.startsWith("https://registry.npmjs.org/")) {
        return new Response(JSON.stringify({ versions: { "0.1.0": {} } }));
      }
      const live = listing === "live";
      const r = new Response(
        live
          ? "<title>Probarion - Chrome Web Store</title> Queue invoices into Probarion and see what waits"
          : "<title>Chrome Web Store</title>",
      );
      Object.defineProperty(r, "url", {
        value: url.replace("/detail/", live ? "/detail/probarion/" : "/detail/empty-title/"),
      });
      return r;
    };
  const run = async (opts) => {
    const report = await checkClaims({ root, online: true, net: { fetchImpl: network(opts) } });
    return {
      got: problems(report).map((p) => p.replace(/: https:\S*$/, "")),
      unreachable: report.unreachable,
    };
  };

  test("passes when the chain and the store say what the README says", async () => {
    assert.deepEqual(await run(), { got: [], unreachable: [] });
  });

  test("reports an item the README calls pending once its store listing is live", async () => {
    assert.deepEqual((await run({ listing: "live" })).got, [
      `README.md:7 [online] the README says item ${ITEM} is pending Chrome Web Store review, and its listing is live`,
    ]);
  });

  test("reports a spend that the vault's own key did not sign", async () => {
    assert.deepEqual((await run({ signer: "someone.testnet" })).got, [
      `README.md:13 [online] spend ${TX2} was signed by someone.testnet, not by the vault's own agent key (v0.demo.testnet)`,
    ]);
  });

  test("reports an outcome the row claims and the transaction does not show", async () => {
    assert.deepEqual((await run({ panic: "PROBARION:OverPerPayment" })).got, [
      "README.md:13 [online] PROBARION:NoMandate is not in the result of AkjyVPmb",
    ]);
  });

  test("an endpoint that does not answer leaves its claims unchecked (exit 2), not passed", async () => {
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    const report = await checkClaims({ root, online: true, net: { fetchImpl: down } });
    assert.deepEqual(problems(report), []);
    assert.deepEqual(
      report.unreachable.map((u) => u.split(": ")[0]),
      [
        `testnet tx ${TX2}`,
        "https://probarion.xyz/api/health",
        `Chrome Web Store item ${ITEM}`,
        "npm @demo/sdk@0.1.0",
      ],
    );
  });

  test("one endpoint that does not answer skips only its own checks", async () => {
    const asked = [];
    const flaky = async (url, init) => {
      asked.push({ method: init?.method ?? "GET", url });
      if (init?.method === "POST" || url.includes("/api/health")) {
        throw new TypeError("fetch failed");
      }
      return new Response("not found", { status: 404 });
    };
    const report = await checkClaims({ root, online: true, net: { fetchImpl: flaky } });
    // The tx lookup tried a second archival host, and the store and npm checks still ran.
    assert.deepEqual(
      asked.filter((a) => a.method === "POST").map((a) => new URL(a.url).host),
      ["archival-rpc.testnet.fastnear.com", "archival-rpc.testnet.near.org"],
    );
    assert.ok(asked.some((a) => a.url === `https://chromewebstore.google.com/detail/${ITEM}`));
    assert.deepEqual(problems(report), ["README.md:17 [online] npm has no @demo/sdk@0.1.0"]);
    assert.deepEqual(
      report.unreachable.map((u) => u.split(": ")[0]),
      [`testnet tx ${TX2}`, "https://probarion.xyz/api/health"],
    );
  });
});
