# Contributing to Probarion

Probarion is a solo project, built for the NEAR Hackathon 2026. Issues and pull requests from others
are welcome, but a large pull request that was not agreed in an issue first may be closed. Open an
issue before you start one.

## Set up and verify

You need Node.js 24 (`.nvmrc`), pnpm 10 and Rust. `rust-toolchain.toml` pins Rust 1.99.1 with the
`wasm32-unknown-unknown` target, rustfmt and clippy, and rustup installs it on first use.

```bash
pnpm install --frozen-lockfile
cargo fetch --manifest-path contracts/Cargo.toml
pnpm verify
```

`pnpm verify` runs the Rust unit and property tests, then Biome lint, the build, the typechecks and
every TypeScript and Node script test (`pnpm verify:ts`, which also runs on its own without Rust),
then the launch checks. It needs no keys, no `.env` and no network once the dependencies are fetched.

Two kinds of check run only in CI (GitHub Actions, ubuntu), not in `pnpm verify`:

- **The sandbox tests** start a local NEAR node, the near-workspaces sandbox, which has no Windows
  build; CI runs them on Linux.
- **The reproducible contract builds** run cargo-near in a Docker image pinned by digest, so that one
  commit always gives one code hash. Only those CI builds are recorded in
  `contracts/code-hashes.json`; a local build never is ([AGENTS.md](AGENTS.md#reproducible-builds-and-code-hashes)).

## How a change lands

1. Make a branch for one change, from `dev`.
2. Open a pull request into `dev` and fill in the template: summary, why, safety, tests, docs and review.
3. CI must pass. Its `verify` check succeeds only when every other job succeeded.
4. The pull request is merged with a merge commit.
5. `dev` is promoted to `main` by a pull request.
6. Releases are cut only from `main`: an `sdk-v*` tag runs
   [`.github/workflows/release.yml`](.github/workflows/release.yml), which refuses a tag whose commit
   is not on `main`.

Commit subjects read `type(scope): one plain sentence`, for example
`fix(vault): set_ledger_key deletes the old ledger key before adding the new one`. Task and review ids
go in the commit body, not in the subject or the pull request title.

AI agents that work here follow [AGENTS.md](AGENTS.md): they never sign a transaction, deploy or
commit a secret, and the OWNER signs everything on mainnet.

## Security and conduct

Do not report a vulnerability in an issue or a pull request: [SECURITY.md](SECURITY.md) says how to
report one privately. Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md).

By contributing, you agree that your contribution is licensed under the [MIT license](LICENSE).
