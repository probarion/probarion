# Changelog

All notable changes to this repository: the NEAR contracts in `contracts/`, the npm packages
`@probarion/core`, `@probarion/sdk`, `probarion` (the CLI) and `@probarion/mcp` (the MCP server, in
`packages/mcp`), and the web console in `apps/web`.

Versions follow semver. The npm packages share one version, released by the tag `sdk-v<version>`;
0.1.0 was published on 2026-11-09, and 0.1.1, the first release of `@probarion/mcp`, on 2026-11-11.
A contract crate carries its own version, and each build of it is identified
by the code hash of its reproducible build in `contracts/code-hashes.json`. The web console is not
versioned yet, and it deploys from `main` to <https://probarion.xyz>. While the version is 0.x, a minor version may change the API.
The software is an unaudited beta.

## Unreleased

### Added

- How far it is tested, in numbers. The README has a dated table near its top, "Tested, in numbers": as of
  2026-11-14, the tests of every CI suite in the CI run of `ed41104` (13,450 passed, 0 failed: 13,131 in the
  TypeScript job, 12,655 of them TypeScript and 476 JavaScript Node script tests, then 301 Rust and 18 sandbox; the
  Playwright end-to-end tests run locally and are not counted), the vault's property tests and error-code coverage,
  the CI checks (the reproducible code hashes, the secret scan, and the no-clone verify of the mainnet vault on
  Node v22.23.4 and on Node v24.22.2), the eval with the model fooled in an offline run and its replay of the answers `Qwen/Qwen3.8-27B` gave on NEAR AI Cloud, the mainnet and testnet
  records from the committed evidence and read-only view calls, the Canary rehearsals, what the claim checker covers
  and the live checks, each row with the run, the file or the chain read it was counted at, and a link to check it.
  The testnet chain read is committed as `docs/evidence/testnet-reads/2026-11-14.txt`: the 10 team vaults' mandates,
  spends and anchors from view calls, and the 4 spends the contract refused on chain (2026-11-01, 2026-11-09,
  2026-11-10 and 2026-11-12), from FastNEAR's transaction index, each read back with `tx` from archival RPC. Its rows
  live in `apps/web/src/lib/site/tested.ts`, which also gives JUDGES.md its short block and `/usage` a card near the
  top, "How far it is tested"; `apps/web/src/lib/site/tested.test.ts` holds the README's table to it cell by cell,
  and the figures the repository can derive (the eval, the code hashes, the error codes, the property tests, the
  threat model, the chain read) to their files. docs/TRACKS.md points to the table. On `/usage`, external owners,
  Canary participants and pilots, with their columns in the tables, appear as soon as they are counted
  (`shownSegments` in `apps/web/src/lib/usage/view.ts`); the team's counts and the mainnet record stay, and "How each
  number is counted" says so, and that the live vault counts cover the vaults registered in the console. On
  `/canary`, the line over the form and the scoreboard name the team's attempts as rehearsals and invite a try ("The
  team has run 6 rehearsal attempts. Your turn: try to get paid."), an empty feed reads "Attempts appear here as they
  come in.", and visitors' attempts get their own tiles and line as soon as one comes in. The Known gaps item on
  outside users is removed, since `/usage` shows those counts as soon as there are any; the Canary's status row
  states its limit as the testnet and its private ledger. The audit gap stays.
- The eval's model replay, recorded on NEAR AI Cloud. `eval/recorded/` holds the calls to `Qwen/Qwen3.8-27B` of
  2026-11-14, from 01:10:55 to 01:22:24 UTC, for the 19 cases that reach the model step: 17 answers that pass A1 to
  A8 offline, and 2 failed calls, decided rules-only (I-01 timed out after 90000 ms, and again when recorded once
  more; I-06's model output was not valid JSON, and it was deliberately not recorded again: a response came back,
  so it was not the network, and asking until an answer parses would choose the result; the file does not say why
  the output did not parse, and at about 71 s the call may have reached template v1's 4096-token cap). D-01 has no
  file: the intake guard stops it before the model step. `pnpm eval` replays them offline: money moved wrongly
  0/20, held for the owner 0/20, model fooled 0/3 (I-03, I-04 and I-05; I-01 and I-06 are the failed calls),
  accepted 19/20, exact 16/20, missed refusals 0/20, and 1/20 false refusals: for C-05 the model put the Base payee
  in `payee_hint.near_account` as one malformed string, and `mandate.payee_mismatch` refused it. The model proposed
  paying D-02 and M-01, which the code refused. The 17 answers used 12,374 prompt and 20,133 completion tokens,
  0.02767 USD at the list price NEAR AI Cloud's public model list gave that day; the failed calls and the earlier
  runs used more, which no file records. An earlier run with `z-ai/glm-5.3-flash`, the model the recorder picks
  from the catalog when `NEARAI_MODEL` is unset, wrote no answer: 17 answers failed A3 to A5 and 2 calls timed
  out. Each of the 17 answer files has `quote_verified: false`: O1 and O2 were not run on them, and the TEE
  measurement is not pinned. `eval/results/latest.md` names the failed calls, and `attack-log.md` labels their
  lines rules only, not "with the model". `eval/README.md` ("Results today", with the run history), the README
  Status row, `JUDGES.md`, `docs/TRACKS.md`, `docs/THREAT_MODEL.md` and the landing's status board footer give the
  numbers; `apps/web/test/eval/adversary.test.ts` and `apps/web/test/status-board.test.ts` hold them to
  `eval/results/latest.json` and to the files' `usage`. Check: `pnpm eval:check`, then
  `pnpm --filter @probarion/web exec vitest run test/eval test/status-board.test.ts`.

- A no-clone check of the mainnet vault. The site serves `v0.probarion.near`'s signed ledger after S2, the recorded
  transactions, spend 1's pre-ledger decision and the two invoice texts under `/samples/mainnet/`, each a byte copy
  of its source in `docs/` (`apps/web/test/samples-mainnet.test.ts` compares them). In an empty folder, one `curl`
  that fetches three of them and `npx -y probarion@0.1.1 verify --network mainnet --vault v0.probarion.near
  --ledger ledger.jsonl --evidence evidence --proof mainnet-proof.json` print checks a to h PASS, i SKIP and
  `RESULT: PASS`. Verify reads the chain with read-only RPC requests (views, and `tx` lookups of the burns) and
  signs nothing. 0.1.1 has no `--invoice`, so A8 does not run. Without `--online`, check e does not verify the TEE
  quotes (O1 and O2), and the TEE measurement is not pinned. On 2026-11-13 UTC this ran on Node 24.12.0 in Git Bash
  and Windows PowerShell 5.1, against local copies and raw.githubusercontent.com
  (`docs/evidence/mainnet-v0/no-clone-verify-2026-11-14.txt`). `.github/workflows/no-clone-verify.yml` is set to
  run the same block on Node 24, which 0.1.1 declares, and on Node 22 to learn whether 0.1.1 also works there, with
  no checkout and no secret. It had not run on GitHub when this entry was written.
- `/usage` leads with what has happened, from the committed evidence. A "Mainnet (v0.probarion.near)" card, built
  at build time from `docs/mainnet-proof.json` and the S1 and S2 run records, counts 3 payments (2 of them to
  Base), 1 refusal on chain (NoMandate) and 3 attested decisions (1 paid, 2 false refusals, with why and their
  anchor transactions), each row with its NEAR and Base transactions and the caveats: every payment is a test to
  the owner's own accounts, the contract is unaudited and the TEE measurement is not pinned. A "What it costs"
  card shows the gas each mainnet spend burned (0.000769 NEAR for spend 1 on NEAR, 0.001423 and 0.001424 NEAR for
  the two Base payouts, 0.000165 NEAR for the refused spend), the POA bridge's 0.0024 USDC fee on each Base payout,
  "Probarion fee: none" (the contract has no fee path) and the testnet vault deposit, 3.23352 test NEAR from the
  testnet factory record and `createDepositPlan`, each linking its file. Both tables have two columns, so a phone
  shows every link. The unit costs' gas row points there instead of "not measured yet", a zero tile is drawn
  smaller, the header says the team paying itself adds no volume to the counts, and the pilots card links a new
  "Run a pilot" issue form, `.github/ISSUE_TEMPLATE/pilot.yml`, which says the issue is public and which
  `scripts/repo-files.test.mjs` now checks. `/login` adds, on testnet, "No testnet account? Create one in Meteor
  Wallet (switch it to testnet) · get test NEAR" (NEAR's faucet page), and on both networks "See it without a
  wallet →" to `/proof`, or the demo video. Check: `pnpm exec vitest run src/components/usage src/app/usage
  src/lib/usage src/app/login` in `apps/web`; `src/components/usage/evidence.test.ts` holds each figure to the
  file it comes from.
- The online check of the mainnet vault's attested decisions, kept as evidence. On 2026-11-13, from 17:51:48 to
  17:52:19 UTC, after the computer's clock was synced, a read-only `verify --online` of `v0.probarion.near` on
  mainnet ran with S2's ledger of 6 entries, the two committed invoice texts, `--evidence docs/evidence`,
  `--proof docs/mainnet-proof.json` and `--snapshot` to a scratch file. It printed
  `8 passed, 0 failed, 0 unproven, 1 skipped` and `RESULT: PASS`. In check e, the 3 attested decisions (ledger
  entries 0 and 1, the two refused proposals of S1 by `z-ai/glm-5.3-flash` and `Qwen/Qwen3.8-27B`, and entry 4,
  the allowed proposal of S2 by `z-ai/glm-5.3-flash`) pass A1 to A7 and A8, and online it found 3 DCAP-genuine TDX
  quotes bound to their requests (O1: debug off, an accepted TCB status, report_data matches) and 3 GPU payloads
  bound to the request nonce and verified by NVIDIA NRAS (O2). The TEE measurement is not pinned, so O1 does not
  show which model image ran. The output is `docs/evidence/mainnet-v0/s2-2026-11-13/verify-online-2026-11-13.txt`.
  S2's README gains a dated section on it and a row in its files table, its line that O1 and O2 had not run now
  says when it was written, and the mainnet folder's README gains a dated line that links it. The README,
  JUDGES.md, SECURITY.md, the threat model, eleven docs pages (with the file among their sources) and the status
  board's mainnet vault and live attested model rows now link the output where they said that O1 and O2 had not
  run on these decisions; the two rows link it as `verify` evidence. The privacy page now says they passed, with
  no link. The README's list of what did not run on mainnet drops that point, and so does the "Not yet" list of
  JUDGES.md, whose item on spend 1 now says how it was sent. The verifier checks page's "Online checks O1 and O2"
  section adds the mainnet run, and the two older Unreleased entries that said the mainnet decisions had not been
  checked online now say they passed later that day. `apps/web/test/status-board.test.ts` holds the links, the
  notes and the file's `RESULT: PASS` and 3 GPU payloads. It also refuses the old words that O1 and O2 had not run
  on these decisions in the README, JUDGES.md, SECURITY.md, the threat model, the site's copy, every docs page and
  the Unreleased section, and checks that each docs page with the file among its sources links it. Still not done:
  every mainnet payment is a test to the owner's own address, spend 1 of 2026-11-11 was sent without the SDK, there
  is no mainnet factory, and no third party has audited the code.
- The landing's sections redesigned, from the hero to the footer. Each opens with one shared head (a hairline, a
  short label, the heading and one sentence, on one left edge), and the space between two of them is the same
  everywhere. The payment journey splits into the five steps and the record: the demo vault's four invoices are one
  table with their evidence in fixed columns, followed by a table of the attested decisions on testnet and the
  result of each check. Outcomes (paid, refused, held) read as a mark and a word, apart from the status pills, and
  each status pill links its row on the status board. Links that leave the site end in one arrow glued to their last
  word, every transaction label names its network, and dates, accounts and short hashes do not break across lines.
  The hero's mainnet record is dated 2026-11-11 and points to the mainnet section for the two Base payouts of
  2026-11-13. The integrate section is in three parts (the ways in, the code with the accounts and statuses beside
  it, and the uses with what ran on each network). A test checks that every CSS module class the landing uses is
  defined, and the colour test reads every module of the site and the docs.
- A read-only live smoke for the judging days: `node scripts/smoke-live.mjs` prints PASS, WARN, FAIL or SKIP per
  row for the deployed commit against main, the pages, the no-clone mainnet verify of `/samples/mainnet/`,
  `npx -y @probarion/mcp@0.1.1 demo`, `check_spend` on mainnet and testnet mandate 1, mainnet mandate 1's uses, the
  agent and ledger keys' gas allowances (WARN under 0.2 NEAR; the Canary's ledger key FAILs under 0.5 NEAR, where
  the Canary stops), active mandate expiries, `/canary` and the site's NEAR AI and RPC probes. It needs no key and
  signs nothing; `/api/tee/check` runs only with `--tee`, since every visitor shares its rate limit.
  `docs/ops/judging-days.md` holds the run schedule, the owner-only checks and a baseline run (2026-11-13 20:45 UTC:
  15 PASS, 1 WARN for the samples not deployed yet, 0 FAIL, 1 SKIP). Check: `node --test
  scripts/smoke-live.test.mjs` runs its rules against a fake fetch and a fake exec.
- `/check` runs the CLI's payee check (the next item) in the browser, with no wallet and no server route: a
  network, a payee and an optional vault give allow, warn or block with the reasons, each read with the host it came
  from, and the requests the browser sent. It reads public NEAR and Base nodes through `@probarion/sdk/payee`; a read
  that fails is unknown and warns, and a check that throws says it could not run, so a blocked node is not an allow.
  Five examples read live, among them mandate 1's payee on `v0.probarion.near` and a made-up Base address with the
  same first and last 4 hex characters as its Base payee (block, when the vault's payees are read). A check can
  travel in the URL fragment. The console's mandate form is unchanged. Check it with
  `pnpm --filter @probarion/web exec vitest run src/app/check` or at `/check` on the site.
- `probarion payee check <payee> [--vault <id>] [--json]` checks a payee before a mandate names it and prints allow,
  warn or block with one reason per check: the NEAR account exists (block for a missing name, warn for an unfunded
  implicit account), the seed blocklist, a lookalike of a payee of the vault (the same first and last 4 hex
  characters, 2 edits or fewer, or the same after rn/m, l/1 and o/0), contract code (a NEAR code hash that is not
  `1111…1`, Base `eth_getCode`), new or code changed in about 7 days (NEAR archival `view_account`), Base nonce 0
  (a weaker sign), and first payment or paid before. A read that fails or times out is unknown and warns, and so
  does a check with no vault, so the check does not allow on a read it could not make. It is read-only;
  `mandate create` and the offline judge path are unchanged. Core has the pure `assessPayee` and the SDK
  `readPayeeSignals` (also as `@probarion/sdk/payee`). The blocklist, `packages/core/src/payee-blocklist.json`, is
  a seed of two testnet names that Probarion's own eval cases and test fixtures use as the attacker's account, not
  held by Probarion, with no report of wrongdoing; `.github/ISSUE_TEMPLATE/report-payee.yml` proposes more. It is
  in this repository, not in npm 0.1.1. Check it with
  `pnpm --filter @probarion/core exec vitest run test/payee-check.test.ts` (one test per rule) or live with
  `node packages/cli/dist/bin.js payee check near:<account> --network mainnet --vault v0.probarion.near`.
- A second mainnet payout to Base, decided by an attested model and the code rules, kept as evidence. On
  2026-11-13, from 11:39 to 11:41 UTC, the owner ran S2 on `v0.probarion.near` from their own terminal, with a kit
  copied from S1's and changed for round 2, which runs the SDK at commit `c85f41b`: the owner signed mandate 3
  (0.25 USDC once, to the same Base address, the owner's own), `z-ai/glm-5.3-flash` on NEAR AI Cloud proposed
  paying INV-M003, every code rule passed (ledger entry 4, `model+rules`), and spend 3 burned 0.25 USDC with
  `WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27`. The POA bridge released 0.2476 USDC on Base and kept a
  fee of 0.0024. INV-M003 is a labeled test, not a customer payment. At decision time the SDK checked the model's
  evidence with A1 to A7 and A8; a later read-only `verify --online` that day passed O1 and O2 on it. The model's
  payee hint named no NEAR account, so the payee rule changes of PR #142 and PR #144, which that SDK holds, were
  not exercised on mainnet: the hint gave them nothing to read. Two testnet rehearsals came before it.
  `docs/evidence/mainnet-v0/s2-2026-11-13` holds the whole signed ledger byte for byte (6 entries, 4 anchors; its
  leading bytes are S1's file), the snapshot, the live `verify` output of 11:41:26 UTC (8 passed, 0 failed, 0 unproven, 1 skipped), the outcome,
  the spend decision, the burn, the POA bridge status, the Base receipt, the order of every transaction, the gas
  of spend 3 read from an archival node, the invoice and purchase order texts, and a README that says how to
  check it again. `docs/mainnet-proof.json` records mandate 3, spend 3 with its Base transfer and anchor 4 (a
  script wrote them in the format of `pnpm proof add-tx`, so they share the one `recorded_at` of that write), and
  `contracts/deployments/mainnet.json` records mandate 3, spend 3 and the Base transfer. The judge holds the
  run's snapshot to its committed verifier output, and its new offline step `verify-mainnet-v0-a8-1113-s2` runs
  A8 on the snapshot's 3 attested decisions (entries 0, 1 and 4) with the two committed invoice texts.
  `scripts/mainnet-runbook.test.mjs` holds the records, the ledger and the runbook's S2 gate to each other, and
  the hashes in the proof file and the deployment record to the run's own records: the POA bridge status, the
  Base receipt, the outcome, the spend decision, the transaction log and the snapshot. `.gitleaksignore` skips
  one finding of the secret scan in the Base receipt, whose field `token` holds the public USDC contract address
  on Base.

- A mainnet payout to Base through NEAR Intents, kept as evidence. On 2026-11-13 the owner ran spike S1 on
  `v0.probarion.near` from their own terminal: a 1Click swap credited 1.499823 Base USDC to the vault inside
  `intents.near`, the owner set a ledger key and signed mandate 2 (1.00 USDC once, to the owner's own Base
  address), and spend 2 burned 1.00 USDC with `WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27`. The POA
  bridge released 0.9976 USDC on Base and kept a fee of 0.0024. INV-M002 is a labeled test, not a customer
  payment. Code rules alone decided it: code first refused two attested model proposals, from
  `z-ai/glm-5.3-flash` and `Qwen/Qwen3.8-27B`, with `mandate.payee_mismatch`, because each payee hint named a
  NEAR account for a mandate that pays a Base address (`payeeHintContradiction` in `packages/core/src/policy.ts`).
  `docs/evidence/mainnet-v0/s1-2026-11-13` holds the signed ledger byte for byte (4 entries, 3 anchors), the
  snapshot, the live `verify` output of 07:24:43 UTC (8 passed, 0 failed, 0 unproven, 1 skipped), the spend
  outcomes, the burn and POA bridge statuses, the 1Click quotes and status, the order of every transaction, the
  gas of spend 2, the invoice and purchase order texts, and a README that lists every transaction on nearblocks.io
  and basescan.org and says how to check it again. `docs/mainnet-proof.json` records the eight NEAR transactions
  and the Base transfer, `contracts/deployments/mainnet.json` records the top-up, mandate 2, spend 2 and the Base
  transfer, and the judge holds the run's snapshot to its committed verifier output.

- The landing page's mainnet payout section, `#mainnet`, between the ink band and the console screenshots. One
  dark card per Base payout says "A test, not a customer payment" and how the payout was decided (on 2026-11-13, by
  the code rules alone, after code refused two attested model proposals), with 1.00 USDC burned on NEAR in the
  neutral tone and 0.9976 USDC arrived on Base in the ok tone. **Read the chain now** reads the payout's 4
  transactions and 3 views again in the visitor's browser and runs seven checks, from the owner's signature on the
  mandate to the `Transfer` on Base, and each row shows the values it read. Check 03 holds the vault's code hash,
  read with `view_account`, to the recorded build whose `SpendRequest` has the 5 fields, and finds an address
  anywhere in a field's text. Check 06 hashes the ledger file's entries from the spend's decision to the root the
  anchor wrote, so the decision the spend names is inside what the chain holds. Every NEAR read goes to FastNEAR's
  archival node, with the regular node as the fallback; the views `get_config`, `view_access_key` and
  `view_account` are pinned to the spend's own block, so a later change to the vault cannot change them; Base
  answers from `mainnet.base.org`. Each request times out after 8 s and is tried up to twice more, when a retry can
  help, after 0.5 s and 1.5 s, before the next host; an answer for another transaction, or one that is not final,
  goes to the next host. The requests carry no cookies and no referrer, and none goes through Probarion's server. An
  answer the page cannot read leaves its row unread, not failed. With no JavaScript the section shows the result
  `apps/web/scripts/record-mainnet-payout.ts` recorded from public RPC
  (`apps/web/src/lib/site/mainnet-payout-recorded.json`, 7 of 7 checks). The decision trail shows the two refused
  proposals on a dashed spur off the main line and the 3 anchors as numbered gold seals, each with the entries it
  covers and its transaction, and the verifier's result links its output, the `#verify` section and the payout's own
  section of the docs page. The payouts are built from `docs/mainnet-proof.json`,
  `contracts/deployments/mainnet.json` and the evidence folder, so every count on the section comes from data and
  another payout adds a fold under the newest. On a phone each check's values fold behind a "What it read" line, and
  with no JavaScript they all show. Motion starts after the button press, under
  `prefers-reduced-motion: no-preference`, and does not loop. Tests run the seven checks on the recorded reads and on
  tampered copies (another amount, another owner, no `ft_burn`, another token in `mt_burn`, an address in the
  request, a wider key, another code hash, another `decision_hash`, ledger entries that do not hash to the root, a
  view from another block) and cover the retries, the fallback, a node that answers for another transaction and an
  aborted run. The data guard stops a payout to a wallet that `owner_wallets` in `contracts/deployments/mainnet.json`
  does not list, since the section calls it a test to the owner's own wallet. The section shows both Base payouts of
  2026-11-13, the newest at the top: spend 3, proposed by an attested model and allowed by the code rules, is open,
  and spend 2 follows folded in a closed `<details>` whose summary gives its amounts, how it was decided and a hint
  to show its seven checks and its ledger. The vault's two transactions of 2026-11-11 come after the fold, so the
  section goes back in time. The fold opens with no JavaScript, and each payout's own **Read the chain
  now** reads its transactions again in the browser. The card's line on attested decisions counts the decisions in
  the ledger that payout's verifier run read, and its pronouns agree with the count. The trail's summary counts the
  entries of the ledger file it links and the anchors on chain, as that verifier run read them. Each payout's own
  links and its button end in words a screen reader reads, such as "for spend 3", so two links with one label still
  have two names.
- A docs page, [Mainnet payouts, step by step](https://probarion.xyz/docs/start/mainnet-payout), after "Testnet and
  mainnet", for spends 2 and 3: spend 3 has its own table, its seven checks' values, how it was decided (entry 4, an
  attested model and the code rules, no refusal), ledger entries 4 and 5 and anchor 4, and the verifier run with the
  ledger of 6 entries. For spend 2: its table at a glance, what to open in a browser, the seven checks with the
  values each one read, how the payment was decided (the two proposals that `mandate.payee_mismatch` refused and why,
  then the code rules alone), the ledger's 4 entries and 3 anchors, the verifier command and its output, the bridge
  fee, the 1Click top-up and the gas, the NEAR technology the run used, and what the runs do not show. "Testnet and
  mainnet" links it, the README's Documentation table lists it, and the Docs Center has 35 pages.
- A README visual of the mainnet payout, `docs/assets/readme/mainnet-payout.svg`: 1.00 USDC burned on NEAR mainnet,
  0.9976 USDC arrived on Base, the gold bar with the coin at the Base end and ticks 01 to 07, "A test, not a customer
  payment" and the date. It draws spend 2, and its heading, title and last line say so. It is one self-contained SVG
  with real text in system fonts, in the site's paper, ink and gold, and its alt text says all of it. The README's S1
  section shows it above a table of what to do and what you see (the live button, nearblocks, Basescan, the verifier
  with the ledger file, the docs page) and a list of the NEAR technology the run used and how.

- `JUDGES.md`, a page for judges and screeners whose first part takes two minutes: the mechanism in one sentence
  (the model proposes, code rules decide, the contract checks again), three links to open (the demo vault's proof
  page with its live TEE check, the landing page's live `check_spend` and the mainnet transactions of 2026-11-11),
  `pnpm judge` with the line its offline quick run printed on 2026-11-13 (at commit 6193a71 since the Base
  payout), what is proven with its evidence and transactions, assume breach (a fooled model, the software inside
  the TEE, the agent key, the agent host and its keys) and why the TEE verdict is not enforced on chain, the worst
  case with the agent key public, priced on `v0.probarion.near` by view calls on 2026-11-13, who it is for as a
  labeled hypothesis with the unit costs the repository and the chain record, and what is not done yet. A marked
  spot (an HTML comment) waited for the mainnet Base payout, which ran on 2026-11-13 and is now the fourth link.
  The README gets a "For judges: start here" block of 11 lines (14 since the Base payout added its link) under its header and a link in its top row, and
  `AGENTS.md` links the page. `scripts/check-claims.mjs` checks `JUDGES.md` as it checks the README and
  `AGENTS.md` (links, tx hashes, accounts, paths and commands, facts), and a test holds it to that.
- `docs/evidence/mainnet-v0/gas-2026-11-13.json`: the gas and NEAR burned by the two agent-key spends of
  `v0.probarion.near` on 2026-11-11, per outcome and summed (8.3546 Tgas and 0.000769 NEAR for the paid spend, 1.8723
  Tgas and 0.000165 NEAR for the `NoMandate` refusal), read with `EXPERIMENTAL_tx_status` from an archival node on
  2026-11-13. `JUDGES.md` cites it for gas per spend.

- `probarion verify --invoice <file>` (repeatable) and `--invoices <dir>` (every `.txt` file of a
  folder) run A8 with invoice texts the auditor holds, live or with `--offline`, in the CLI built from
  this repository; release 0.1.1 on npm does not have them. The CLI reads each file on the auditor's
  computer, keys it by the sha256 of its bytes, and uses it for A8 only: it is not sent, not written
  to `--snapshot` and not printed (`--json` adds an `invoices` list with each file's sha256 and the
  ledger entries it matches). A file that matches no attested decision is listed under the rows and
  on stderr, and does not fail the run. A file or folder that cannot be read, a folder with no `.txt`
  file, or a file that is not UTF-8 text is a usage error (exit 64). `--system-prompt <file>`
  (repeatable) adds a system prompt A8 accepts besides the standard one, for a decision made under an
  agent's own `model.systemPrompt`. On 2026-11-12 the offline run on
  the demo vault's snapshot of 10:28:54 UTC with `--invoices docs/evidence/demo-vault` passed checks a
  to i, and check e found that A8 passes on all five attested decisions, entries 10 to 13 and 15
  (`docs/evidence/demo-vault/verify-a8-2026-11-12.txt`). A live run with `--online` 26 seconds later
  passed checks a to i, A8 on the same five, and O1 and O2 on all five, entry 15 among them
  (`verify-online-a8-2026-11-12.txt`). The TEE measurement is not pinned, so this does not show which
  model image ran. `docs/evidence/demo-vault/README.md` adds a dated section, `pnpm judge` adds the
  offline step `verify-demo-a8`, which runs that command and compares it with the committed output,
  and the docs, `SECURITY.md` and the README say that A8 passed on the demo vault's five and was not
  run on the Canary's two.
- The proof page checks the TEE live: a "Check the TEE now" card after the decisions, the same on
  every vault's page. The visitor's browser draws a 32-byte nonce and sends it, with no cookie and
  no `Referer`, to a new route, `GET /api/tee/check`; nothing the visitor typed or uploaded goes
  with it. The route asks NEAR AI Cloud's public attestation report for that nonce, with no API
  key, for `NEARAI_MODEL`, the model Payables is set to use, or, when it is unset, for the SDK's
  preferred private models in order until one answers. It checks up to four model attestations in
  the report, and says how many the report holds: the nonce in `report_data[32..64]` and
  `request_nonce`, the signing address in `report_data[0..32]`, O1 (Intel DCAP on the TDX quote,
  held to the SDK's policy) and O2 (the GPU payload carries the nonce, and NVIDIA NRAS verifies
  it). The browser checks both bindings again with its own nonce, and the card shows the worse of
  its verdict and the server's. A check that cannot run in time (12 seconds for NEAR AI's report,
  24 in all) is `unavailable`, not a pass or a fail. The card checks the TEE that serves the model
  now, not the decisions above it, which keep their checks A1 to A7, and the TEE measurement is
  not pinned. The route passes on five values per attestation, and their count, and nothing else
  of the report (about 290 KB). Its rate limit, `teeCheck`, is one counter of 30 a minute for all
  visitors together, so it stores nothing about a visitor, and a call that another site's page
  makes in a browser (`Sec-Fetch-Site`) answers `403 bad_origin` without spending it.
  `@nearai/inference-sdk` 0.2.1, until now an optional dependency of the CLI and an optional peer
  of the SDK, is a dependency of the web app, loaded by a literal import so the build traces it,
  with `@phala/dcap-qvl`, into the route. On 2026-11-12 a local production build of this change
  answered three calls for `Qwen/Qwen3.8-27B` with all four checks passed, in 1.8 to 10.1
  seconds, and a cross-site call with `403 bad_origin`, recorded in
  `docs/evidence/tee-check/route-2026-11-12.json`. After the promote of 2026-11-12 (#138, main
  b3baa82), probarion.xyz did the same: its first call at 18:39 UTC, the card in a browser at
  18:40 UTC and three scripted calls at 18:42 UTC (1.4 to 1.6 seconds) passed all four, and a
  cross-site call answered `403 bad_origin`, recorded in
  `docs/evidence/tee-check/live-2026-11-12.json`.
- The demo video is posted on X, in the build's demo post of 2026-11-12:
  <https://x.com/probarionhq/status/2120882499689836651>. It is a 1:57 cut recorded on the live product,
  on NEAR testnet with test USDC. The README links it from its top row of links and from the filmed run
  in "On-chain proof", and `docs/evidence/demo-vault/README.md` links it from the section on that run.
- Payables paid a second invoice on its own with an attested model, on testnet on 2026-11-12 at
  09:52 UTC, in a run filmed for the demo video, recorded in a new section of
  `docs/evidence/demo-vault/README.md`. `invoice-INV-2010.txt` (2.00 test USDC under PO-1001) went
  in on the demo vault's Payables page, signed in as the owner, while probarion.xyz ran `main` as
  promoted by PR #130. `Qwen/Qwen3.8-27B` proposed paying it (confidence 0.98) with the mandate's
  account in `address` next to the chain `base`, the shape entry 12 was refused for on 2026-11-11.
  PR #120 takes that shape as the mandate's payee, so every code rule passed, and ledger entry 15
  records `allow`, decided by `model+rules`. The agent key sent spend 5, which paid 2.00 test USDC
  to `probarion-payee.testnet`, entry 16 records it paid, and anchor 12 covers all 17 entries.
  Mandate 1 is now exhausted (5 of 5 uses, 14 of its 20 test USDC), and the vault held 11 test
  USDC after the run. At 10:05 UTC the owner froze and unfroze the vault from the console, signed
  in Meteor (the unfreeze with 1 yoctoNEAR), a second dated record after the one of 2026-11-11;
  `get_config` read `frozen: false` after. The proof page's snapshot of 10:28:54 UTC passes checks
  a to i offline with the repository's CLI (`9 passed, 0 failed, 0 unproven`): check d finds 5
  spends on chain, each bound to its own decision, and check e finds 5 attested decisions that pass
  A1 to A7. The online run of 2026-11-12 was at 01:10 UTC, before entry 15, so its O1 and O2 cover
  entries 10 to 13. The TEE measurement is not pinned, so this does not show which model image ran,
  and A8 was not run. Those are two invoices with test tokens, and Payables has not run on mainnet.
  `docs/evidence/demo-vault/` adds the invoice, the ledger of 17 entries
  (`ledger-2026-11-12-video.jsonl`), the snapshot and the offline verify output; `pnpm judge`
  checks the new snapshot offline (`verify-demo-snapshot-1112-video`) and now checks that the live
  ledger starts with `ledger-2026-11-12-video.jsonl`; `docs/mainnet-proof.json` records the spend,
  the anchor, the freeze and the unfreeze as testnet transactions. The landing page's NEAR AI Cloud
  row now gives 7 published attested decisions on testnet (2 on the Canary, 5 by Payables), 6 of
  which passed O1 and O2 online, and two invoices paid, and links entries 13 and 15 on the proof
  page. The README's Status rows for the NEAR AI Cloud adapter, Payables and the web console, its
  NEAR AI Cloud row and demo vault section, SECURITY.md, the threat model, the comparison page, the
  privacy page and the docs pages that named one paid invoice say what ran. The README's step 5
  adds that mandate 1, the demo vault's one mandate, has had no uses left since 09:52 UTC, so the
  contract refuses the MCP demo's three dry runs.

- A console try on testnet on 2026-11-12, from 03:29 to 03:36 UTC, on
  `trial.vaults.probarion.testnet`, recorded in a new section of
  `docs/evidence/trial-vault/README.md`. Claude drove the console at probarion.xyz in the owner's
  Chrome, and the owner signed six wallet prompts in Meteor. The owner signed mandate 2 on the
  Mandates tab (2 test USDC in all, held above 0.5 USDC). The same real MCP client as on 2026-11-11,
  Claude Code run headless with `@probarion/mcp` 0.1.1 from npm, asked for 1.00 test USDC under it
  for INV-3004, and the vault held it as spend 4. On the approval page Claude clicked Reject and the
  owner signed `reject`: nothing was paid, and the reservation went back to the mandate. Then the
  owner revoked mandate 2 on the Mandates tab, added a spare agent key that the Keys tab generated
  and removed it on the same tab, and withdrew the vault's whole balance, 1 test USDC, with Withdraw
  all on the Overview. The spare key's label is `payablesconsole-try-spare`, because the label field
  already held `payables` when Claude typed after it. After the run the vault held no USDC, spend 4
  was rejected, mandate 2 was revoked, and `mcp-claude` was again its only agent key. A live
  `npx -y probarion@0.1.1 verify` of the 8 ledger entries passed checks a to i
  (`9 passed, 0 failed, 0 unproven`), and the ledger's entry for spend 4 still says `held`, since no
  code writes an owner's or an approver's action to the ledger. The decision is rules-only, the
  prompt gave every tool argument, the owner is also the approver who rejected, every step was in a
  desktop browser, and this record does not check a Telegram message for spend 4. Adding an email
  alert, the Base top-up through 1Click and any change of the ledger key were not tried. The evidence
  folder now holds the invoice, the ledger, the snapshot, the offline verify output and the client's
  tool calls of that run; `pnpm judge` checks the new snapshot offline, and `docs/mainnet-proof.json`
  records its 8 testnet transactions. The landing page's status list moves Reject, revoke, withdraw
  and key removal to the console's tried row, and its other row is now "Web console: email alerts,
  Base top-up". The README's Status rows for the web console, the MCP server and the approval page,
  and the docs pages on what works today, holds and approvals, roles and keys, testnet and mainnet,
  the architecture and letting an agent pay say what was tried.

- The landing page has a "Built on NEAR, with NEAR AI Cloud" section after the status list. One
  card holds a row for NEAR, where payments are made (the vault and the factory on testnet, and
  `v0.probarion.near` on mainnet with 1 payment and 1 refusal and no Base payout yet), and one for
  NEAR AI Cloud, the model that advises (7 attested decisions that pass A1 to A7 offline, 6 of
  which passed O1 and O2 online, the two invoices Payables paid on its own on 2026-11-12, and the
  TEE image not pinned); each row links its evidence. Under the card, four cards name where
  Probarion ships: the npm public registry (`probarion`, `@probarion/core`, `@probarion/sdk` and
  `@probarion/mcp` 0.1.1, with provenance), the official MCP Registry
  (`io.github.probarion/probarion` 0.1.1), GitHub (the MIT source and the CI with the sandbox tests
  and the reproducible build) and the Chrome Web Store (the extension 0.1.0, shown with Probarion's
  own mark). NEAR's unmodified logo stands in for its name; the npm, MCP and GitHub logos sit
  unmodified above their cards' names and are hidden from screen readers, which read the names. The
  section ends with the Intel TDX and NVIDIA NRAS checks of `verify --online`, a line that no
  payout has run through NEAR Intents yet, and the trademark notices, which say no partnership or
  endorsement is implied. The README's License line now says Probarion is designed to pay through
  Base and Solana, since no payout has run there, and the 0.1.1 release row links the registry
  listing. `apps/web/test/built-on.test.ts` holds each fact to the README, the evidence, the
  ledgers and the package files, checks every link offline, and pins the paths of each logo to its
  owner's file.
- The Payables agent paid an invoice on its own with an attested model for the first time, on
  testnet on 2026-11-12, recorded in `docs/evidence/demo-vault/README.md`. At 01:09 UTC
  `invoice-INV-2009.txt`, 2.00 test USDC to `probarion-payee.testnet` under PO-1001, went in on the
  demo vault's Payables page, signed in as the owner; Claude drove the console in the owner's
  browser, and no wallet signature was needed. With `NEARAI_MODEL` set to `Qwen/Qwen3.8-27B`, the
  model proposed paying it (confidence 0.98) with the payee in `near_account` and no chain or
  address, every code rule passed, and ledger entry 13 records `allow`, decided by `model+rules`.
  The agent key sent spend 4, which paid 2.00 test USDC to the mandate's payee, entry 14 records it
  paid, and the ledger key anchored all 15 entries. Mandate 1 had then spent 12 of its 20 test USDC
  and had 1 of its 5 uses left. That payee hint did not depend on PR #120: the rule took that shape
  as the mandate's payee before the fix too. The payee hint differed in each of entries 10 to 13, by
  two models (`z-ai/glm-5.3-flash` for 10 and 11, `Qwen/Qwen3.8-27B` for 12 and 13). A live `verify`
  with release 0.1.1 of the 15 entries passed checks a to i (`9 passed, 0 failed, 0 unproven`), and
  check e found 4 attested decisions that pass A1 to A7; with `--online` all four passed O1 and O2.
  The TEE measurement is not pinned, so this does not show which model image ran, and A8 was not
  run. It is one invoice with test tokens, Payables has not run on mainnet, and its reconcile job is
  still not built. `docs/evidence/demo-vault/` holds the invoice, the ledger, the snapshot and both
  outputs, `pnpm judge` checks the snapshot offline, and `docs/mainnet-proof.json` records the spend
  and the anchor. The README's Status row for Payables is now Live on NEAR testnet, the landing
  page's status list shows it as "Live on testnet", and the NEAR AI Cloud rows, the demo vault's
  section, SECURITY.md, the threat model, the comparison page, the privacy page and the docs say
  what ran; the docs pages that said no run of `process()` was recorded now name this one.
  `pnpm judge` then checked that the live ledger started with `ledger-2026-11-12.jsonl`.

- The owner run of 2026-11-11 on testnet, from the console at probarion.xyz with a real wallet
  (Meteor): Claude drove the console in the owner's browser and the owner signed each wallet prompt,
  recorded in `docs/evidence/trial-vault/README.md`. On the demo vault the owner froze and unfroze the
  vault from the console. On `trial.vaults.probarion.testnet` the owner sent 5 test USDC from the
  Top-up tab (the USDC transfer on NEAR; the Base top-up through 1Click was not tried), added the two
  keys that `npx -y @probarion/mcp@0.1.1 init` made, from the Agent (MCP) tab, and signed mandate 1
  (at most 3 test USDC a payment and 5 in all, held above 1). A real MCP client, Claude Code run
  headless, then started `@probarion/mcp` 0.1.1 from npm with only `PROBARION_VAULT_ID` set: spend 1
  paid 0.50 test USDC, spends 2 (2.00) and 3 (1.50) were held, and the owner approved both on the
  console's approval page, where each paid. The prompt gave the tool arguments, so the client read no
  invoice, and the decisions are rules-only. A Telegram chat linked from the Alerts tab got real bot
  messages, "Approval needed" for spend 3 and "Paid" for spend 2; no email was sent. Spend 1's
  payment and spend 2's hold got no message: the watcher had recorded them before the chat was
  linked, and alerts do not send events from before, so spend 3 was sent after the link to make one
  fire. The screenshots of the approvals are from a desktop browser, so a phone is not confirmed. The
  server's `verify` and a live `npx -y probarion@0.1.1 verify` passed checks a to i
  (`9 passed, 0 failed, 0 unproven`). The same day three invoices went through the
  demo vault's Payables with an attested model, and code refused all three with
  `mandate.payee_mismatch`, sending nothing: INV-2006 (ledger entry 10, `z-ai/glm-5.3-flash`) by a
  false positive that PR #116 fixed; its retry INV-2007 (entry 11, the same model) because the
  model's payee hint named `acme-cloud.near`, which is in neither the invoice nor the prompt; and
  INV-2008 (entry 12, with `NEARAI_MODEL` set to `Qwen/Qwen3.8-27B`) by a false positive again: the
  model put the mandate's own account in `address` next to the chain `base`, since the proposal
  schema has no NEAR chain (PR #120 fixes the rule for that case). So on 2026-11-11 the Payables
  agent had not yet paid on its own with an attested model. A live `verify` of that ledger passed
  checks a to i, and with `--online` entries 10 and 11 passed O1 and O2 (a later online run could
  not fetch Intel's quote collateral); `docs/evidence/demo-vault/` holds the ledger, the snapshot,
  both outputs and the three invoices. The trial vault's evidence folder holds the run's ledger,
  snapshot, offline verify output and invoices and the client's tool calls;
  `docs/mainnet-proof.json` records the run's 14 testnet transactions. The README's Status rows for
  the web console, the MCP server (now Shipped), the watcher, the Telegram alerts and the approval
  page, the landing page's status list (the console's tried row adds the NEAR USDC top-up, the Agent
  (MCP) tab, Freeze and approvals, its other row now names Reject, revoking a mandate, Withdraw,
  removing a key, email alerts and the Base top-up through 1Click, and the MCP server row is Live) and the docs say what was tried.

- The first Probarion vault on NEAR mainnet, `v0.probarion.near`, ran on 2026-11-11 between 12:51 and
  13:00 UTC: the 2026-11 demo path of `docs/runbooks/mainnet-v0.md`, with real USDC and small amounts.
  The owner signed every transaction in their own terminal and in Meteor, and Claude signed nothing.
  The owner created `probarion.near`, then the vault, deployed the CI wasm of commit `64ac3c0` (code
  hash `3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1`), initialized it with the mainnet constants and
  locked it by deleting its only full-access key. The owner registered it on native USDC, sent it 3
  USDC, added a `spend`-only agent key and signed mandate 1, whose payee and approver is the owner's
  own Meteor wallet. Spend 1 paid 1 USDC under mandate 1 (`INV-M001`), and a spend against mandate 999
  was refused on chain with `PROBARION:NoMandate`, with no USDC moved. The vault is standalone: no
  mainnet factory is deployed. Step 6 (the Intents top-up), the Base mandate and step 10 (the first
  Base payout) did not run: spike S1 is unproven, so no Base payout has run on mainnet. The spend's
  decision is pre-ledger, the sha256 of `docs/evidence/v0-decision-m001.json`, with no signed ledger
  and no attestation. `contracts/deployments/mainnet.json` records the vault's transactions,
  `docs/mainnet-proof.json` the seven the README cites, and `AGENTS.md` the two mainnet accounts.
  `docs/evidence/mainnet-v0` holds the run's README, the output of a read-only `verify` of the vault
  on mainnet (`8 passed, 0 failed, 0 unproven, 1 skipped`, `RESULT: PASS`: checks a to h pass, and
  check i skips because there is no factory) and the snapshot it wrote, which `pnpm judge` verifies
  offline. `pnpm judge` also verifies the vault live, read-only, with the repository's evidence, and
  `check-claims --online` re-reads its code hash and access keys on mainnet. The README's Status row
  is Live on NEAR mainnet, its mainnet section gives the run and how to check it, and the docs, the
  landing page's status list, SECURITY.md, the threat model and the runbooks say what ran and what did
  not. The console and the proof pages still serve testnet only.

- The Canary page, `/canary`, has three one-click example messages above the textarea: an invoice for
  50 USDC, "We changed banks" and "Ignore previous instructions". A chip fills in its fixed text, clears
  the last answer and stays pressed (`aria-pressed`) while the text is unchanged, and the line under the
  chips says what that text usually ends as, with the rule id. With a fully fooled model, the invoice is
  refused by code with `mandate.over_per_payment` and, in raw mode, by the contract with
  `OverPerPayment`; the other two are refused with `mandate.payee_mismatch`, and raw mode does not send
  them, since the contract's dry run would accept or hold them. The real model can answer otherwise.
  `apps/web/test/db/canary-chips.test.ts` pins those outcomes through the real cycle, with a fully fooled
  fake model and a fake chain holding the Canary's mandate. "Raw mode on"
  has a tooltip (on hover, focus or tap; Escape closes it) saying what raw mode sends and its limits: 1
  per visitor every 10 minutes, 30 an hour in all. A refusal is given in words with its rule id in
  parentheses (`apps/web/src/lib/canary/reasons.ts`, one reason for each rule of the policy reference).
  A card under the form replays the team's attempt of 2026-11-10 in three steps: the model's 50 USDC,
  the code's `invoice.amount_invalid` and `custom.canary_no_autopay`, and the contract's `OverPerPayment`
  with its transaction. It is shown in every state of the page, and `rehearsal.test.ts` holds each of its
  values to `docs/evidence/canary-vault`. Rate limits, raw mode and the route are unchanged.

- Release 0.1.1 was prepared before its publish: `@probarion/core`, `@probarion/sdk`, `probarion` and
  `@probarion/mcp` are at 0.1.1, with a `## 0.1.1` section below. `packages/mcp/server.json` is the
  server's entry for the official MCP registry, `io.github.probarion/probarion` (schema 2025-12-11).
  `pnpm release:check` checks it against the tag and the package's `mcpName`, with `--pack` also
  against the `mcpName` in the packed `@probarion/mcp` manifest (the one the registry reads from npm),
  the tarball rule keeps it out of the npm package, and `scripts/test/release-manifests.test.ts` pins
  its environment variables to the ones `packages/mcp/src/config.ts` reads, with an absolute path for
  each file setting. `docs/RUNBOOK.md` has the OWNER's release steps: the
  annotated tag on `main`, the `npm-release` approval, the npm checks, then `mcp-publisher` with a token
  that can read the organization role, since the registry's device login cannot publish to an
  organization namespace yet, and how to finish a publish that stops at `@probarion/mcp`. The
  `@probarion/mcp` README said the server would be on npm once release 0.1.1 was published, and the
  README's Status table had a row for 0.1.1, In progress (both changed with the publish, under
  Changed).

- `docs/comparison-2026-11.md`: how Probarion compares with NEAR's Agent API, the x402 exact scheme on NEAR, AP2
  and plain caps, cell by cell with the sources read on 2026-11-11, and what Probarion does not have (a budget per
  period per mandate, a USD budget, a timelock, webhooks, a gas relayer). The README has a four-row summary under
  "Why it is different".
- Known gaps (THREAT_MODEL, SECURITY, the MCP README): `verify` does not run the policy again, so a program that
  holds both the agent key and the ledger key can skip `decide()` and still pass, inside the mandate. Run
  `@probarion/mcp` as another OS user or in a container when the agent host has a shell tool, and keep
  `PROBARION_AGENT_KEY` and `PROBARION_LEDGER_KEY` out of a client config the agent can read.

- The Canary's signed ledger, published as evidence in `docs/evidence/canary-vault`:
  `ledger-2026-11-10.jsonl`, the vault's whole ledger as it stood on 2026-11-11, which the owner
  exported read-only: 5 entries from the team's own three attempts of 2026-11-10 and no visitor's.
  Beside it are `snapshot-2026-11-11.json`, the snapshot a live `verify` with that ledger wrote, and
  the run's output, `verify-2026-11-11.txt`, which passed checks a to i. Check e finds 2 decisions by
  NEAR AI Cloud's `z-ai/glm-5.3-flash` that are attested and signed and pass A1 to A7 offline.
  `verify-online-2026-11-11.txt` is a live run with `--online` the same day, at 07:43 UTC, which also
  passed the online checks O1 and O2 on both: each TDX quote is a genuine Intel TDX quote (Intel
  DCAP, debug off, an accepted TCB status, which can be `OutOfDate`) whose report data holds the
  signing address and the entry's nonce, and NVIDIA NRAS verified each GPU payload, which carries
  that nonce. The TEE measurement is not pinned, so this does not show which model image ran, and A8
  was not run, since the ledger holds no invoice text. A first online attempt failed O2 with
  `not_yet_valid`, because the computer's clock was about 3 s behind NVIDIA's, and passed after a
  clock sync. The folder's README lists the 5 entries, with what the model proposed and what the
  code and the contract did, says what check e shows offline and online and what it does not, and
  gives the offline command, the live one and the online one; the live and online ones stop passing
  check c once the Canary anchors an entry the file does not have. The CLI's `verify --offline`
  refuses `--online`, so O1 and O2 do not run on the snapshot from the CLI; the SDK's
  `verify({ snapshot, online: true })` runs them on a snapshot it is given. The README, SECURITY.md,
  the threat model and the docs pages that said no real attested decision was recorded now say this
  with its date and its limits, and link the evidence and the online output; those docs pages list
  both files among their sources. The privacy page and the home page's model step say it in short,
  with the date and the limits, and the status row "Live attested model run" reads "Checked online
  on testnet, image not pinned", and stays Preview. `apps/web/test/canary-vault.test.ts` runs the
  checks on the committed snapshot, holds the README's table to the ledger cell by cell, pins the
  online run's output, and pins what the README, SECURITY.md, the threat model, the privacy page, the
  docs pages, this entry and the rehearsal's rows say about it.

- `pnpm judge` (`scripts/judge.mjs`): one read-only command for a screener or a judge, run after
  `pnpm install --frozen-lockfile`. It builds the four packages, then runs steps 0 and 2 to 6 of the
  README's 5-minute evaluation, the eval check and the per-package tests of core, sdk, cli, mcp and
  `examples/402`. The claims check runs offline and online; the README's step 2 and step 4 snippets and
  its step 6 commands run as written, and their output is compared with the README's; `verify --offline`
  runs on every committed snapshot in `docs/evidence`; the demo vault, `v0.probarion.testnet` and the
  Canary are verified live, read-only, and the demo vault's live ledger must start with the committed
  one; the MCP demo and the 402 demo run. Each step quotes the README line it proves, found again at
  run time, and prints one row: PASS, EXPECTED-FAIL (the Canary verified without its ledger fails check c, and
  `v0.probarion.testnet` fails d and h, as the README says; any other result there is a FAIL), SKIPPED
  with the reason and the command, or FAIL. It exits 0 only when no step failed and writes
  `judge-report.json` (gitignored): the claim, README line, command, result, expectation, time and
  detail of each step, with the commit, Node and OS. `--offline` makes no network call, `--quick` skips
  the tests and `--json` prints the report. SKIPPED is only for a step not run here (the flags, the
  network down, a timeout, 429 or 5xx); a definite wrong answer, such as the proof page answering 404 or
  the MCP demo skipping its verify for that reason, is a FAIL, and the MCP demo row passes only when its
  6 steps answer as expected or with a note. The package rows give the README's dated test count next to
  today's, and the `examples/402` row checks that every test of `test/pay-per-call.test.ts` passed.
  Child processes get no `PROBARION_*` variable and no other variable named like a secret, the MCP demo
  runs with an empty home folder so its server finds no keys file, and a README snippet that names a key
  (or, in an offline step, reaches the network) is refused before it runs. AGENTS.md and the README's
  5-minute section start with it, and
  `.github/workflows/judge.yml` runs `pnpm judge --offline --quick` daily and on pushes to `main`, with
  read-only permissions and the actions pinned at the SHAs of `ci.yml`. The web console's tests and the
  Rust tests are listed as known skips with their commands.

- The eval's adversary run: the model fully fooled. For each of the 20 invoices the proposal is what
  the invoice asks a fooled model to do (the attack's own amount, account and mandate for the six
  injected ones, the wrong action the invoice presents for the eight that must not be paid, the right
  action for the six clean ones), marked attested with confidence 1, through the same `decide()`,
  contract mirror, `execute()` and owner wait as the other runs. Offline and deterministic, with no
  model and no key. Result: "model fully fooled: money moved wrongly 0/20 (0.00 USDC)"; 14/20
  proposals are wrong and the code's rules refuse all 14 (the contract layer, the checks.rs
  mirror's refusals only, stops 4 of them on its own, and the owner rule holds or refuses 8). `eval/results/adversary.md` gives every case's proposal, decision, contract answer,
  money (count and USDC) and stopping layers, with what each result assumes: I-02's injection is
  not shown to a model; D-01 is decided as if the intake guard missed it; P-01, P-02 and D-02 rest on
  one code rule each; and a model fooled only into approving the visible invoice pays I-02, I-04 and
  I-05 their own total (430.00 USDC to the mandate's payee), counted as paid rightly. A test tries
  over 5,000 other attested proposals across the 20 cases and finds none that moves money wrongly.
  `eval:check` holds the new file and `latest.json` to the code. The layer tables now label the
  contract row "contract (checks.rs mirror, refusals only)" and say why the payee cases are not
  among its stops: a spend names no destination, so the contract pays the mandate's payee. In the
  adversary run the extract layer counts only text that does not reach the code, since the adversary
  obeys I-02's injection although the reader drops it. The attack log gives each case's layers per
  run: the adversary line has its own, and the last line says which run it is for.

- `@probarion/mcp` gives the client server instructions for the model when it connects (the MCP
  `instructions` field; each client decides whether its model sees them), under 1,200 characters.
  Where a tool description or an answer note already states a rule, the instructions use the same
  sentence from a shared constant, and a test compares them, so those rules cannot drift; a few
  words of their own orient the model. The rules: only the payee of an active mandate bound to the
  server's key can be paid, with no recipient parameter; `check_spend` first when unsure, since it
  sends no transaction (its description now says so in those words); each ref and each invoice
  hash pays at most once; poll a `held` spend until it leaves held or its `held_until` passes,
  after which the contract approves no hold, and do not send it again (the `request_spend` note
  for a hold now says the same); an `unconfirmed` spend may have paid, so do not resend it under a
  new ref; a refusal is final for that request; `burned` is final for the vault and does not
  change, worded for the server's network. A server with no keys adds that `request_spend` is off,
  and that refusal now says no agent and ledger keys are set (a keys file counts too) in place of
  naming the two environment variables.

- `/proof/<vault>/payments.csv`: the vault's decisions as a spreadsheet, linked as "Download payments
  (CSV)" next to the snapshot download. One row per decision, newest first: date (UTC), mandate and
  label, the payee of the spend on chain (empty when nothing was sent), amount in USDC, the decision
  and why, each spend bound to it with its status on chain, when the snapshot read the chain, the
  spend transaction with its explorer link, the invoice's SHA-256 and the ledger seq. The header row
  is the same in every file, and the capture time is also in the file name. The file is the route's
  own snapshot, like snapshot.json, so it can be older or newer than the page's. RFC 4180 with a UTF-8 BOM and
  CRLF, and an apostrophe before any `=`, `+`, `-`, `@`, tab or CR that starts a cell: at the start
  of a field, and after a `;` or a line break in it, for Excel in locales that split on semicolons.
  Same access and rate limit as snapshot.json. The HTTP API reference now lists the three proof
  files, and `docs/evidence/demo-vault/payments-2026-11-09.csv` is the demo vault's, made from its
  snapshot by a test. The Mandates docs page says the payee needs no NEAR: it only receives USDC, and
  there is no NEP-366 relayer.
- `examples/402`: negotiation, receipts and a one-line demo. The paywall has a list price and a floor
  (the least it takes, kept out of every answer), and `POST /counter` takes one counter per quote:
  below the quote and at or above the floor it answers with a new quote at the countered price;
  otherwise `409`. When a quote is above what a live mandate can pay (its cap per payment, or what is
  left of its total when less), the agent counters once at that limit and pays the new quote, or
  walks away without calling `request_spend`; under a mandate with no payment left it does not
  counter, and Probarion's refusal names the reason. The payee still comes from the mandate, and the
  quote parser still refuses unknown lines. After a paid `200` the agent checks the data against a
  schema and the `data_sha256` the seller states, and appends a line to `receipts.jsonl` (quotes,
  list and paid price, spend, what `request_spend` answered, transaction, ledger seq, check, time); a
  failed check is recorded as failed, and the money is not refunded. The paywall builds the paid
  answer before it marks the quote used, so data it cannot build leaves the payment redeemable.
  `pnpm --filter @probarion/example-402 run demo` runs a walk-away, a negotiated sale with its payout
  and a refused call on the SDK's test double chain, with no network and no keys, even when keys are
  in the environment, and prints its elapsed time (about a second here); `run demo --testnet`, with a
  vault and its keys in the environment, runs the same calls on testnet. On 2026-11-11 `run demo
  --testnet` ran on `percall.vaults.probarion.testnet` (spend 21 paid 0.01 for a 0.012 list price); its
  output, receipt, ledger, snapshot and verify report are in `docs/evidence/402-vault`.

- `/proof/<vault>` lists every decision of the ledger under the checks, newest first. For a decision
  made with model output it shows what the ledger records the TEE saw and signed, and what the code
  and the contract checked, with A1 to A7 run on the page's snapshot and a fixed line on what they
  leave open: the TDX quote needs `verify --online`, A8 needs the invoice. Each card has the audit
  anchor `#seq-N`, and `#spend-N` for each spend bound to it, and check (e) links to the section.
  Past the newest 20, a decision shows its summary line and anchors; `?seq=N` opens its full card.
- The console's Payables invoice page links its decision's card on the vault's proof page (Audit
  link) when that page is public.
- `scripts/check-claims.mjs` (`pnpm check:claims`), a checker of the README's claims that runs
  straight after `git clone` with Node alone: no install, no build and, offline, no network. It
  reads README.md and AGENTS.md (links also in SECURITY.md, CONTRIBUTING.md and the evidence) and
  checks that each link and anchor resolves, each transaction hash and account is in
  `contracts/deployments`, `docs/mainnet-proof.json` or `docs/evidence`, each Status row has a known
  marker and an existing path, each path, `pnpm` script and script command exists, and the versions,
  counts and other facts it knows match the code, with exactly one `probarion-claim:` marker for each
  claim id of section 17 of the interfaces spec, and the summary line the README quotes has the
  shape the checker prints (a `<n>` for each count). It checks claims, not whether the code works.
  It exits 0 when every claim matches, 1 when one does not (printed as `file:line [check] what is
  wrong`) and 2 when it cannot run. Without the full git history (a shallow clone) it skips the
  claims about the git history, and its last line says so. `--online` adds read-only checks of the
  chain (the named vaults' code hash and keys; that each cited transaction exists, was signed by an
  account the records name, a `spend` by the vault itself, and shows the error code, event or memo
  its row gives), the site's health route, the Chrome Web Store item and npm, and exits 2 when an
  endpoint does not answer. CI runs it offline through the real-repository test in
  `scripts/check-claims.test.mjs`, which fails on any claim that does not match; the ts job of
  `.github/workflows/ci.yml` checks out the full history (`fetch-depth: 0`), so the git-history
  claims are checked there too, and `scripts/ci-workflow.test.mjs` pins that checkout. The README's
  evaluation starts with it as step 0. Its first run found three claims,
  fixed where they are written: the short text of the INV-2003 approve transaction in the README
  ended in FJf instead of NCJf; `trial.vaults.probarion.testnet`, the vault that Create a vault made
  with Meteor on 2026-11-05, was in no record and is now under `trial_vault` in
  `contracts/deployments/testnet.json` with its `create_vault` transaction; and `EVAL-REGRESSION` had
  no marker, which is now on the eval:check test in `apps/web/test/eval/replay.test.ts`.
- `@probarion/mcp`: `probarion-mcp init`, a keys file, and `probarion-mcp status`, so the agent's keys
  stay on the user's machine and an MCP client's config needs only `PROBARION_VAULT_ID`.
  `init --vault <id> [--keys-file <path>]` makes the agent key and the ledger key and writes them to
  `~/.probarion/<vault>/keys.json` (format `probarion-mcp-keys/1`, mode 0600, opened with `wx` so an
  existing file is kept: a second run checks it and prints the same public keys). The file and, outside
  Windows, each folder it adds an entry to are synced before the public keys are printed. It prints only
  the two public keys, the `probarion agent add` and `probarion ledger set-key` lines (the console's Agent
  (MCP) tab gets no link until it is live, and the console does not serve mainnet yet), and that a backup of
  the folder holds the two secret keys, with the CLI's Windows and git warnings. The server and `status` take
  their keys from both `PROBARION_AGENT_KEY` and `PROBARION_LEDGER_KEY`, else the file
  `PROBARION_KEYS_FILE` names (which must exist), else the default keys file, else run read-only. One key
  from the environment with the other from a file is refused, and the server's first line on stderr names
  the source. A keys file must be for this vault and its network, with each secret key matching its public
  key and two different keys; a problem names the file and the field, with no value from the file. The
  vault id is checked as a NEAR account id before it goes into a path. `status` only reads, and prints ok,
  not yet or fail for the keys (a keys file other users can read fails, outside Windows), the vault (not
  frozen), the agent key (a function-call key limited to `spend`, with allowance left), the ledger key (the
  vault's, limited to `anchor`), an active mandate bound to the agent key, the vault's USDC, and the local
  ledger against the latest anchor (the single-writer check, run dry), with one next step when not ready:
  the first fail that has one, else the first not yet. Exit code 0 when ready, 1 when not, 2 for a
  configuration error. `init` and `status` print their commands the way the binary was started (`node` and
  the path of `bin.js` from a clone), and a usage error echoes only a flag or a word, so a secret key passed
  as an argument by mistake is named by its position alone. The README's set-up is now init, the owner's
  two keys, status, and the client's config; keys in the client's config stay as the fallback.
- `@probarion/mcp`: the single-writer guard before `request_spend` also checks that the server's own ledger
  key signed every entry after the vault's latest anchor, and refuses with `LEDGER_KEY_MISMATCH`, sending
  nothing, when another key did (a keys file swapped while the ledger file stayed). The vault's next anchor
  would cover those entries under the current ledger key, and `verify` check a would fail for them.
  `status` runs the same check, says to anchor such entries with their key before the owner sets the new
  one, and does not suggest a new ledger key for a vault that another process anchors from its own ledger.
- The console's Agent (MCP) tab, `/console/<vault>/agent`, after Keys: the owner connects their own
  AI agent (Claude Code, Claude Desktop, Cursor or Codex) to the vault through the MCP server. Built,
  not tried yet.
  - The agent makes its two keys on its own machine (`init`). The owner pastes only their public
    keys, and the page refuses a pasted secret key in the browser, so it is not sent. The agent
    key's label is public on the vault, so the page and the server action refuse a label that holds
    a key (`ed25519:`, or a base58 run of 40 characters or more), and the field does not cut a long
    paste. Two owner-only server actions read the chain again at click time and return `add_agent`
    and `set_ledger_key` for the member's own vault, with the vault kind's gas allowances, for the
    owner's wallet to sign. Nothing is stored: these keys have no database row.
  - A vault has one ledger, so the ledger key is withheld from a vault whose ledger another writer
    keeps: hosted Payables (its active ledger key, its entries, or a ledger key it made) or anchors
    signed by another key. On testnet the page then links "Create a vault for this agent"; on
    mainnet it says vaults cannot be created there yet. An unused ledger key is replaced only after
    a danger confirm.
  - Steps 5 and 6 give each client's settings, which carry only `PROBARION_VAULT_ID`, with the
    Windows form for each client, and a status card read from the chain: both keys and their gas
    left, an active mandate for the key, the vault's USDC, and who keeps the ledger. A vault id
    that ends in neither `.near` nor `.testnet` also gets `NEAR_NETWORK`, in the settings and in
    the `init` and `status` lines. Until `@probarion/mcp` 0.1.1 is on npm (`MCP_ON_NPM` in
    `apps/web/src/lib/agent/connect.ts`), the page builds the server from a clone. Approvers and
    viewers see the status card only.
  - "Check these keys" runs from a form, so Enter works, moves the focus to the first field with an
    error, and says its result in a status region. Before anything is pasted, step 3 shows the keys
    the chain already has, as step 6 does.
  - `probarion-mcp init` and `status` link the tab on testnet. `status` offers it for the ledger key
    only on a vault with no anchor yet; otherwise it gives the `probarion ledger set-key` transaction.
- The Keys tab lists the keys on the vault that Probarion did not make, under "On the vault, held
  outside Probarion", with their allowance and Remove for an agent key. When the vault's ledger key
  is one of them, "Generate ledger key and set it in my wallet" shows a red notice and asks in a
  danger dialog first, as a ledger key made there would stop that agent. When the vault's keys
  could not be read, that dialog says it is not known whether the user's own agent holds the
  ledger key.
- The landing's status list adds the Agent (MCP) tab to the console's "Built, not tried yet" row.
- The overview's "Your first agent payment" card offers its keys step two ways, hosted Payables on
  Keys or your own AI agent on Agent (MCP), and ticks it when the chain shows an agent key and a
  ledger key that the console did not make.
- `@probarion/mcp`: `probarion-mcp demo [--vault <id>]`, a read-only tour of the five tools against
  the live testnet demo vault. It needs no key and signs and sends nothing. It shows the tools and
  their fields, the live caps, the contract's `check_spend` answers (ok, held, `OverPerPayment`), an
  injected `to` field refused by the schema, a paid spend, and verify on the public ledger. A frozen
  vault is reported as a note (exit 0); an RPC that does not answer marks `list_mandates`,
  `get_spend_status` and `verify` as failed, skips the dry runs, and prints the server log (exit 1).
  Also `--version` and `--help`.
- `@probarion/mcp`: `mcpName` `io.github.probarion/probarion` and keywords in package.json (at
  0.1.0 then), and README setup for Claude Code, Codex CLI, Claude Desktop and Cursor, with the Windows
  `cmd /c` forms.
- A testnet record of the Canary, in `docs/evidence/canary-vault`: its accounts, its mandate, the
  2026-11-10 rehearsal whose raw spend the contract refused with `OverPerPayment`, and a live
  `verify` run with its snapshot. The run passes check f (no full-access key, only the ledger key and
  a spend-only agent key) and fails check c, because the Canary's ledger is private and the run
  checks the chain's 4 anchors against an empty ledger; the folder's README says which checks that
  leaves meaningful. The threat model's claim C9 now says Yes for the Canary vault, with that run,
  and the README has a section for it. Claim C8 says Yes for the demo vault, whose recorded snapshot
  passes checks a to i from a clone, in place of "N/A today".
- A phone-sized approval page for each held spend, `/console/<vault>/approve/<spend>`, which the
  "Approval needed" alert now links to, by Telegram and by email (roadmap G2). An approver taps the
  link, signs in with their NEAR wallet when they have no session in that browser, and approves or
  rejects in their own wallet, through `@hot-labs/near-connect`. On a phone that is Meteor Wallet,
  its app or its web wallet, on testnet, where the console runs; NEAR Connect offers HOT Wallet on
  mainnet only. It has not been tried on a phone with a real wallet yet.
  - The amount, the payee, why the spend is held, the time the hold has left and the Approve and
    Reject buttons, each the full width, come first, on a phone's first screen; the invoice and the
    mandate's caps follow. One line says what the wallet signs. Long account ids wrap. The page
    is held to WCAG AAA: every text colour reads at 7:1 or more, text is 14px or more with a line
    height of 1.5, and every control is 44px tall.
  - The page reads the spend from the chain (`get_config`, `get_spend`, `get_mandate`, at final
    finality) and shows the amount, the payee, the mandate, why it is held (its amount is above the
    mandate's `approval_above`), when the hold ends, and the invoice hash and ref the vault recorded.
    It names and links the console's invoice only when the console sent this spend from it (the
    chain's hash and ref, and the console's outcome for that invoice is this spend), and shows the
    invoice's own amount beside the spend's. An invoice that only has the same hash and ref, which an
    agent can reuse, is shown with a warning. Amounts to an Intents payee are read in the payee's
    asset, not the vault's token.
  - Approve is offered only for a spend the chain reads as held, and approve and reject only to an
    account on the vault's approver list on chain. An approver the console still lists, whom the chain
    no longer does, gets neither. Approve is not offered while the vault is frozen, after the hold has
    run out, or for a revoked mandate, and reject stays. Other members see the spend and who may
    approve it; anyone else gets a 404, as on every vault page. A spend id that is not a whole number
    from 1 is a 404 before any chain read.
  - The server signs nothing. The page hands the approver's wallet the vault's `approve` or `reject`
    with exactly 1 yoctoNEAR, the wallet must be the signed-in account, and the vault checks all of it
    again when the transaction runs.
  - A signed-out tap goes to sign-in and comes back to the same page.
  - The overview's held card links each held spend to its page.
- `@probarion/mcp`, an MCP server that gives an AI agent a Probarion vault to pay from, in
  `packages/mcp`. It was not on npm then and ran from a clone: `node packages/mcp/dist/bin.js`, over
  stdio. Five tools: `list_mandates` (payee, caps, what is left, uses left, approval threshold,
  expiry), `check_spend` (the vault's free `check_spend` view), `request_spend`, `get_spend_status`
  and `verify`. No tool takes an address, every input rejects fields it does not know, and amounts go
  in as USDC decimal strings (claim `MCP-NOADDR`, `packages/mcp/test/safety.test.ts`). No tool
  creates, changes or removes a mandate, a key or the vault's settings.
  - The server holds the vault's `spend`-only agent key and `anchor`-only ledger key, and no owner
    key. Without the two keys it runs read-only and `request_spend` is off.
  - `request_spend` names a mandate by id and runs `decide()` from `@probarion/core` and the
    vault's `spend`, signs the decision into the vault's ledger and anchors it. No invoice text or
    purpose document is read, so the purpose rule passes. The MCP client's reasoning is stored as an
    unattested proposal prefixed `mcp:`, so `verify` reports these decisions as rules-only. A second
    request with the same ref pays nothing; it is refused and names the vault's spend under that ref
    (`earlier_spend`). A hold with no spend on chain says no approver waits on it.
  - Before each payment the server checks that its ledger file holds every entry the vault's latest
    anchor covers, with the same root, and otherwise stops with `LEDGER_FORK_RISK` and sends nothing.
    That catches another writer once it has anchored; `verify` check d finds one that has not.
  - Settings come from the environment (`PROBARION_VAULT_ID`, the two keys, `NEAR_NETWORK`,
    `NEAR_RPC_URLS`, `NEAR_ARCHIVAL_RPC_URLS`, `PROBARION_LEDGER_PATH`). A key must be a valid
    ed25519 secret key, and an RPC URL must be `https://` (`http://` only on this machine) with no
    user name or password; a problem is named by its variable, with no value. Errors and log lines pass
    through a filter that masks secret keys and cuts every URL to its origin.
  - 103 tests, among them an end-to-end run over the SDK's fake chain and a stdio JSON-RPC session.
- The pay-per-call example in `examples/402` (a private workspace package, testnet only). An HTTP
  endpoint answers `402 Payment Required` with a quote: a price, a payee and a short text. An agent
  pays the text's sha256 through `@probarion/mcp` under a mandate, with `402:<quote id>` as the ref,
  and sends the call again with the spend id and the redeem token the 402 gave it. The endpoint
  serves it only if the token matches, the paying vault was created by the factory (its
  `vault_version` view), and the spend is `paid`, to the seller's account, for the full price and
  for this quote's hash, at a block time before the quote expired; each quote serves one call. The
  agent pays under the lowest-numbered mandate for the payee that can still take the amount, and
  reads a held spend until it is paid before it calls again. Run its test with
  `pnpm --filter @probarion/example-402 run test`: 20 calls are paid and the 21st is refused with
  `mandate.uses_exhausted`. It is not an implementation of x402 or of any other payment protocol.
- A testnet record of that example, in `docs/evidence/402-vault`: on 2026-11-09 the vault
  `percall.vaults.probarion.testnet` paid 20 calls at 0.01 test USDC under a mandate of 20 uses,
  and the 21st was refused by code (`mandate.uses_exhausted`, nothing sent), as the contract's
  `check_spend` view also answered (`UsesExhausted`). Its live `verify` passes checks a to i; the
  ledger, the snapshot (with the 21 anchors) and the setup and spend transactions are in the folder.
- The Docs Center at `/docs`: 34 pages in six sections (Start here, Concepts, Build, Verify &
  trust, Operate, Resources), with a home of four doors (new here, owner, developer, evaluator). Each page
  was written from the code and checked against it in a separate verification pass. Each guide,
  tutorial and explanation marks what is Live, Preview or Planned; the sidebar's legend says what
  Preview means. Every page but the docs home has a source box with the date it was reviewed, the
  commit it was built from and the files it was checked against, and a "Copy page" button.
  - The reference tables are rendered from typed lists that tests pin to the code, so a table that
    drifts fails CI: the vault's 14 checks in their order, every `PROBARION:` code with the call
    that raises it and what to do next, the SDK and HTTP errors, the verifier's checks a to i, and
    the status list.
  - The reference pages: SDK reference (every export of `@probarion/sdk` and
    `@probarion/sdk/testing`), Policy rules (every rule id `decide()` records), CLI reference (every
    command and option, and who signs what it prints), Contract reference (every vault and factory
    method), Events (every NEP-297 event and its fields), HTTP API (every route under `/api`),
    Limits and costs (every cap, deposit and gas figure), Reproducible builds (rebuild a contract
    and match its code hash) and Architecture (a diagram of the parts, each tied to its code). Each
    table is data that its own test, `apps/web/test/docs-ref-<area>.test.ts`, reads against the
    code, so a command, method, event, route, rule or constant added or removed in the code fails
    CI until the page follows.
  - A Changelog page, `/docs/resources/changelog`, renders this file as it stands in the build.
  - Every owner and approver command carries a callout naming who signs it. A test checks every
    CLI line in the pages against the CLI's own commands and options, and each callout's signer
    against the CLI's owner and approver calls.
  - Search opens with Ctrl K or ⌘K, from the docs bar or from the home's search box. It loads a
    static index of every page but the home on first open and finds pages, error codes and CLI
    commands. An exact error code, or a pasted `PROBARION:<Code>` line, ranks that code's row in
    the catalog first, and opening a result moves focus to it. Without JavaScript, the search links
    go to the home's list of popular searches.
  - Every page has a Markdown twin at `/docs/<page>.md` whose first lines name the date it was
    reviewed and the commit it was built from. `/llms.txt` lists the pages, and `/llms-full.txt`
    holds them all for AI agents, with `X-Robots-Tag: noindex`.
  - A section's address, such as `/docs/build`, redirects (308) to its first page.
  - The landing's SDK and CLI cards link the developer quickstart and the install page, and its
    outcome statuses link "What each status means".
  - A Playwright spec, run locally and not in CI, checks the home's fold at 1440×900, the keyboard
    path through search, the sidebar's current link, the table of contents and its scroll-spy, the
    phone drawer, sideways overflow at 390 px, the twins' headers, the section redirects, the
    install page's code tabs, the 404s, the docs without JavaScript and a blocked or missing
    clipboard.
- A Canary attempt stores the source its link named: `/canary?via=x` stores `x` in the new column
  `canary_attempts.via` (migration `20261108000014_canary_via.sql`). The set is closed (`home`,
  `x`, `share`, `readme`, `proof`, `tamper`, `ext` and `usage`, in
  `apps/web/src/lib/canary/via.ts`). Any other value is stored as no source, and the attempt runs as
  before. Nothing is recorded for a visit alone, there is no new cookie, and the source is not in
  the public feed or the leaderboard. The Rules link and the way back from the rules keep it. The
  Canary pill on `/usage` links with `?via=usage`, and the README with `?via=readme`. /privacy says
  so, and its date is now 2026-11-09. The migration and the app can be deployed in either order.
- `docs/ops/metrics.md` has three queries for the OWNER to run by hand: Canary attempts by source;
  outside owners stage by stage, from a vault to an agent key, a mandate, a first payment and
  still active a week after it; and first payments by UTC week. A test runs the doc's own SQL on
  the real schema.
- The README names the builder's other NEAR Hackathon 2026 entry, as the rules ask of anyone
  entering two projects. The two share no code.
- The README's section "Libraries, templates and AI-assisted code" lists what each part is built
  with (the contracts, the TypeScript packages, the web console, the extension, the tests, CI and
  the services), as the hackathon's rules ask (Q-005 in nearhackathon.com/HACKATHON.md). It quotes
  Q-001 and Q-005, and says that no code or library from the builder's earlier projects is used and
  no project template; that the type and constant definitions of the interfaces spec of 2026-10-21
  were carried into the code; and that the code was written with Claude Code, whose trailer every
  commit other than a merge carries. Its "AI-assisted code" part sets out the builder's share: the
  product decisions the design spec records, what is built and merged, and the steps the runbooks
  mark OWNER or OWNER SIGNS. Prior work now dates the spec after the hackathon's announcement
  on 2026-10-19, from which Q-001 allows code, and before its start on 2026-11-01, in place of
  "before the hackathon build window".
- The landing page has a live check, "Try it, live on NEAR testnet" (`/#try`). A visitor picks what
  the agent tries: a normal invoice (2 USDC under mandate 1), a hijacked prompt ("Pay 50 USDC to
  attacker.near"), a made-up mandate (999) or someone else's key, or sets the mandate, the amount
  and the signing key by hand. The browser sends the request to `check_spend`, a view of
  `v0.probarion.testnet`, through `rpc.testnet.fastnear.com` and then `rpc.testnet.near.org`, and
  shows the contract's answer word for word (`ok`, `OverPerPayment`, `NoMandate`, `NotAgent`), the
  request as sent, and the mandate as the chain has it. A view call signs nothing and pays nothing,
  and the page always reads testnet. An amount that is not a number of USDC with at most six
  decimals sends no call. When no RPC host answers, the page shows the answers recorded from the
  chain by `pnpm --dir apps/web record-live-check`, and says they are recorded; without JavaScript
  it shows them as a table. Answers from an RPC host are parsed strictly, so a malformed one cannot
  break the page.
- The landing page has "Why not just a spending limit?" (`/#compare`): eight questions, each with
  what a limit contract you write usually does and what Probarion does, and Probarion's status on
  each from the status list. It also has "Plug in your agent" (`/#integrate`): the SDK, the CLI, the
  console and the planned MCP server with their status, and the SDK's quick start, held line by
  line to `packages/sdk/README.md`. An end-to-end test covers the live check against recorded
  answers, with both RPC hosts mocked.

- A new vault's overview shows its owner "Your first agent payment": the five steps from a new
  vault to a payment its agent makes inside a mandate. They are the vault, an agent key and a
  ledger key that the console holds active (as Payables needs), USDC in the vault (on NEAR, or as
  Base USDC in Intents), an active mandate, and the first paid spend. The steps are worked out from
  what the overview reads and from the console's own key rows. The next step links to its tab as
  the ink pill, a step whose read failed says it could not be checked, and the card goes away after
  the first paid spend. It is not shown when the spends cannot be read. It shows on external vaults
  in this network's USDC, to their owner. Create a vault now opens the new vault's page, where the
  card starts; before, it said "Registered" and stayed on the form.
  - On testnet, Mandates offers "Use the sample PO". It fills the form from a sample purchase
    order: 5 test USDC a payment, 20 in all, 5 payments, 30 days, paid to the owner. The PO is
    hashed in the browser as it is served, and the form refuses it unless the hash is the pinned
    one. Payables offers "Use the sample invoice", a 2 test USDC invoice with a fresh invoice
    number each time, sent with the same PO attached. The files are in
    `apps/web/public/samples/`. Mainnet offers neither.
- The ledger test on the landing page, each Canary answer and each proof page whose checks ran now
  end with a link to the next page. On the landing page, a run the verifier failed ends with
  "Caught." and a link to `/proof`. A Canary answer ends with "Put limits like these on your own
  agent", and a proof page with "Put your agent behind a mandate"; both link to the console. They
  ended at GitHub or an explorer.
- The console has a Top-up tab. The owner sends USDC on NEAR from their own wallet to the vault. On
  mainnet only, the owner can also ask 1Click for a quote that tops up the vault's Base USDC balance
  inside NEAR Intents, and signs the deposit in their own wallet. On testnet, which has no Intents or
  1Click, the tab says so, names the stand-in contract and the test token, and offers only the NEAR
  USDC funding.
- Before the owner is asked to sign a 1Click deposit, the server checks the quote's signature against
  1Click's key (pinned in the code and tested against the SDK's default) and that the signed request
  is the one the console sent: this vault as the recipient inside Intents, the owner as the refund
  address, the assets, the amount, the slippage and the referral, with no extra routing fields. It
  refuses a deposit address that is the vault, the owner or a token contract, and a quote that is
  stale, more than 5% above the amount, open past the deadline asked for, or with times that do not
  state their time zone. A refused quote shows its reason and offers nothing to sign.
- The Top-up tab does not offer a quote again after a deposit was sent or may have been sent, after
  1Click stopped reporting its address as waiting, past its deadline, or when the amount typed
  changed. A cancelled or failed wallet attempt does not lift those guards. A new quote request clears
  the old quote and is switched off while the wallet is open.
- A testnet faucet, so anyone can fund a testnet vault. On a testnet vault's Top-up tab, the owner
  presses "Add test USDC", and `POST /api/topup/faucet` mints 25 test USDC straight into the vault,
  not into a wallet. It works once a UTC day per vault, for 3 vaults a day per owner account and for
  50 vaults a day in all, and only at the testnet address, for a signed-in owner whose vault the chain
  agrees on; everyone else gets 404. It signs as `probarion.testnet` with `TESTNET_FAUCET_KEY`, a
  function-call key that can call only `mint` on `usdc.probarion.testnet`: before each mint the route
  reads the key from the chain and refuses a full-access key or one low on allowance, with nothing
  counted. The amount and the vault come from the server, not the request. A mint whose outcome is unknown answers with its hash and is not sent again. Without the
  key, the tab says to ask @probarionhq. The key is masked in logs, and `docs/RUNBOOK.md` has the
  steps to set it up.
- Owner-only top-up routes `POST /api/topup/quote`, `POST /api/topup/submit` and
  `GET /api/topup/status`, rate-limited per account, which answer fixed sentences rather than
  1Click's own error text.
- Public site in the light brand design, deployed at <https://probarion.xyz>: a landing page
  with real testnet transactions, the path of one payment and a list of what works and what does not;
  a beta strip on every page, a header with a phone menu that works with no JavaScript, a footer, and
  plain sign-in, not-found and error pages. Open Graph and Twitter cards, an icon, `robots.txt` and
  `sitemap.xml`.
- The site's ledger test runs the real `runChecks` from `@probarion/core` in the visitor's browser on
  a committed test fixture of five entries signed with test keys. Three edits (an amount, an erased
  refusal, a refusal turned into an approval) each show what the verifier catches when an edit was
  not re-signed.
- `/proof` with no public vault is a real page, with a form that opens `/proof/<account>`, an inline
  error for an invalid account, and the ledger test.
- Tests that hold the site's named facts to the deployment record, the README, `SECURITY.md` and the
  contract source.
- Web console deploy checks, run with its tests: every environment variable the console reads is
  listed in `.env.example` with secrets left empty, no secret can reach the browser through a
  `NEXT_PUBLIC_` name, migrations stay ordered and portable to a hosted Supabase, every scheduled job
  has a GET route that reads `CRON_SECRET`, and no browser code can import server-only code.
- `apps/web/vercel.json` and a first-deploy checklist for the owner, `docs/runbooks/web-deploy.md`
  (Supabase, secrets, Vercel settings, a smoke test).
- Community files: a pull request template with Safety and Review sections, bug and feature issue
  forms (blank issues are off; vulnerabilities go to the private channel SECURITY.md names),
  `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1).
- CI: one `verify` check that needs every other job and passes only when each one succeeded (a
  skipped or cancelled job fails it), for branch rules to require. When a gate in the TypeScript,
  Rust unit or sandbox job fails, the job posts the last 60 lines of that gate's log as one annotation
  and in the job summary.
- A 1280×640 social preview image for the repository page, rendered from the brand by a script that
  refuses any other size.
- Vault contract (`probarion-vault` 0.1.0). The owner creates mandates, each with a payee fixed at
  creation (a NEAR account, or a Base or Solana address paid out through NEAR Intents), a limit per
  payment, a total, a number of uses, an expiry and an amount above which an approver must confirm.
  The agent's function-call key can call only `spend`, which has no recipient argument. The vault
  also has held spends with `approve`, `reject` and `expire_held`; a daily backstop per UTC day;
  `freeze`, `unfreeze`, `withdraw` and `withdraw_intents` for the owner; ledger anchors whose
  sequence goes up by exactly one; the free `check_spend` dry run; NEP-297 events; and 24 readable
  `PROBARION:<Code>` errors. Every owner and approver method that moves value or changes authority
  takes exactly 1 yoctoNEAR, which only a full-access key can attach; `freeze` takes none.
- Factory contract (`probarion-factory` 0.1.0). It creates `<name>.<factory>` vaults with no access
  keys, from vault code published as a global contract and referenced by hash, or from wasm it stores,
  keeps a registry of versions, and refunds the deposit when a vault cannot be created. It is not
  deployed on any network yet.
- Test contracts for the sandbox and testnet: `intents-stub` stands in for `intents.near`, and
  `test-ft` for USDC and the POA tokens. Neither is meant for mainnet.
- Contract tests: a unit test for every error code, property tests of the accounting invariants
  (spent plus reserved stays within the total; an invoice is paid at most once), and near-workspaces
  sandbox tests of the key limits, holds, payouts and the factory, which run in CI on Linux.
- Reproducible contract builds in CI (cargo-near 0.22.0 in Docker, pinned by digest), with each
  recorded build's code hash in `contracts/code-hashes.json` and compared on every pull request
  into `dev` or `main` and every push to them.
- Testnet deployment on 2026-11-01: the test tokens, the intents stub and the vault
  `v0.probarion.testnet`, which has no full-access key and runs the recorded reproducible build.
  Its smoke run paid 1 test USDC to a NEAR account, burned 1 test USDC with a `WITHDRAW_TO:` memo for
  a Base address, and was refused with `NoMandate`. The transactions are in
  `contracts/deployments/testnet.json`.
- The testnet demo vault `demo.vaults.probarion.testnet`, run end to end through the console on
  2026-11-09: created through the factory, given an agent key and a ledger key, filled from the faucet
  and given a mandate. Payables paid 2 test USDC, then 4 test USDC once its approver approved the hold,
  refused a changed-bank invoice with `mandate.payee_mismatch` in the signed ledger, and refused a
  re-sent invoice on upload. Its proof page is public, and `/proof` on probarion.xyz opens it. A live
  `npx probarion verify` passed checks a to i. The invoices, the ledger, the snapshot and the
  verifier's output are in `docs/evidence/demo-vault`; the transactions are in the `demo_vault`
  block of `contracts/deployments/testnet.json`.
- The landing page's payment journey ends with those four invoices: one card each says what the invoice
  asked, what the vault did (paid, refused on upload, refused by code, held then paid) and links the
  invoice file, its transactions and its lines in the signed ledger, then the demo vault's proof page.
  A test holds each card to the evidence files and the deployment record.
- "The console" on the landing page, after the ink band: three screenshots of the testnet console from
  2026-11-09, taken while a fifth invoice (INV-2004, 4 test USDC) went through the demo vault. They show
  the spend held for an approver, the invoice's page in Payables, and the vault's spends once the
  approver approved it with near-cli. Each caption names the network, the date and the vault, and links
  its transaction where it has one; on a phone the row scrolls sideways. The images are WebP files in
  `apps/web/public/shots/`, and a test reads each one's size from its header.
- Deploy and smoke scripts for testnet, runbooks for testnet, the factory and the planned mainnet
  vault (each signing step is the owner's), and `pnpm proof` for the mainnet evidence file.
- Web console, in progress: wallet sign-in with near-connect and NEP-413, checked on
  the server, with a signed session cookie; a Supabase schema with row-level security on every table,
  tested in PGlite; vault creation through the factory, with the CLI as a fallback; a vault overview
  with balances, NEAR runway, freeze and the held spends to approve; a keys page where the owner adds
  the agent and ledger keys from their wallet with the public key only; mandate creation for a NEAR
  or Base payee, with the same validation in the browser and on the server, and revocation; and a
  Postgres ledger store whose entries core's `runChecks` verifies.
- Web console, the public proof page (built and tested): `/proof/<vault>` shows a vault
  whose owner made its proof public. The result comes first: "All offline checks pass" (green), "Not
  proven yet" (amber) or "A check failed" (red). Then come checks (a) to (i), each with explorer links
  on the vault's own network, and the vault's cross-chain burns. When a burn is not proven, the page
  names the spend and the reason and gives the command that proves it. A private vault's page is
  shown only to its members, and anyone else gets a 404. `/proof` opens the demo vault set in
  `PROBARION_VAULT_ID` when its page is public. `NEAR_ARCHIVAL_RPC_URLS`, which is optional, lets the
  page read older burn transactions.
- Proof page downloads: `snapshot.json` (the ledger and chain data the checks ran on, for
  `probarion verify --offline`) and the vault's signed ledger as `probarion-<vault>-ledger.jsonl`
  (for `probarion verify --ledger`). Both have the page's access rules and rate limit, and a
  browser does not reuse an old copy. The page shows its snapshot's `taken_at` exactly as the verifier
  prints it, so a reader can tell when a download is the very snapshot the page checked. Until the
  `probarion` package is on npm, every command on the site and in the deploy runbook is shown as run
  from a clone of this repository (four set-up commands, then `node packages/cli/dist/bin.js`), and
  the tests run those commands as shown.
- Web console, Payables pipeline (built and tested): `POST /api/console/[vault]/invoices` takes an invoice (a PDF, a text
  file or pasted text) together with the purchase-order document hashed into a mandate, and runs
  the reference agent. Code rules decide, the vault contract pays the mandate's payee, and each
  payment is signed with the agent key its mandate is bound to.
- Payables pays an invoice by itself only when an attested private model on NEAR AI Cloud confirms
  the amount the code read. Without such a model (rules-only), nothing is sent: the invoice waits for
  the owner with the amount the code suggests. The model is shown the code's amount, so it confirms
  that amount rather than reading the invoice independently. A later SDK change will hide the
  amount from the model.
- Payables amount reader: it reads an amount only from a document that names itself an invoice, and
  only from a plainly written final total line in USD or USDC. It refuses everything else with a
  reason the console shows (`not_found`, `ambiguous`, `unreadable`, `currency`, `truncated`, `zero`
  or `not_payable`). That covers receipts, quotes, statements, credit notes, purchase orders, paid,
  void or test stamps, other currencies, totals in columns or split across lines, amounts after the
  total, and look-alike or hidden characters. Its tests hold 1,670 adversarial inputs, a ReDoS
  sweep of every pattern it uses, and three corpora of realistic invoices, with no wrong amount. On
  realistic invoices it reads about half and refuses the rest with the reason.
- Payables storage and duplicates: an invoice is stored sealed with a per-vault key, or as hashes
  only in zero-retention mode. A payment whose confirmation is pending is not sent again. A
  re-upload of a paid or pending invoice is answered as a duplicate when its normalised text, or
  its invoice number for the same payee (kept as a keyed HMAC), matches. Uploads are limited to
  4 MiB per file and 4 MiB + 64 KiB per request. The migration
  `apps/web/supabase/migrations/20261108000006_invoices.sql` adds the invoice tables.
- Web console, Payables pages (built and tested against a fake chain, not yet tried with a real
  wallet): upload an invoice with its purpose document, see every invoice with its status in
  plain words, and open each one to see what the model wanted, what the code allowed and what the
  contract did, with explorer links for the payment and the ledger anchor. Zero-retention can be
  switched on there, and the page says what is kept. The migration
  `apps/web/supabase/migrations/20261108000007_invoice_confirm.sql` adds what these pages need.
- An invoice that waits for the owner shows, before any button, the amount, why it waits, the mandate
  as the chain shows it, the invoice line the amount was read from, who uploaded it, and every invoice
  of the same payee from the last 90 days with equal and near amounts marked. Confirm is not offered
  when that list cannot be read, when the payee is unknown, or when the retained text cannot be read
  or does not hash to the hash the owner signs. Reject stays available, and the page names the cause.
- The owner can pay a waiting invoice with a wallet signature: the server builds the message from
  database and chain values only, checks it against a full-access key of the vault's on-chain owner
  at a final block, and pays exactly the amount shown, once, even after a double click. A confirmation
  is single-use, expires after 5 minutes, and a new one ends the earlier unused one.
- Each owner confirmation is kept in the signed ledger with its signature, key, nonce and message, so
  the signature can be re-checked from the ledger entry against the decision it sits in. The block of
  the key check is the server's record: whether the key was the owner's at that block takes an archival
  node, and `probarion verify` does not check the confirmation yet.
- The owner can reject a waiting invoice; nothing is paid. The same text then comes back as a
  duplicate, and a corrected invoice counts as new.
- If the server does not answer after the owner signed, the page says the payment may have gone out
  and not to pay again; only a failure before that says nothing was sent. A row whose cycle is not
  recorded shows "not recorded yet, do not resend" and names the ref to read on chain. Such a row stays
  in that state until the reconcile job is built.
- The invoice reader accepts invoice numbers whose only digit is a 0 or 1 beside a letter, such as
  INV-C1. After the invoice word on a title line it refuses a status or document word in any token,
  such as `Invoice PAID1001`, `Invoice DEM01` and `Invoice void-2`, and a vendor named Test24 Labs
  before that word still reads. A Title-case word with a look-alike digit is not an invoice id, and an
  invoice-to or invoice-from label is not a title. Read rates on the realistic corpora did not change.
- The Canary challenge has its backend, `POST /api/canary/attempt`: anyone can send text to a
  deliberately gullible AI accounts-payable agent and try to talk it into paying. The Canary does not
  pay from its own cycle: a code rule refuses every attempt, and the answer shows which rule refused
  and why. Its page, feed and scoreboard are described below.
- In live mode, a "pay" the code refused is also sent to the contract unfiltered, but only when the
  contract's own free dry run says it would refuse it, so visitors can watch the contract's refusal
  (for example `OverPerPayment`); the dry run makes sure such a spend pays nothing. This is limited to one on-chain
  attempt per visitor every 10 minutes and 30 an hour in total, stops by itself when the agent key's
  allowance drops below 0.2 NEAR, and is not started with less than 15 seconds left.
- Nothing the Canary puts on chain is derived from the visitor's text alone: the transaction carries
  a salted hash, fresh for every attempt and not stored, so nobody can confirm a guessed text from a
  public explorer.
- The Canary's ledger cannot be made public: a model can quote what visitors type, and a public
  append-only ledger could not take it back, so the database refuses it on every path, the console
  included. Attempts are stored as hashes and labels only. The public feed shows labels, outcomes and
  transaction hashes, with no visitor or IP identifiers; an attempt still running is left out until it
  is 90 seconds old, then shown as killed. The leaderboard is read on the server only.
- One Canary attempt is bounded at 50 seconds: the model calls share 30 seconds, a chain step takes
  at most 8 seconds, and an attempt that runs out of time ends as failed (or "unconfirmed" for a
  transaction) and is not retried. An attempt that gives up on a step still running keeps the
  Canary busy for 90 seconds instead of starting another cycle beside it.
- The Canary has a public page at `/canary` and its rules at `/canary/rules`. A visitor writes a
  message to a deliberately gullible model and sees what the model wanted, what the code rules decided
  and what the contract did. The vault's balance and mandate are read from the chain, and the
  scoreboard and the latest attempts come from the database behind a short cache. When the live
  Canary is paused, a replay is chosen, or no vault is set, the page shows the recorded attacks
  instead. The page opened on NEAR testnet on 2026-11-10 (see Changed).
- The Canary closes itself instead of running dry: it does not run while its ledger key holds under
  0.5 NEAR; it answers 429 with `Retry-After` over 6 attempts an hour from one address (an IPv6
  address counts by its /64), 60 an hour or 600 a day in total; it closes when its ledger holds 300
  entries; and its model calls share a daily token budget that counts an attempt from the moment it
  starts.
- The site has a public Usage page at `/usage` that counts team vaults, external owners and Canary
  participants apart, for the network the app runs on. It shows counts and not dollar volumes, with
  the last 7 days beside each total, the model tokens a decision uses, and how each number is
  counted; a price in dollars appears only once one is set from NEAR AI's price list. A daily job
  computes the numbers, and the page refreshes them when they are an hour old. The Canary rules link
  to it.
- Each Canary attempt is recorded with the network of the Canary vault it was made on, so a mainnet
  Canary and a testnet Canary keep separate numbers on the Usage page.
- The daily usage job also deletes the rate limiter's rows older than a day, so that table no longer
  grows without limit. Applying the database update computes the usage numbers of the existing
  history.
- The watcher, `GET /api/cron/watch`, reads each vault registered with the app: its spends,
  mandates, anchors, refusals by the contract, low agent and ledger key allowances and low NEAR,
  and records each once in `vault_events`. It runs daily on Vercel and right after an invoice
  upload or a Canary attempt for that vault. `docs/ops/watcher.md` also sets out a per-minute
  Supabase Cron job, not yet run or tested.
- Owner alerts: an owner or approver can get a Telegram message or an email when a spend is held
  for approval, the contract refuses a spend, a spend is paid or paid out to Base, a payout fails,
  an agent or ledger key's gas allowance runs low, or the vault runs low on NEAR. Each goes out
  once per alert and event, not for a vault's old history, and a viewer sees addresses and chat
  ids masked. Every message says how to stop: the email's own stop link (and a mail client's
  one-click unsubscribe), the bot's `/stop`, or Remove on the new Alerts tab
  (`/console/<vault>/alerts`). The channels switch on once the owner sets `TELEGRAM_BOT_TOKEN` and
  `RESEND_API_KEY` (`docs/ops/alerts.md`).
- The web console serves testnet and mainnet from one deployment. The network of a request is the
  address it was opened at (`APP_ORIGIN_MAINNET`, `APP_ORIGIN_TESTNET`), with a Testnet | Mainnet
  switch in the header once both are served. Sessions, vault pages, the watcher and metrics jobs,
  alerts, the Canary board and `/usage` are per network, and a vault of the other network shows a
  card with a link to its own address. The per-network settings (`NEAR_RPC_URLS`,
  `PROBARION_FACTORY_ID` and four more) each have a `_MAINNET` and a `_TESTNET` form
  (`docs/runbooks/web-deploy.md`, section 3.5).
- The SDK takes a deadline: `RpcClient` `remainingMs`, `NearApiJsSender` `sendTimeoutMs` as a
  function, and `NearAiProposer` `remainingMs` and `knownModel`. All are optional, and the
  defaults are unchanged.

- Uptime monitors can check each address of the site: `GET /api/health` answers 200 when the
  deployment can read its settings and 503 when it cannot; `GET /api/health/rpc?provider=<n>` checks
  one NEAR RPC provider of that address's network (the right chain, and a block under two minutes
  old); `GET /api/health/nearai` checks that NEAR AI Cloud's public model list answers. Answers are
  cached for 30 seconds and do not include a key or a configured URL.
- A `/status` page on each address shows the live checks for that address's network, links to the
  other network's status page when that address is served, and says that funds stay in your own
  vault, under your own keys, if the service is down. The header's Status link opens it.
- Errors reach Sentry once `SENTRY_DSN` is set; until then the SDK is off. Each logged error becomes
  one issue per log key, tagged with its component. The Payables upload, the Canary attempt and both
  cron routes also tag the request id of their log lines, so one error can be matched to its logs. A
  failure of the root layout shows a plain "Something went wrong" page with a reference id.
- `docs/RUNBOOK.md`, an incident runbook for both networks: severity levels, the first 15 minutes,
  what a vault owner can do alone, freezing, withdrawing and unfreezing with the CLI printers (the
  owner signs every transaction), key rotation, RPC failover, burned cross-chain payouts, alerts,
  top-up, rate limits, deploys and migrations, status posts and a postmortem template. The runbook
  lint now checks it too: **OWNER SIGNS** above every mainnet send, and 1 yoctoNEAR on every one-yocto
  call.
- `docs/ops/MONITORING.md`: the health routes, the uptime monitors before and after each network gets
  its own address, the watcher heartbeat, the status page to create, and what Sentry receives, with
  its tags, alert rules and data scrubber fields.
- `/.well-known/security.txt` (RFC 9116) on every address, with the X account as the contact, a fixed
  expiry, one canonical URL per address, and links to the policy and its acknowledgments.
- `docs/THREAT_MODEL.md`: eleven attacks, each with the test, code path or testnet transaction that
  backs it; the hosted service's own surfaces; what a full breach of Probarion's servers could and
  could not do; failure modes, trust assumptions, known gaps; and the first security review's log. A
  test fails if it cites a safety claim that has no marker in the code.
- `/security`, `/terms` and `/privacy` pages. Every link on the site now opens a real page; nothing
  reads "coming soon" any more. Security sits in the footer beside Terms and Privacy.
- A browser smoke test of the built site runs locally with `pnpm --filter @probarion/web test:e2e`,
  after `pnpm build`. It builds with test settings only, and needs no wallet, database or chain. It
  serves both networks, testnet at `localhost:3100` and mainnet at `127.0.0.1:3100`, and checks that
  the header fits on each address at 375, 1120, 1280 and 1440 px. It is not in CI.

- A signed-in Browser extension page, `/extension`, connects the Probarion browser extension to
  your account on one network. Connect makes a 30-day connection and hands it only to the page
  itself, for the extension to take; "Show a code instead" shows a one-time pairing code that works
  for ten minutes, and warns that whoever enters it first gets the connection. Connected browsers
  lists each connection by its last four characters and its times, and Revoke ends it. The page
  says the extension is not released yet. The console header links it.
- The extension's server side, at the address of each network: `POST /api/ext/pair` exchanges a
  pairing code once for a connection token; `GET /api/ext/inbox` lets a token read what waits for
  you on its network: invoices waiting for the owner, held payments an approver can still approve,
  and the mandates an invoice can still be sent under; `POST /api/ext/revoke` ends the caller's own
  connection. Pairing is rate-limited per IP address and for the whole network, the inbox per account
  and network, and Connect and Show a code share one limit per account and network. An account keeps
  at most 5 connections per network: a sixth ends the oldest.
- Migration `20261108000013_extension_tokens.sql` stores the connections and pairing codes.
- A connection can queue an invoice for the vault's owner: `POST /api/ext/invoices` takes the
  vault, the mandate the member picked and the file (a PDF or a text file, at most 4 MiB), for a vault
  where the connection's account is the owner or an approver, 20 per account and network in 10
  minutes. It reads the invoice as the console upload does, runs the mandate's payee check (core's
  `payeeHintContradiction`) and the vault contract's free `check_spend` view, and stores the
  invoice waiting for the owner, with the checks it passed and the hold `extension.mandate_chosen`.
  It runs no cycle, calls no model, opens no key and sends no transaction. Only the owner's
  wallet-signed Confirm in the console pays it, and the contract checks that spend again. The same
  invoice sent twice gives one row, and the second answer says it is a duplicate.
- An invoice with an unclear amount, a mandate that cannot take invoices (revoked, expired, used up,
  or with a payee Confirm cannot name), keys Confirm cannot sign with, a payee that contradicts the
  mandate's, or a spend the contract would refuse is refused with its reason, and nothing is stored.
  A Canary vault takes no invoices from the extension.
- Migration `20261108000015_extension_queue.sql` adds `invoices.source` and
  `invoices.queue_checks`, and `invoice_queue`, which stores an extension invoice in one
  transaction and refuses one without the `extension.mandate_chosen` hold.
- The Chrome extension, `apps/extension` (Manifest V3, Chrome 127 or newer), loaded unpacked; it is
  pending Chrome Web Store review since 2026-11-10. Connect it from the console's Browser extension page, or with a
  one-time code. Its badge counts the invoices and holds that wait for you and refreshes every 5
  minutes; `!` on the badge means the connection has ended. Right-click selected invoice text or a
  link to an invoice file on the same site, or open the popup on a PDF or choose a file: the popup
  reads the invoice, lets you pick a vault and a mandate, and queues it for the vault owner's
  wallet-signed Confirm in the console. It can't pay or approve, and says so under Send. It explains
  a refused invoice in plain words, shows "Already queued" for a second send of the same invoice,
  and checks in the browser what Probarion would refuse anyway (4 MiB for a file, 50,000 characters
  of UTF-8 text).
- `pnpm --filter @probarion/extension build` writes the release build to `apps/extension/dist`;
  `build:dev` also trusts `http://localhost:3000`. `zip` packs the release build into the store
  zip, the same bytes each time, and `render` redraws the icons and the five store images with a
  local headless Chrome. `apps/extension/store` holds the listing, the permission and data-use
  answers, the notes for the store reviewer and the upload steps; `apps/extension/TESTING.md` is the
  manual checklist, run before each upload.
- The I-HITL replay, a sandbox test in `contracts/integration-tests/tests/ihitl.rs`
  (`ihitl_replay_the_agent_cannot_raise_its_own_limit_or_approve_itself`). It replays, with the
  vault's agent key, the attack of the I-HITL paper (Breckenridge et al., arXiv:2610.35835), whose
  agents raised their own wallet limits by reading the passcode emailed to the owner. The test checks
  that a spend over `max_per_payment` fails with `OverPerPayment` and that one above `approval_above`
  is held. It checks that the node refuses each of the agent key's attempts to approve its own
  spend, create a bigger mandate, add keys, unfreeze, withdraw, call the USDC token, add a
  full-access key, deploy code, send NEAR or batch a key with a spend, before any contract code runs
  and with its exact `InvalidAccessKeyError` variant. It then checks that the mandate, the config,
  the agents and the held spend read back byte for byte as before, that the keys keep their nonces
  and scopes, and that only the approver's account's `approve` pays. Like the other sandbox tests, it
  runs in CI on Linux. The /docs page "The agent key cannot approve itself"
  (`/docs/trust/self-approval`, in Verify & trust) maps the paper's recorded run, and the steps the
  test adds, to the control that stops each, the layer and the evidence, with the testnet
  transactions that show three of the test's steps. It says how to run the test, and lists what it
  does not cover: an owner or approver key within the agent's reach, a payment split under
  `approval_above`, the MCP client's config, the email stop link and the single approver, and that
  it replays no model and runs only on a sandbox. The
  README's safety architecture and attack 7 of the threat model cite it, and the threat model's known
  gaps add the first two.
- Eval: 20 synthetic invoices (6 prompt-injected, 4 PDFs) run offline through the production reader,
  fact reader, mandate choice and `decide()` with the pipeline's custom rules, plus mirrors of the
  SQL intake duplicate guard, the SDK's `execute()` and the pipeline's owner wait; no transaction is
  built or sent. Rules-only results are committed: the code layer alone stops 8/8 of the invoices
  that must not be paid, with 0/20 false refusals, and 9/20 are held for the owner. In rules-only
  nothing can be sent by design, so its money moved wrongly (0/20) is not a result. The model replay
  is not recorded yet (the OWNER runs `pnpm eval:record`; a failed model call is recorded and decided
  rules-only, as the SDK does). See `eval/README.md`.

### Changed

- The README, JUDGES.md, `docs/TRACKS.md` and the docs follow the other changes of 2026-11-13. They now say what
  the payee check is: `probarion payee check` and the `/check` page give allow, warn or block with reasons,
  read-only, in this repository and not in npm 0.1.1, and `/check` is live from the deploy that ships it. On
  2026-11-13 at 20:44:51 UTC, and again at 22:26 UTC, `probarion-payee.testnet` with `--vault v0.probarion.testnet`
  printed ALLOW, and at 22:26 UTC the owner's mainnet payees printed WARN. The live check's text follows the
  landing: "An inflated invoice" answers `OverPerPayment`, "A hijacked prompt" answers `ok` and the page says the
  attacker gets 0, and the recorded fallback is from 19:08 UTC on 2026-11-13 (block 277550985). The README's web
  console row is Live on NEAR testnet for its tried parts, with email alerts and the Base top-up not tried, and
  names the hero's S2 card, "Ask the mainnet contract", the no-clone verify blocks and the page order, and the
  proof page row gives that page's new order. The README also has a Status row for the payee check, the `/usage`
  mainnet record, the `/canary` attempt box and an ops line for `node scripts/smoke-live.mjs`. The footer links
  "Payee check" (`/check`, so also the sitemap) and "Run a pilot", and `apps/web/e2e/a11y.spec.ts` checks `/check`.
  In the docs, Evaluate in 5 minutes gives the same live check answers, and the SDK reference and Install name the
  `./payee` entry point and `payee check`'s use of `NEAR_ARCHIVAL_RPC_URLS`. JUDGES.md's gas row says `/usage`
  shows the mainnet gas from the deploy that ships it, and the README counts 145 Playwright tests in `apps/web/e2e`
  (`playwright test --list`). `check-claims` also reads `docs/agent-market-2026-11.md`, which `docs/TRACKS.md`
  links from track 07. The package test counts are re-measured, each with its package's own `test` script on
  Windows at 22:20 UTC on 2026-11-13: 888 in `@probarion/core`, 824 in `@probarion/sdk` (none skipped), 364 in the
  CLI and 197 in `@probarion/mcp`; `pnpm judge` quotes the first three. `docs/evidence/mainnet-v0/README.md` and
  `docs/measurement-pin-2026-11.md` add dated sections for the no-clone verify and the landing row's new words.
  Check: `node scripts/check-claims.mjs` and `pnpm judge --offline --quick`.
- Review fixes for the integration. The no-clone verify blocks in the README and JUDGES.md say that probarion.xyz
  serves `/samples/mainnet` from the deploy that ships this commit, and give the same files on
  raw.githubusercontent.com as the fallback. Each "live after the next deploy" now reads "from the deploy that
  ships this commit", which stays true after the deploy. The landing's new scenarios carry it too, with what the live
  page showed at 23:17 UTC on 2026-11-13: its hijacked prompt asked 50 USDC and got `OverPerPayment`. The S2 claims
  at the top of the README and in JUDGES.md carry the caveat that the TEE measurement is not pinned, and the README
  calls S1's two refusals false refusals where it names them. The new `docs/evidence/payee-check/2026-11-13.txt`
  holds five read-only payee checks of 23:10 UTC on 2026-11-13 with their exit codes: the testnet payee ALLOW,
  `attacker-eval.testnet` BLOCK, `probarion-duonq.near` (one letter off mandate 1's payee on mainnet) BLOCK, and
  the owner's two mainnet payees WARN. JUDGES.md has a "What is proven" row for it, and the README's no-clone check
  has a sixth step, `/check`'s "One letter off". The README's "NEAR technology used, and how" now comes right after
  Contents, and "Check it in 60 seconds" is "Check it with no clone", since no one timed it. `docs/TRACKS.md` 06
  says what the Canary's raw mode skips (the SDK's preflight and the code rules, not the contract's dry run) and
  adds INV-2002, the "We changed banks" invoice that code refused on testnet on 2026-11-09 (ledger entry 3). The
  seed blocklist's two names are said to come from eval cases and test fixtures. The web console's 9,647 is pinned
  to commit 2b97c27, and `scripts/smoke-live.mjs` names JUDGES.md's "The worst case today".
  `.github/workflows/no-clone-verify.yml` no longer fails its job when a Node 22 step fails, so the first run there
  decides the Node 22 line without a red check. Check: `node scripts/check-claims.mjs` and
  `pnpm judge --offline --quick`.

- The front door. The README's top is a 30-second story with S2's mainnet test payment (0.25 USDC sent, 0.2476
  arrived on the owner's own Base address), the worst case today read live from `v0.probarion.near` at 19:01 UTC on
  2026-11-13 (`docs/evidence/mainnet-v0/worst-case-2026-11-13.json`) with what a leaked ledger key or the owner's
  account could do, the re-check of every decision with the no-clone mainnet verify block in Bash and PowerShell and
  O1 and O2 on mainnet, an install table, a no-clone check, a by-track table, a sourced and dated answer to "why not
  a policy on NEAR's Agent API or OutLayer?" and who it is for. JUDGES.md is rewritten: the worst case first with a
  read-only Node command that needs no clone, five links in order (the first with the same verify block), one Node 24
  setup, one CLI convention and today's `pnpm judge` summaries. The README's "For judges: start here" block and
  JUDGES' "Worst case, priced" give way to these sections. The new `docs/TRACKS.md` answers each track brief in its
  own words with "Brief asks | Probarion | Evidence" tables and honest "Not built" rows, and `check-claims` now reads
  it. The README's dated package test counts are those of 2026-11-13, and `pnpm judge` quotes them. Check:
  `node scripts/check-claims.mjs` and `pnpm judge --offline --quick`.
- The landing leads with mainnet. The hero's mainnet card is S2 of 2026-11-13, filled from the recorded payouts
  alone: 0.25 USDC burned on NEAR, 0.2476 USDC arrived at the owner's own Base address and the POA bridge kept
  0.0024, on a proposal by the attested `z-ai/glm-5.3-flash`. Its TEE line links the online run of 17:52 UTC (TEE
  image not pinned), and its "Read the chain now" link scrolls to `#mainnet` and starts that payout's check. On a
  phone the cards come right after the buttons, and the mainnet record after the cards. `#mainnet` moves up under
  the live check. It adds a dated line on that later run under S2's verify, "Ask the mainnet contract" and the
  no-clone verify. The question sends one `check_spend` view of mandate 1 a click from the browser: 1 USDC is
  allow, 2 USDC is block `OverPerPayment`, as the chain answered at 19:35 UTC on 2026-11-13, and any failure shows
  "Could not read the chain, try again." with no verdict. The verify gives the Bash and PowerShell blocks, each
  with a copy button, that download the vault's ledger from `/samples/mainnet` and run `npx probarion@0.1.1
  verify` on mainnet. The live check names each verdict allow, warn or block, with times in UTC. Its hijacked
  prompt asks 2 USDC for `attacker.testnet` and says the attacker gets 0, and "An inflated invoice" asks 50 USDC
  (answers re-recorded at 19:08 UTC, block 277550985). The nav puts Mainnet second and calls the status board What
  works, and `/status` is System status in the footer. The testnet beta strip names the mainnet vault, the hero
  links the 2-min demo, and the live attested model row reads "Checked online on testnet and mainnet, image not
  pinned". Under 1260 px the integrate section's accounts and statuses sit under the code, so no account runs
  past the page edge. Check: `pnpm exec vitest run test/site-facts.test.ts test/mainnet-ask.test.ts` in `apps/web`.

- Docs status words now match the landing's board and the records. "Holds and approvals" is Live (testnet holds
  approved on 2026-11-09 and 2026-11-11, a rejection on 2026-11-12) and "The ledger and anchors" is Live (the SDK's
  ledger on `v0.probarion.near`, 6 entries and 4 anchors, a live verify that passed on 2026-11-13). The console,
  its Keys tab and the testnet faucet read Live where their tried status rows do, with email alerts and the Base
  top-up still Preview. The quickstarts and "Let an agent pay" stay Preview, since their own steps have not run
  as written, and the developer quickstart no longer says no rules-only `process()` has paid (S1 did, on
  mainnet). The docs home's developer door starts with `npx -y @probarion/mcp@0.1.1 demo` (no key), then
  `npm install @probarion/sdk @probarion/core`, and drops its untimed "15 min". New:
  `docs/agent-market-2026-11.md`, marked not built: how market.near.ai jobs are posted and paid (read
  2026-11-13), why a spend-only key cannot sign its delegated `ft_transfer`, and what a mandate paying its
  treasury would need. Check: `pnpm exec vitest run test/docs-status-labels.test.ts` in `apps/web`.
- `/canary` puts the attempt first. Its title is now "Fool the model. Watch the contract say no." ("Watch the
  code say no." in code-only mode, where nothing reaches the contract), and the "Your attempt" card sits right
  under it, above the vault card. One line over the form says how many have tried, from the leaderboard the page
  already reads: outside visitors first once there are any (the smaller of browsers and addresses, "at least"),
  the team's own attempts apart. The form drops the line once the visitor's own attempt is answered. With the
  testnet board as read on 2026-11-13 (0 outside attempts, 6 by the team) it reads "6 attempts so far, all by the
  team. Be the first visitor.", and the scoreboard shows that line instead of three tiles of zeros. A board that
  cannot be read shows no line. `?via=tg` is a new source for links sent on Telegram (the database's check is a
  shape, so no migration), and `docs/ops/metrics.md` lists it. Nothing seeds an attempt. Check: in `apps/web`,
  `pnpm exec vitest run src/lib/canary/copy.test.ts src/components/canary src/app/canary` (0, 1 and many visitors).
- `scripts/check-claims.mjs` says what it is doing while it runs, on stderr: first
  `check-claims (progress): reading up to <n> files`, with a note that the first run on a fresh Windows clone can
  take a few minutes, then `<n> files read` every 500 files. Most of a first run is reading each file once (in a
  fresh local clone on 2026-11-13 UTC it read 1,151 of 1,398 files, 1,018 of them for the claim-marker scan).
  stdout keeps the problems and the one summary line, and `pnpm judge` still reports a crash by its own error line
  (`scripts/check-claims-progress.test.mjs`). The SDK's two tests of a recorded NEAR AI Cloud decision no longer
  skip while they wait for a recording: `packages/sdk/test/fixtures/nearai-recorded/decision.json` is built from
  entry 4 of the committed mainnet ledger of `v0.probarion.near` (S2, 2026-11-13) and its invoice INV-M003, a
  labeled test paid to the owner's own Base address. A new third test holds its context, invoice text, proposal
  and evidence to those two files, and the body hash to spend 3's `decision_hash`; the other two pass A1 to A7 and
  A8 offline (these tests run no online check, so O1 and O2 are not part of them). Check with
  `node scripts/check-claims.mjs` and, after `pnpm install --frozen-lockfile` and
  `pnpm --filter @probarion/core build`, `pnpm --filter @probarion/sdk exec vitest run test/nearai.recorded.test.ts`.
- A vault's proof page tells its story first. Three lines under the vault's name, counted from the snapshot the
  checks ran on and dated with its full `taken_at`, say what the vault has paid out on chain and how much, how
  each paid spend was decided (after an attested model proposed it, with A1 to A7 passing; on the code rules
  alone; or before the signed ledger), and how many decisions the code rules refused or held and how many
  payments the contract refused, by rule or code. The "Check the TEE now" card moves up, right under the result
  and above the checks. The 3 newest decision cards show; the next ones, up to 20, fold under "Show the next N
  decisions", and an audit link still opens the card it names. The page stays dynamic (no revalidate and no route
  cache) and rate-limited per IP address. As before, the checks reuse a vault's result for up to 60 s, and the
  story is dated with that snapshot's `taken_at`. Check it with
  `pnpm exec vitest run test/proof-story.test.ts test/proof-routes.test.ts` in `apps/web`.

- The landing's "What works today, and what does not" is a status board. A summary computed from
  the rows comes first: how many are Verified, and what each row marked In part or Not tried yet
  misses. A key then defines the two marks every row can carry: Proof (Verified, In part, Not tried
  yet) and, where it applies, Use (Running, Released). The 13 rows sit in four groups (On chain,
  Packages, The web app, Agents and the model) on one set of columns: name, what it does and what
  is not done yet, the marks, where it runs, and the evidence. Each evidence link names its kind
  (Try, Testnet, Mainnet, Base, npm, Registry, Store, Log, Record, Page, Docs, Verify), and the
  real-money kinds are set in ink. The web console is one row whose tried parts fold under a line
  that names them, with what is left to try always shown. Known gaps close the section in three
  short lists. No status changed: each mark follows its STATUS row's tone and the README, and
  `apps/web/test/status-board.test.ts` holds every mark, transaction, amount and link to its record.
  The styles live in `components/site/status.module.css`.
  The mainnet rows now tell round 2 (S2): three test payments, the 0.25 USDC one on an attested
  model's proposal, with spend 3, its Base transfer and the S2 run linked, and `verify --online`
  (O1 and O2) not yet run on the 3 mainnet decisions. The board's mainnet verify links now open
  S2's output, the live verify of the 6-entry ledger.

- After S2, the judge's `live-verify-mainnet-v0` step verifies `v0.probarion.near` with S2's copy of the ledger
  (`docs/evidence/mainnet-v0/s2-2026-11-13/ledger-2026-11-13.jsonl`, 6 entries, since the chain's anchors now
  cover 6 and S1's copy of 4 fails checks c and d) and both invoice texts (`--invoice` for INV-M002 and for
  INV-M003), and expects c, d, e and h to say what the chain now holds: 4 anchors, A8 on 3 of 3 attested
  decisions and 2 burn pairs. A SKIPPED row now prints up to 500 characters, so that command prints whole. The
  README (the sub line, the "For judges" block, the beta notice, the Real-World Money row, the status rows, the
  NEAR Intents row, the live verify command and a section for S2, with the list of what did not run on mainnet
  moved after it), `JUDGES.md` (a fifth link, the payout rows of what is proven, the worst case read again
  after S2, the gas and bridge fee rows and what is not done yet), `AGENTS.md`, `SECURITY.md`,
  `docs/THREAT_MODEL.md`, the mainnet runbook (an S2 paragraph, its done line and an S2 gate, with the S1 gate
  in the past tense), the web deploy runbook's ledger path, the landing page's mainnet pill and NEAR facts, the
  terms page's status line, the rules for agents and the docs pages that told one Base payout now tell both,
  each as a test to the owner's own Base address: 1.00 USDC decided by code rules alone, then 0.25 USDC decided
  by an attested model and the code rules. The docs tests now also refuse pages that still say one Base payout
  or no mainnet payment on a model's proposal, and the SDK's evidence test reads spend 3 from the proof file.

- After S2, the places that list the attested decisions recorded in the repository also give the 3 on mainnet:
  the README's NEAR AI Cloud row, the "A1 to A8, O1 and O2" row of `JUDGES.md`, `SECURITY.md`,
  `docs/THREAT_MODEL.md`, the privacy page and the docs pages that list them (SDK reference, Let an agent pay,
  glossary, what works today, how one payment works, what is Probarion, architecture, security model and verifier
  checks). The 3 are on `v0.probarion.near`, of 2026-11-13: they pass A1 to A7 and, with the two invoice texts,
  A8 offline and, in a later run that day, O1 and O2 online. Code refused the two of S1, and the third, entry 4,
  led to spend 3, a 0.25 USDC test to the owner's own Base address. The docs tests now also refuse a page that
  says the recorded attested decisions are all on testnet.

- The landing's "Built on NEAR, with NEAR AI Cloud" section is recomposed below its card. "Also in
  the stack" (NEAR Intents, and the Intel TDX and NVIDIA NRAS checks of `verify --online`) is now
  the card's last row, on the same columns as the NEAR and NEAR AI Cloud rows. The four channels
  sit under the heading "Where to get Probarion", each card in the same order: logo, kind, name,
  what you get, the exact names with their version, and one full-width link that names the page
  it opens. The package, server, repository and listing names are a list for screen readers. The
  trademark notices, every sentence kept, move into a small footer under a hairline, apart from the
  technical note. The NEAR AI Cloud row now says all 7 attested testnet decisions have passed O1
  and O2 online (the Canary's 2 on 2026-11-11 and the demo vault's 5 in the 16:13 UTC run of
  2026-11-12), where it said 6. The styles live in `components/site/ships.module.css`, and
  `apps/web/test/built-on.test.ts` checks that every class the section reads exists.
- The judge's `live-verify-mainnet-v0` step verifies `v0.probarion.near` with its committed ledger
  (`--ledger docs/evidence/mainnet-v0/s1-2026-11-13/ledger-2026-11-13.jsonl`) and the run's invoice text
  (`--invoice docs/evidence/mainnet-v0/s1-2026-11-13/invoice-INV-M002.txt`, one file, so the verifier warns about
  no other `.txt` file of the folder), and expects checks c, d, e and h to say what the chain and that ledger now
  hold. With `--offline` its skip says it reads NEAR mainnet, not testnet. Its snapshot guard also reads the
  subfolders of `docs/evidence`. The README (the "For judges" block, the status rows, the
  NEAR Intents row, the verify command and a section for the run), `JUDGES.md` (a fourth link, two rows of what
  is proven, the worst case and the costs read again), `AGENTS.md`, `SECURITY.md`, `docs/THREAT_MODEL.md`, the
  mainnet runbook, the landing page's mainnet pill and NEAR facts, the terms page's status line (and its date,
  now 2026-11-13), the rules for agents, the SDK reference and the docs pages that said no Base payout had run
  now tell the run, each as a test to the owner's own Base address, decided by code rules alone, and the tests
  that hold those texts follow. A docs test fails when a page calls the Base payout unrun while
  `contracts/deployments/mainnet.json` records it (`proof.first_base_payout_tx`), and another when a docs page
  or a rule for agents tells the payout without both labels. The S1 record says the two refusals by code were
  false ones (the right amount and address, and the mandate's asset account in the hint) and adds 1Click's
  settlement transaction, `FJA7rehn…`, signed by `intents.near`.

- The README has a "Privacy & Private AI" section after "NEAR technology used, and how", linked from
  the top row of links, from Contents and from a line under the tagline. It says what the TEE
  protects and what it does not, maps the track's example asks (an OpenAI-compatible call, a
  TEE-hosted model chosen from the models endpoint, a nonce, a Verified panel, keeping data off the
  server, sample documents) to the code that does each, and says what the hosted console keeps: each
  invoice file sealed, its file name and facts not encrypted, or with zero-retention only its hashes
  and the outcome, and the vault's signed ledger either way. It shows selective disclosure: an auditor
  who holds the invoice texts runs `verify --invoices`, and A8 passed on the demo vault's five
  attested decisions. It lists the known limits plainly: the signed ledger keeps the model's whole
  answer, the invoice reaches the model before the attestation checks run, the hosted server reads
  invoices in plain text, the request is not encrypted end to end and the NEAR AI gateway's
  attestation is not checked, invoice hashes have no salt (the Canary's raw spends aside), and the TEE
  measurement is not pinned. "How to evaluate Probarion in 5 minutes" now opens with a table of the
  five tracks this entry was submitted to (AI Security & Defense, Real-World Money, Agent Economy,
  Autonomous Business, Privacy & Private AI), with one thing to do and one to see for each, and adds a
  browser step: press "Check the TEE now" on the demo vault's proof page.
  The README's NEAR AI Cloud rows, its demo vault section and `SECURITY.md` add that the live run at
  16:13 UTC on 2026-11-12 passed O1 and O2 on all five attested decisions, entry 15 included, and the
  README's libraries table lists `@nearai/inference-sdk` 0.2.1 for the web console.

- The landing page's hero shows two real testnet transactions from two vaults. The paid card is the
  demo vault's INV-2001, 2 test USDC to `probarion-payee.testnet` (`HFyW61UZ…dQp1`). The blocked card
  is the Canary rehearsal of 2026-11-10: 50 test USDC under a mandate that pays at most 1 test USDC a
  payment, refused by code (`invoice.amount_invalid` and `custom.canary_no_autopay`) and then by the
  contract on chain with `OverPerPayment` (`6XuxN42d…v6z8DH`), with a link to try the Canary
  (`/canary?via=home`). The buttons read "Try the demo" (`#try`) and "Explore the docs" (`/docs`),
  followed by a "Verify it yourself" link to the demo vault's proof page, and the fine print and the
  audience line are now one line that links the mainnet vault's payment and refusal on the mainnet
  explorer. While the live check asks, its answer panel says "Asking the testnet" and is `aria-busy`,
  and its hint keeps room for two lines, four on a phone. On a phone the amount slider gets a row of
  its own, 44 px high. The hijacked prompt names `attacker.testnet` and links the Canary. In the
  hero's cards a long account name moves under its label whole. "Plug in your agent" has a new title,
  the factory and vault accounts, a row of developer links under the code, and an MCP card that links
  the MCP server's README. Each of its three uses (invoices, pay per API call, cross-chain payouts)
  shows what the mandate controls, what that did on testnet, its evidence and its status pill; the
  cross-chain one says that on testnet a stand-in takes the place of NEAR Intents and that no payout
  through NEAR Intents has run on mainnet. The comparison links `docs/comparison-2026-11.md`. The two
  big headings read as sentences to a screen reader, and `/canary`, `/status`, `/proof` and
  `/proof/<vault>` give a canonical address at the request's own network. The README's hijack line and
  its note on the contract's refusal of the agent key's direct spend of 2026-11-09 are updated to
  match. In the blocked card, the row with `OverPerPayment` is labelled Contract, since that code is
  the contract's answer. The use cases, the notes under the code, the comparison link and the Built on
  section's fine print keep 2.5em between paragraphs and run to the 32em measure, as the WCAG pass
  holds the rest of the landing.

- The site's type targets WCAG 2.2 AA on every page and the AAA text criteria (1.4.6 contrast, 1.4.8
  visual presentation) in the landing copy, the Docs Center, the console, the Canary, the proof page
  and the reading pages (Privacy, Terms, Security, Status). The site does not claim AAA conformance as
  a whole. The brand stays: Hanken Grotesk and IBM Plex Mono, ink, paper and gold.
  - Contrast: small gold text (eyebrows, the docs step numbers and tags, the error and 404 labels, the
    proof page's step badges) is `gold-ink`, 8.6:1 on paper, in place of `gold-small` (5.9:1), which
    stays on the landing's 42px step numerals only. `band-mute` goes from #a9a59b to #b0aca2 (8.7:1 on
    the ink band). The gold headline gradient is darker (#5e4210 to #8a6420, 4.9:1 or more on paper)
    and is used on 24px text and up only. The metal card's gradient ends lighter (#cfa54a) with a softer
    shade, so its ink reads at 7.6:1 or more and its labels (88% ink) at 7:1 or more. The header is 96%
    paper, so its grey text stays at 7:1 over the ink band. Link underlines are 60% ink, placeholders
    use `mute`, and a disabled control is drawn at 65% opacity in place of 50% (its ink label reads
    at about 6:1), or at 75% for the red buttons, whose label then reads at 4.9:1 in place of 3.8:1.
  - Visual presentation: reading text has a line height of 1.5 or more. A paragraph break leaves 2.5em
    or more from the top of one paragraph's last line to the top of the next one's first, inside docs
    list items and steps, the landing's story cards and screenshot captions, and the Canary cards
    too. Reading blocks run to 32em, about 71 characters on average (the new `--container-measure`
    token, `max-w-measure` in classes), nested ones included: a docs step's paragraphs, a verifier
    check, the docs hub's agent block, and the Canary's replay banner and the note under it. Laid
    out at 1440px, each line of reading text on the docs and the public reading pages has 80
    characters or fewer (before this change some reached 109, and at 33em some still reached 82).
  - Sizes and weights: text set in the stylesheets and class names is 12px or more, light weight is
    used at 24px and up only (card and dialog titles go from 22px to 24px), docs articles style `h4`,
    and the landing's panel and comparison headings are 17px. The architecture diagram is the
    exception: its smallest labels are 12 units of an SVG that scales with the column, so they draw
    at about 11.6px in a 1440px window and 10.7px where it scrolls.
  - Text spacing and reflow (1.4.12, 1.4.10): the docs search boxes grow with their text, inline pills,
    the nav links and the landing's inline code wrap, scrolling code blocks and tables keep their
    screen reader text inside them, the console's definition lists stack on a phone, and its wide
    tables scroll inside their card.
  - Focus and edges (2.4.7, 1.4.11): selects and text areas get the shared focus ring, the docs search
    input's ring is drawn all round, a ring inside a clipping box is drawn inside it, the Canary
    tables and the landing's screenshot row on a phone leave 6px of room for the ring of a link at
    their edge, a link that the keyboard focuses inside a sideways scroller is scrolled into view
    (Chrome left the second screenshot mostly out of sight), form fields have `mute` borders, the
    pressed Canary scenario has a 2px ink edge, and the open docs code tab has a gold-bright bar.
  - The site declares `color-scheme: only light` (also as Next.js `viewport.colorScheme`), since it
    has no dark theme yet. `only` also turns off a browser's own automatic dark mode (Chrome's), which
    would recolour the tokens without their contrast checks. Forced colours still apply: in them
    (Windows contrast themes), buttons, pills, the metal card, the pressed scenario and the open
    console tab keep a visible edge.
  - `apps/web/test/typography-aaa.test.ts` reads `globals.css` and the CSS modules and fails on a
    text colour pair below 7:1 (4.5:1 at 24px and up), a disabled label under 4.5:1, a reading line
    height under 1.5, light weight under 24px, text under 12px, justified text, an ellipsis, or a
    missing forced colours rule. For the rules it lists, it also fails on a paragraph break under
    2.5em or a reading block wider than the measure. `site-facts.test.ts` holds small text to 7:1 and
    the gold headline to 4.5:1.
  - `apps/web/e2e/a11y.spec.ts` (with `@axe-core/playwright` 4.14.0, a new dev dependency) runs
    axe-core's WCAG 2.0, 2.1 and 2.2 A and AA rules, then its AAA contrast rule, over `/`, `/status`,
    `/docs`, a docs article and the demo vault's proof page, and checks reflow at 320px with and
    without the 1.4.12 spacing. It also lays out every docs article and the public reading pages (45
    pages) at 1440px and fails on a line of reading text over 80 characters or a break between two
    paragraphs under 2.5em; code, tables, mono labels and text of 24px and up are left out. A local
    run on 2026-11-12 passed all 65 tests of this spec, and the docs, landing and smoke specs with
    them (123 in all); the test settings reach no database, so the proof page was checked in its
    unavailable view.
  - Not covered yet: a dark theme (and, with `only light`, a browser's automatic one),
    `prefers-contrast`, font sizes in rem, the architecture diagram's labels under 12px, visible
    labels on the register-vault and email forms (they have a placeholder and an accessible name),
    and the signed-in console pages in axe and in the laid-out checks.

- The Canary no longer follows `NEARAI_MODEL`. That variable pins the NEAR AI Cloud model for Payables and the SDK
  factory; the Canary keeps the SDK's default order (`z-ai/glm-5.3-flash` first), the model of its recorded attempts.
  With `Qwen/Qwen3.8-27B` pinned on probarion.xyz on 2026-11-11, a Canary attempt timed out at 40 s and was decided
  rules-only. The deploy runbook says so in the `NEARAI_MODEL` row.

- Release 0.1.1 is on npm: `@probarion/core`, `@probarion/sdk`, `probarion` and `@probarion/mcp` 0.1.1
  were published on 2026-11-11 from the tag `sdk-v0.1.1`, and the official MCP registry lists the server
  as `io.github.probarion/probarion`. What the repository says about npm now matches. The README says so
  in its banner note, its Status rows for core, the SDK and the CLI (on npm as 0.1.1), the 0.1.1 row
  (Shipped on 2026-11-11, with the install lines), the MCP server's row and the quick start, which runs
  the server as `npx -y @probarion/mcp@0.1.1`. `SECURITY.md` supports 0.1.1 and lists `@probarion/mcp` with the other
  packages. The `@probarion/mcp` README leads with npm and the registry name, and gives each client's npx
  form next to the build from a clone. The docs pages that named 0.1.0 as the npm release, or said the MCP
  server is not on npm, say 0.1.1 (Install, the CLI and SDK references, Let an agent pay, Ledger and
  anchors, the docs home, the developer quickstart, Evaluate in 5 minutes, What is Probarion, What works
  today, whose "npm release 0.1.1" section replaces the one for 0.1.0, Architecture, For AI agents and
  Verify a vault); the MCP server stays Preview. The landing's pills read "0.1.1 on npm" for the SDK and
  CLI and "Tried on testnet, 0.1.1 on npm" for the MCP server. `MCP_ON_NPM` in
  `apps/web/src/lib/agent/connect.ts` is true, so the console's Agent (MCP) tab gives
  `npx -y @probarion/mcp@0.1.1` for `init`, `status` and each MCP client, with no clone to build. This
  file's opening note says both releases are published. The tests that pin these lines follow them, and
  an install line in the docs may name `@probarion/mcp`.

- `probarion verify --online`: when check e fails because NVIDIA's NRAS token is `not_yet_valid` by this computer's
  clock (a clock a few seconds behind is enough, since `@nearai/inference-sdk` allows no tolerance), the report adds an
  `online hint:` line that says to sync the clock and run again, and prints it on stderr as a warning (with
  `--json`, only there). Check e still fails; the hint is not a result. Only the SDK's own failure message at the
  start of check e's detail adds it, so text from a ledger cannot.
- The grey text on `/proof/<vault>` (the decision cards, each check's detail, the model note and the
  limits line under A1 to A7) uses the mute token, 7:1 or more on paper.
- The browser extension is on the Chrome Web Store as version 0.1.0
  (https://chromewebstore.google.com/detail/probarion/hhadnmnjdlamihjjoejphkimnbcfidmn). The README
  (Status row Shipped), the extension's README, the store pack, What works today, the HTTP API and
  architecture docs, the threat model and `/privacy` say so and link the listing. What works today
  keeps it at Preview, with the server half it calls, because no end-to-end run with a real wallet
  against this deployment is recorded yet. The threat model covers the extension's own permissions
  and storage, `SECURITY.md` lists `apps/extension` in scope, `/privacy` is dated 2026-11-11 (`/terms`
  keeps 2026-11-10), and the Browser extension page (`/extension`) gains an Add to Chrome link.
  Loading it unpacked stays the way to run it from source.
- Docs: the text says the team is on Vercel Pro. The crons in `apps/web/vercel.json` still run once a
  day, by choice; Pro also accepts hourly or per-minute schedules, and the runbooks say what to change
  for those. A 90 s Canary attempt fits Pro with or without Fluid compute, which stays pinned on.
- The Canary evidence (`docs/evidence/canary-vault/README.md`) names the mandate's purpose document,
  the sample PO-1001, whose SHA-256 matches the `purpose_hash` read from the chain, and lists the
  vault's 11 transactions from `create_vault` to the rehearsal, each confirmed by RPC.
- The Canary is open on NEAR testnet at `/canary` on probarion.xyz, in live mode, since
  2026-11-10. Its vault is `canary.vaults.probarion.testnet`, with one mandate that pays
  `probarion-payee.testnet` at most 1 test USDC a payment and holds every spend. In the team's
  rehearsal that day, a fake invoice asked for 50 USDC: the model proposed paying 50 USDC, the code
  rules refused it (`invoice.amount_invalid`), and the contract refused the same spend on chain with
  `OverPerPayment`
  ([transaction](https://testnet.nearblocks.io/txns/6XuxN42dDWaboaqaiCuRGKCoA1UrypcDfvat48v6z8DH)).
  The README, the status list on the site, the `/docs` pages and the policy reference call it Live
  on testnet instead of not open yet. The threat model's claim C9 names the Canary vault (its
  `verify` run is under Added), and the deploy runbook says `CANARY_MODE` is `live` on
  probarion.xyz. The README's beta note says the demo vault's proof page and the Canary are public.
  Mainnet has no Canary vault, so `/canary` there still shows the recorded attacks.
- The "Approval needed" alert, by Telegram and by email, links the held spend's approval page,
  `/console/<vault>/approve/<spend>`, in place of the overview's held card. An event without a spend
  id still links the held card (`/console/<vault>#held`).
- The browser extension is pending Chrome Web Store review (submitted on 2026-11-10), so the site
  says what it does in the present tense. `/privacy#browser-extension`, which the store listing
  links, adds that a file read from a tab or a link is fetched with your own session for that site,
  and that the extension reads the address of the tab you are on when you open it; its date moves to
  2026-11-10. The `/extension` page says the extension is pending review and can be loaded unpacked
  from `apps/extension`. The Docs Center's What works today lists the extension for Chrome as Preview,
  and its HTTP API page drops "not released yet". The store's connect screenshot is rendered again
  with the page's new lead.
- Every console page's text reads at WCAG AAA: 7:1 or more for normal text, as on the phone
  approval page. The shared colour tokens in `apps/web/src/app/globals.css` are darker: `mute` and
  `plan` go from #5f5c55 to #4e4b45, `ok` from #17693f to #125935, `bad` from #a32a1c to #8e2317,
  and `wait` from #7a5a18 to #5e4210 (the value of `gold-ink`). Each reads at 7:1 or more on paper,
  on a white card and on its own pale background, so the Notice and Badge tones (5.4:1 to 5.9:1
  before) and the console header's "Signed in as" line (6.2:1 on paper before) pass. The landing
  page and the Docs Center read the same tokens, so their grey and status text is darker too.
  - Grey text at 60% ink, in Payables and the invoice confirm panel, is 75% ink (9.1:1 on a white
    card), and the sign-in page's "Console" label is `gold-ink` (9.3:1).
  - `text-xs` and `text-sm` have a line height of 1.5 (WCAG 1.4.8): 18px and 21px.
  - `apps/web/test/console-kit.test.ts` fails when a tone pair, a button, or any text colour class
    on a console page, the sign-in page or the extension page reads below 7:1 on paper or on a card.
- The MCP server's row in the status list moves from Planned to "Tried on testnet, not on npm"
  (Preview in the docs), and the README's Status row, its NEAR technology rows, its testnet proof and
  its quick start say what the server and the 402 example do. The Docs Center pages that called the MCP
  server Planned (HTTP API, Let an agent pay, Architecture, For AI agents, What is Probarion, What works
  today, Security model) now say it is Preview, and said it was not on npm then. The threat model
  cites claim `MCP-NOADDR` and drops the MCP server from its planned surfaces.
- The workspace includes `examples/*`, and the CI pin tests cover `packages/mcp` and
  `examples/402`: their test, build, typecheck and lint scripts, and the publish guard of
  `packages/mcp`.
- The landing page states each caveat once. The beta strip says "Unaudited beta on NEAR testnet,
  test tokens only." and that Probarion holds no owner key, links the known gaps, and folds to its
  first sentence on a phone; only mainnet asks for small amounts, and the footer no longer does.
  The status list gives the web console two rows, "Tried on testnet" and "Built, not tried yet",
  says which tests check the page, and ends with a "Known gaps" list: no third-party audit, and
  `v0.probarion.testnet`'s missing ledger, its failing checks d and h, and its older build, which
  the on-chain section and the closing used to repeat. In the payment journey, what is true today
  is a note labelled "Today" with a gold rule, on steps 2 and 5.
- The site header has "Docs" right after the Canary, and Usage moves to the footer's Product
  column. The landing page's closing button "Evaluate in 5 minutes" opens the docs page of that
  name in the same tab, not the README section. The sitemap lists every docs page with the date it
  was reviewed.
- The docs, the README and the landing say that release 0.1.0 of `@probarion/core`,
  `@probarion/sdk` and the `probarion` CLI is on npm: the install page, the developer quickstart,
  the status table, and the landing's "0.1.0 on npm" pill for the SDK and CLI and "Shipped, on npm"
  for the offline verifier. The README's browser checks add the verifier at `/#verify`, and its
  "NEAR technology used, and how" table adds NEP-297 events, near-workspaces and cargo-near and
  says what is not done live yet: the first mainnet payout, a 1Click top-up with a live quote and
  an attested NEAR AI Cloud decision.
- The site writes its CLI commands as `npx probarion …` now that 0.1.0 is on npm: the landing, the
  proof page, /security and the console's CLI fallback, under one line saying that npx needs Node
  24 and asks once before it downloads the package, with no set-up. A mainnet pre-ledger check on
  the proof page also reads the repository's evidence files, so for it the page says to
  `git clone` the repository first. The root `package.json` is renamed `probarion-monorepo`, so
  `npx probarion` also runs at the root of a clone. The README's offline verify step and the deploy
  runbook's smoke step 7 use `npx probarion`, and the install page says so.
- The READMEs of `@probarion/core`, `@probarion/sdk` and the `probarion` CLI install from npm
  (`npm install @probarion/core`, `npm install @probarion/sdk @probarion/core`, `npm install -g probarion`
  or `npx probarion`) and keep the steps to build from a clone. These are the pages npm shows for
  0.1.0. Their release notes are closed, so `pnpm release:check sdk-v0.1.0` passes.
- The landing page leads with what an owner gets: "Give your AI agent a budget, not your wallet",
  with buttons to the live check and to "Plug in your agent". The thesis and the numbers band are
  one section, "The problem": an agent with its own wallet key next to an agent with a mandate. The
  order is the problem, the live check, the comparison, how a payment works, plugging in an agent,
  the payee, the ledger test, the chain and the status list. The header's first link is "Try it",
  the fourth step of "How a payment works" links to the live check, and the closing says what to do
  next above its links.
- The landing's refused card and the README banner show a real refusal from 2026-11-09 in place of
  mandate 999: the agent key asked mandate 1 for 6 test USDC, over its limit of 5 USDC a payment,
  and the contract answered `PROBARION:OverPerPayment` (tx `4715d4nb…Vsr1`, recorded in
  `contracts/deployments/testnet.json`). Step 3 of the README's evaluation and step 5 of the docs'
  evaluation read it from an archival node.
- The site, the docs, the Terms and the READMEs no longer say that anyone can verify the ledger
  without a condition: a ledger is private until its owner publishes it, so they now say the owner
  can publish it for anyone to verify. A test keeps the unconditional claim out of the site's
  code, the docs and the READMEs. The landing's hero also names the category above the headline
  ("A mandate layer for AI agents on NEAR") and says who it is for under the buttons.
- The landing's offline check runs in an empty folder with npx alone. The site serves a
  byte-for-byte copy of the test fixture at `/samples/valid-snapshot.json`, and step 5 prints the
  download and the verify on separate lines, with a note to type `curl.exe` in Windows PowerShell
  5.1. Step 2 of the README's evaluation gives the same two lines for a reader with no clone.
- The ledger test on the landing page and on /proof puts a plain line under each of the nine
  checks, and calls a cross-chain spend a withdrawal ("Withdrawal to Base") in place of "Burned for
  Base" (site audit P1-11).
- A spend that waits for approval now comes first on the vault's overview, right under the tabs.
  A hold that ran out does not count, since the vault refuses approve then. The "Approval needed"
  alert, by Telegram and email, links straight to the card (`/console/<vault>#held`); before, it
  opened the overview, where the held card was the third or fourth. While a spend waits, the card
  offers an owner or approver "Get a message next time", a link to the Alerts tab, unless a
  confirmed alert of the vault already sends held spends.
- The Alerts tab says when a message can arrive: right after an invoice is uploaded on Payables
  (and, on the Canary vault, after each attempt), otherwise at the watcher's next run, once a day
  at 00:00 UTC or every minute if the per-minute schedule is turned on. A test holds the time to
  the schedule in `apps/web/vercel.json`. Before, it read as if a check every minute were already
  running.
- The console has the landing page's brand. It used a Tailwind kit from before the brand: buttons
  about 32px tall, 14px fields that a phone zooms in on, and Approve and Reject buttons that looked
  the same on a held payment.
  - Buttons are ink pills at least 44px tall. Approve is the ink pill and Reject a red outline. Any
    wallet button whose confirm dialog says it cannot be undone gets the red outline too: removing
    an agent key and revoking a mandate.
  - Fields are 16px, with the landing page's mute edge.
  - Cards, notices, badges and status text use the colour tokens. A test reads them from
    `globals.css` and checks that every text colour reads at WCAG AA.
  - The vault's tabs mark the open one with an underline and `aria-current`. Each tab is 44px tall,
    and on a phone they sit in one row that scrolls sideways.
  - The confirm dialog's Cancel is an outline pill.
  - Explorer links are ink rather than blue.
  - A pending payout is gold, the brand's colour for in progress.
  - Every page but the landing page now uses the header's frame: 1320px wide, with 16px gutters up
    to 620px and 24px above, so the page's left edge lines up with the logo. The console's and the
    extension page's content stays 1024px wide.
  - The proof page's coloured result panels are unchanged.
- The sign-in page says what signing in is for (a vault, a mandate and a key that can only call
  `spend`, or approving a held payment) and what it takes: on testnet, a NEAR testnet account, and
  about 3.3 test NEAR to create a vault later, which stays in the vault and cannot be withdrawn. On
  mainnet it says vaults cannot be created yet, as the factory is not deployed. Below the sign-in
  button it links the ledger test, which needs no wallet, and the terms and the privacy notice. The
  sign-in card had one button and no link.
- The ledger test gives its verdict in one plain sentence beside PASS or FAIL, read from the
  verifier's result, such as "Entry 2 was changed after it was signed, so its signature no longer
  matches." It names a cause and an entry only when the verifier's own words name them, and
  otherwise gives the counts. The counts and the verifier's words on each check that did not pass sit behind "Verifier
  detail". The test printed the counts as its verdict and the verifier's words under each failed
  check.
- Sessions name their network and belong to one address, so a person signs in at each network's
  address with a wallet of that network. After this change everyone signs in once more. A vault's
  routes and actions answer `409 wrong_network` at the other network's address, and a registered
  vault keeps its network: Register at the other address cannot move it (`network_mismatch`).
  Per-account rate limits are counted per network, and Register has its own.
- The console asks for confirmation in its own dialog instead of the browser's confirm box. The
  dialog is titled with the action, shows the same question as before, and says that the wallet asks
  for the signature next and that nothing is sent until then. Revoking a mandate, removing an agent
  key, and rejecting a spend or an invoice get a red dialog with a "Cannot be undone" line. Esc, a
  click outside the dialog and Cancel all cancel; the focus starts on Cancel and goes back to the
  button that was clicked, and the action button is held back for a moment after the dialog opens, so
  a double click on the opener does not confirm it.
- The site and console are served at <https://probarion.xyz>; `www.probarion.xyz` redirects there,
  and <https://probarion.vercel.app> still answers.
- The vault factory is deployed on NEAR testnet as `vaults.probarion.testnet` (code hash
  `FK6mMqUd…`). It serves the vault build with the `set_ledger_key` fix (code hash `3cQXYDvf…`) as an
  embedded version, so each new vault stores its own copy of the code and needs about 3 test NEAR.
  The console's Create a vault and the CLI's `vault create` use it. A smoke vault,
  `smoke-embedded.vaults.probarion.testnet`, has no access keys. The README, the site's status list
  and `contracts/deployments/testnet.json` record it; `v0.probarion.testnet` still runs the earlier
  build.
- The README, `SECURITY.md` and the site say what an offline check shows: `verify --offline` checks a
  snapshot against itself, so a forged snapshot with re-signed entries passes, and only `verify --vault`
  reads the chain. They also say that `verify --vault v0.probarion.testnet` fails checks d and h today,
  because the smoke run sent its spends without a ledger.
- The wallet provider moved to `/console` and `/login`, with one connector per network. First-load JS
  of `/` went from 148.5 KiB to 139.5 KiB gzip.
- The web build downloads Hanken Grotesk and IBM Plex Mono from Google Fonts and serves them itself, so
  `pnpm verify` reaches the network for that step.
- The repository pins pnpm 10.34.9 through `packageManager` in the root `package.json`. CI, the
  release job and Vercel builds run exactly that version, which is patched against the pnpm advisories
  GHSA-vq4v-j7r6-jq4m, GHSA-c59q-g84q-2gj5 and GHSA-vx52-2968-3vc6. The pinned tests refuse a
  workflow that names its own pnpm version, and they refuse a pin outside pnpm 10. The web deploy
  runbook sets `ENABLE_EXPERIMENTAL_COREPACK=1` on Vercel and checks the build log for that version.
- `verify`: check h reports a burn it cannot prove as `unproven`, lists it in `VerifyReport.unproven`,
  and `VerifyReport.ok` is false while any check fails or is unproven. A burn transaction that cannot
  be read right now is unproven (`tx_unavailable`). A burn record that names a transaction holding no
  burn pair, a transaction the node does not know, or a hash that is not a NEAR transaction hash
  fails h.
- `verify`: checks g and h trust only the network's own intents contract and POA assets. The online
  check O1 holds the TDX quote to the DCAP policy and to its report data, and O2 binds the NVIDIA
  payload to the request's nonce. Measurement pinning (O1b) is deferred, so `quote_verified` stays
  false.

- `SECURITY.md` now gives response targets (acknowledge within 72 hours, a severity within 7 days,
  a SEV2 fix within 14 days, disclosure once fixed or after 90 days), a safe harbor for good-faith
  research that covers the Canary under its rules, the Canary as a public testnet challenge with no
  reward, the practices CI runs, and acknowledgments.
- The deploy runbook's smoke test checks the health routes and security.txt. The key rotation
  runbook says that a new master key also resets duplicate matching by invoice number.

- Signing in from the Browser extension page brings you back to it, with the extension's request
  kept. Every other sign-in still returns to the console.
- `/privacy` has a new last section, "Browser extension". For each connected browser it says what
  Probarion keeps: a sha256 of the connection token, its last four characters, a browser name and
  its times, kept after the connection ends. For a pairing code it keeps a sha256, your account, the
  network and the times, and deletes the record, once the code is used or expired, the next time a
  code is made. A connection cannot pay, approve or confirm a payment. It ends after 30 days, when a
  sixth connection on the same network replaces it, or sooner with Revoke. The rate-limit sentence
  names code pairing, counted per IP address like sign-in.
- The threat model, the incident runbook, the key-rotation runbook, the monitoring guide and the
  security policy cover the extension's connections: what a token can read, that it cannot pay,
  approve or confirm, how to end one or all of them, and that a new master key does not end them.
  The runbook has a new entry, "An extension token leaked" (SEV3). Ending every token deletes the
  pairing codes first, in one transaction. For a stolen session it ends the sessions first, then
  either ends every token with that SQL or waits out the session's pairing codes (10 minutes) before
  revoking its tokens at that network's address. The threat model lists, as a known gap, that a few dozen
  addresses can hold code pairing at its network-wide limit while Connect keeps working.
- The console marks an invoice sent from the browser extension: the Waiting card says "Waiting for
  you: sent from the browser extension", a queued invoice lists only its holds under "Why it waits"
  and every check under "Checks when it was queued", and once a Confirm ran, the page says why the
  signed ledger's purpose rule passes under the mandate the member picked. The extension's inbox says
  where each waiting invoice came from.
- /privacy's Browser extension section, the threat model, the security policy, the incident runbook
  and the monitoring guide say that a connection can also queue an invoice, which waits for the
  owner's Confirm: what is stored for it, its rate-limit bucket, who ends a leaked connection, and
  that a queued or rejected invoice keeps its duplicate slot. Alert rule 4 (the money path) includes
  `component:extension`. The /docs security model and "What works today" pages say the same, and
  the /docs HTTP error table gains the Extension API rows.

### Fixed

- `@probarion/core`: the asset rule of the entry below matched only the bare asset account, and an
  attested model can add a label to it. In the testnet rehearsal of the second mainnet Base payout,
  on 2026-11-13 at 09:17 UTC in vault `s2-rehearsal-1.vaults.probarion.testnet` (test tokens),
  `z-ai/glm-5.3-flash` proposed to pay the mandate's Base address with confidence 0.95 and set
  `near_account` to `base-usdc.probarion.testnet (asset)`, the mandate's `payee.asset` followed by
  " (asset)"; `mandate.payee_mismatch` refused it (ledger seq 1, anchored, nothing paid). In the
  trusted proposal's hint, `payeeHintContradiction` now also takes the asset followed by one space
  and one label in parentheses of 1 to 40 characters, ASCII letters in words joined by single spaces,
  as naming no other payee. A label with a dot, digit, colon or other sign, spaces inside the
  parentheses at either end, two labels, text after the label, or the label after any other
  account still contradicts, so the label cannot hold a dotted account such as `vendor.testnet`, a
  `0x` address or a number. A bare word still fits; like the hint's `name`, it is compared and not
  sent, and the contract pays only the mandate's payee. The invoice's hint is
  unchanged: any `near_account` refuses there. When only spaces around a labelled asset differ, the
  detail quotes the value as given. Unit tests cover the labelled asset and 21 values next to it.
  The /docs pages "Why spend has no payee" and "Policy rules" say the same.

- `@probarion/core`: `decide()` refused as `mandate.payee_mismatch` a correct attested proposal for
  a Base payee when the model's payee hint also put the mandate's own asset account in
  `near_account`. It was seen on NEAR mainnet on 2026-11-13 in vault `v0.probarion.near`, mandate 2:
  1.00 USDC on Base to the owner's own Base address, a test of the cross-chain path and not a
  customer payment. Ledger entry 0 (07:17:47 UTC, model `z-ai/glm-5.3-flash`, confidence 0.95) and
  entry 1 (07:22:23 UTC, `Qwen/Qwen3.8-27B`, confidence 0.9) both proposed to pay the mandate's Base
  address `0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27` and set `near_account` to
  `base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`, the mandate's `payee.asset` (USDC on
  Base in NEAR Intents). The rule refused both with "invoice names NEAR account
  base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near; the mandate pays
  base:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27" (the detail says "invoice" for either hint: the
  account came from the models' hint, and the invoice INV-M002 names no NEAR account and no
  address), so that payment was decided by the rules alone (entry 2, `decided_by: "rules-only"`,
  spend 2) and then paid out on Base. For a Base or Solana payee, `payeeHintContradiction` in
  `packages/core/src/policy.ts` now takes a `near_account` equal to the mandate's `payee.asset`,
  compared exactly with no trimming and no case change, as naming no other payee, but only in the
  trusted proposal's hint: the model is shown the mandate's payee, asset included, and the asset is
  the token the mandate pays in. `decide()` and the eval's checks of a model's proposal pass the new
  option `ownAssetNamesNoPayee` for that hint. In the invoice's hint any `near_account` still
  refuses, the asset included, as before: the console reads only the first NEAR account of an
  invoice's text, so an invoice that writes the asset first could otherwise hide another payee
  behind it. The extension's queue check of an invoice stays as strict. Any other `near_account`
  still contradicts, the asset in another letter case or with spaces included (the detail then
  quotes the value as given, so it does not read like the asset that passes), and the chain and
  address checks are unchanged, so the asset given as the `address` still refuses. The rule for a
  NEAR payee, the schema and the system prompt of `probarion-proposal/v1` (check A8 knows the system
  prompt by its hash) and the contract are unchanged. `verify` does not re-run the policy, so ledger
  entries already written, these two included, are unaffected. Unit tests cover the asset and the
  contradictions next to it, and `packages/core/test/policy-mainnet-replay.test.ts` replays the two
  recorded mainnet proposals: `mandate.payee_mismatch` now passes for both, and every other rule
  gives the outcome and detail the ledger recorded; with the asset in the invoice's hint instead,
  the rule refuses as recorded. `apps/web/src/lib/payables/asset-payee-hint.test.ts` reads invoice
  texts with `extractFacts` and decides them: a Base and a Solana invoice that write the asset
  before another NEAR account are refused, with no model and with a model hint that copies the
  asset. The /docs pages "Why spend has no payee" and "Policy rules" say the same, and the line
  citations of `docs/THREAT_MODEL.md` follow the code. No eval case or committed eval result has an
  asset account in a hint, so the eval results are unchanged.

- The Canary gives its model up to 55 s instead of 40 s, and says so when the model's time runs out.
  On probarion.xyz the "Ignore previous instructions" example message was decided with no proposal
  twice, at 2026-11-11 23:40 UTC (with `Qwen/Qwen3.8-27B` pinned) and 2026-11-12 01:15 UTC (with
  `z-ai/glm-5.3-flash`): the chat request alone ran out of the 40 s (39,631 ms and 39,692 ms; the
  model calls before it took under 0.4 s), and the answer only said that no proposal came back.
  Template `probarion-proposal/v1` asks for up to 4096 tokens with no limit on reasoning, and the
  attested answers in `docs/evidence` (533 to 895 tokens, 401 to 792 of them reasoning) came at about
  20 to 60 tokens a second, the signature's fetch included, so a model that reasons longer on a
  message that argues with its instructions does not finish in 40 s. A cap on reasoning or on
  `max_tokens` would change the request bytes that check A8 rebuilds, so the time is what changed:
  the model's calls now share 55 s (`CANARY_LIMITS.modelBudgetMs`) and end at least 15 s
  (`afterModelMs`) before the attempt's 80 s deadline, so its decision is still written and
  anchored. The route's 90 s, the lease, the code rules and the system prompt are unchanged. A model
  that answers in about 40 s or less still leaves raw mode its 15 s; after a slower answer the
  proposal is shown and raw mode sends nothing (`no_time`). When the model's time ran out, the
  answer now reads "No proposal: the model's time ran out (at most 55 seconds) before its answer came
  back. Code decided without it." Whether 55 s is enough for that message is not measured yet.

- `@probarion/core`: `decide()` refused as `mandate.payee_mismatch` an invoice the mandate allows
  when an attested model's payee hint put the mandate's own NEAR account in `address`, next to a
  chain. It was seen on the testnet demo vault, ledger entry 12 (2026-11-11T23:35:56Z, model
  `Qwen/Qwen3.8-27B`): the invoice named `probarion-payee.testnet` for 2.00 USDC under PO-1001, the
  model proposed to pay with the hint `address` and `name` set to `probarion-payee.testnet` and
  `chain` set to `base`, and the rule refused with "invoice names base address
  probarion-payee.testnet; the mandate pays NEAR account probarion-payee.testnet". The v1 proposal
  schema has no NEAR value in its chain enum and no account field but `near_account`, so a model can
  put a NEAR account in `address`. For a NEAR payee, `payeeHintContradiction` in
  `packages/core/src/policy.ts` now takes the mandate's own account, in `near_account` or in
  `address` and whatever the chain, as naming no other payee, except an account that is also a Base
  or Solana address, such as an ETH-implicit `0x` account, which in `address` still refuses. A hint
  still contradicts when either field holds any other value, compared exactly so another letter
  case refuses, or when it names a chain with no account and no address. The rule for a Base or
  Solana payee is unchanged, and so are the schema and the system prompt of `probarion-proposal/v1`.
  `verify` does not re-run the policy, so ledger entries already written are unaffected. Tests cover
  the entry 12 hint, the contradictions next to it, and accounts that are also a Base or Solana
  address. The /docs pages "Why spend has no payee" and "Policy rules" say the same, and the line
  citations of `docs/THREAT_MODEL.md` follow the code.

- `@probarion/core`: `decide()` refused as `mandate.payee_mismatch` when an attested model's payee
  hint named the mandate's NEAR account plus a chain with no address, so the SDK and the console's
  Payables refused a payment the mandate allows. It was first seen on the testnet demo vault on
  2026-11-11 (INV-2006). The proposal schema's chain enum offers only `base` and `solana`, so the
  model filled one next to the NEAR account, and `payeeHintContradiction` in
  `packages/core/src/policy.ts` took the chain alone for an external destination. For a NEAR payee,
  a chain next to the mandate's own NEAR account, with no address, now names no other destination. A
  hint still contradicted when it named another NEAR account, an address that is not blank, or a
  chain with no NEAR account, and that last refusal now names the chain rather than
  `address (none)`. (The entry above, for ledger entry 12, then also took the mandate's own account
  in `address`: an address contradicts when it differs from that account or is also a Base or
  Solana address, and a chain only when neither field is given.) The vault pays the mandate's payee
  either way, and `verify` does not re-run the policy, so ledger entries already written are
  unaffected. Tests cover both hint shapes from the model and the contradictions next to them. The
  /docs pages "Why spend has no payee" and "Policy rules" said the same then.

- Console: an invoice upload keeps to one time budget counted from the request's start
  (`apps/web/src/lib/payables/budget.ts`). The NEAR AI calls share 40 s from the first one, each
  capped by what is left, and they end by 50 s from the start whatever the start took, so a slow
  model decides rules-only and the invoice waits for the owner with nothing sent. The chain reads
  before the first transaction stop at 60 s. A read refused there sends nothing: a context read or
  the `check_spend` dry run stops the upload as an `error` that a new upload runs again, a refused
  POA balance read holds the decision on `intents.balance_low`, and a refused anchor read leaves
  the anchor to the next cycle. From the first transaction on, nothing changes: the send keeps the
  SDK's own timing. Before, the SDK's defaults (90 s for the chat alone) could outlast the route's
  60 s, and a function stopped mid-cycle left the row in `processing`, which blocks a new upload, with
  no time left for the watcher kick. The route's `maxDuration` goes from 60 s to 90 s, planned as
  10 s for the start, 40 s for the model, 10 s for the decision and its dry run, 10 s for the send,
  the anchor and the row, and 20 s for the watcher kick after the answer. The kick now gets the
  function's end (the route's start plus 90 s), so after a late answer (a slow send) it claims fewer
  alerts instead of starting a send that the platform cuts off. The tenant lease goes from 90 s to
  120 s, 30 s longer than the route; the route's 90 s stays under the 2 minutes after which the
  alerts' SQL takes a sending alert back. No migration and no new setting. Tests pin the sums, the
  lease against the route, and the route against the SQL; the budget and the kick's end counted from
  the route's start, past a slow session and mandates read; a late answer that shortens the kick's
  alerts, on a fake clock; and, with the real SDK on PGlite, a 70 s model held for the owner with
  nothing sent. At the route, with a stubbed cycle, the kick is asked for before the cycle runs. The
  RUNBOOK's "Invoice stuck in processing" covers an upload or an owner's Confirm left there: how to
  read the row's ref, look its spend up on chain, and tell from the last decision whether a spend
  can still land.

- `@probarion/mcp`: the burned outcome no longer tells the agent to poll `get_spend_status`. A burn
  is final for the vault: the agent must not resend it under any ref, and should tell the owner if
  the payee reports nothing. On mainnet the bridge releases the funds and Probarion does not watch
  that release yet; on testnet the note says intents-stub stands in for NEAR Intents and nothing
  leaves NEAR. Spend outcomes, the developer quickstart, the glossary and the SDK README say the
  same.
- Console: a long account id (a 64-character implicit account, or a long named one) wraps inside the
  confirmation dialog, such as "Create vault in my wallet", and in the mandate form, where it made the
  dialog scroll sideways. The shared `ConfirmDialog` wraps its title, body and footnote anywhere.
- SDK: `NearApiJsSender` with `sendTimeoutMs` as a function starts no step (signing, the send, a
  status lookup) when the caller has less than 50 ms left or the function throws. Before, such an
  answer became a 1 ms deadline and the transaction was still sent, so a spend could land while the
  caller was told its outcome was unknown. A signing or send that does not start is `TxSendFailed`
  (nothing was sent); after an `InvalidNonce` the node confirmed, it is that refusal; a lookup that
  does not start keeps the outcome unknown, with its tx hash. The Canary counts the first case as
  `no_time`. A deadline longer than a timer holds (about 24.8 days) is cut to that, where Node.js
  fired it after 1 ms. New tests in `packages/sdk/test/deadline.test.ts` pin each case.
- SDK: `RpcClient` and `NearAiProposer` do not start a call with less than 50 ms of the caller's
  `remainingMs` left, where they refused only at 0. A timer can fire about 1 ms before `Date.now()`
  reaches the deadline, so a call sent with what was left could only time out: a test in
  `packages/sdk/test/deadline.test.ts` failed now and then in CI for that reason (seen on #87). A NEAR
  AI signature back-off is waited out only when it leaves 50 ms for the next try. `RpcClient` still
  cuts its back-off to the time left. The Canary counts a refusal under that floor as running out of
  time, as before (`no_time` for the dry run, `deadline` for the cycle). New tests pin 1, 49 and 50 ms
  with fixed clocks.
- The Canary's persona tells the model to write amounts in USDC's smallest units, with an example
  (50 USDC is `50000000`), as core's default prompt does. On 2026-11-10 the live testnet Canary's
  model wrote `50` for 50 USDC, a spend of 0.00005 USDC that the contract would hold, so the contract's
  refusal could not be shown. The earlier persona is kept as `CANARY_SYSTEM_PROMPT_V1`, and
  `CANARY_SYSTEM_PROMPTS` lists both hashes for a verifier of the Canary's ledger.
- A Canary attempt gets 80 s instead of 50 s: the model 40 s instead of 30 s, the route's
  `maxDuration` 90 s and the tenant's lease 130 s. On 2026-11-10 a slow model used 30 s on its own,
  and the step that sends a refused spend to the contract, which needs 15 s, was skipped.
  `apps/web/vercel.json` sets `"fluid": true`, and the deploy runbook says to leave Fluid compute on.
- The console's Keys page asks for larger allowances on the Canary's vault: 3 NEAR for its agent key
  and 2 NEAR for its ledger key. With the allowances every other vault gets (1 NEAR and 0.25 NEAR),
  the Canary could not open, since it does not run while its ledger key holds under 0.5 NEAR. A key's
  allowance is fixed when the vault adds it, so these apply to keys added from now on.
- The Canary's vault card says when the owner froze the vault: it then refuses every spend and every
  approval until the owner unfreezes it. A config read that failed adds nothing to the card.
- The Canary page shows its form only when the Canary vault and `NEARAI_API_KEY` are set, the
  database holds a private Canary tenant for that vault on the page's network, its ledger has room,
  its ledger key has gas for anchors, and the vault holds a mandate. It went live as soon as the vault
  was set, with a form that could only answer "not ready" when the key, the tenant or the mandate was
  missing. The page asks once a minute, with the same tenant and ledger key checks the attempt route
  makes; otherwise it shows the replay.
- Once the Canary's ledger is full, the page says the live Canary is closed instead of showing the
  form.
- The Canary replay shows attacks from the team's own tests, starting with the smoke run's refusal on
  testnet: the agent key cited mandate 999 and the contract answered `NoMandate`. A test holds every
  transaction in the list to a deployment record. The list was empty. Under the banner the page
  offers the ledger test, which needs no wallet, and @probarionhq on X, and it shows the "paid to an
  attacker" and Freysa cards, which hold whether or not the Canary is live.
- The live Canary page says why it shows no ledger: the model's answers in it can quote what visitors
  wrote, so it stays private.
- Sign-in explains two more answers of the server in words: `unavailable` (sign-in could not finish,
  so you were not signed in) and `payload_too_large` (the wallet's answer was too large to be a
  sign-in). The page showed the bare code before.
- The mandate form refuses a purpose document over 4 MiB. It took 25 MB, but the Payables upload
  takes the invoice and its purpose document together in 4 MiB, so a mandate made from a larger
  document could not be paid through Payables. The form still only hashes the file, in the browser.
- The `near_low` alert links to "Send NEAR to this vault" on the vault's Overview. It linked to
  Top-up, which funds USDC only.
- The Canary rules ask for a report the way SECURITY.md does, with a direct message to @probarionhq on
  X. They named an email address that does not exist.
- The package READMEs built the packages from a clone while none was on npm; they had shown
  `npm install`. The SDK quick start no longer passes an empty `NEARAI_API_KEY`, which throws a
  `ConfigError`. The SDK README says that a code hold has no approval to give, and that an
  unconfirmed spend is found by listing the vault's spends and matching `ref`: `spends.get` takes a
  spend id, and the contract has no lookup by ref.
- `freeze` takes no deposit, but a function-call key can sign it only when it may call the vault. The
  CLI's `vault freeze` help, SECURITY.md and the README said any owner key could freeze. The CLI's
  note also says that `reject` and `expire_held` still work while the vault is frozen.
- THREAT_MODEL: the SDK and the CLI read the bare `NEAR_RPC_URLS`, and only the web app reads the
  per-network names; the SDK already marks a ledger fork risk (`LEDGER_FORK_RISK`); and CI runs on
  pull requests into `dev` and `main` and on pushes to them. The README and this changelog said CI
  runs on every push.
- This changelog no longer contradicts itself about the Canary page, the pages that once read
  "coming soon" and the factory's fixed vault build, and the 0.1.0 heading says it is not released
  yet.
- With both networks served, the site header no longer runs past the window between 1101 and 1360 px
  wide, where the network switch left no room for the links. At those widths the links move into the
  menu, as they do below 1101 px. With one network the header is unchanged.
- The browser-tab icon has a clear background instead of a white square, and its mark is larger. The
  bar under the coin is ink in a light browser theme and paper in a dark one.
- Signing in now lands on the console. A prefetched redirect could leave the visitor on `/login` with
  no error.
- `/proof/<vault>` says the checks did not run, and its `snapshot.json` and `ledger.jsonl` downloads
  answer 503, when the database or the server's environment fails. They answered 500 before.
- A failed sign-in challenge says sign-in is unavailable and nothing was signed. The sign-in page no
  longer names wallets the picker may not offer.
- Web console: no link answers 404. While the Canary, the open metrics (now `/usage`), Payables,
  Top-up, Alerts, Security, Status, Terms and Privacy pages were being built, a link to one showed as
  "coming soon" and the landing page did not present it as available. Each is now a real page.
- Proof page: text from a ledger or the chain cannot disguise a result. Bidi and control characters
  are replaced, long values are cut, and only well-formed transaction hashes and account ids become
  links. A database or chain failure shows "No result" with the reason, and it is not shown as a pass.
- SDK: a Next.js app that uses `@probarion/sdk` keeps its own source tree out of its server
  functions. The file ledger store's dynamic path carries a `turbopackIgnore` hint. With it, the proof
  page's server functions trace a few dozen files instead of the whole app (about 225 files before).
- Vault: `set_ledger_key` deletes the old ledger key and adds the new one in two separate receipts,
  the delete first. A failed delete no longer rolls back the new key and leaves the vault unable to
  anchor, and a rotation fits on a vault with no spare NEAR. `v0.probarion.testnet` runs the build
  from before this fix. The fixed build (code hash `3cQXYDvf…`) is version 1 of the testnet factory
  `vaults.probarion.testnet`, so every vault the factory creates runs it.
- Web console: a payment is signed with the key its mandate is bound to; a key made active again keeps
  its first activation date; and a discarded key that shows up on chain is reported, for the owner to
  keep or remove.
- Web console, keys: only the ledger key can be loaded as "the active key"; every payment loads the
  agent key named by its mandate, not the ledger key. A ledger key that is
  stuck now says what to do for this vault's code: a vault built before the `set_ledger_key` fix needs
  a new vault, and a vault on the fixed code can set a new ledger key. A `set_ledger_key` that
  recovers a stuck key, whose only failed receipt is the delete of the missing old key, is shown as
  done, after the page checks that the new anchor-only key is on the vault.
- Web console, mandates: an expired mandate that still has payments waiting for approval shows
  Revoke, because the contract can still approve them. The "Sign mandate" button stays locked after
  a reload or an edit while an earlier create may have landed, so a mandate cannot be created twice
  by accident. The form refuses an expiry less than an hour away and a payee that is the vault's own
  USDC, Intents or asset contract; it warns when a 0x address is typed as a NEAR account (that is
  not a Base payout) or when the NEAR account does not exist; and it says plainly when the vault does
  not allow Base payouts. Revoke and the form appear only when your account is the vault's owner on
  chain.
- The SDK's chain reads fail closed: a malformed node answer is an error, and a node's own error is
  kept after the read fails over to another endpoint rather than reported as an outage.

- A database test of the alert list could fail when two subscriptions were created in the same
  instant and tied on their creation time.

- A canary test could fail about once in 58 runs, when the agent key it changed already ended in
  the character it wrote, so the key it called inactive was the active one.
- A test of the NEAR transaction-hash check could fail about once in 58 runs. It added a
  character to a random hash and expected the result to be refused, but a small 43-character hash
  with one more character can still decode to exactly 32 bytes. The test now starts from the
  largest hash, 44 characters long.

- Another invoice uploaded in the console with the same number for the same payee as one that was
  paid or may still pay is refused by code, rule `custom.invoice_number_duplicate`, and the
  decision entry signed by the ledger key says why. Before, the upload got a 409 before any rule
  ran, and nothing reached the ledger. An invoice queued from the browser extension with that
  number, and the same text uploaded again while the number stays blocked, are still duplicates at
  intake. When this rule's refusal is the outcome's code, the console's notice says whether an
  upload can run again: when the earlier invoice waits for the owner, after the owner rejects it.
  Otherwise the number stays blocked: a paid invoice, a spend held on chain (even one the approver
  rejects), a payment sent but not confirmed, a cycle cut off with an unknown outcome, and a
  refusal that could not be written to the new invoice. A paid
  invoice is not paid again. The notice gives no advice to reissue the bill under a new number:
  the console cannot yet show that the earlier spend can no longer pay, and a new number would
  pass every duplicate check. The migration
  `apps/web/supabase/migrations/20261108000016_invoice_number_rule.sql` changes `invoice_insert`.

- A bill could be paid twice when an agent paid one text of it outside the console. The owner's
  Confirm of that text in the console was refused as already paid (`invoice.duplicate`), and that
  refusal freed the invoice number, so a second text of the bill with the same number could run
  and pay. The duplicate guard now counts a refusal because the text was already paid or may still
  pay as an invoice that may pay: `invoice.duplicate` or `ledger.unresolved` in its signed decision
  (also when another rule refused first), or the contract's `DuplicateInvoice` or `DuplicateRef`.
  The same holds at intake and at the owner's Confirm. The guard also names an invoice that may
  have paid before one that waits for the owner, so the notice offers a re-upload after a Reject
  only when no invoice with the number may have paid. When two invoices with the number wait (the
  browser extension and the console raced), the notice asks the owner to reject each. A Reject
  still frees the number of the invoice it rejects. The migration
  `apps/web/supabase/migrations/20261110000017_invoice_guard_paid_refusals.sql` changes
  `invoice_insert` and `invoice_confirm_begin`.

- Web console, Payables: an invoice whose spend the vault held for an approver shows what the chain
  says of that spend now. The list and the invoice's page read the vault's spends with the same
  `list_spends` view the overview reads, and match the spend by its id and decision hash. An approved
  spend reads "Approved and paid on NEAR"; a rejected one, or one whose hold expired, says nothing was
  paid. Both pages kept "Held for approval", the outcome stored when the cycle ran: on testnet,
  INV-2003 and INV-2004 of `demo.vaults.probarion.testnet` were paid on chain but read held. The pages
  only read the chain: the stored outcome and the signed ledger do not change. When the spends cannot
  be read, the page says so and shows the status the cycle recorded.
- Web console, Payables: the banner says "1 invoice waits for you", not "1 invoice wait".
- Web console, Mandates: the table gives each column room. At desktop width its headers ran together
  ("PaymentsExpires").

- An on-demand render of `/docs/trust/reproducible-builds` on Vercel, such as a POST, which skips
  the prerender, answered 500: the function did not carry `.github/workflows/ci.yml`. The page's
  data now reads each file by a literal path. The docs functions carry the 8 repository files they
  read (0.09 MB), not about 1,170 (17.7 MB).
- The README's "Why it is different" said every vault method that moves value or changes authority
  needs a deposit. `freeze` takes none, and `spend` moves value without one; it now says every owner
  and approver method but `freeze` needs one. The /docs page Holds and approvals said no hold or
  approval had been recorded on NEAR testnet; on 2026-11-09 the demo vault held spends 2 and 3 and
  its approver approved both, and no rejection or expiry is recorded yet.
- The threat model's note on how evidence is named counted only the smoke transactions of
  `contracts/deployments/testnet.json` as testnet evidence. It now counts each transaction recorded
  there (`factory.deploy_tx`, `smoke`, `direct_refusal` and `demo_vault`), since attack 7 cites the
  direct refusal and the demo vault's held spend and its approval.

### Security

- Why the TEE measurement is not pinned yet (O1b): `docs/measurement-pin-2026-11.md` records the
  finding of 2026-11-12. A NEAR AI Cloud TDX quote measures the VM's operating system and NEAR AI's
  management harness, and `compose-manager` starts the model stack after boot from a git tag of
  `nearai/cvm-compose-files`, so no measurement pin can show which model image ran. For the demo
  vault's entries 10 to 13 the stored event log replays RTMR0 to RTMR3 of each quote, and MRCONFIGID
  holds the compose hash; the page lists those values, a script to check them, what NEAR AI publishes
  and what O1b would need. The landing page row stays "Checked online on testnet, image not pinned",
  and SECURITY.md, the threat model, the README's NEAR AI Cloud row, the verifier checks page and the
  interfaces spec link the finding.
- Key sealing: the web console generates agent and ledger keys on the server and seals them at rest
  with libsodium secretbox, under subkeys of one master key, `KEY_ENCRYPTION_SECRET`. A key becomes
  active only when the chain shows that exact function-call key on the vault, limited to `spend` or
  to `anchor`.
- Key rotation: `pnpm --filter @probarion/web rotate-keys` dry-runs by default, re-seals under the new
  master only after every row verifies, writes all rows in one compare-and-set call, prints counts
  only, and does not generate a master. The steps, including what to do after a leak, are in
  `docs/ops/key-rotation.md`.
- Release pipeline: `release.yml` publishes only from a `sdk-v*` tag on `main`, through the protected
  `npm-release` environment, with npm provenance, and the job that publishes runs no repository code.
  The release check gates the versions, this changelog, open release-note comments and the packed
  tarballs. A version already on npm is skipped only when npm holds the same bytes. `release.yml` is
  pinned by sha256, every step runs with `pipefail`, and a test refuses any step that would swallow a
  failure. Third-party actions are pinned by commit SHA, and the cargo-near download is checked by
  sha256.
- CI scans the whole git history for secrets with gitleaks.
- The repository's GitHub security settings are on: private vulnerability reporting, secret scanning,
  push protection and Dependabot security updates. `SECURITY.md`, `/security`, the Docs Center's
  security model page and the issue form now offer the private advisory form (**Security → Report a
  vulnerability**) beside the direct message on X, and the threat model's known gaps no longer list
  the settings as off; secret scanning's non-provider patterns and validity checks stay off.
- The console refuses, at start, settings that could point a network at the other chain: an
  unsuffixed per-network setting while both networks are served, a mainnet account id ending in
  `.testnet` or a testnet one ending in `.near`, and an RPC host named after the other network. The
  error names the variable, not its value. Sign-in, Register and the approvers re-sync read the chain
  only through RPC URLs that answered the JSON-RPC `status` call with that network's `chain_id`, and
  answer `503 wrong_chain` once any URL has answered with the other chain.

- Before an error report leaves for Sentry, the user, cookies, headers, request bodies and query
  strings are removed, console breadcrumbs are dropped, a request breadcrumb keeps only the origin of
  another host, and every known secret value and secret shape is masked. Tracing and browser sessions
  are off. The request that starts a server instance is left untagged, so its tags cannot reach other
  requests' reports.

- An extension connection token is stored only as a sha256 and its last four characters, and a
  pairing code only as a sha256. Logs and error reports mask any connection token they contain, and
  tag the extension's errors as their own component.
- A connection token cannot pay, approve or confirm a payment. `apps/web/test/ext-structure.test.ts`
  reads, with the TypeScript parser, every app module the extension's server code can load, and fails
  if one imports a module or function that pays, signs or opens a sealed key, imports anything from
  near-api-js, names an RPC method that sends a transaction or a database function or column that
  returns a sealed agent key, builds its own database client, asks for a subkey other than the
  session's, loads a raw crypto package outside lib/crypto, uses the cookie session, or loads code
  dynamically. It reads imports and names: it catches a plain import, not code written to get around
  it, so review of every change to that code is the other control.
- The extension asks for four permissions (`storage`, `contextMenus`, `activeTab`, `alarms`) and
  Probarion's three addresses, trusts a connect message only from Probarion's own `/extension` page
  with a nonce it made, and calls only `/api/ext/pair`, `inbox`, `invoices` and `revoke`, which a
  test pins. A file fetched from the page's site is refused if a redirect took it to another site.
  The popup builds its DOM without HTML strings, and the bundles hold no remote code. Disconnect
  revokes the token, and so does a new connection that replaces one for the same address.
- Since the queue, that test's claim is narrower: the extension's server code imports nothing that
  pays or signs and, outside `lib/crypto`, nothing that opens a sealed key. The queue's route reads
  the master key only to seal the invoice with `sealInvoice` and to key its duplicate guard, as the
  console upload does. The test also fails if that code builds a `VaultClient` with anything but a
  vault id and an RPC client, re-exports it, or imports the cycle's `decide`.
- Dependabot triage: vitest 4.1.12 (it was 3.2.7) in the root and every package, and
  `@sentry/nextjs` 11.11.0 (it was 11.10.0) in `apps/web`, fix 12 of the 18 open alerts: `vitest`,
  `@vitest/mocker` and `tinypool` (dev only; vitest 4 no longer uses `tinypool`), and `glob` and
  `minimatch` (Sentry's build plugin, build time only). `elliptic` has no patched version and is not
  reachable: only the CLI's `verify --online` loads it, to verify TDX quote signatures, and the flaw
  is in signing. `wee_alloc` stays a known gap until a new vault version. `rustls` reaches only the
  sandbox tests and is bumped with the next contract change, since changing `contracts/Cargo.lock`
  makes the recorded code hashes stale. Every alert is in the threat model's review log.

## 0.1.1 - 2026-11-11

### Added

- `@probarion/mcp`, an MCP server that gives an AI agent a Probarion vault to pay from, over stdio, as the command `probarion-mcp`; this is its first release on npm. Five tools: `list_mandates` (payee, caps, what is left, uses left, approval threshold, expiry), `check_spend` (the vault's free `check_spend` view), `request_spend`, `get_spend_status` and `verify`. No tool takes an address, every input rejects fields it does not know, and amounts go in as USDC decimal strings. No tool creates, changes or removes a mandate, a key or the vault's settings. The server holds the vault's `spend`-only agent key and `anchor`-only ledger key, and no owner key; without the two keys it runs read-only and `request_spend` is off. Error messages and log lines pass through a filter that masks secret keys and cuts every URL to its origin. The package is also a library: `createServer` builds the server on any `ProbarionPort`, `buildPort` is the port over `@probarion/sdk`, and `main` is what the binary runs.
- `@probarion/mcp`: `request_spend` names a mandate by id and runs `decide()` from `@probarion/core` and the vault's `spend`, signs the decision into the vault's ledger and anchors it. The MCP client's reasoning is stored as an unattested proposal prefixed `mcp:`, so `verify` reports these decisions as rules-only. A second request with the same ref pays nothing; it is refused and names the vault's spend under that ref (`earlier_spend`). Before each payment the server checks that its ledger file holds every entry the vault's latest anchor covers, with the same root, and otherwise stops with `LEDGER_FORK_RISK`; and that its own ledger key signed every entry after that anchor, and otherwise stops with `LEDGER_KEY_MISMATCH`. Either way it sends nothing.
- `@probarion/mcp`: `probarion-mcp init --vault <id> [--keys-file <path>]` makes the agent key and the ledger key on the user's machine, writes them to `~/.probarion/<vault>/keys.json` (mode 0600 outside Windows) and prints only the two public keys, with the owner's `probarion agent add` and `probarion ledger set-key` lines; `probarion-mcp status` checks, read-only, that the vault is ready for them (exit code 0 when ready, 1 when not, 2 for a configuration error); on testnet, `init` and `status` also link the console's Agent (MCP) tab, where the owner can paste the two keys instead (`status` offers it for the ledger key only on a vault with no anchor yet); `probarion-mcp demo [--vault <id>]` is a read-only tour of the five tools against the live testnet demo vault, with no key; and `--version` and `--help`. The server and `status` take their keys from both `PROBARION_AGENT_KEY` and `PROBARION_LEDGER_KEY`, else the file `PROBARION_KEYS_FILE` names, else the default keys file, else run read-only, so an MCP client's config needs only `PROBARION_VAULT_ID`. The other settings are `NEAR_NETWORK`, `NEAR_RPC_URLS`, `NEAR_ARCHIVAL_RPC_URLS` and `PROBARION_LEDGER_PATH`; a problem is named by its variable, or by the keys file and its field, with no value.
- `@probarion/mcp`: when a client connects, the server gives it instructions for the model (the MCP `instructions` field; each client decides whether its model sees them), under 1,200 characters: whom it can pay, `check_spend` first when unsure, and what to do with a held, unconfirmed, refused or burned spend. A burned spend is final for the vault, in the words for the server's network.
- `@probarion/mcp`: `mcpName` `io.github.probarion/probarion` in package.json, and `packages/mcp/server.json`, its entry for the official MCP registry, which the OWNER publishes with `mcp-publisher` once npm has the package. `server.json` is not in the tarball.

### Changed

- `probarion verify --online`: when check e fails because NVIDIA's NRAS token is `not_yet_valid` by this computer's clock (a clock a few seconds behind is enough, since `@nearai/inference-sdk` allows no tolerance), the report adds an `online hint:` line that says to sync the clock and run again, and prints it on stderr as a warning (with `--json`, only there). Check e still fails; the hint is not a result.
- `@probarion/sdk`: the README and the `SpendOutcome` comments say that `burned` is final for the vault. The bridge releases the funds on the other chain, and Probarion does not watch that release yet, so `process` does not return `settled`. The README says the ledger is a record that the vault's owner can publish for anyone to check.
- `@probarion/core`: no change in its code since 0.1.0. It is released at 0.1.1 because the npm packages share one version.
- Packaging: ESM only, Node 24 or newer, as in 0.1.0. Each of the four tarballs holds `dist/` (without source maps), `README.md` and `LICENSE`. The release workflow publishes them in dependency order: `@probarion/core`, `@probarion/sdk`, `probarion`, then `@probarion/mcp`.

### Fixed

- `@probarion/sdk`: `RpcClient` and `NearAiProposer` do not start a call with less than 50 ms of the caller's `remainingMs` left, where they refused only at 0. A timer can fire about 1 ms before `Date.now()` reaches the deadline, so a call sent with what was left could only time out. A NEAR AI signature back-off is waited out only when it leaves 50 ms for the next try. `RpcClient` still cuts its back-off to the time left.
- `@probarion/sdk`: `NearApiJsSender` with `sendTimeoutMs` as a function starts no step (signing, the send, a status lookup) when the caller has less than 50 ms left or the function throws. Before, such an answer became a 1 ms deadline and the transaction was still sent, so a spend could land while the caller was told its outcome was unknown. A signing or send that does not start is `TxSendFailed` (nothing was sent); after an `InvalidNonce` the node confirmed, it is that refusal; a lookup that does not start keeps the outcome unknown, with its tx hash. A deadline longer than a timer holds (about 24.8 days) is cut to that, where Node.js fired it after 1 ms.

## 0.1.0 - 2026-11-09

### Added

- `@probarion/core`: TypeScript mirrors of the vault and factory contract views; RFC 8785 canonical hashing; ed25519 keys; the signed, hash-chained ledger with the ledger-derived attestation nonce (bound to the vault account); the deterministic policy engine `decide()` with its built-in rules and custom rules; the model proposal parser; offline attestation checks A1 to A7, and the request-binding check A8 for auditors; and the snapshot verifier `runChecks` with checks a to i.
- `@probarion/sdk`: a NEAR JSON-RPC client with failover and backoff; vault, intents and factory clients; function-call key signing through near-api-js 7; the NEAR AI Cloud adapter (private TEE models, a nonce-bound attestation report, the `provider_tee` signature); the JSONL file ledger store (locked, which needs a local file system with hard links) and the in-memory store; the `Probarion` class with `process`, `requestSpend`, `checkSpend`, `mandates`, `spends`, `anchors`, `rules`, `snapshot` and `verify` (with optional online TEE quote checks through `@nearai/inference-sdk`); and `@probarion/sdk/testing` test doubles (fake chain, fake NEAR JSON-RPC server, fake NEAR AI Cloud).
- `probarion` CLI: `vault create`, `mandate create`, `mandate revoke`, `agent add`, `agent remove`, `ledger set-key`, `spend approve`, `spend reject`, `vault freeze`, `vault unfreeze`, `vault withdraw` and `vault withdraw-intents` check their input against the contract and print the transaction for the owner or approver to sign with `near-cli-rs` (1 yoctoNEAR where the contract requires it); the CLI does not sign. `agent keygen` makes an ed25519 key pair (`--out <file>` or `--print-secret`). `check` dry-runs a spend against the contract; `verify` runs checks a to i on a live vault or, with `--offline`, on a saved snapshot, prints a table or `--json`, and exits 0 (pass), 1 (a check fails or verify cannot run), 2 (a burn is unproven) or 64 (usage); `--online` adds the TEE quote checks O1 and O2 when `@nearai/inference-sdk` is installed and says when they did not run. `ledger export` copies the ledger to a new file.
- Packaging: ESM only, Node 24 or newer. Each tarball holds `dist/` (without source maps), `README.md` and `LICENSE`, and is published from CI with npm provenance when the repository is public.
