# Changelog

All notable changes to this repository: the NEAR contracts in `contracts/`, the npm packages
`@probarion/core`, `@probarion/sdk` and `probarion` (the CLI), and the web console in `apps/web`.
The MCP server `@probarion/mcp` is planned and does not exist yet.

Versions follow semver. The npm packages share one version, released by the tag `sdk-v<version>`;
none is published yet. A contract crate carries its own version, and each build of it is identified
by the code hash of its reproducible build in `contracts/code-hashes.json`. The web console is not
versioned yet and is not deployed. While the version is 0.x, a minor version may change the API.
The software is an unaudited beta.

## Unreleased

### Added

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
  recorded build's code hash in `contracts/code-hashes.json` and compared on every push.
- Testnet deployment on 2026-11-01: the test tokens, the intents stub and the vault
  `v0.probarion.testnet`, which has no full-access key and runs the recorded reproducible build.
  Its smoke run paid 1 test USDC to a NEAR account, burned 1 test USDC with a `WITHDRAW_TO:` memo for
  a Base address, and was refused with `NoMandate`. The transactions are in
  `contracts/deployments/testnet.json`.
- Deploy and smoke scripts for testnet, runbooks for testnet, the factory and the planned mainnet
  vault (each signing step is the owner's), and `pnpm proof` for the mainnet evidence file.
- Web console, in progress and not deployed: wallet sign-in with near-connect and NEP-413, checked on
  the server, with a signed session cookie; a Supabase schema with row-level security on every table,
  tested in PGlite; vault creation through the factory, with the CLI as a fallback; a vault overview
  with balances, NEAR runway, freeze and the held spends to approve; a keys page where the owner adds
  the agent and ledger keys from their wallet with the public key only; mandate creation for a NEAR
  or Base payee, with the same validation in the browser and on the server, and revocation; and a
  Postgres ledger store whose entries core's `runChecks` verifies.

### Changed

- `verify`: check h reports a burn it cannot prove as `unproven`, lists it in `VerifyReport.unproven`,
  and `VerifyReport.ok` is false while any check fails or is unproven. A burn transaction that cannot
  be read right now is unproven (`tx_unavailable`). A burn record that names a transaction holding no
  burn pair, a transaction the node does not know, or a hash that is not a NEAR transaction hash
  fails h.
- `verify`: checks g and h trust only the network's own intents contract and POA assets. The online
  check O1 holds the TDX quote to the DCAP policy and to its report data, and O2 binds the NVIDIA
  payload to the request's nonce. Measurement pinning (O1b) is deferred, so `quote_verified` stays
  false.

### Fixed

- Web console: pages that are not built yet (Canary, open metrics, the proof page, Payables, Top-up,
  Alerts, Security, Status, Terms, Privacy) show as "coming soon" instead of a link that answers 404,
  and the landing page no longer presents them or the offline `probarion verify` as available.
- Vault: `set_ledger_key` deletes the old ledger key and adds the new one in two separate receipts,
  the delete first. A failed delete no longer rolls back the new key and leaves the vault unable to
  anchor, and a rotation fits on a vault with no spare NEAR. The testnet vault runs the build from
  before this fix; the fixed build is recorded (code hash `3cQXYDvf…`) and not deployed yet.
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

### Security

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
  The release check gates the versions, this changelog, open `TODO(release)` notes and the packed
  tarballs. A version already on npm is skipped only when npm holds the same bytes. `release.yml` is
  pinned by sha256, every step runs with `pipefail`, and a test refuses any step that would swallow a
  failure. Third-party actions are pinned by commit SHA, and the cargo-near download is checked by
  sha256.
- CI scans the whole git history for secrets with gitleaks.

## 0.1.0 - 2026-11-07

### Added

- `@probarion/core`: TypeScript mirrors of the vault and factory contract views; RFC 8785 canonical hashing; ed25519 keys; the signed, hash-chained ledger with the ledger-derived attestation nonce (bound to the vault account); the deterministic policy engine `decide()` with its built-in rules and custom rules; the model proposal parser; offline attestation checks A1 to A7, and the request-binding check A8 for auditors; and the snapshot verifier `runChecks` with checks a to i.
- `@probarion/sdk`: a NEAR JSON-RPC client with failover and backoff; vault, intents and factory clients; function-call key signing through near-api-js 7; the NEAR AI Cloud adapter (private TEE models, a nonce-bound attestation report, the `provider_tee` signature); the JSONL file ledger store (locked, which needs a local file system with hard links) and the in-memory store; the `Probarion` class with `process`, `requestSpend`, `checkSpend`, `mandates`, `spends`, `anchors`, `rules`, `snapshot` and `verify` (with optional online TEE quote checks through `@nearai/inference-sdk`); and `@probarion/sdk/testing` test doubles (fake chain, fake NEAR JSON-RPC server, fake NEAR AI Cloud).
- `probarion` CLI: `vault create`, `mandate create`, `mandate revoke`, `agent add`, `agent remove`, `ledger set-key`, `spend approve`, `spend reject`, `vault freeze`, `vault unfreeze`, `vault withdraw` and `vault withdraw-intents` check their input against the contract and print the transaction for the owner or approver to sign with `near-cli-rs` (1 yoctoNEAR where the contract requires it); the CLI does not sign. `agent keygen` makes an ed25519 key pair (`--out <file>` or `--print-secret`). `check` dry-runs a spend against the contract; `verify` runs checks a to i on a live vault or, with `--offline`, on a saved snapshot, prints a table or `--json`, and exits 0 (pass), 1 (a check fails or verify cannot run), 2 (a burn is unproven) or 64 (usage); `--online` adds the TEE quote checks O1 and O2 when `@nearai/inference-sdk` is installed and says when they did not run. `ledger export` copies the ledger to a new file.
- Packaging: ESM only, Node 24 or newer. Each tarball holds `dist/` (without source maps), `README.md` and `LICENSE`, and is published from CI with npm provenance when the repository is public.
<!-- TODO(release): set the date above to the day the tag is pushed -->
