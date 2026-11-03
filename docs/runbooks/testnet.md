# Testnet runbook (Day 3)

**OWNER** runs every command that signs. Claude prepares and checks. Intents has no testnet, so `intents-stub.probarion.testnet` stands in for `intents.near` (see `contracts/intents-stub/README.md`).

Run every command from the repo root, in Git Bash (Windows) or any Linux/macOS shell. In Git Bash, put the cargo tools on the path first: `export PATH="$HOME/.cargo/bin:$PATH"`. Signing uses `sign-with-keychain` (on Windows the keys sit in the Credential Manager). No script here reads, prints or writes a private key.

**Protocol versions differ.** On 2026-11-01 testnet runs protocol 88 and mainnet runs protocol 86 (on 2026-10-21 it was 87 against 86). A testnet pass does not prove mainnet behaviour for anything that changed between the two. Check both before each deploy and write both numbers into `contracts/deployments/testnet.json` (`protocol_versions`). Re-run this runbook whenever either number changes.

```bash
node scripts/testnet/chain.mjs protocol-version testnet
node scripts/testnet/chain.mjs protocol-version mainnet
```

## 0. One-time setup

1. Tools: near-cli-rs 0.30.1 (then `near --version` must print 0.30.1), Node 24, `curl` and the GitHub CLI `gh` (logged in with `gh auth login`). Git Bash ships `curl`. `jq` is not needed. Install near-cli-rs from the official release binary: download the archive for your platform from https://github.com/near/near-cli-rs/releases (tag v0.30.1; on Windows `near-cli-rs-x86_64-pc-windows-msvc.tar.gz`), check its sha256 against the `.sha256` file that sits next to it in the release (`sha256sum --check`), and put the `near` executable in `~/.cargo/bin`. On Windows do not use `cargo install near-cli-rs --version 0.30.1 --locked`: it fails building openssl-sys. That command works on Linux and macOS.
2. **OWNER:** the four testnet accounts. They already exist, each with 10 test NEAR and its key in the keychain:

   | Variable | Account |
   |---|---|
   | `ROOT` | `probarion.testnet` |
   | `OWNER_ID` | `probarion-owner.testnet` |
   | `APPROVER_ID` | `probarion-approver.testnet` |
   | `PAYEE_ID` | `probarion-payee.testnet` |

   To create one again, use the faucet (testnet only):

   ```bash
   near account create-account sponsor-by-faucet-service probarion.testnet autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain network-config testnet create
   ```

   `--signature-scheme ed25519` is spelled out because near-cli-rs otherwise asks for the scheme in a terminal. Every variable can be overridden, so other account names work the same way.
3. **OWNER:** top up `ROOT` before you deploy. `ROOT` pays the initial balances of the five new accounts: 1.8 NEAR for each of the three tokens, 1.9 for the stub and 3 for the vault, 10.3 NEAR in all, plus gas. Storage costs 1 NEAR per 100 KB of wasm, and the vault wasm is 248,501 bytes. `ROOT` holds exactly 10 NEAR from the faucet, so send it 3 NEAR from the owner account first (a testnet send):

   ```bash
   near tokens probarion-owner.testnet send-near probarion.testnet '3 NEAR' network-config testnet sign-with-keychain send
   ```

   `deploy.sh` checks the balance before it sends anything, and prints this command if `ROOT` is still short.
4. **OWNER:** generate the agent keypair. This sends no transaction.

   ```bash
   near account create-account fund-later use-auto-generation save-to-folder ./.keys/testnet-agent
   ls ./.keys/testnet-agent   # one <64-hex>.json file
   ```

   The file holds `public_key`, `private_key` and a seed phrase. `.keys/` is git-ignored. Never commit the file and never paste it anywhere, chat included. The smoke script reads only its `public_key`.

## 1. Build and get the vault wasm

`test-ft` and `intents-stub` are test-only contracts. They always come from the local build:

```bash
bash scripts/build-contracts.sh
```

The vault wasm is different (R6). A local build is never a source of code hashes, so the vault comes from the CI reproducible build, the artifact `probarion-vault-wasm`. Take one of the two paths.

**Path A, the normal one: the CI artifact.** Pick a CI push run that built the commit recorded in `contracts/code-hashes.json` (run 41280041934 built it), download it and check it against the record:

```bash
gh run list --repo probarion/probarion --workflow ci --branch dev --limit 10
gh run download 41280041934 --repo probarion/probarion -n probarion-vault-wasm -D contracts/target/ci-artifact
REQUIRE_RECORDED=1 node scripts/code-hash.mjs check probarion-vault vault contracts/target/ci-artifact/probarion_vault.wasm
```

Expected: the last line says `matches the recorded build`. If it says `not recorded` or `mismatch`, the source changed since the record (R9): take the artifact of the push run that changed it and record it first (AGENTS.md, "Reproducible builds and code hashes"). Then deploy with `VAULT_WASM=contracts/target/ci-artifact/probarion_vault.wasm` (step 2). `deploy.sh` repeats this check and refuses a wasm that fails it.

**Path B, a throwaway testnet run only: the local build.** If no recorded artifact is at hand, `deploy.sh` can deploy the local, non-reproducible vault build:

```bash
ALLOW_NON_REPRODUCIBLE=1 bash scripts/testnet/deploy.sh
```

It prints a loud warning, and the vault's code hash is then in no record and nobody can verify it. **Mainnet never allows this fallback.** A mainnet deploy uses only a CI-built wasm whose hash is in `contracts/code-hashes.json`, and the mainnet runbooks (plan 02, Task 17) have no such switch.

Without `VAULT_WASM` and without `ALLOW_NON_REPRODUCIBLE=1`, `deploy.sh` refuses before it sends anything.

## 2. Deploy (OWNER)

```bash
export OWNER_ID=probarion-owner.testnet APPROVER_ID=probarion-approver.testnet
export VAULT_WASM=contracts/target/ci-artifact/probarion_vault.wasm   # path A. For path B leave it unset.
DRY_RUN=1 bash scripts/testnet/deploy.sh   # read every command first
bash scripts/testnet/deploy.sh
```

The script checks first and sends nothing if a check fails: the tools exist, the wasm matches the record, the five new accounts do not exist yet, and `ROOT` can pay. Then it creates and deploys `usdc`, `base-usdc`, `sol-usdc` (all `test-ft`), `intents-stub` and `v0`, deletes the vault's only full-access key, and funds it: 100 test USDC on `usdc`, plus 50 Base and 50 Solana test USDC inside the stub, credited to the vault.

Expected at the end:
- `checks passed` at the start and `vault has no access keys` at the end;
- `v0.probarion.testnet code_hash <hash> matches <wasm>`;
- `get_config` JSON with `"owner": "probarion-owner.testnet"`, `"factory": null` and `"version": "0.1.0"`;
- `ft_balance_of` returns `"100000000"`;
- `mt_balance_of` returns `"50000000"` for both tokens;
- `public_keys_of` returns `[]`.

The vault is locked for good: no key can deploy to it again and it cannot be deleted. If a step fails after the lock, re-run only the remaining commands from the dry-run listing. If you must start over, use a new vault name (`VAULT_NAME=v1`) and keep it in the smoke step too. `create-account` fails for an account that already exists.

## 3. Record

`deploy.sh` already compared the deployed code hash with the wasm. To see it again:

```bash
node scripts/testnet/chain.mjs code-hash v0.probarion.testnet
node scripts/code-hash.mjs hash contracts/target/ci-artifact/probarion_vault.wasm
```

The two hashes must be equal, and for path A equal to the entry in `contracts/code-hashes.json`. Claude writes the hash into `contracts/deployments/testnet.json` (`vault_v0.code_hash`, `locked: true`) and the two protocol versions from the top of this page into `protocol_versions`, and commits. After path B, say in the commit message that the wasm was not reproducible.

## 4. Smoke (OWNER)

```bash
export OWNER_ID=probarion-owner.testnet PAYEE_ID=probarion-payee.testnet
export AGENT_KEY_FILE="$(ls ./.keys/testnet-agent/*.json)"
DRY_RUN=1 bash scripts/testnet/smoke.sh
bash scripts/testnet/smoke.sh
```

Run it once, on a fresh vault: it creates mandates 1 and 2. The owner's calls are signed with the keychain. The three spends are signed by the agent key: the key file and `sign-as v0.probarion.testnet`, a function-call key that can call only `spend`.

Expected:
- `add_agent` succeeds.
- Both `create_mandate` calls print return values `1` and `2`.
- The first `spend` logs `EVENT_JSON` `spend_submitted` and `spend_paid` and returns `{"spend_id":1,"status":"paid"}`.
- The second logs `mt_burn` (owner `v0.probarion.testnet`), `ft_burn` (owner `intents-stub.probarion.testnet`) with memo `WITHDRAW_TO:0x1111…`, and `spend_burned`, and returns `{"spend_id":2,"status":"burned"}`.
- The third fails with `Smart contract panicked: PROBARION:NoMandate`. The script keeps going and prints `OK: the vault refuses mandate 999 with NoMandate`.
- `public_keys_of` prints `[]`.
- The script prints an `OK:` line for each of these checks and ends with `smoke passed`. A `MISMATCH:` line fails the run: read the output above it.

At the end it prints the transaction ids of the NEAR payment and the Base burn. Copy them into `contracts/deployments/testnet.json` (`smoke.near_payment_tx`, `smoke.base_burn_tx`). A refused call prints no id, so take the failed `spend` of `v0.probarion.testnet` from <https://testnet.nearblocks.io/address/v0.probarion.testnet> for `smoke.no_mandate_tx`. Claude commits them.

## 5. Gas and deposits

Calls that cascade into cross-contract promises need explicit gas, and the owner's and approver's mutating calls attach exactly `'1 yoctoNEAR'` (interfaces v2 §4.2). Use these values:

| Call | Signed by | Deposit | Gas |
|---|---|---|---|
| `add_agent`, `remove_agent`, `set_ledger_key`, `revoke_mandate`, `unfreeze` | owner | `'1 yoctoNEAR'` | `'30 Tgas'` |
| `reject` | approver | `'1 yoctoNEAR'` | `'30 Tgas'` |
| `freeze` | owner | `'0 NEAR'` | `'30 Tgas'` |
| `create_mandate` | owner | at least the storage cost, `'0.05 NEAR'` is plenty (the excess is refunded) | `'100 Tgas'` |
| `spend` | the agent key | `'0 NEAR'` | `'200 Tgas'` (an Intents payee cascades into `ft_withdraw`, 100 Tgas, and a callback) |
| `anchor` | the ledger key | `'0 NEAR'` | `'30 Tgas'` (one record and one event; the ledger key attaches no deposit) |
| `approve` | approver | `'1 yoctoNEAR'` | `'150 Tgas'` (the payout and its callback; at least 130) |
| `withdraw` | owner | `'1 yoctoNEAR'` | `'100 Tgas'` |
| `withdraw_intents` | owner | `'1 yoctoNEAR'` | `'150 Tgas'` (at least 130) |

## 6. Day 3 gate (2026-11-03 14:00 UTC)

Pass when CI is green for Tasks 1–14 and step 4 above succeeded. Otherwise switch to the reduced contract (plan 02, "Day 3 gate and the reduced contract") before Day 4.
