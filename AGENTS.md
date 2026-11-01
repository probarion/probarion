# AGENTS.md

Probarion lets an AI agent pay people and services only inside mandates a human signed. This file is for AI agents and humans who build, verify or review this repository. It grows as the build progresses.

## Setup

- Unit tests, `cargo fmt`, `cargo clippy` and the Node script tests run on native Windows (Git Bash) or Linux. The near-workspaces sandbox tests and the reproducible Docker build run in CI (GitHub Actions, ubuntu).
- Rust comes from `rust-toolchain.toml` (rustup installs it on first use), target `wasm32-unknown-unknown`.
- Node.js 24 (`.nvmrc`) and pnpm 10.
- Contract builds need `cargo-near` 0.22.0. Reproducible builds need Docker (CI runs them). Deploys (humans only) need `near-cli-rs` 0.30.1.

```bash
pnpm install
cargo fetch --manifest-path contracts/Cargo.toml
```

## Verify (no network, no keys)

```bash
pnpm verify
```

This runs the Rust unit and property tests, then TS lint, typecheck and tests.

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
| `docs/specs` | Pre-hackathon spec and interfaces, copied unchanged |
| `docs/runbooks` | Deploy runbooks; human steps are marked OWNER / OWNER SIGNS |

## Rules for agents

1. Never sign a transaction, create an account or deploy. Steps marked **OWNER** or **OWNER SIGNS** are for the human owner.
2. Never commit secrets. `.env.example` lists every variable. Real values live in `.env`, which git ignores.
3. Names, JSON shapes, error codes and constants come from `docs/specs/2026-10-21-probarion-interfaces.md`.
4. Test first. `pnpm verify` stays green on every commit.

## Reproducible builds and code hashes

- The reproducible build runs in CI only: job `reproducible` (ubuntu, Docker, `sourcescan/cargo-near:0.22.0-rust-1.99.1`, pinned by digest in `contracts/vault/Cargo.toml`). The local Windows build (`pnpm contracts:build`, `--no-abi`) has no Docker and is never a source of code hashes.
- `bash scripts/build-reproducible.sh vault probarion_vault` is the build the job runs. It builds the committed source in Docker and writes `contracts/target/reproducible/vault/probarion_vault.wasm` plus `probarion_vault.build-info.json` (crate, commit, source keys, code_hash, sha256). It prints the NEAR code hash.
- The job uploads both files as the artifact `probarion-vault-wasm`. Its run summary shows the build-info.
- A reproducible wasm embeds the git commit it was built from (NEP-330 `source_code_snapshot`). The same source built at two commits has two code hashes, so a recorded hash is reproduced by rebuilding the recorded commit.
- `contracts/code-hashes.json` records, per exact source (git tree of the crate, `contracts/Cargo.toml`, `contracts/Cargo.lock`), the `commit` and the `code_hash` of its reproducible build. Plan 03's verifier reads `entries[].code_hash` as `expected_code_hashes`.
- Once the vault source is recorded, CI rebuilds the recorded commit (not HEAD) and fails on a hash mismatch. On `v*` tags it also fails if the source is not recorded. While the source is not recorded, CI warns, builds HEAD and uploads it to be recorded.
- Record a hash from the artifact of a CI push run. `record` refuses a wasm without its CI `build-info.json`, and a build-info whose event is not `push` (so never a local build, a pull_request run or a manual run):

  ```bash
  gh run download <run-id> -n probarion-vault-wasm -D <dir>
  node scripts/code-hash.mjs record probarion-vault vault <dir>/probarion_vault.wasm
  node scripts/code-hash.mjs check probarion-vault vault <dir>/probarion_vault.wasm
  git add contracts/code-hashes.json && git commit -m "chore: record probarion-vault reproducible code hash"
  ```

- **R9:** any change to `contracts/vault`, `contracts/Cargo.toml` or `contracts/Cargo.lock` makes the record stale. Re-record right after the push that changes them: take the artifact of that push run and run `record`. Until then CI warns "not recorded" and a `v*` tag fails.
- Every deploy uses only a CI-built reproducible wasm whose `code_hash` is in `contracts/code-hashes.json` (`check` passes). A deploy script may fall back to a local non-reproducible build only when `ALLOW_NON_REPRODUCIBLE=1` is set, with a loud warning. The testnet smoke may set it; mainnet never may.
- Compare a deployed contract: `curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"v0.probarion.near"}}' | jq -r .result.code_hash`
