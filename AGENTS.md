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
