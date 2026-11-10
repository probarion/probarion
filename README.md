<div align="center">

<img src="docs/assets/readme-banner.png" alt="Probarion. Spend by mandate. Prove every payment. An AI agent pays only inside mandates its owner signed; the vault contract checks every payment and a signed ledger records every decision. On NEAR testnet with test tokens, the agent key of the vault v0.probarion.testnet made three calls: one paid 1 USDC to a NEAR account, one burned 1 USDC with a WITHDRAW_TO memo for a Base address, and the contract blocked one of 6 USDC on mandate 1, whose limit is 5 USDC a payment, with PROBARION:OverPerPayment." width="100%">

# Probarion

**A mandate layer for AI agents on NEAR. The agent pays people and services only inside mandates its owner signed: a NEAR contract checks every payment, and every decision goes into a signed, hash-chained ledger that the owner can publish for anyone to verify.**

[![CI](https://img.shields.io/github/actions/workflow/status/probarion/probarion/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/probarion/probarion/actions/workflows/ci.yml)
[![Status: unaudited beta](https://img.shields.io/badge/status-unaudited%20beta-b45309?style=flat-square)](SECURITY.md)
[![Network: NEAR testnet](https://img.shields.io/badge/NEAR-testnet-0B0B0C?style=flat-square)](#on-chain-proof)
[![License: MIT](https://img.shields.io/badge/License-MIT-6b7280?style=flat-square)](LICENSE)

<a href="docs/specs/2026-10-21-probarion-design.md"><img src="docs/assets/readme/read-the-spec.png" alt="Read the spec: design and interfaces" height="48"></a>
<a href="#how-to-evaluate-probarion-in-5-minutes"><img src="docs/assets/readme/verify-a-ledger.png" alt="Verify a ledger: checks a to i, offline" height="48"></a>
<a href="https://x.com/probarionhq"><img src="docs/assets/readme/follow-the-build.png" alt="Follow the build: @probarionhq on X" height="48"></a>

**[Live site](https://probarion.xyz)** · **[Docs](https://probarion.xyz/docs)** · **[Evaluate in 5 minutes](#how-to-evaluate-probarion-in-5-minutes)** · **[What is shipped](#status)** · **[NEAR tech](#near-technology-used-and-how)** · **[Testnet proof](#on-chain-proof)** · **[Design spec](docs/specs/2026-10-21-probarion-design.md)** · **[Interfaces](docs/specs/2026-10-21-probarion-interfaces.md)** · **[Security](SECURITY.md)** · **[Changelog](CHANGELOG.md)** · **[@probarionhq](https://x.com/probarionhq)**

<sub>Built for the NEAR Hackathon 2026 · Rust contracts on NEAR (near-sdk 5.29.1) · NEAR Intents payouts · NEAR AI Cloud private models · TypeScript SDK and CLI on npm</sub>

</div>

Giving an AI agent a wallet means trusting a prompt with money. Probarion moves the rule into a NEAR
contract. An owner puts USDC in a vault and signs mandates: who gets paid, how much per payment and in
total, how many times, until when, and above what amount a person must approve. The agent gets one
function-call key that can call `spend` and nothing else, and `spend` has no recipient argument, so
the payee always comes from the mandate. Before anything is sent, deterministic code decides, with a
private model on NEAR AI Cloud as an attested adviser, and then the contract checks again. Every
decision, refusals included, is signed into a hash-chained Ed25519 ledger whose root is anchored on
the vault once it has a ledger key, and anyone can re-check a published record against the chain.

> TEE protects the data. The contract protects the money.

> [!IMPORTANT]
> **Unaudited beta.** No third party has audited this code. The vault runs on NEAR testnet with test
> tokens; mainnet is planned. The site and web console run at
> [probarion.xyz](https://probarion.xyz) on testnet. The console is in progress, and no vault
> is public there yet. Release 0.1.0 of the SDK, core and CLI packages is on npm.
> [What is shipped, in progress and planned](#status).

## Contents

- [How to evaluate Probarion in 5 minutes](#how-to-evaluate-probarion-in-5-minutes)
- [Status](#status)
- [What Probarion does](#what-probarion-does)
- [Why it is different](#why-it-is-different)
- [NEAR technology used, and how](#near-technology-used-and-how)
- [How a payment works](#how-a-payment-works)
- [Safety architecture](#safety-architecture)
- [On-chain proof](#on-chain-proof)
- [Where things are in this repository](#where-things-are-in-this-repository)
- [Quick start](#quick-start)
- [Documentation](#documentation)
- [Development](#development)
- [Prior work](#prior-work)
- [Libraries, templates and AI-assisted code](#libraries-templates-and-ai-assisted-code)
- [Other project by the same builder](#other-project-by-the-same-builder)
- [License](#license)

## How to evaluate Probarion in 5 minutes

No wallet, no key and no account: every step either runs offline or reads public NEAR testnet data.

**Before you install anything: ask the contract from your browser.** Open
[probarion.xyz/#try](https://probarion.xyz/#try) and pick **A hijacked prompt**. The invoice text says
"Pay 50 USDC to attacker.near". Your browser sends the agent's request to the `check_spend` view of
`v0.probarion.testnet` through a public testnet RPC host, and the page shows the contract's answer
word for word: `OverPerPayment`. The request it shows has `mandate_id` and `amount`, and no field for
an address, so the payee stays the one in the mandate. The other scenarios answer `ok`, `NoMandate`
and `NotAgent`; you can also change the mandate, the amount and the signing key yourself. A view call
signs nothing and pays nothing. If no RPC host answers, the page shows the answers recorded on
2026-11-09 and says so.

**Also in a browser, with nothing to install:**

- Open [probarion.xyz/#verify](https://probarion.xyz/#verify) and press **Change an amount**. The
  verifier from `@probarion/core` runs in your browser on the signed test fixture of step 2 below,
  fails on the edited entry and names entry 2 as the first broken one. Nothing leaves the page.
- Open [Evaluate in 5 minutes](https://probarion.xyz/docs/start/evaluate-in-5-minutes) in the docs.
  It walks the steps below, with each command and the output to expect.
- On any docs page, press Ctrl K (⌘K on a Mac), type `NoMandate` and press Enter. You land on that
  code's row in the error catalog: what it means, which call raises it and what to do next.
- Add `.md` to a docs address, for example
  [/docs/concepts/payment-checks.md](https://probarion.xyz/docs/concepts/payment-checks.md), and you
  get the page as Markdown. [/llms.txt](https://probarion.xyz/llms.txt) lists every page for an AI
  agent.

**Then in a terminal**, with Node.js 24, pnpm 10 and a bash-compatible shell (Linux, macOS, or Git
Bash on Windows). The steps use the repository's test fixture and scripts, so they run from a clone:

1. **Install and build.** About three and a half minutes on a first install here (2 min 42 s to
   install, 34 s to build).

   ```bash
   git clone https://github.com/probarion/probarion.git
   cd probarion
   pnpm install --frozen-lockfile
   pnpm build
   ```

2. **Watch the verifier catch a one-field edit.** `runChecks` from `@probarion/core` runs checks a to i
   over a snapshot of a ledger and its chain state. The snapshot here is a committed test fixture
   (five entries, two spends and a refusal, signed with test keys), not a live vault.

   ```bash
   node --input-type=module -e '
   import { readFileSync } from "node:fs";
   import { firstBrokenSeq, runChecks } from "./packages/core/dist/index.js";
   const snapshot = JSON.parse(readFileSync("packages/core/test/fixtures/valid-snapshot.json", "utf8"));
   const report = await runChecks(snapshot);
   console.log("as recorded:", report.ok, report.checks.map((c) => `${c.id} ${c.status}`).join(", "));
   snapshot.ledger[2].body.amount = "1"; // one decision: 40 USDC becomes 0.000001 USDC
   const edited = await runChecks(snapshot);
   console.log("after one edit:", edited.ok, "first broken entry:", firstBrokenSeq(edited));
   for (const c of edited.checks) if (c.status !== "pass") console.log(`  ${c.id} ${c.status}: ${c.detail}`);
   '
   ```

   ```text
   as recorded: true a pass, b pass, c pass, d pass, e pass, f pass, g pass, h pass, i pass
   after one edit: false first broken entry: 2
     a fail: entry 2 body_hash does not recompute from its body: a signature over a hash the body does not produce proves nothing about the body
     b fail: entry 2 body_hash does not recompute from its body
     d fail: spend 2 does not match its decision seq 2 (spend vs decision): amount 40000000 vs 1
   ```

   The CLI runs the same checks over the same fixture, offline, and exits 0:

   ```bash
   npx probarion verify --offline packages/core/test/fixtures/valid-snapshot.json
   ```

   ```text
   9 passed, 0 failed, 0 unproven
   RESULT: PASS
   ```

   No clone? The site serves the same file, byte for byte, so the CLI from npm runs the same check
   in an empty folder (in Windows PowerShell 5.1, type `curl.exe` for `curl`):

   ```bash
   curl -O https://probarion.xyz/samples/valid-snapshot.json
   npx probarion verify --offline valid-snapshot.json
   ```

3. **Check the testnet vault on chain.** These read public RPC data, with no key.

   ```bash
   node scripts/testnet/chain.mjs code-hash v0.probarion.testnet         # 6tbERLAXWjaVKbSNzaivRDh7H9kCcjtmV1qGrgz7entR
   grep -n 6tbERLAXWjaVKbSNzaivRDh7H9kCcjtmV1qGrgz7entR contracts/code-hashes.json   # the recorded reproducible build
   node scripts/testnet/chain.mjs full-access-keys v0.probarion.testnet  # prints an empty line: no full-access key
   node scripts/testnet/chain.mjs key-count v0.probarion.testnet         # 1: the agent's spend-only key
   ```

   Then read the three smoke transactions, and the refusal the landing page shows, from an archival node:

   ```bash
   tx() { curl -s https://archival-rpc.testnet.fastnear.com -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tx\",\"params\":{\"tx_hash\":\"$1\",\"sender_account_id\":\"v0.probarion.testnet\",\"wait_until\":\"NONE\"}}"; }
   tx 3DFV2thBU9V4b5w7kM691poLJ8SWiCqp46LKBn1Fy9cX | grep -o 'spend_paid' | sort -u                  # spend_paid
   tx 3u4ffrwpiwLoNV6cU72NHLVBAMq729NwLs6ixDLdcvYe | grep -o 'WITHDRAW_TO:0x[0-9a-f]*' | sort -u     # the burn memo, built from the mandate
   tx AkjyVPmb6LdMES7ykpzJQR7EXXGvw3kYH6Nhem9YdzgY | grep -o 'PROBARION:[A-Za-z]*' | sort -u         # PROBARION:NoMandate
   tx 4715d4nbYn6cq981nmLU5y8efCoX2w3SbgW8PPq4Vsr1 | grep -o 'PROBARION:[A-Za-z]*' | sort -u         # PROBARION:OverPerPayment
   ```

4. **Ask the vault itself.** A read-only `Probarion` instance (no keys, `model: null`) lists the
   mandates and runs the contract's free `check_spend` dry run. Mandate 1 allows at most 5 test USDC
   per payment, so the contract accepts 2 and refuses 6.

   ```bash
   node --input-type=module -e '
   import { Probarion } from "./packages/sdk/dist/index.js";
   const vault = new Probarion({ network: "testnet", vault: "v0.probarion.testnet", model: null });
   for (const m of await vault.mandates.list())
     console.log(`mandate ${m.id} "${m.label}": ${m.status}, pays ${m.payee.account_id ?? m.payee.address}, at most ${m.max_per_payment} per payment`);
   const invoiceHash = "ab".repeat(32);
   console.log("2 USDC:", await vault.checkSpend({ mandateId: 1, amount: "2000000", invoiceHash, ref: "README-1" }));
   console.log("6 USDC:", await vault.checkSpend({ mandateId: 1, amount: "6000000", invoiceHash, ref: "README-1" }));
   '
   ```

   ```text
   mandate 1 "smoke near": active, pays probarion-payee.testnet, at most 5000000 per payment
   mandate 2 "smoke base": active, pays 0x1111111111111111111111111111111111111111, at most 5000000 per payment
   2 USDC: { ok: true, code: null, would_hold: false }
   6 USDC: { ok: false, code: 'OverPerPayment', would_hold: false }
   ```

5. **Print an owner transaction without signing it.** The CLI checks the input against the contract's
   rules, writes the arguments to a file and prints the `near-cli-rs` command for the owner to review
   and sign in their own wallet. It signs nothing.

   ```bash
   node packages/cli/dist/bin.js mandate create --vault v0.probarion.testnet \
     --payee near:probarion-payee.testnet --max-per 5 --max-total 20 --uses 5 --expires 2026-12-31 \
     --approval-above 2 --agent-pk ed25519:5errZXjDMXpk51BLypA3hBRUfBfh9v4bHeyU9vRmzYFK \
     --purpose docs/evidence/v0-po.txt --label "Contractor" --out-dir probarion-tx
   node packages/cli/dist/bin.js mandate create --vault v0.probarion.testnet --payee base:0x1234 \
     --max-per 5 --max-total 20 --uses 5 --expires 2026-12-31 --approval-above 2 \
     --agent-pk ed25519:5errZXjDMXpk51BLypA3hBRUfBfh9v4bHeyU9vRmzYFK --purpose docs/evidence/v0-po.txt --label x
   # error: --payee base:0x1234 is not a 0x-prefixed 20-byte address
   ```

**Then run every test:** `pnpm verify` runs the Rust unit and property tests, Biome, the build, the
typecheck, every TypeScript test and the launch checks. It needs Rust as well (rustup installs the
pinned 1.99.1 from `rust-toolchain.toml`); on Windows, set `AWS_LC_SYS_PREBUILT_NASM=1` first or
install NASM. On a Windows 10 laptop the first run took about 10 minutes, most of it compiling the
Rust dependencies, and later runs about 7½ minutes; CI runs the same checks on ubuntu on every pull request into `dev` or
`main` and every push to them.
On that laptop one database test, `apps/web/test/db/key-rotation.test.ts`, went past its 20-second
limit in each of three full runs while every package's tests ran at once, and passed when run alone:
`pnpm --filter @probarion/web exec vitest run test/db/key-rotation.test.ts`.

**Reviewing security:** [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) has the threat model (eleven
attacks, the blast radius, failure modes, known gaps and the latest review), and
[SECURITY.md](SECURITY.md) says how to report a vulnerability and what `verify` does not prove yet.

## Status

What exists at this commit, and what does not yet.

| Component | Status | Where |
| --- | --- | --- |
| Vault contract | **Shipped on NEAR testnet** as `v0.probarion.testnet` (test tokens). The vault source changed after that deployment (a `set_ledger_key` fix on 2026-11-03). Vaults created by the testnet factory run the fixed build (code hash `3cQXYDvf…`); `v0.probarion.testnet` still runs the earlier one | [`contracts/vault`](contracts/vault) |
| Factory contract | **Shipped on NEAR testnet** as `vaults.probarion.testnet` (2026-11-05). It serves the fixed vault build as an embedded version: each new vault stores its own copy of the code, so it needs about 3 test NEAR (the 0.5 NEAR `min_deposit` plus 2.49 NEAR of storage). The global version and a mainnet factory are not deployed yet | [`contracts/factory`](contracts/factory) |
| Reproducible builds and recorded code hashes | **Shipped** (CI, Docker) | [`scripts/build-reproducible.sh`](scripts/build-reproducible.sh), [`contracts/code-hashes.json`](contracts/code-hashes.json) |
| `@probarion/core`: policy engine, ledger, attestation checks A1 to A8, verifier checks a to i | **Shipped**, on npm as `@probarion/core` 0.1.0 | [`packages/core`](packages/core) |
| `@probarion/sdk`: RPC with failover, vault clients, ledger stores, `Probarion` class, `snapshot()` and `verify()` with online O1/O2 | **Shipped**, on npm as `@probarion/sdk` 0.1.0 | [`packages/sdk`](packages/sdk) |
| NEAR AI Cloud adapter (private TEE model, nonce-bound attestation, `provider_tee` signature) | **Built** and tested against a fake NEAR AI Cloud. A real attested decision, recorded and verified in this repository: **In progress** | [`packages/sdk/src/nearai.ts`](packages/sdk/src/nearai.ts) |
| `probarion` CLI: owner and approver transaction printers, `agent keygen` | **Shipped**, on npm as `probarion` 0.1.0. `vault create` reads the testnet factory and prints its `create_vault` call for the owner to sign | [`packages/cli`](packages/cli) |
| CLI `check`, `verify` and `ledger export` | **Shipped**, in the same 0.1.0 package. `verify` exits 0 when every check passes, 1 when one fails or verify cannot run, 2 when a burn is unproven | [`packages/cli`](packages/cli) |
| npm release 0.1.0 of the packages | **Shipped** on 2026-11-09: `@probarion/core`, `@probarion/sdk` and `probarion` 0.1.0, published from the tag `sdk-v0.1.0` on `main` by the release pipeline, with npm provenance. Install with `npm install @probarion/sdk @probarion/core`, or `npm install -g probarion` for the CLI. ESM only, Node 24 or newer | [`.github/workflows/release.yml`](.github/workflows/release.yml), [npm](https://www.npmjs.com/package/@probarion/sdk) |
| Web console (Next.js 16 and Supabase): the public site, wallet sign-in, vault overview, freeze, approvals, keys, mandates, top-up, Payables, the public proof page | **In progress**. Deployed at [probarion.xyz](https://probarion.xyz) on testnet, from `main`. The landing page asks the testnet vault live: a visitor picks what the agent tries (a normal invoice, a hijacked prompt, a made-up mandate, someone else's key) and the browser calls the vault's `check_spend` view on `v0.probarion.testnet` through public testnet RPC, whatever network the page is on. It shows the contract's answer and the mandate as the chain has it, falls back to answers recorded from the chain when no RPC host answers, and shows those answers as a table without JavaScript. The landing page also compares Probarion with a limit contract you write, and shows the SDK call an agent makes. Its payment journey ends with the demo vault's four invoices: each card says what the vault did and links the invoice file, its transactions and its ledger lines. After the ink band, "The console" shows three screenshots of the testnet console from 2026-11-09: a held spend, the invoice's page in Payables, and the vault's spends once paid. Each is captioned with the network, the date and the vault, and links its transaction where it has one. The landing's status list gives the console two rows, what was tried on testnet and what is built but not tried yet, and ends with the site's known gaps, which the beta strip on every page links. The top-up tab sends USDC on NEAR from the owner's wallet. On testnet it also has a faucet button that adds 25 test USDC straight into the vault, once a UTC day per vault and for up to 3 vaults per owner account, with no wallet: built and tested, and its key is set on probarion.xyz; on 2026-11-09 it added 25 test USDC to `demo.vaults.probarion.testnet` ([runbook](docs/RUNBOOK.md#testnet-faucet)). The 1Click top-up of the vault's Base USDC inside NEAR Intents is mainnet only and has not been tried with a live quote yet. Sign-in and Create a vault have been tried there with a real wallet (Meteor, on testnet: `trial.vaults.probarion.testnet`). On 2026-11-09 the testnet demo vault `demo.vaults.probarion.testnet` went further with a real wallet: Create a vault, the agent and ledger keys, the faucet, a mandate, four Payables invoices and a public proof page ([evidence](docs/evidence/demo-vault)); its approver approved the held spend with near-cli. A fifth invoice, INV-2004 (4 test USDC), ran the same day for those screenshots: the vault held it as spend 3, and the approver approved it with near-cli too. Payables reads a held spend from the chain each time its list or the invoice's page opens, so an invoice whose spend an approver approved reads "Approved and paid on NEAR", and one rejected or whose hold expired says nothing was paid. The other console actions, such as Freeze, approving from the console and the Top-up tab's USDC transfer, have not been tried yet. The sign-in page says what a vault takes (on testnet, a testnet account and about 3.3 test NEAR; on mainnet, vaults cannot be created yet) and links the ledger test for visitors with no wallet. The console uses the landing page's brand: 44px ink pills, a red-outlined Reject beside Approve on a held payment, 16px fields, text that reads at WCAG AAA (7:1 contrast, a line height of 1.5) on every console page, and tabs that mark the open one. Create a vault opens the new vault's page, where a checklist shows its owner the five steps to the first agent payment (keys, USDC, a mandate, an invoice paid) and links each to its tab; on testnet, Mandates and Payables fill themselves from a sample purchase order and invoice in one click. Deploy checks run with its tests, and the first-deploy checklist is [`docs/runbooks/web-deploy.md`](docs/runbooks/web-deploy.md) | [`apps/web`](apps/web) |
| Docs Center at `/docs`: 34 pages in six sections (Start here, Concepts, Build, Verify & trust, Operate, Resources), search, a Markdown twin of every page, `llms.txt` and `llms-full.txt` | **Built** and tested. Each page was written from the code and then checked against it in a separate verification pass. Each guide, tutorial and explanation marks what is Live, Preview or Planned. Every page but the docs home has a source box with the commit it was built from, the date it was reviewed and the files it was checked against, and every Markdown twin names the commit and the date in its first lines. Ctrl K (⌘K) search loads a static index on first open and finds pages, error codes and CLI commands. The reference tables are rendered from typed lists that tests pin to the code, so a table that drifts fails CI: the vault's 14 checks, the error codes, the verifier's checks a to i and the status list. The reference pages list every SDK export, CLI command and option, contract method, NEP-297 event, HTTP route, policy rule, limit, deposit and gas figure, and recorded contract build, each table checked against the code by its own test. An Architecture page draws the parts with the repository path behind each box, and a Changelog page renders this repository's `CHANGELOG.md`. Every owner and approver command is marked with who signs it. A Playwright spec, run locally and not in CI, checks the fold, the keyboard path through search, the phone drawer, the 404s, a blocked clipboard and the docs without JavaScript | [`apps/web/content/docs`](apps/web/content/docs), [`apps/web/src/lib/docs`](apps/web/src/lib/docs), [`apps/web/e2e/docs.spec.ts`](apps/web/e2e/docs.spec.ts) |
| Mainnet vault `v0.probarion.near` | **Planned**. The runbook is ready; the owner signs every step | [`docs/runbooks/mainnet-v0.md`](docs/runbooks/mainnet-v0.md) |
| MCP server `@probarion/mcp`: five tools (`list_mandates`, `check_spend`, `request_spend`, `get_spend_status`, `verify`), none of which takes an address | **Built** and tested, and tried on NEAR testnet; not on npm yet, so it runs from a clone (`node packages/mcp/dist/bin.js`). It speaks MCP over stdio and holds the vault's `spend`-only agent key and `anchor`-only ledger key, and no owner key; without the two keys it runs read-only. Each input rejects fields it does not know. `request_spend` names a mandate by id and goes through `decide()` (no invoice text or purpose document is read) and the vault's `spend`, signs its decision into the ledger and anchors it. It sends nothing (`LEDGER_FORK_RISK`) when the vault's latest anchor covers entries its own ledger file does not hold, which catches another writer once that writer has anchored; a second request with the same ref pays nothing and names the earlier spend. On 2026-11-09 the pay-per-call example ran through it on testnet: an endpoint answered `402` with a price of 0.01 test USDC, the agent paid 20 calls under a mandate of 20 uses, and the 21st was refused by code (`mandate.uses_exhausted`), as the contract's own `check_spend` also answered (`UsesExhausted`) ([evidence](docs/evidence/402-vault)). The example is not an implementation of x402 or of any other payment protocol | [`packages/mcp`](packages/mcp), [`examples/402`](examples/402) |
| Payables, the reference agent that pays invoices in USDC | **In progress**. The pipeline, its invoice API and the console pages are built and tested against a fake chain, and deploy with the console. On 2026-11-09 it ran on testnet with a real wallet, on the demo vault: of four invoices, two were paid (one after an approver's approval), one was refused for a changed payee and one was refused on upload as a duplicate ([evidence](docs/evidence/demo-vault)). It pays by itself only when an attested NEAR AI model confirms the amount the code read; without one, nothing is sent and the invoice waits for the owner, who can pay it with a wallet signature or reject it. The amount reader refuses any total it cannot read with certainty. Another text uploaded in the console with the invoice number of an invoice that was paid or may still pay, for the same payee, is refused by code in the signed ledger (`custom.invoice_number_duplicate`); one queued from the browser extension is answered as a duplicate at intake. An unfinished payment stays marked "do not resend" until the reconcile job is built | [`apps/web/src/lib/payables`](apps/web/src/lib/payables) |
| Browser extension for Chrome | **Built**; pending Chrome Web Store review since 2026-11-10 (item `hhadnmnjdlamihjjoejphkimnbcfidmn`). Until the store publishes it, load it unpacked. The extension (`apps/extension`, Chrome 127 or newer) connects from the `/extension` page or with a code, shows on its badge and in its popup what waits for you, and queues an invoice from selected text, the PDF in the tab, a linked PDF on the same site, or a file. It asks for four permissions (`storage`, `contextMenus`, `activeTab`, `alarms`) and Probarion's three addresses, and calls only `pair`, `inbox`, `invoices` and `revoke`. Its popup says "Nothing is paid from the browser. It waits until you confirm it in the console with your wallet." A replaced or disconnected connection revokes its token at that address. `apps/extension/store` holds the listing, the permission and data-use answers, the reviewer notes and the upload steps, which wait for the next promote and migration 0015; `apps/extension/TESTING.md` is the manual checklist. The server half: The signed-in `/extension` page makes a 30-day connection for one network (or shows a one-time code that works for ten minutes), lists each connection and revokes it. `GET /api/ext/inbox` lets a connection read what waits for you: invoices waiting for the owner, each marked as sent from the console or the browser extension, holds an approver can still approve, and the mandates an invoice can still be sent under. `POST /api/ext/invoices` lets a connection queue an invoice under a mandate it picks, for a vault where its account is the owner or an approver, 20 per 10 minutes. It reads the invoice as the console upload does, then refuses it, and stores nothing, when the amount is unclear, the mandate cannot take invoices, Confirm's keys are not active, the invoice's payee contradicts the mandate's (core's `payeeHintContradiction`) or the vault contract's free `check_spend` view would refuse it. Otherwise it stores the invoice waiting for the owner, with the checks it passed and the hold `extension.mandate_chosen`. It calls no model, opens no key and sends no transaction: only the owner's wallet-signed Confirm in the console pays it, and the contract checks that spend again. There is no purpose document, so at Confirm the signed ledger's purpose rule (`invoice.po_mismatch`) passes under the mandate the member picked; the hold stays on the invoice and its page, before and after Confirm. A connection is stored as a sha256 and its last four characters, at most 5 per account and network, and cannot pay, approve or confirm. `apps/web/test/ext-structure.test.ts` fails if the extension's server code imports anything that pays or signs or, outside `lib/crypto`, opens a sealed key; the queue's route reads the master key only to seal the invoice, as the console upload does. The test reads imports and names, so review of that code is the other control | [`apps/extension`](apps/extension), [`apps/extension/TESTING.md`](apps/extension/TESTING.md), [`apps/web/src/lib/ext`](apps/web/src/lib/ext), [`apps/web/src/app/api/ext`](apps/web/src/app/api/ext), [`apps/web/src/lib/payables/queue.ts`](apps/web/src/lib/payables/queue.ts), [`apps/web/test/ext-structure.test.ts`](apps/web/test/ext-structure.test.ts) |
| Canary, a public vault anyone may try to trick into paying them | **Live on NEAR testnet** since 2026-11-10, in live mode. `POST /api/canary/attempt` gives a visitor's text to a deliberately gullible model, and the Canary does not pay from its own cycle (a code rule refuses every attempt). In live mode a refused "pay" is also sent to the contract only when the contract's own dry run refuses it, so a visitor can watch the contract say no. In the team's rehearsal on 2026-11-10, a fake invoice asked for 50 USDC under the Canary's mandate, which pays at most 1 USDC a payment: the model proposed paying 50 USDC, the code rules refused it (`invoice.amount_invalid`), and the contract refused the same spend on chain with `OverPerPayment` ([transaction](https://testnet.nearblocks.io/txns/6XuxN42dDWaboaqaiCuRGKCoA1UrypcDfvat48v6z8DH)). Its tests run against a fake chain and a fake NEAR AI Cloud. Its ledger is private and the database refuses to make it public; nothing it puts on chain is derived from the visitor's text alone; one attempt is bounded at 80 s, which leaves a slow model 40 s and the contract step its 15 s. On the page `/canary`, beside its rules, a visitor sees what the model wanted, what the code rules decided and what the contract did, then a link to the console, beside a scoreboard and the latest attempts. The page shows its form only when the Canary vault and `NEARAI_API_KEY` are set, a private Canary tenant on that network has room in its ledger, its ledger key has gas for anchors (the console's Keys page asks for 2 NEAR on the Canary's ledger key and 3 NEAR on its agent key), and the vault holds a mandate. The vault card says when the owner froze the vault. When one of these is missing, as on mainnet, which has no Canary vault, the page shows attacks from the team's own tests instead (one: the smoke run's `NoMandate` refusal on testnet), and the route answers `not_ready` (`closed` once the ledger is full). An attempt also stores the one word its link named, such as `x` from `/canary?via=x`, from a closed set: nothing is stored for a visit alone, there is no new cookie, and the word is not shown in public. That lets the team count attempts by where people came from (`docs/ops/metrics.md`) | [`apps/web/src/lib/canary`](apps/web/src/lib/canary), [`apps/web/src/app/canary`](apps/web/src/app/canary), [probarion.xyz/canary](https://probarion.xyz/canary?via=readme) |
| Testnet and mainnet from one deployment | **Built** and tested. The network of a request is the address it was opened at. Each network has its own sign-in, vault pages, watcher and metrics runs, alerts, Canary board and `/usage`; a vault of the other network answers `409 wrong_network`, and a registered vault keeps its network. Settings that could point a network at the other chain are refused at start, and sign-in and Register first check that the RPC serves the right chain. Only the testnet address is live: mainnet has no factory yet, so no mainnet address is served | [`apps/web/src/lib/network.ts`](apps/web/src/lib/network.ts), [`docs/runbooks/web-deploy.md`](docs/runbooks/web-deploy.md#35-both-networks-in-one-project) |
| Public Usage page `/usage`: team vaults, external owners and Canary participants, counted apart, for the network of the address it is opened at | **Built** and tested. It shows counts, not dollar volumes, with the last 7 days beside each total, the model tokens a decision uses and how each number is counted; a dollar price appears only once one is set from NEAR AI's price list. A daily job (`GET /api/cron/metrics`, 00:10 UTC) computes the numbers and also deletes the rate limiter's rows older than a day; the page refreshes the numbers when they are an hour old. Each Canary attempt carries the network of its Canary vault, so the two networks never mix. `docs/ops/metrics.md` also holds the SQL the OWNER runs by hand, which is not on the page: Canary attempts by source, outside owners stage by stage (vault, agent key, mandate, first payment, still active a week later), and first payments by week. A test runs that SQL on the real schema | [`apps/web/src/app/usage`](apps/web/src/app/usage), [`apps/web/src/lib/usage`](apps/web/src/lib/usage), [`docs/ops/metrics.md`](docs/ops/metrics.md) |
| Watcher: the chain events of each vault registered with the app, in `vault_events`, which `/usage` counts and the owner alerts read | **Built** and tested against a fake chain. `GET /api/cron/watch` records each spend status, new mandates, anchors, refusals by the contract, agent and ledger keys whose allowance is under 0.2 NEAR, and vaults with under 0.05 NEAR free, each once. It runs once a day on Vercel (the Hobby plan takes only daily crons) and right after an invoice upload or a Canary attempt; its runbook also sets out a per-minute Supabase schedule, not yet run or tested | [`apps/web/src/lib/watcher`](apps/web/src/lib/watcher), [`docs/ops/watcher.md`](docs/ops/watcher.md) |
| Owner alerts by Telegram and email | **Built** and tested against a fake Telegram and a fake Resend; no real bot message or email has been sent yet. An owner or approver adds an alert on a vault's Alerts tab (`/console/<vault>/alerts`): an email is confirmed through a link, a Telegram chat through the bot's `/start`. After each watcher run, a spend held for approval, a spend the contract refused, a spend paid or paid out to Base, a failed payout, a key low on gas allowance and a vault low on NEAR each go out once per alert and event, not for a vault's old history. Every message says how to stop: the email's stop link and one-click unsubscribe, the bot's `/stop`, or Remove on the tab. The approval message links to the held spend's own approval page (`/console/<vault>/approve/<spend>`, the row below); an event without a spend id links the held card (`#held`), which comes first on the overview while a spend waits for approval. The held card offers an owner or approver "Get a message next time", unless a confirmed alert of the vault already sends held spends. The Alerts tab says when a message can arrive: right after an invoice upload, otherwise at the watcher's next run. Telegram and email switch on once `TELEGRAM_BOT_TOKEN` and `RESEND_API_KEY` are set | [`apps/web/src/lib/alerts`](apps/web/src/lib/alerts), [`docs/ops/alerts.md`](docs/ops/alerts.md) |
| Phone approval page for a held spend, `/console/<vault>/approve/<spend>`, which the approval alert links to | **Built** and tested against a fake chain; not tried on a phone with a real wallet yet. Tap the alert's link, sign in with your NEAR wallet if that browser has no session, then tap Approve or Reject and sign in your own wallet (on a phone, Meteor Wallet's app or its web wallet on testnet, where the console runs; NEAR Connect offers HOT Wallet on mainnet only). The page reads the spend, its mandate and the vault's config from the chain: the amount, the payee, the mandate, why it is held (its amount is above the mandate's `approval_above`), when the hold ends, and the invoice hash and ref. It links the console's invoice only when the console sent this spend from it, and warns when an invoice merely has the same hash and ref, which an agent can reuse. Amounts to an Intents payee are read in the payee's asset. The decision is on a phone's first screen, and the page is held to WCAG AAA (7:1 text contrast, 44px controls). Approve is offered only for a spend the chain reads as held, and approve and reject only to an account on the vault's approver list on chain; approve is not offered while the vault is frozen, after the hold ran out or for a revoked mandate. The server signs nothing | [`apps/web/src/lib/console/approve.ts`](apps/web/src/lib/console/approve.ts), [`apps/web/src/app/console/[vault]/approve/[spend]/page.tsx`](apps/web/src/app/console/%5Bvault%5D/approve/%5Bspend%5D/page.tsx) |
| Public `/proof/<vault>` page: checks a to i with explorer links, the snapshot and the signed ledger as downloads for the offline verifier | **Live** for the testnet demo vault `demo.vaults.probarion.testnet`: [its proof page](https://probarion.xyz/proof/demo.vaults.probarion.testnet) is public, its checks a to i pass on its own ledger and chain data, and [`/proof`](https://probarion.xyz/proof) opens it. Built and tested, and deployed with the console. A vault whose owner has not made its proof public answers page not found. Without a public demo vault, `/proof` offers a form and a ledger test that runs the verifier in your browser on a test fixture; the landing page has the same ledger test. The ledger test gives its verdict in a plain sentence, with the verifier's own words behind "Verifier detail"; a proof page ends with a link to the console. It prints its commands as `npx probarion …`, which run release 0.1.0 from npm with Node 24 and no clone; only a mainnet pre-ledger check also reads the repository's evidence files, so for it the page says to `git clone` the repository first. Its tests run the same verify commands through the repository's CLI | [`apps/web/src/app/proof`](apps/web/src/app/proof) |
| Health checks and the `/status` page | **Built** and tested. `GET /api/health` answers 503 when the deployment cannot read its settings, `GET /api/health/rpc?provider=<n>` checks one NEAR RPC provider of the address's network (the right chain, a block under two minutes old), and `GET /api/health/nearai` checks NEAR AI Cloud's public model list; answers are cached for 30 seconds and do not include a key or a configured URL. `/status` on each address shows those checks live for its network. The uptime monitors and a third-party status page are created by the owner and are not set up yet | [`apps/web/src/lib/health.ts`](apps/web/src/lib/health.ts), [`apps/web/src/app/status`](apps/web/src/app/status), [`docs/ops/MONITORING.md`](docs/ops/MONITORING.md) |
| Error reports to Sentry | **Built** and tested with the real SDK sending nothing; off until `SENTRY_DSN` is set. Before an event leaves, the user, cookies, headers, bodies and query strings are removed, a request breadcrumb keeps only the origin of another host (or a path on this site, without its query), and every known secret value and shape is masked; tracing is off. Each logged error becomes one issue per log key, tagged with its component; the Payables upload, Canary attempt and both crons also tag the request id of their log lines | [`apps/web/src/lib/sentry-scrub.ts`](apps/web/src/lib/sentry-scrub.ts), [`apps/web/src/lib/observe.ts`](apps/web/src/lib/observe.ts) |
| Incident runbook, threat model and security contact | **Shipped** as documents. The runbook covers severity, freezing, key rotation and RPC failover on both networks, with **OWNER SIGNS** above every mainnet send; a test fails if a mainnet send loses that mark or a one-yocto call its 1 yoctoNEAR. `/.well-known/security.txt` (RFC 9116) is on every address; the contact is a direct message to [@probarionhq](https://x.com/probarionhq) | [`docs/RUNBOOK.md`](docs/RUNBOOK.md), [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md), [`SECURITY.md`](SECURITY.md) |
| `/security`, `/terms` and `/privacy` pages | **Built** and tested. Every link on the site opens a real page; nothing reads "coming soon" any more | [`apps/web/src/app/security`](apps/web/src/app/security), [`apps/web/src/lib/site/ops-copy.ts`](apps/web/src/lib/site/ops-copy.ts) |
| Browser smoke test of the built site | **Built**; runs locally only, with test settings: `pnpm build`, then `pnpm --filter @probarion/web test:e2e`. It serves both networks, one per loopback address, and checks that the header fits on each at 375, 1120, 1280 and 1440 px. It is not in CI | [`apps/web/e2e/smoke.spec.ts`](apps/web/e2e/smoke.spec.ts) |

**Known limitations** ([all of them](docs/THREAT_MODEL.md#known-gaps)): no Content-Security-Policy
yet (owner and approver actions still need a 1 yoctoNEAR wallet prompt, so a script in the page
cannot approve or withdraw); the contracts link near-sdk's unmaintained default `wee_alloc`
allocator, which can change only with a new vault version; CI has no dependency-audit job
(Dependabot alerts are triaged in the review log); an exception on an untagged route, or in the
request that starts a server instance, reaches Sentry without a request id.

## What Probarion does

| Piece | What it does |
| --- | --- |
| **Mandates** | The owner signs each one from their own wallet: one payee (a NEAR account, or a Base or Solana address paid out through NEAR Intents), `max_per_payment`, `max_total`, `max_uses`, `expires_at_ns`, `approval_above`, and the one agent key that may use it. The payee is fixed when the mandate is created: a new payee needs a new mandate |
| **The vault** | One contract per owner that holds the USDC. `spend` checks the request against its mandate, the vault's daily backstop (per UTC day) and the invoices and refs already used; holds a spend above `approval_above` until an approver approves; and pays a NEAR payee with `ft_transfer`, or an Intents payee with `ft_withdraw` on `intents.near` and the memo `WITHDRAW_TO:<mandate address>`. A refusal is a readable `PROBARION:<Code>` error |
| **The agent key** | A function-call key the vault adds to itself on the owner's instruction, limited to `spend`. A second key, limited to `anchor`, signs the ledger |
| **Decisions** | `decide()` in `@probarion/core` is pure and deterministic. Its built-in rules run first and cannot be removed (`mandate.none`, `mandate.payee_mismatch`, `mandate.over_total`, `invoice.duplicate`, `invoice.po_mismatch`, `vault.daily_backstop`, `model.attestation_invalid`, `model.low_confidence` and others); your own `custom.*` rules run after them. A private model on NEAR AI Cloud may propose `pay`, `hold` or `refuse`, and its proposal counts only when its attestation checks pass. Without a model, or when it fails, the code decides alone and the ledger says `rules-only` |
| **The ledger** | Every decision and every outcome, refusals included, is an entry whose body hash is signed with Ed25519 and chained to the entry before it. The SDK anchors the latest root on the vault after every cycle |
| **Verify** | `runChecks` (offline, pure) and `verify()` (which gathers the chain state) run checks a to i: signatures, hash links, anchors, a decision for every spend, attestations, a locked vault, intents keys, burn memos and the factory version |
| **Owner tools** | The CLI prints each owner and approver transaction for `near-cli-rs` and signs none. The owner can freeze the vault with no deposit, from their full-access key or a function-call key on their account that may call the vault, and withdraw USDC and the Intents balance to their own account, without Probarion |

## Why it is different

- **The limit is on the money's path.** It is not in a prompt or in the agent's own process. Even if
  every line of off-chain code were wrong, the contract refuses a payment outside its mandate.
- **The agent cannot name the payee.** `SpendRequest` has `mandate_id`, `amount`, `invoice_hash`, `ref`
  and `decision_hash`, and no address. For a cross-chain payee the vault builds the `WITHDRAW_TO:`
  memo itself, from the mandate.
- **The agent key can do one thing.** The NEAR protocol limits a function-call key to its listed
  methods and to calls without a deposit. The agent key's one method, `spend`, moves value with no
  deposit, and only inside a mandate. Every owner and approver method but `freeze` needs a deposit,
  1 yoctoNEAR or the storage deposit of `create_mandate`, which only a full-access key can attach;
  `freeze` takes none, so the owner can stop the vault fast.
- **Confidential, attested, and only advice.** The model runs privately on NEAR AI Cloud. Its
  attestation report is bound to one position in one vault's ledger by a nonce, and its response is
  signed by the provider's TEE key. Whatever text an invoice carries, the model cannot widen a
  mandate: the code rules and the contract still apply.
- **Proof that does not need us.** `verify --vault` reads the chain itself. `verify --offline` runs
  over a snapshot and checks that file against itself, so a snapshot you did not take proves nothing
  about the chain ([what is not proven yet](SECURITY.md#what-is-not-proven-yet)). Contract builds are
  reproducible, their code hashes are recorded, and two public RPC calls show that a vault has no
  full-access key and which code it runs.

## NEAR technology used, and how

| NEAR technology | How Probarion uses it | Where |
| --- | --- | --- |
| **Smart contracts in Rust** (near-sdk 5.29.1) | The vault holds the USDC and checks every payment against its mandate before anything moves. The rule lives on the money's path, not in a prompt | [`contracts/vault`](contracts/vault) |
| **Function-call access keys** | The vault adds the agent's key to itself, limited to `spend`, and a second key limited to `anchor`. NEAR lets a function-call key call only its listed methods and attach no deposit. So the owner and approver methods that move value or change authority need a deposit that only a full-access key on the owner's or an approver's account can attach: 1 yoctoNEAR, or the storage deposit for `create_mandate`. `freeze` takes none, so the owner can also stop the vault fast with a function-call key on their account that may call the vault. The MCP server `@probarion/mcp` holds these two keys and no other | [`contracts/vault/src`](contracts/vault/src), [`packages/mcp`](packages/mcp) |
| **NEP-141 fungible tokens** | The vault pays a NEAR payee in USDC with `ft_transfer` | [`contracts/vault`](contracts/vault) |
| **NEAR Intents** | A Base or Solana payee is paid with `ft_withdraw` on `intents.near` and the memo `WITHDRAW_TO:<address>`, which the vault builds from the mandate. On mainnet the POA bridge then releases the USDC on the other chain. On testnet, `intents-stub.probarion.testnet` stands in for `intents.near`, so the burn is recorded and nothing leaves NEAR; the first mainnet payout is planned ([runbook](docs/runbooks/mainnet-v0.md)). On mainnet, the console's top-up asks the 1Click API for a quote into the vault's Intents balance; it has not been tried with a live quote yet | [`contracts/vault`](contracts/vault), [`apps/web/src/app/api/topup`](apps/web/src/app/api/topup) |
| **Global contracts** | The factory creates keyless vaults. It can deploy them from code stored once on chain and referenced by hash (`use_global_contract`), or from an embedded copy, and it keeps a version registry. The testnet factory serves the embedded copy today, and the global version is not deployed yet. The seller in the 402 example calls the factory's `vault_version` view to check that the vault paying it was created by the factory | [`contracts/factory`](contracts/factory), [`examples/402/src/paywall.ts`](examples/402/src/paywall.ts) |
| **NEAR AI Cloud** | A private model in a TEE proposes pay, hold or refuse over NEAR AI Cloud's API (plain `fetch` in `nearai.ts`). A nonce binds its attestation report to one ledger position, and the provider's TEE key signs its answer; `@probarion/core` checks both (A1 to A8). `verify --online` loads the optional `@nearai/inference-sdk` to check the TDX quote (O1) and the GPU evidence (O2). The model only advises: the code and the contract decide. Built and tested against a fake NEAR AI Cloud; a real attested decision is not recorded yet | [`packages/sdk/src/nearai.ts`](packages/sdk/src/nearai.ts), [`packages/sdk/src/online.ts`](packages/sdk/src/online.ts), [`packages/core`](packages/core) |
| **near-api-js 7** | The SDK signs and sends the agent's transactions with near-api-js; it reads vaults with its own JSON-RPC client, with failover. The console verifies wallet sign-in as a NEP-413 signed message | [`packages/sdk`](packages/sdk), [`apps/web/src/lib/auth/verify.ts`](apps/web/src/lib/auth/verify.ts) |
| **NEAR Connect** (`@hot-labs/near-connect`) | Wallet sign-in on the console. The user also signs every owner and approver transaction there, in their own wallet. On a phone, an approver opens the approval alert's link and signs `approve` in a mobile wallet: Meteor Wallet on testnet, HOT Wallet on mainnet, where NEAR Connect offers it. Not tried on a phone with a real wallet yet | [`apps/web/src/components/wallet`](apps/web/src/components/wallet), [`apps/web/src/lib/near/send.ts`](apps/web/src/lib/near/send.ts) |
| **near-cli-rs** | The CLI prints each owner and approver transaction as a near-cli-rs command for the owner to review and sign. The CLI signs nothing | [`packages/cli`](packages/cli) |
| **NEP-297 events** | The vault logs `EVENT_JSON` events (standard `probarion`) for mandates, keys, spends and their holds, freezes, anchors and withdrawals. For check h, `snapshot()` reads a burn's events: the POA token's `ft_burn` with its `WITHDRAW_TO:` memo and the intents contract's NEP-245 `mt_burn` | [`contracts/vault/src/events.rs`](contracts/vault/src/events.rs), [`packages/sdk/src/snapshot.ts`](packages/sdk/src/snapshot.ts) |
| **near-workspaces** and **cargo-near** | The contract integration tests run on a near-workspaces sandbox. cargo-near 0.22.0 builds the contracts reproducibly in CI. Their code hashes are recorded in `contracts/code-hashes.json`, and check f of `verify` accepts a vault whose code is one of those builds or a version of the canonical factory | [`contracts/integration-tests`](contracts/integration-tests), [`scripts/build-reproducible.sh`](scripts/build-reproducible.sh) |

## How a payment works

```mermaid
flowchart TD
    O["Owner wallet<br/>full-access key"]
    V["Vault contract<br/>one per owner, no full-access key"]
    A["Agent with @probarion/sdk<br/>process(invoice)"]
    M["Private model on NEAR AI Cloud<br/>proposes, attested (optional)"]
    P["Code: decide()<br/>built-in rules, then custom rules"]
    L[("Signed, hash-chained ledger")]
    R["Approver wallet"]
    N["Payee on NEAR"]
    I["intents.near<br/>ft_withdraw, memo WITHDRAW_TO:address"]
    B["Payee on Base"]

    O -- "create_mandate, add_agent,<br/>freeze, withdraw" --> V
    A --> M --> P
    P -- "1. decision entry, signed<br/>before anything is sent" --> L
    P -- "2. check_spend, then spend<br/>with the agent key" --> V
    V -- "above approval_above: held" --> R
    R -- "approve, 1 yoctoNEAR" --> V
    V -- "ft_transfer USDC" --> N
    V -- "Intents payee" --> I --> B
    L -- "3. anchor(seq, root, count)<br/>with the ledger key" --> V
```

In words, as `Probarion.process()` runs it:

1. **The owner sets the rules.** From their own wallet the owner funds the vault, adds the agent's
   public key with `add_agent` (the vault adds a `spend`-only key to itself) and signs a mandate for
   that key. The CLI prints each of these transactions; it does not sign them.
2. **The model proposes, if there is one.** The SDK derives a nonce from the next ledger position and
   the vault account, asks a private TEE model on NEAR AI Cloud for one structured proposal, and
   fetches the attestation report for that nonce and the `provider_tee` signature.
3. **Code decides.** `decide()` picks the mandate by the purchase order's hash, and the destination
   is always that mandate's payee: a payee the invoice claims that contradicts it is refused. The
   decision is signed into the ledger before anything is sent, and its body hash travels to the
   contract as `decision_hash`.
4. **The contract decides last.** The SDK runs the free `check_spend`, then `spend` with the agent
   key. The vault checks, in order: frozen, mandate exists, active, not expired, signed by this
   mandate's key, amount above zero and within the per-payment limit, uses left, spent plus reserved
   plus amount within the total, invoice and ref unused, and the daily backstop. Above
   `approval_above`, the spend waits for an approver until its hold expires.
5. **The vault pays.** A NEAR payee is paid with `ft_transfer`. For a Base payee the vault calls
   `ft_withdraw` on `intents.near` with the memo `WITHDRAW_TO:<mandate address>`. On mainnet the POA
   bridge then releases the USDC on Base; on testnet the stub records the burn and nothing leaves NEAR.
6. **The ledger records and anchors.** The outcome becomes a ledger entry, and the ledger key anchors
   the new root on the vault. `verify` later ties each on-chain spend to exactly one decision.

## Safety architecture

```mermaid
flowchart LR
    M["Model<br/>proposes"] --> C["Code<br/>decides"] --> K["Contract<br/>enforces"] --> L["Ledger<br/>records"] --> V["verify<br/>re-checks"]
```

| Layer | What it enforces | Where |
| --- | --- | --- |
| **Spend-only key** | The agent key can call `spend` and nothing else, with no deposit | [`keys.rs`](contracts/vault/src/keys.rs) |
| **No address in the request** | The destination and the Intents memo come from the mandate in storage | [`types.rs`](contracts/vault/src/types.rs), [`spend.rs`](contracts/vault/src/spend.rs) |
| **Mandate limits** | Per payment, total (counting reservations), uses, expiry, and the one agent key the mandate names | [`checks.rs`](contracts/vault/src/checks.rs) |
| **Daily backstop** | A vault-wide cap on what is reserved or paid per UTC day | [`checks.rs`](contracts/vault/src/checks.rs) |
| **Exactly once** | An invoice hash is paid at most once, and a `ref` is accepted once | [`checks.rs`](contracts/vault/src/checks.rs) |
| **Holds** | A spend above `approval_above` pays only after an approver approves it, before its hold expires and while the vault is not frozen | [`held.rs`](contracts/vault/src/held.rs) |
| **One-yocto rule** | `add_agent`, `remove_agent`, `set_ledger_key`, `revoke_mandate`, `approve`, `reject`, `unfreeze`, `withdraw` and `withdraw_intents` need exactly 1 yoctoNEAR, so a dapp login key cannot call them | [`errors.rs`](contracts/vault/src/errors.rs) |
| **Freeze** | The owner stops every new spend and every approve at once, with no deposit: from their full-access key, or from a function-call key on their account that may call the vault. `reject` and `expire_held` still work | [`admin.rs`](contracts/vault/src/admin.rs) |
| **No way to change the rules underneath** | No upgrade method, no method to change the owner or the approvers, no full-access key on the vault | [`lib.rs`](contracts/vault/src/lib.rs) |
| **Code before the contract** | `decide()` refuses or holds before a transaction exists; built-in rules cannot be removed | [`policy.ts`](packages/core/src/policy.ts) |
| **Signed ledger and anchors** | Every entry is signed and chained; anchors pin each range on chain, with the key that signed it | [`ledger.ts`](packages/core/src/ledger.ts), [`anchors.rs`](contracts/vault/src/anchors.rs) |
| **Verify** | Checks a to i, attestation checks A1 to A8, online O1 and O2 | [`verify.ts`](packages/core/src/verify.ts), [`attestation.ts`](packages/core/src/attestation.ts), [`online.ts`](packages/sdk/src/online.ts) |

**If the agent's key leaks.** Say an attacker takes over the server that runs the agent:

| The attacker can | but cannot |
| --- | --- |
| Call `spend` with the stolen key | Pay anyone a mandate does not name |
| Submit made-up invoice hashes against open mandates | Exceed a mandate's per-payment limit, total, uses or expiry, or the vault's daily backstop; a spend above `approval_above` still waits for an approver |
| Rewrite the off-chain ledger | Hide it in an anchored range: `verify` names the first entry that does not match |
| Stop the agent | Touch the owner's funds: the owner can freeze, withdraw and remove keys from their own wallet, without Probarion |

**The agent cannot approve itself with its own key.** In the I-HITL paper
([arXiv:2610.35835](https://arxiv.org/abs/2610.35835)), AI agents raised their own wallet limits by
reading the passcode emailed to the owner. A Probarion agent key has no such path: NEAR refuses any
transaction it signs for a method other than `spend` or with a deposit, a higher limit needs a new
mandate from the owner's account, and a held spend pays only on `approve` from an approver's account.
The sandbox test [`ihitl.rs`](contracts/integration-tests/tests/ihitl.rs) replays the paper's attack
with the agent key and checks each refusal by its exact NEAR error, and that the mandate, the config
and the keys did not change. This holds while the owner's and the approvers' keys stay out of the
agent's reach, on a device it cannot drive: an agent that can sign with one of them puts the vault in
what the paper calls the plain topology, where no approval gate can tell the person from the agent.
[The agent key cannot approve itself](https://probarion.xyz/docs/trust/self-approval)
maps each step to its evidence and lists the gaps, among them a payment split into spends under
`approval_above`.

What the checks do not prove yet, such as the TEE measurement (O1b, deferred), is listed in
[SECURITY.md](SECURITY.md#what-is-not-proven-yet). The contract source is in
[`contracts/`](contracts) and has not been audited.

## On-chain proof

### NEAR testnet, 2026-11-01

Intents has no testnet, so `intents-stub.probarion.testnet` stands in for `intents.near`, and the
tokens are test tokens (`test-ft` acting as USDC and as the Base and Solana POA tokens). On testnet a
cross-chain burn does not leave NEAR. The smoke run exercised the contract alone: its spends were sent
with the agent key directly, without the SDK, a model or a ledger, so this vault has no ledger key
and no anchors yet. For the same reason, `verify --vault v0.probarion.testnet` prints `RESULT: FAIL`
today: check d finds spends with no decision in the ledger, and check h finds no burn event without
the burn's tx hash. The [demo vault](#near-testnet-demo-vault-2026-11-09) below passes all nine checks.

| Account | Role |
| --- | --- |
| [`v0.probarion.testnet`](https://testnet.nearblocks.io/address/v0.probarion.testnet) | The vault. Owner `probarion-owner.testnet`, approver `probarion-approver.testnet`, daily backstop 500 test USDC, holds expire after 72 hours. No full-access key: its one access key is the agent's `spend`-only key. Code hash `6tbERLAXWjaVKbSNzaivRDh7H9kCcjtmV1qGrgz7entR`, the reproducible CI build recorded for commit `3bd8189` in [`contracts/code-hashes.json`](contracts/code-hashes.json) |
| [`usdc.probarion.testnet`](https://testnet.nearblocks.io/address/usdc.probarion.testnet) | `test-ft` acting as USDC |
| [`base-usdc.probarion.testnet`](https://testnet.nearblocks.io/address/base-usdc.probarion.testnet), [`sol-usdc.probarion.testnet`](https://testnet.nearblocks.io/address/sol-usdc.probarion.testnet) | `test-ft` acting as the Base and Solana POA tokens |
| [`intents-stub.probarion.testnet`](https://testnet.nearblocks.io/address/intents-stub.probarion.testnet) | The stand-in for `intents.near` |
| [`probarion.testnet`](https://testnet.nearblocks.io/address/probarion.testnet) | The account that created the others |

| What happened | Transaction | Result |
| --- | --- | --- |
| The agent key called `spend` on mandate 1, a NEAR payee | [`3DFV2thB…Fy9cX`](https://testnet.nearblocks.io/txns/3DFV2thBU9V4b5w7kM691poLJ8SWiCqp46LKBn1Fy9cX) | Spend 1 `paid`: 1 test USDC to `probarion-payee.testnet` (`spend_submitted`, `ft_transfer`, `spend_paid`) |
| The agent key called `spend` on mandate 2, a Base payee | [`3u4ffrwp…dcvYe`](https://testnet.nearblocks.io/txns/3u4ffrwpiwLoNV6cU72NHLVBAMq729NwLs6ixDLdcvYe) | Spend 2 `burned`: 1 test USDC, `mt_burn` and `ft_burn` with the memo `WITHDRAW_TO:0x1111111111111111111111111111111111111111` the vault built from the mandate |
| The agent key called `spend` on mandate 999, which does not exist | [`AkjyVPmb…dzgY`](https://testnet.nearblocks.io/txns/AkjyVPmb6LdMES7ykpzJQR7EXXGvw3kYH6Nhem9YdzgY) | Refused by the contract: `PROBARION:NoMandate` |
| The agent key called `spend` on mandate 1 for 6 test USDC, above its limit of 5 test USDC per payment (2026-11-09, after the smoke run) | [`4715d4nb…Vsr1`](https://testnet.nearblocks.io/txns/4715d4nbYn6cq981nmLU5y8efCoX2w3SbgW8PPq4Vsr1) | Refused by the contract: `PROBARION:OverPerPayment`. Nothing was paid, and no call reached the USDC contract |

NearBlocks' testnet index can lag behind the chain. Step 3 of
[the evaluation](#how-to-evaluate-probarion-in-5-minutes) reads the same transactions from an archival
RPC node. The deployment record is [`contracts/deployments/testnet.json`](contracts/deployments/testnet.json),
and the steps are in [`docs/runbooks/testnet.md`](docs/runbooks/testnet.md).

The vault source changed after this deployment (a `set_ledger_key` fix on 2026-11-03), so
`v0.probarion.testnet` runs the earlier build. The fixed build, recorded in
[`contracts/code-hashes.json`](contracts/code-hashes.json) (commit `64ac3c0`, code hash
`3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1`), runs on the vaults the testnet factory creates.

The factory went on testnet on 2026-11-05, following [`docs/runbooks/factory.md`](docs/runbooks/factory.md).
It serves one version, the fixed vault build as an embedded copy, so a new vault pays for the storage
of its own code. The global version waits: publishing it burns about 25 test NEAR.

| Account | Role |
| --- | --- |
| [`vaults.probarion.testnet`](https://testnet.nearblocks.io/address/vaults.probarion.testnet) | The factory. Owner `probarion-owner.testnet`, `min_deposit` 0.5 NEAR. Code hash `FK6mMqUdieWmYyB9hqyJL23Aew9wWGSPustb6tUDtaQ6`, the reproducible CI build recorded for commit `3e7bd2d`. Version 1: the vault build `3cQXYDvf…`, embedded |
| [`smoke-embedded.vaults.probarion.testnet`](https://testnet.nearblocks.io/address/smoke-embedded.vaults.probarion.testnet) | The smoke vault the factory created ([`EZ7pm7FQ…wokdD`](https://testnet.nearblocks.io/txns/EZ7pm7FQrJTvooKAwmEyZq4gUKueCNcDdpweib6wokdD)). Owner `probarion-owner.testnet`, approver `probarion-approver.testnet`, no access keys, code hash `3cQXYDvf…` |

### NEAR testnet demo vault, 2026-11-09

`demo.vaults.probarion.testnet` ran end to end through the web console at [probarion.xyz](https://probarion.xyz):
created through the factory, given an agent key and a ledger key, filled from the testnet faucet, given a mandate on a
purchase order, then sent four invoices through Payables. A person signed every owner and approver step in their own
wallet. The SDK signed each decision into the ledger before its spend and anchored the ledger five times, so a live
`verify` reads the chain and passes checks a to i. [Its proof page](https://probarion.xyz/proof/demo.vaults.probarion.testnet)
is public. The invoices, the ledger, the snapshot, the verifier's output and every transaction are in
[`docs/evidence/demo-vault`](docs/evidence/demo-vault), and the deployment record has the vault under `demo_vault`.

| Invoice | What happened | Transaction |
| --- | --- | --- |
| INV-2001: 2 test USDC to the mandate's payee | Paid as spend 1 | [`HFyW61UZ…dQp1`](https://testnet.nearblocks.io/txns/HFyW61UZXfwpqhgqWq9bXnRXaYiEnpk4WPUHDAEydQp1) |
| INV-2001 again | Refused on upload as a duplicate. Nothing was decided or sent | None |
| INV-2002: "we changed banks", 2 test USDC to `new-account.testnet` | Refused by code, rule `mandate.payee_mismatch`, ledger entry 3. Nothing was sent | None |
| INV-2003: 4 test USDC, above the mandate's approval limit of 3 | Held as spend 2, then approved by `probarion-approver.testnet` from its own key, and paid | [`6oDNZEUB…2Tb`](https://testnet.nearblocks.io/txns/6oDNZEUBWMSZxLq2ANXMhWNxzii3irVAcqoXf7eHy2Tb), [`47VCARhw…FJf`](https://testnet.nearblocks.io/txns/47VCARhwsG2B7xbaFDS3f6nZdqR2gnQvBMofcP9FNCJf) |

To verify it live, download the ledger file from [its proof page](https://probarion.xyz/proof/demo.vaults.probarion.testnet)
and run, with Node 24 or later:

```bash
npx probarion verify --network testnet --vault demo.vaults.probarion.testnet --ledger probarion-demo.vaults.probarion.testnet-ledger.jsonl
```

On 2026-11-09 that run printed `9 passed, 0 failed, 0 unproven` and `RESULT: PASS`
([output](docs/evidence/demo-vault/verify-2026-11-09.txt)). The vault may have acted since, so its counts can be higher.
To check the recorded run offline instead, with no network, from a clone of the repository:

```bash
npx probarion verify --offline docs/evidence/demo-vault/snapshot-2026-11-09.json
```

### NEAR testnet pay-per-call vault, 2026-11-09

`percall.vaults.probarion.testnet` paid for API calls through the MCP server. An endpoint answered each call with
`402 Payment Required` and a quote for 0.01 test USDC to `probarion-payee.testnet`. The agent, an MCP client of
[`@probarion/mcp`](packages/mcp), found the mandate that pays that account, called `request_spend` with the quote's
hash, and sent the call again with the spend id. The endpoint read the spend from the vault and served the data.
The mandate allowed 0.01 USDC a payment and 20 uses, and the agent asked 21 times:

| Calls | What happened | Transaction |
| --- | --- | --- |
| 1 to 20 | Paid, 0.01 test USDC each, as spends 1 to 20, and each call got its data | [`8q5qwWhz…`](https://testnet.nearblocks.io/txns/8q5qwWhzxKnZYgMbXLGvBJmvVT2HFyLJVQhDqLBf561H) (spend 1) to [`4T3zW2KU…`](https://testnet.nearblocks.io/txns/4T3zW2KUAxZsiUPkyGyGwSKPX13pT4fYWrZN6auHNY69) (spend 20) |
| 21 | Refused by code, rule `mandate.uses_exhausted`, ledger entry 40. Nothing was sent; the contract's `check_spend` view answered `UsesExhausted` | None |

The ledger key anchored the ledger after every call, and a live `verify` passes checks a to i
([output](docs/evidence/402-vault/verify-2026-11-09.txt)). The setup and spend transactions, the ledger and the
snapshot, which holds the 21 anchors, are in [`docs/evidence/402-vault`](docs/evidence/402-vault). To check the recorded run offline, from a clone of the repository:

```bash
npx probarion verify --offline docs/evidence/402-vault/snapshot-2026-11-09.json
```

### NEAR mainnet

**Planned.** The first mainnet vault, `v0.probarion.near`, follows
[`docs/runbooks/mainnet-v0.md`](docs/runbooks/mainnet-v0.md): a NEAR payment, a Base payout through
NEAR Intents and a `NoMandate` refusal, with small amounts and the owner signing every step. Until it
runs, [`contracts/deployments/mainnet.json`](contracts/deployments/mainnet.json) and
[`docs/mainnet-proof.json`](docs/mainnet-proof.json) hold no transactions, and this README makes no
mainnet claim.

## Where things are in this repository

| Path | What it holds |
| --- | --- |
| [`contracts/vault`](contracts/vault) | The vault contract (Rust, near-sdk 5.29.1): mandates, the spend check, holds, freeze, withdrawals and anchors, with unit and property tests |
| [`contracts/factory`](contracts/factory) | The factory: keyless vaults from global code referenced by hash, or from stored wasm, and the version registry |
| [`contracts/intents-stub`](contracts/intents-stub), [`contracts/test-ft`](contracts/test-ft) | Test stand-ins for `intents.near` and for USDC, for the sandbox and testnet only |
| [`contracts/integration-tests`](contracts/integration-tests) | near-workspaces sandbox tests, run by CI on Linux |
| [`contracts/deployments`](contracts/deployments), [`contracts/code-hashes.json`](contracts/code-hashes.json) | The testnet accounts and smoke transactions, the empty mainnet record, and the recorded reproducible code hashes |
| [`packages/core`](packages/core) | `@probarion/core`: types, canonical hashing, keys, the ledger, the policy engine, the attestation checks and the verifier. No network, no file system |
| [`packages/sdk`](packages/sdk) | `@probarion/sdk`: the RPC client, the vault, intents and factory clients, the NEAR AI Cloud adapter, the ledger stores, the `Probarion` class, `snapshot()` and `verify()`, and test doubles |
| [`packages/cli`](packages/cli) | `probarion`: owner and approver transaction printers and key generation |
| [`packages/mcp`](packages/mcp) | `@probarion/mcp`: the MCP server, five tools over `@probarion/sdk`, none of which takes an address |
| [`examples/402`](examples/402) | The pay-per-call example: an endpoint that answers `402` with a price, and an agent that pays it through `@probarion/mcp` under a mandate |
| [`apps/web`](apps/web) | The web console (Next.js 16, Supabase with row-level security), in progress |
| [`apps/extension`](apps/extension) | The Chrome extension (Manifest V3): the worker, the popup, the build and store zip, the rendered icons and store images, the store pack and the manual checklist |
| [`apps/web/content/docs`](apps/web/content/docs) | The Docs Center's pages, one MDX file each, with the [authoring guide](apps/web/content/docs/README.md). The registry that lists them is in [`apps/web/src/lib/docs/pages`](apps/web/src/lib/docs/pages) |
| [`scripts`](scripts) | Contract builds, the reproducible build and code-hash record, testnet deploy and smoke, the proof file and the release check |
| [`docs/specs`](docs/specs) | The design spec and the shared interfaces |
| [`docs/runbooks`](docs/runbooks), [`docs/ops`](docs/ops) | Deploy runbooks (testnet, factory, mainnet v0, the web console), the key rotation procedure, the guide to the usage numbers, the watcher's runbook and the alerts runbook |
| [`docs/evidence`](docs/evidence) | The purchase order and invoices prepared for the planned mainnet v0 run, and the records of the testnet runs ([`demo-vault`](docs/evidence/demo-vault), [`402-vault`](docs/evidence/402-vault)) |

## Quick start

Release 0.1.0 is on npm. ESM only, Node 24 or newer:

```bash
npm install @probarion/sdk @probarion/core   # the SDK for your agent; the examples import both
npm install -g probarion                      # the CLI, or run it once with npx probarion
```

The steps below, the evaluation and the tests use the repository's fixtures and scripts, so they run from
a clone:

```bash
git clone https://github.com/probarion/probarion.git
cd probarion
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/bin.js --help
```

**Read a vault with the SDK.** A read-only instance needs no key: step 4 of
[the evaluation](#how-to-evaluate-probarion-in-5-minutes) lists the mandates of the testnet vault and
dry-runs a spend against it.

**Make an agent key.** This writes the key pair to a file you keep on your server and prints only the
public key, which the vault owner adds with `probarion agent add`:

```bash
node packages/cli/dist/bin.js agent keygen --out ../agent-key.json
```

**Run an agent against a vault.** `Probarion.process()` needs:

- a vault you own, with USDC in it (on testnet, create one with Create a vault in the console or
  with `vault create`, which prints the `create_vault` call to `vaults.probarion.testnet`);
- `PROBARION_AGENT_KEY`, the secret of a `spend`-only key the owner added with `agent add`, and a
  mandate that names its public key;
- `PROBARION_LEDGER_KEY`, the secret of an `anchor`-only key the owner set with `ledger set-key`;
- optionally `NEARAI_API_KEY`, for the model step on NEAR AI Cloud. With `model: null` the code
  decides alone.

[`.env.example`](.env.example) lists every variable, and the
[`@probarion/sdk` README](packages/sdk/README.md) shows `process()`, its outcomes and the ledger
stores.

**Give an MCP client the vault.** `@probarion/mcp` is not on npm yet, so it runs from the clone you built
above. With the same two keys, add it to Claude Code from the clone's folder:

```bash
claude mcp add probarion -e PROBARION_VAULT_ID=<vault> -e PROBARION_AGENT_KEY=ed25519:... -e PROBARION_LEDGER_KEY=ed25519:... -- node "$PWD/packages/mcp/dist/bin.js"
```

Ask the agent to list its mandates, and you see each one's payee, caps, what is left, uses left and expiry. Leave
the two keys out and it runs read-only; its `verify` then reads the ledger file at `PROBARION_LEDGER_PATH`. [Its README](packages/mcp/README.md) has the other MCP clients and every
variable.

**Pay per call.** The 402 example runs its 21 calls against the SDK's fake chain, with no network:

```bash
pnpm --filter @probarion/example-402 run test
```

You see `test/pay-per-call.test.ts` pass: 20 calls paid at 0.01 test USDC and the 21st refused with
`mandate.uses_exhausted`. To run it on testnet against your own vault, start the endpoint with
`pnpm --filter @probarion/example-402 run paywall` and the agent with `run agent` in a second terminal, as
[the example's README](examples/402/README.md) says. You see one line per call, from
`#01 402 for 0.01 USDC -> paid` to `#21 ... -> refused_by_code (mandate.uses_exhausted)`.

## Documentation

| | |
| --- | --- |
| **Docs Center** | [Docs home](https://probarion.xyz/docs) · [Evaluate in 5 minutes](https://probarion.xyz/docs/start/evaluate-in-5-minutes) · [Owner quickstart](https://probarion.xyz/docs/start/owner-quickstart) · [Developer quickstart](https://probarion.xyz/docs/start/developer-quickstart) · [Errors](https://probarion.xyz/docs/build/errors) · [For AI agents](https://probarion.xyz/docs/resources/for-ai-agents) · [llms.txt](https://probarion.xyz/llms.txt) |
| **Design** | [Design spec](docs/specs/2026-10-21-probarion-design.md) · [Interfaces: ABI, ledger, attestation checks, verifier](docs/specs/2026-10-21-probarion-interfaces.md) · [Security policy](SECURITY.md) · [Threat model](docs/THREAT_MODEL.md) |
| **Packages** | [`@probarion/core`](packages/core/README.md) · [`@probarion/sdk`](packages/sdk/README.md) · [`probarion` CLI](packages/cli/README.md) · [`intents-stub`](contracts/intents-stub/README.md) |
| **Operations** | [Testnet runbook](docs/runbooks/testnet.md) · [Factory runbook](docs/runbooks/factory.md) · [Mainnet v0 runbook](docs/runbooks/mainnet-v0.md) · [Web deploy runbook](docs/runbooks/web-deploy.md) · [Key rotation](docs/ops/key-rotation.md) · [Usage numbers](docs/ops/metrics.md) · [Watcher](docs/ops/watcher.md) · [Alerts](docs/ops/alerts.md) · [Incident runbook](docs/RUNBOOK.md) · [Monitoring](docs/ops/MONITORING.md) |
| **This repository** | [AGENTS.md](AGENTS.md), for AI agents and humans who build here · [Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Changelog](CHANGELOG.md) · [CI runs](https://github.com/probarion/probarion/actions/workflows/ci.yml) |

## Development

Rust 1.99.1 (`rust-toolchain.toml`, target `wasm32-unknown-unknown`), near-sdk 5.29.1, Node.js 24,
pnpm 10, TypeScript 5, Vitest 4, Biome 2, Next.js 16 and Supabase.

```bash
pnpm install --frozen-lockfile
pnpm verify        # Rust unit and property tests, then lint, build, typecheck, every TS test and the launch checks
pnpm verify:ts     # the TypeScript part only, no Rust needed
```

As of 2026-11-03, `pnpm verify` ran 301 Rust tests: 227 vault unit tests, 2 error-coverage tests,
2 property tests that take about two minutes, and 53 factory, 12 intents-stub and 5 test-ft tests.
As of 2026-11-09 it runs 10,767 TypeScript tests: 290 Node script tests, 806 in `@probarion/core`,
782 in `@probarion/sdk`, 341 in the CLI, 8,349 in the web console and 199 launch checks. Skipped on
the Windows run of that day:
- in the SDK, the two tests of a recorded real NEAR AI Cloud decision, which wait for that
  recording;
- in the CLI, 15 tests: one file-permission test, and the tests that parse the printed commands
  with near-cli-rs, which need `near` on PATH. CI skips them too: its TypeScript job does not
  install near-cli-rs.

The browser extension's tests, added after that count, need no server and no Chrome:
`pnpm --filter @probarion/extension test` (250 tests). `pnpm --filter @probarion/extension build`
writes the unpacked extension to `apps/extension/dist`; [its README](apps/extension/README.md) says
how to load and try it.

The Playwright specs in [`apps/web/e2e`](apps/web/e2e), 57 tests, run locally against a build with
test settings: `pnpm build`, then `pnpm --filter @probarion/web test:e2e`.

Some checks need Linux or Docker, so they run in [CI](.github/workflows/ci.yml) (GitHub Actions,
ubuntu) on every pull request into `dev` or `main`, every push to those two branches and every `v*` tag:

| CI job | What it does |
| --- | --- |
| Rust fmt, clippy and unit tests | `cargo fmt --check`, `cargo clippy -D warnings`, the unit and property tests |
| Sandbox integration tests | `cargo near build` of every contract, then the near-workspaces sandbox tests (`pnpm test:sandbox`, Linux only): 17 tests in [the run of 2026-11-03](https://github.com/probarion/probarion/actions/runs/41602304226) |
| Reproducible build and code hash | Builds the vault and the factory in Docker with cargo-near 0.22.0 and compares each code hash with `contracts/code-hashes.json` |
| TS lint, typecheck and tests | `pnpm verify:ts` and `pnpm verify:launch` |
| Secret scan | gitleaks over the whole history |
| `verify` | Passes only when every job above succeeded; a skipped or cancelled job fails it. This is the one check a branch rule requires |

When a gate fails, the job's last step posts the last 60 lines of that gate's log as an annotation and in the job summary, so the cause is readable without signing in.

A local `pnpm contracts:build` (cargo-near 0.22.0) is not reproducible and is not a source of code
hashes; [AGENTS.md](AGENTS.md#reproducible-builds-and-code-hashes) describes how a CI build is
recorded.

The web console needs a Supabase project and `KEY_ENCRYPTION_SECRET` (32 random bytes, base64) to
run; [`.env.example`](.env.example) lists every variable. Its tests need neither: they run every
migration on an in-process Postgres (PGlite) inside `pnpm verify`.

## Prior work

The design spec and the interfaces in [`docs/specs`](docs/specs) were written on 2026-10-21, after
the hackathon's announcement on 2026-10-19 and before its start on 2026-11-01, and have been amended
since through the interface change requests their git history records. The specs refer to
pre-hackathon spikes (S1 to S9); they are not part of this repository, whose first commit was made on
2026-11-01 at 01:07 UTC.

## Libraries, templates and AI-assisted code

The hackathon's rules ([nearhackathon.com/HACKATHON.md](https://nearhackathon.com/HACKATHON.md))
answer two questions this section covers:

> **Q-001. Code before 2026-11-01?** Yes, from the announcement on 2026-10-19 (…). The window runs
> from then to 2026-11-14. Earlier commits are baseline.
>
> **Q-005. Libraries, templates, boilerplate?** All allowed, including own pre-hackathon libs and AI
> code. List in README; own old libs count as baseline.

For Probarion:

- **Code or libraries from the builder's earlier projects:** none.
- **Project templates or generators:** none. The repository's first commit, on 2026-11-01 at
  01:07 UTC, is empty; the workspace, the contracts and the web app were written in it file by file.
- **Work done before 2026-11-01:** the design spec and the interfaces spec in
  [`docs/specs`](docs/specs), both written on 2026-10-21, after the announcement of 2026-10-19, and
  the throwaway spikes S1 to S9 the specs refer to, run in a separate repository that is not part of
  this one (see [Prior work](#prior-work)). The interfaces spec sets the repository layout, the
  pinned versions, and the names, JSON shapes, error codes and constants, and it gives the type and
  constant definitions as TypeScript and Rust blocks. Those definitions went into the code as the
  spec gives them, in commits of 2026-11-01, among them the network constants in
  [`packages/core/src/constants.ts`](packages/core/src/constants.ts), the vault's ABI types in
  [`contracts/vault/src/types.rs`](contracts/vault/src/types.rs) and the ledger and verifier types
  in [`packages/core/src/types.ts`](packages/core/src/types.ts). Everything else was written in this
  repository from 2026-11-01 on.
- **AI-written code:** most of the code, tests and documentation; see
  [AI-assisted code](#ai-assisted-code) below.
- **Libraries and tools:** the table below, with the versions the manifests pin or allow.

| Part | Built with |
| --- | --- |
| Contracts | near-sdk 5.29.1, alone in the vault and the factory; the test token and the Intents stub also use near-contract-standards 5.29.1. cargo-near 0.22.0 builds them with Rust 1.99.1, in the `sourcescan/cargo-near:0.22.0-rust-1.99.1` image for the reproducible build. The tests use near-sdk's `unit-testing` feature, proptest (the vault's invariants in [`invariants.rs`](contracts/vault/tests/invariants.rs)), and near-workspaces 0.23.0 with tokio, anyhow and serde_json (the sandbox tests) |
| `@probarion/core` | `@noble/curves` (ed25519 keys and ledger signatures), `@noble/hashes` (sha256), `canonicalize` (canonical JSON before hashing), bs58, and viem 2 (recovering the address that signed a model's answer) |
| `@probarion/sdk` | `@probarion/core`, near-api-js 7 (signing and sending the agent's transactions) and viem 2. `@nearai/inference-sdk` is an optional peer dependency |
| CLI (`probarion`) | `@probarion/core`, `@probarion/sdk` and commander 15. `@nearai/inference-sdk` is an optional dependency, which `verify --online` loads |
| `@probarion/mcp` and [`examples/402`](examples/402) | The MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32), zod 4 in the server, and Probarion's own packages |
| Web console | `@probarion/core` and `@probarion/sdk`, Next.js 16 and React 19, Tailwind CSS 4, `@hot-labs/near-connect` 0.11.4 (wallet sign-in and signing), near-api-js 7, viem 2, `@defuse-protocol/one-click-sdk-typescript` 0.1.26 (checking the signature on a 1Click quote; the console calls the 1Click API itself), `@supabase/supabase-js` 2, `libsodium-wrappers` 0.8.4 (sealing the keys and invoices it stores, authenticating the session and sign-in cookies, and the keyed hashes behind alert stop links and rate limits), `pdf-parse` 2.4.5 (reading invoice PDFs), Resend 6 (email), `@sentry/nextjs` 11 (error reports), and the Hanken Grotesk and IBM Plex Mono fonts through `next/font/google`. The Docs Center adds `@next/mdx` and `@mdx-js/loader`, unified with remark-parse, remark-gfm, remark-mdx, remark-stringify, rehype-slug and github-slugger, Shiki 4.6 with `@shikijs/rehype`, and MiniSearch 7.2 for search. The wallets' executor scripts are not bundled: browsers load them at run time from `raw.githubusercontent.com`, at pinned commits of hot-dao/near-selector, Meteor-Wallet/meteor_wallet_sdk and near/near-connect-ledger ([`manifest.ts`](apps/web/src/components/wallet/manifest.ts)) |
| Browser extension | No runtime dependency; esbuild builds it |
| Tests and tools | Vitest 4, TypeScript 5.9, tsx, Biome 2 (lint and format), PGlite (`@electric-sql/pglite`, which runs every migration in-process for the web tests), tweetnacl (the web tests sign 1Click quotes with a key of their own) and Playwright (the browser checks in [`apps/web/e2e`](apps/web/e2e)) |
| CI | GitHub Actions with `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`, `pnpm/action-setup`, `dtolnay/rust-toolchain` and `Swatinem/rust-cache`, each pinned to a commit; gitleaks 8.21.2 for the secret scan, from the `zricethezav/gitleaks` image pinned by its sha256 digest; and cargo-near 0.22.0's release archive, checked against its sha256 |
| Services | NEAR RPC: FastNEAR by default, with Intear's RPC (`rpc.intea.rs`) as the second mainnet RPC, and FastNEAR's archival RPCs; the landing page's live check asks `rpc.testnet.fastnear.com`, then `rpc.testnet.near.org`, from the browser. FastNEAR's transactions API, which the SDK reads when it verifies online. NEAR AI Cloud and, for `verify --online` through `@nearai/inference-sdk`, Intel's PCS (the collateral the library uses to check the TDX quote locally) and NVIDIA's NRAS (which verifies the GPU evidence). The 1Click API, Supabase, Resend, the Telegram Bot API, Sentry and a Better Stack heartbeat. Vercel hosts the web console. [`.env.example`](.env.example) lists the variables for the RPCs and for each keyed service; it also lists `BASE_RPC_URL`, which the web app validates when it first loads its settings but no code reads yet |

### AI-assisted code

Probarion was built with Claude Code, Anthropic's AI coding agent, which wrote most of the code,
tests and documentation. Every commit other than a merge carries a `Co-Authored-By: Claude` trailer;
most merge commits, the pull-request merges among them, do not.

The builder's part:

- **The product.** The builder chose it, its name, its positioning as a mandate layer for any agent
  with the accounts-payable agent as the reference app, and the goal of a real, professionally
  operated product. The design spec records these as "Decisions confirmed by the user"
  ([`docs/specs/2026-10-21-probarion-design.md`](docs/specs/2026-10-21-probarion-design.md)).
- **What is built and merged.** The builder decides what each pull request builds and when it is
  merged.
- **The steps the runbooks mark OWNER or OWNER SIGNS.** These are the builder's to sign or start:
  each mainnet transaction in the deploy runbooks ([`docs/runbooks`](docs/runbooks)), each
  transaction that changes a vault Probarion runs ([`docs/RUNBOOK.md`](docs/RUNBOOK.md)), every step
  of the web deployment ([`web-deploy.md`](docs/runbooks/web-deploy.md)), and publishing the npm
  packages ([`release.yml`](.github/workflows/release.yml)).

This is the split Probarion makes for payments: the agent does the work within limits, and a person
keeps the keys that move value. Besides CI, changes were checked by adversarial reviews run with
further AI agents; no third party has audited the contracts or the packages (see
[SECURITY.md](SECURITY.md)).

At run time a model only advises: the code rules and the contract decide each payment. When a model
is configured, it is a private model on NEAR AI Cloud, as
[NEAR technology used, and how](#near-technology-used-and-how) describes; without one, the code
decides alone and the ledger records `rules-only`.

## Other project by the same builder

Under the NEAR Hackathon 2026 rules, one person may enter two independent projects if each README
names the other. The other entry is **Satchel**, an NFT that is a wallet on every EVM chain
through NEAR Chain Signatures: <https://github.com/duongnq2798/satchel>. The two projects share no
code.

## License

[MIT](LICENSE). NEAR, NEAR Intents, NEAR AI Cloud, USDC, Base and Solana are trademarks of their
respective owners; their names say what Probarion is built on and pays through, not an endorsement.
