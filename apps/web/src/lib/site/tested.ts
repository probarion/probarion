// How far Probarion is tested, in numbers: one dated table that the README's "Tested, in numbers", the block in
// JUDGES.md and the card on /usage share. Every figure was read, not estimated, at the commit, the CI run or the chain
// read its row names: a public CI log, a file of this repository, or a read-only view call. Test counts change with
// every commit, so a row says when it was counted, and no count is rounded up. tested.test.ts holds the README's table
// to these rows cell by cell, and the figures this repository can derive (the eval, the code hashes, the error codes,
// the property tests, the threat model) to their files.

/** The day the table was read, and the commit of `dev` whose CI run the test counts come from. */
export const TESTED_AS_OF = "2026-11-14";
export const TESTED_COMMIT = "ed41104";

const ACTIONS = "https://github.com/probarion/probarion/actions/runs";
/** The CI run of `ed41104` on `dev` (ci.yml), and its jobs. */
const CI_RUN = `${ACTIONS}/43533889651`;
const CI_JOB = {
  ts: `${CI_RUN}/job/132258046910`,
  rust: `${CI_RUN}/job/132258047201`,
  sandbox: `${CI_RUN}/job/132258446638`,
  vaultBuild: `${CI_RUN}/job/132258047258`,
  factoryBuild: `${CI_RUN}/job/132258047305`,
  secrets: `${CI_RUN}/job/132258047338`,
} as const;
/** The no-clone verify of `ed41104` (no-clone-verify.yml), and pnpm judge on `main` (judge.yml). */
const NO_CLONE_RUN = `${ACTIONS}/43533889407`;
const JUDGE_RUN = `${ACTIONS}/43465246300`;

/**
 * Where a figure was read. `href` is a full address (a CI log), a path of this repository (no leading slash), or a page
 * of the site (a leading slash), which the README links on probarion.xyz.
 */
export interface TestedSource {
  label: string;
  href: string;
}

/** One row: what was tested, the figure (backticks are code), when it was read, and where. */
export interface TestedRow {
  what: string;
  figure: string;
  at: string;
  sources: readonly TestedSource[];
}

export const TESTED = {
  /** The README's and JUDGES.md's heading, and the card's title on /usage. */
  title: "Tested, in numbers",
  cardTitle: "How far it is tested",
  lede: `As of ${TESTED_AS_OF}, the strongest figures at the top. Test counts change with every commit, so each row names the commit, the CI run or the chain read it was counted at. Every figure links where it was read, and none is rounded up.`,
  /** The block in JUDGES.md: these few figures, then a link to the table. */
  judges: `Every suite in CI passed at commit \`${TESTED_COMMIT}\` on ${TESTED_AS_OF}: 13,450 tests, 0 failed. With the model fooled by every invoice, in an offline run that asks no model, the eval moves no money wrongly (0/20, 0.00 USDC). \`npx probarion@0.1.1 verify\` on the mainnet vault gives RESULT: PASS on Node v22.23.4 and on Node v24.22.2.`,
  rows: [
    {
      what: "Automated tests, every suite",
      figure:
        "13,450 CI tests: 13,131 TypeScript, 301 Rust, 18 sandbox. Each passed, 0 failed, and 15 more were skipped (1 web, 14 CLI).",
      at: `CI run of \`${TESTED_COMMIT}\` on \`dev\`, ${TESTED_AS_OF}, 00:23 to 00:31 UTC`,
      sources: [{ label: "CI run 43533889651", href: CI_RUN }],
    },
    {
      what: "TypeScript tests, by suite",
      figure:
        "13,131 TypeScript tests: 9,826 web console, 888 `@probarion/core`, 824 `@probarion/sdk`, 366 CLI, 198 `@probarion/mcp`, 251 browser extension, 78 pay-per-call example, 476 Node script tests, 224 launch checks.",
      at: "the same run, TypeScript job",
      sources: [{ label: "TypeScript job", href: CI_JOB.ts }],
    },
    {
      what: "Contract tests",
      figure:
        "301 Rust tests: 227 vault unit, 2 vault error-coverage, 2 vault property, 53 factory, 12 intents-stub, 5 test-ft. Each of the vault's 24 error codes has a unit test, and a test fails if one has none. The 2 property tests run 256 random cases each, of 1 to 39 random operations, for spent plus reserved staying within `max_total` and each invoice hash paid at most once.",
      at: `the same run, Rust job, ${TESTED_AS_OF} 00:24 UTC`,
      sources: [
        { label: "Rust job", href: CI_JOB.rust },
        { label: "invariants.rs", href: "contracts/vault/tests/invariants.rs" },
        { label: "error_coverage.rs", href: "contracts/vault/tests/error_coverage.rs" },
      ],
    },
    {
      what: "Sandbox integration tests",
      figure:
        "18 passed against the contracts' wasm on a local NEAR node: factory 4, flows 2, I-HITL 1, keys 4, security 7. In the I-HITL test the agent's key tries to raise its own limits and approve its own spend, and the node refuses each try before any contract code runs.",
      at: "the same run, sandbox job, 00:24 to 00:28 UTC",
      sources: [
        { label: "sandbox job", href: CI_JOB.sandbox },
        { label: "ihitl.rs", href: "contracts/integration-tests/tests/ihitl.rs" },
      ],
    },
    {
      what: "CI checks",
      figure:
        "The reproducible builds match the recorded code hashes: vault `3cQXYDvf…`, factory `FK6mMqUd…`. gitleaks scanned 783 commits and found no leak. The required `verify` check passed, with all 6 jobs green.",
      at: "the same run, 00:23 to 00:31 UTC",
      sources: [
        { label: "vault build", href: CI_JOB.vaultBuild },
        { label: "factory build", href: CI_JOB.factoryBuild },
        { label: "secret scan", href: CI_JOB.secrets },
        { label: "code-hashes.json", href: "contracts/code-hashes.json" },
      ],
    },
    {
      what: "Mainnet verify, no clone",
      figure:
        "`npx probarion@0.1.1 verify` on `v0.probarion.near`, from npm with no key: checks a to h PASS, i SKIP, RESULT: PASS, on Node v22.23.4 and on Node v24.22.2.",
      at: `CI run of \`${TESTED_COMMIT}\`, ${TESTED_AS_OF} 00:23 UTC`,
      sources: [
        { label: "CI run 43533889407", href: NO_CLONE_RUN },
        { label: "no-clone-verify.yml", href: ".github/workflows/no-clone-verify.yml" },
      ],
    },
    {
      what: "Eval, 20 synthetic invoices, 6 of them prompt-injected",
      figure:
        "With the model fooled by every invoice (an offline run that asks no model; 6/6 injections, by construction), 14 of 20 proposals are wrong and `decide()` allows none of them: money moved wrongly 0/20, 0.00 USDC. A grid of over 5,000 attested pay proposals on the 20 cases moves no money wrongly. With rules alone, the code layer stops 8/8 of the invoices that must not be paid, with 0/20 false refusals.",
      at: `results committed at \`${TESTED_COMMIT}\`; \`pnpm eval:check\` reruns them offline and fails on any drift`,
      sources: [
        { label: "adversary.md", href: "eval/results/adversary.md" },
        { label: "latest.md", href: "eval/results/latest.md" },
        { label: "adversary.test.ts", href: "apps/web/test/eval/adversary.test.ts" },
      ],
    },
    {
      what: "Real USDC on mainnet, vault `v0.probarion.near`",
      figure:
        "3 test payments to the owner's own accounts: 1.00 USDC to a NEAR account on 2026-11-11, then 1.00 and 0.25 USDC to a Base address through NEAR Intents on 2026-11-13. 1 spend refused on chain (`NoMandate`). 3 attested decisions pass A1 to A8 offline, and O1 (Intel TDX) and O2 (NVIDIA NRAS) online; the TEE measurement is not pinned. 6 signed ledger entries, with 4 anchors on chain.",
      at: `recorded 2026-11-11 and 2026-11-13; ledger anchors read on chain ${TESTED_AS_OF} 01:10 UTC`,
      sources: [
        { label: "mainnet-proof.json", href: "docs/mainnet-proof.json" },
        {
          label: "online check",
          href: "docs/evidence/mainnet-v0/s2-2026-11-13/verify-online-2026-11-13.txt",
        },
      ],
    },
    {
      what: "Testnet team vaults, read from the chain",
      figure:
        "10 vaults (9 created by the factory `vaults.probarion.testnet`, and `v0.probarion.testnet`), 13 mandates, 35 spends (30 paid on NEAR, 4 burned for a Base address through the testnet Intents stand-in, 1 held and then rejected), 53 anchors over 88 signed ledger entries.",
      at: `view calls \`list_vaults\`, \`list_mandates\`, \`list_spends\` and \`list_anchors\`, ${TESTED_AS_OF} 01:10 UTC, finality final`,
      sources: [{ label: "testnet.json", href: "contracts/deployments/testnet.json" }],
    },
    {
      what: "Testnet runs with a person and a model",
      figure:
        "3 held spends approved and paid (2026-11-09 with the approver key, 2026-11-11 twice on the phone approval page) and 1 rejected with nothing paid (2026-11-12). 3 refusals on chain recorded: `NoMandate` in the smoke run, `OverPerPayment` on 2026-11-09, and the Canary's `OverPerPayment` on 2026-11-10. 7 attested decisions (demo vault 5, Canary 2) pass A1 to A7 offline, and O1 and O2 online; the demo vault's 5 pass A8 too. The TEE measurement is not pinned.",
      at: "2026-11-09 to 2026-11-12",
      sources: [
        { label: "demo vault", href: "docs/evidence/demo-vault/README.md" },
        { label: "trial vault", href: "docs/evidence/trial-vault/README.md" },
        { label: "Canary vault", href: "docs/evidence/canary-vault/README.md" },
        { label: "testnet.json", href: "contracts/deployments/testnet.json" },
      ],
    },
    {
      what: "Pay per call (HTTP 402)",
      figure:
        "20 calls paid 0.01 test USDC each, and the 21st was refused by code (`mandate.uses_exhausted`); the contract's `check_spend` answered `UsesExhausted` for the same payment.",
      at: "2026-11-09, 18:12 to 18:16 UTC",
      sources: [{ label: "402 vault", href: "docs/evidence/402-vault/README.md" }],
    },
    {
      what: "Canary rehearsals",
      figure:
        "6 attempts by the team, 2026-11-10 to 2026-11-12, each refused by code; the 2 sent straight to the contract were refused on chain with `OverPerPayment`, and no spend was created.",
      at: `the live attempts feed and a view of the Canary vault's spends, ${TESTED_AS_OF} 01:10 UTC; the rehearsal of 2026-11-10 is recorded in the repository`,
      sources: [
        { label: "rehearsal", href: "docs/evidence/canary-vault/README.md" },
        { label: "live feed", href: "/canary" },
      ],
    },
    {
      what: "Claim checker",
      figure:
        "`scripts/check-claims.mjs` checked 723 links (167 anchors), 46 transaction hashes, 24 accounts, 30 status rows, 122 paths and commands and 223 facts offline, and made 100 online checks: each cited transaction exists with its signer and error code, and the vault's code hash and keys are as recorded. Each of the 22 security claim ids has one `probarion-claim` marker in code or tests, and the threat model (11 attacks) cites the evidence for each.",
      at: `at \`${TESTED_COMMIT}\`, ${TESTED_AS_OF}`,
      sources: [
        { label: "check-claims.mjs", href: "scripts/check-claims.mjs" },
        { label: "THREAT_MODEL.md", href: "docs/THREAT_MODEL.md" },
      ],
    },
    {
      what: "Live checks",
      figure:
        "`node scripts/smoke-live.mjs` read 17 rows of the live site, both NEAR networks and npm, with no key: 15 PASS, 1 WARN, 0 FAIL, 1 SKIP. `pnpm judge` runs offline in CI on `main` every day: 21 PASS, 1 EXPECTED-FAIL, 14 SKIPPED, 0 FAIL.",
      at: "smoke run 2026-11-13 20:45 UTC; judge 2026-11-13 16:41 UTC, on `main` at `18cdf04`",
      sources: [
        { label: "smoke-live.mjs", href: "scripts/smoke-live.mjs" },
        { label: "CI run 43465246300", href: JUDGE_RUN },
        { label: "judge.yml", href: ".github/workflows/judge.yml" },
      ],
    },
  ],
} as const satisfies {
  title: string;
  cardTitle: string;
  lede: string;
  judges: string;
  rows: readonly TestedRow[];
};

/** The site's address that the README links a site page on, with its source named (`?via=readme`). */
const SITE = "https://probarion.xyz";

/**
 * A source as the README writes it, from the repository root (README.md and JUDGES.md are there): a CI log as given, a
 * file by its path, and a page of the site on probarion.xyz with `?via=readme`.
 */
export function readmeSource(s: TestedSource, from = ""): string {
  const href = s.href.startsWith("https://")
    ? s.href
    : s.href.startsWith("/")
      ? `${SITE}${s.href}?via=readme`
      : `${from}${s.href}`;
  return `[${s.label}](${href})`;
}

/** The README's table row for one row of the table, cell by cell. */
export const readmeRow = (r: TestedRow): string =>
  `| ${r.what} | ${r.figure} | ${r.at} | ${r.sources.map((s) => readmeSource(s)).join(", ")} |`;
