# Changelog

All notable changes to `@probarion/core`, `@probarion/sdk`, `probarion` (CLI) and `@probarion/mcp`.
Versions follow semver. All published packages share one version, released by the tag `sdk-v<version>`.
While the version is 0.x, a minor version may change the API. The software is an unaudited beta.

## 0.1.0 - 2026-11-07

### Added

- `@probarion/core`: TypeScript mirrors of the vault and factory contract views; RFC 8785 canonical hashing; ed25519 keys; the signed, hash-chained ledger with the ledger-derived attestation nonce (bound to the vault account); the deterministic policy engine `decide()` with its built-in rules and custom rules; the model proposal parser; offline attestation checks A1 to A7, and the request-binding check A8 for auditors; and the snapshot verifier `runChecks` with checks a to i.
- `@probarion/sdk`: a NEAR JSON-RPC client with failover and backoff; vault, intents and factory clients; function-call key signing through near-api-js 7; the NEAR AI Cloud adapter (private TEE models, a nonce-bound attestation report, the `provider_tee` signature); the JSONL file ledger store (locked, which needs a local file system with hard links) and the in-memory store; the `Probarion` class with `process`, `requestSpend`, `checkSpend`, `mandates`, `spends`, `anchors`, `rules`, `snapshot` and `verify` (with optional online TEE quote checks through `@nearai/inference-sdk`); and `@probarion/sdk/testing` test doubles (fake chain, fake NEAR JSON-RPC server, fake NEAR AI Cloud).
- `probarion` CLI: `vault create`, `mandate create`, `mandate revoke`, `agent add`, `agent remove`, `ledger set-key`, `spend approve`, `spend reject`, `vault freeze`, `vault unfreeze`, `vault withdraw` and `vault withdraw-intents` check their input against the contract and print the transaction for the owner or approver to sign with `near-cli-rs` (1 yoctoNEAR where the contract requires it); the CLI does not sign. `agent keygen` makes an ed25519 key pair (`--out <file>` or `--print-secret`).
- Packaging: ESM only, Node 24 or newer. Each tarball holds `dist/` (without source maps), `README.md` and `LICENSE`, and is published from CI with npm provenance when the repository is public.
<!-- TODO(release): add the CLI check, verify and ledger export commands when plan 03 Task 16 lands, and set the date above to the day the tag is pushed -->
