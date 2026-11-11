// Tests for scripts/check-claims.mjs: the helpers, a small fake repository with one defect at a
// time, and the real repository (as checked out, then with one claim edited in memory).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// these and nothing else, so the fix can land in any order: once it has, delete the entry.
const KNOWN_PROBLEMS = [
  // README "INV-2003" row: the approve tx 47VCARhw...NCJf is shown ending in FJf.
  "[hashes] link text 47VCARhw\u2026FJf does not match its hash 47VCARhwsG2B7xbaFDS3f6nZdqR2gnQvBMofcP9FNCJf",
  // Interfaces section 17 lists EVAL-REGRESSION; the eval lane adds its marker.
  '[facts] claim EVAL-REGRESSION has no "probarion-claim: EVAL-REGRESSION" marker in the code or its tests',
];
const isKnown = (p) => KNOWN_PROBLEMS.some((k) => p.endsWith(k));

describe("the real repository", () => {
  let report;
  before(async () => {
    report = await checkClaims({ root: ROOT });
  });

  test("passes offline, but for the claims listed above for a fix where they are written", () => {
    assert.deepEqual(
      problems(report).filter((p) => !isKnown(p)),
      [],
    );
  });

  test("covers every kind of check", () => {
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
    const facts = [
      "versions",
      "npm versions",
      "code hashes",
      "keyless vaults",
      "MCP tools",
      "extension manifest",
      "docs pages",
      "threat model",
      "factory mode",
      "evidence",
      "test sums",
      "contents",
      "mainnet record",
      "claim markers",
    ];
    // A README rewording that a fact check no longer matches shows up here: update the check.
    for (const f of facts)
      assert.ok((report.facts.get(f) ?? 0) > 0, `fact check "${f}" matched nothing`);
    if (!report.counts.has("git facts skipped (no full git history)")) {
      assert.ok((report.facts.get("git history") ?? 0) > 0, "no git history fact was checked");
    }
  });

  const readme = readFileSync(join(ROOT, "README.md"), "utf8").replace(/\r\n/g, "\n");
  const json = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

  /** Runs the checker with one change and returns the problems not already known. */
  const withChange = async (overrides) =>
    problems(await checkClaims({ root: ROOT, overrides })).filter((p) => !isKnown(p));
  const readmeWith = (from, to) => {
    assert.ok(readme.includes(from), `README.md has ${JSON.stringify(from)}`);
    return { "README.md": readme.replace(from, to) };
  };

  const cases = [
    [
      "a toolchain version",
      "near-sdk 5.29.1",
      "near-sdk 5.30.1",
      /near-sdk 5\.30\.1": contracts\/Cargo\.toml pins 5\.29\.1/,
    ],
    [
      "a library version",
      "`@hot-labs/near-connect` 0.11.4",
      "`@hot-labs/near-connect` 0.12.0",
      /apps\/web\/package\.json pins 0\.11\.4/,
    ],
    [
      "an npm version",
      "on npm as `@probarion/core` 0.1.0",
      "on npm as `@probarion/core` 0.2.0",
      /packages\/core\/package\.json is at/,
    ],
    [
      "the MCP tool count",
      "five tools (`list_mandates`",
      "six tools (`list_mandates`",
      /"six tools": packages\/mcp\/src\/server\.ts registers 5/,
    ],
    [
      "the threat model's attacks",
      "(eleven\nattacks",
      "(twelve\nattacks",
      /"twelve attacks": the Attacks table of docs\/THREAT_MODEL\.md has 11 rows/,
    ],
    [
      "the docs page count",
      "34 pages in six sections",
      "35 pages in six sections",
      /apps\/web\/content\/docs has \d+ \.mdx pages/,
    ],
    [
      "the extension's Chrome version",
      "Chrome 127 or newer",
      "Chrome 120 or newer",
      /sets minimum_chrome_version 127/,
    ],
    [
      "a ledger entry",
      "`mandate.payee_mismatch`, ledger entry 3",
      "`mandate.payee_mismatch`, ledger entry 4",
      /has entry 4 refused by mandate\.payee_mismatch/,
    ],
    [
      "a verify output",
      "printed `9 passed, 0 failed, 0 unproven`",
      "printed `8 passed, 1 failed, 0 unproven`",
      /"8 passed, 1 failed, 0 unproven" is in none of docs\/evidence\/demo-vault\/verify-2026-11-09\.txt/,
    ],
    [
      "a check a verify output does not pass",
      "It fails check c",
      "It fails check f",
      /check f is not FAIL/,
    ],
    [
      "an anchor count",
      "the chain's 4 anchors",
      "the chain's 5 anchors",
      /reports another anchor count/,
    ],
    [
      "a code hash commit",
      "recorded for commit `3bd8189`",
      "recorded for commit `64ac3c0`",
      /commit 64ac3c0: contracts\/code-hashes\.json records 6tbER/,
    ],
    [
      "an account's code hash",
      "# 6tbERLAXWjaVKbSNzaivRDh7H9kCcjtmV1qGrgz7entR\n",
      "# 3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1\n",
      /v0\.probarion\.testnet: the records give code hash 6tbER/,
    ],
    ["a status marker", "| **Planned**.", "| **Soon**.", /unknown status marker "Soon"/],
    [
      "a Where path",
      "[`contracts/factory`](contracts/factory) |",
      "[`contracts/factories`](contracts/factories) |",
      /contracts\/factories is not a file of the repository/,
    ],
    [
      "the shortened hash of a link",
      "[`3DFV2thB\u2026Fy9cX`]",
      "[`3DFV2thC\u2026Fy9cX`]",
      /link text 3DFV2thC\u2026Fy9cX does not match/,
    ],
    [
      "a pnpm package filter",
      "pnpm --filter @probarion/example-402 run test",
      "pnpm --filter @probarion/example-403 run test",
      /--filter @probarion\/example-403: no workspace package/,
    ],
    [
      "a chain.mjs command",
      "chain.mjs key-count v0",
      "chain.mjs keys v0",
      /scripts\/testnet\/chain\.mjs has no command "keys"/,
    ],
  ];
  for (const [what, from, to, expected] of cases) {
    test(`fails when README.md misstates ${what}`, async () => {
      const got = await withChange(readmeWith(from, to));
      assert.ok(
        got.some((p) => expected.test(p)),
        `expected ${expected} in:\n${got.join("\n")}`,
      );
    });
  }

  test("fails when the records drop a transaction the README cites", async () => {
    const testnet = json("contracts/deployments/testnet.json");
    delete testnet.smoke.no_mandate_tx;
    const got = await withChange({ "contracts/deployments/testnet.json": JSON.stringify(testnet) });
    assert.ok(
      got.some((p) => /testnet tx AkjyVPmb\w+ is not recorded/.test(p)),
      got.join("\n"),
    );
  });

  test("fails when a global factory version is recorded and the README says there is none", async () => {
    const testnet = json("contracts/deployments/testnet.json");
    testnet.factory.versions[0].mode = "global";
    const got = await withChange({ "contracts/deployments/testnet.json": JSON.stringify(testnet) });
    assert.ok(
      got.some((p) => /records 1 version\(s\) not embedded/.test(p)),
      got.join("\n"),
    );
  });

  test("fails when a mainnet transaction is recorded and the README says there is none", async () => {
    const mainnet = json("contracts/deployments/mainnet.json");
    mainnet.proof.first_near_payment_tx = UNRECORDED;
    const got = await withChange({ "contracts/deployments/mainnet.json": JSON.stringify(mainnet) });
    assert.ok(
      got.some((p) => /says mainnet has no transactions, and 1 are recorded/.test(p)),
      got.join("\n"),
    );
  });

  test("fails when a vault said to have no full-access key has no record of it", async () => {
    const testnet = json("contracts/deployments/testnet.json");
    testnet.vault_v0.locked = false;
    const got = await withChange({ "contracts/deployments/testnet.json": JSON.stringify(testnet) });
    assert.ok(
      got.some((p) => /v0\.probarion\.testnet is said to be keyless/.test(p)),
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
      report.unreachable.map((u) => u.split(":")[0]),
      ["onlineTxs", "onlineHttp"],
    );
  });
});
