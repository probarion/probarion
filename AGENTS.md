# AGENTS.md

Probarion lets an AI agent pay people and services only inside mandates a human signed. This file is for AI agents and humans who build, verify or review this repository. It grows as the build progresses.

## Judge or evaluate in one command

With Node.js 24 and pnpm 10, from a clone, run this first. It is read-only: it signs and sends nothing, and no step gets a key.

```bash
pnpm install --frozen-lockfile
pnpm judge             # every step: about 6 minutes on a Windows 10 laptop, 4 of them the package tests
pnpm judge --quick     # without the package tests: about 2 minutes
pnpm judge --offline   # no network at all: the live testnet reads are SKIPPED
```

It builds the four packages (not the web app) and runs steps 0 and 2 to 6 of the README's "How to evaluate Probarion in 5 minutes", the eval check and the package tests: the claims check (offline, then online), the README's own snippets with their output compared line by line, `verify --offline` on every committed snapshot in `docs/evidence`, live read-only verifies of the testnet vaults, the MCP and 402 demos. Each step quotes the README line it proves and prints one row: PASS, EXPECTED-FAIL, SKIPPED (with the reason and the command) or FAIL. EXPECTED-FAIL is a failure the README says is by design (the Canary's private ledger fails check c; `v0.probarion.testnet` has no ledger, so d and h fail); if one ever passes or fails another way, it is a FAIL. SKIPPED is for a step not run here: `--offline`, `--quick`, the network down, or an endpoint that timed out or answered 429 or 5xx. A definite wrong answer is a FAIL, such as the demo vault's proof page answering 404, or the MCP demo skipping its verify for that reason. The command exits 0 only when no step failed, and writes `judge-report.json`: per step the claim, the README line, the command, the result, the expectation, the time and the detail, plus the commit, Node and OS. The web console's tests and the Rust tests are not in it; the report lists each as SKIPPED with its command. Give it a 10-minute timeout or run it in the background; the rows print as each step ends.

## Setup

- Unit tests, `cargo fmt`, `cargo clippy` and the Node script tests run on native Windows (Git Bash) or Linux; on Windows set `AWS_LC_SYS_PREBUILT_NASM=1` (or install NASM) so `aws-lc-sys` builds. The near-workspaces sandbox tests and the reproducible Docker build run in CI (GitHub Actions, ubuntu).
- Rust comes from `rust-toolchain.toml` (rustup installs it on first use), target `wasm32-unknown-unknown`.
- Node.js 24 (`.nvmrc`) and pnpm 10.
- Contract builds need `cargo-near` 0.22.0. Reproducible builds need Docker (CI runs them). Deploys (humans only) need `near-cli-rs` 0.30.1.

```bash
pnpm install
cargo fetch --manifest-path contracts/Cargo.toml
```

## Verify (no keys)

```bash
pnpm verify
```

This runs the Rust unit and property tests, then TS lint, typecheck and tests. The one thing it reaches the network for is the web build: `next/font` downloads the site's two fonts from Google Fonts at build time and serves them itself.

## Full verify (downloads the NEAR sandbox binary)

```bash
pnpm verify:full
```

This adds `cargo near build` for every contract and the near-workspaces sandbox tests. The sandbox tests need Linux, so they run in CI (the `sandbox` job); a local Windows run covers `pnpm verify` only.

## Repo map

| Path | What |
|---|---|
| `contracts/vault` | The mandate vault (crate `probarion-vault`) |
| `contracts/factory` | Creates keyless vaults (crate `probarion-factory`) |
| `contracts/intents-stub` | Sandbox/testnet stand-in for `intents.near`; never on mainnet |
| `contracts/test-ft` | NEP-141 test token; never on mainnet |
| `contracts/integration-tests` | near-workspaces sandbox tests |
| `docs/specs` | Pre-hackathon spec and interfaces, amended since in place: the interfaces file lists each change as a dated ICR line, and git history has every edit |
| `docs/runbooks` | Deploy runbooks; human steps are marked OWNER / OWNER SIGNS |

## Rules for agents

1. Never sign a transaction, create an account or deploy. Steps marked **OWNER** or **OWNER SIGNS** are for the human owner.
2. Never commit secrets. `.env.example` lists every variable. Real values live in `.env`, which git ignores.
3. Names, JSON shapes, error codes and constants come from `docs/specs/2026-10-21-probarion-interfaces.md`.
4. Test first. `pnpm verify` stays green on every commit.

## Reproducible builds and code hashes

- The reproducible build runs in CI only: job `reproducible` builds both crates, one matrix leg each (`vault` and `factory`; ubuntu, Docker, `sourcescan/cargo-near:0.22.0-rust-1.99.1`, pinned by digest in each crate's `Cargo.toml`). The local Windows build (`pnpm contracts:build`, `--no-abi`) has no Docker and is never a source of code hashes.
- `bash scripts/build-reproducible.sh vault probarion_vault` is the build the job runs. It builds the committed source in Docker and writes `contracts/target/reproducible/vault/probarion_vault.wasm` plus `probarion_vault.build-info.json` (crate, commit, source keys, code_hash, sha256). It prints the NEAR code hash.
- Each leg uploads both files as an artifact, `probarion-vault-wasm` or `probarion-factory-wasm`. Its run summary shows the build-info.
- A reproducible wasm embeds the git commit it was built from (NEP-330 `source_code_snapshot`). The same source built at two commits has two code hashes, so a recorded hash is reproduced by rebuilding the recorded commit.
- `contracts/code-hashes.json` records, per exact source (git tree of the crate, `contracts/Cargo.toml`, `contracts/Cargo.lock`), the `commit` and the `code_hash` of its reproducible build. Plan 03's verifier reads `entries[].code_hash` as `expected_code_hashes`.
- Once a crate's source is recorded, CI rebuilds that crate's recorded commit (not HEAD) and fails on a hash mismatch. On `v*` tags it also fails if the source is not recorded. While the source is not recorded, CI warns, builds HEAD and uploads it to be recorded.
- Record a hash from the artifact of a CI push run. `record` refuses a wasm without its CI `build-info.json`, and a build-info whose event is not `push` (so never a local build, a pull_request run or a manual run):

  ```bash
  gh run download <run-id> -n probarion-vault-wasm -D <dir>
  node scripts/code-hash.mjs record probarion-vault vault <dir>/probarion_vault.wasm
  node scripts/code-hash.mjs check probarion-vault vault <dir>/probarion_vault.wasm
  git add contracts/code-hashes.json && git commit -m "chore: record probarion-vault reproducible code hash"
  ```

  The factory records the same way: download `-n probarion-factory-wasm` and use `probarion-factory factory <dir>/probarion_factory.wasm`.

- **R9:** any change to `contracts/vault` or `contracts/factory` (or to `contracts/Cargo.toml` or `contracts/Cargo.lock`, which both crates share) makes that crate's record stale. Re-record right after the push that changes them: take the artifact of that push run and run `record`. Until then CI warns "not recorded" and a `v*` tag fails.
- Every deploy uses only a CI-built reproducible wasm whose `code_hash` is in `contracts/code-hashes.json` (`check` passes). A deploy script may fall back to a local non-reproducible build only when `ALLOW_NON_REPRODUCIBLE=1` is set, with a loud warning. The testnet smoke may set it; mainnet never may.
- Compare a deployed contract (Node reads the JSON, because Git Bash on Windows has no JSON tool): `RPC=https://rpc.mainnet.fastnear.com node scripts/testnet/chain.mjs code-hash v0.probarion.near` prints the account's base58 code hash. Compare it with `node scripts/code-hash.mjs hash <wasm>` of the CI artifact.

## Contracts

| Network | Account | Role |
|---|---|---|
| testnet | `usdc.probarion.testnet` | test-ft acting as USDC |
| testnet | `base-usdc.probarion.testnet`, `sol-usdc.probarion.testnet` | test-ft acting as the Base and Solana POA tokens |
| testnet | `intents-stub.probarion.testnet` | intents-stub (Intents has no testnet) |
| testnet | `v0.probarion.testnet` | vault v0, locked (no full-access key) |

Deployments and transaction hashes: `contracts/deployments/`. Code hashes: `contracts/code-hashes.json`.

Testnet scripts: `scripts/testnet/deploy.sh` and `smoke.sh` (OWNER runs them; `DRY_RUN=1` prints only), steps in `docs/runbooks/testnet.md`. `deploy.sh` deploys the vault only from `VAULT_WASM`, a CI reproducible artifact that passes `code-hash.mjs check`; `ALLOW_NON_REPRODUCIBLE=1` is the testnet-only escape hatch. Every call to a one-yocto method attaches `'1 yoctoNEAR'`, and `scripts/runbooks.test.mjs` lints that.
