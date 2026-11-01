# Factory runbook (Day 7, plus the Day 10 freeze)

**Global code is the primary path.** A vault account uses the vault code published once as a global contract and referenced by hash (NEP-591). Every vault then runs the same immutable code for well under 0.001 NEAR. **Embedded wasm is the fallback.** It costs about 1 NEAR of storage per 100 KB per vault: 2.49 NEAR for the current 248,501-byte vault wasm.

To control cost (spec §7.2), the global code is published on **mainnet** only at the Day 10 freeze. Until then the mainnet factory serves an embedded version, so the console can create vaults from Day 8. On testnet both modes are exercised on Day 7.

**OWNER** runs the testnet commands. Every mainnet command that sends a transaction is **OWNER SIGNS**. Run every command from the repo root, in Git Bash (Windows) or any Linux/macOS shell. In Git Bash, put the cargo tools on the path first: `export PATH="$HOME/.cargo/bin:$PATH"`. Keys are kept only in the OS keychain: `create-account ... save-to-keychain` stores each new key there, signing uses `sign-with-keychain`, and no command here prints a private key.

**Protocol versions differ.** `protocol_versions` in `contracts/deployments/testnet.json` records testnet at 88 and mainnet at 86 on 2026-11-01. A testnet pass does not prove mainnet behaviour for anything that changed between the two. Check both before each deploy, and re-run the testnet part whenever either number changes (as `docs/runbooks/testnet.md` does). Global contracts work on both networks.

```bash
node scripts/testnet/chain.mjs protocol-version testnet
node scripts/testnet/chain.mjs protocol-version mainnet
```

## 0. Get the wasm files from CI

A local build is never a source of code hashes (R6), and the Windows dev machine has no Docker. Both wasm files therefore come from the CI reproducible build. Pick the CI **push** run whose `headSha` is the commit recorded in `contracts/code-hashes.json` for both crates (`commit` of the `probarion-vault` and `probarion-factory` entries). `recorded-commit` prints that commit for the current source; if it prints nothing, the source is not recorded, so stop. If the two entries record different commits, download each artifact from the run of its own commit.

```bash
node scripts/code-hash.mjs recorded-commit probarion-vault vault
node scripts/code-hash.mjs recorded-commit probarion-factory factory
gh run list --repo probarion/probarion --workflow ci --branch dev --limit 20 --json databaseId,headSha,event,conclusion
gh run download <run-id> --repo probarion/probarion -n probarion-vault-wasm -D contracts/target/ci-artifact
gh run download <run-id> --repo probarion/probarion -n probarion-factory-wasm -D contracts/target/ci-artifact
git fetch origin   # check needs the recorded build commit in this clone
REQUIRE_RECORDED=1 node scripts/code-hash.mjs check probarion-vault vault contracts/target/ci-artifact/probarion_vault.wasm
REQUIRE_RECORDED=1 node scripts/code-hash.mjs check probarion-factory factory contracts/target/ci-artifact/probarion_factory.wasm
```

Expected: both `check` lines end with `matches the recorded build`. If a `check` fails (`not recorded`, `code_hash mismatch`, or `recorded at … but this wasm was built at …`), stop: the artifact is not the recorded build, and nothing may be deployed from it. Recording a hash is a controller step done before this runbook (AGENTS.md, "Reproducible builds and code hashes"), not a step here.

```bash
export VAULT_WASM=contracts/target/ci-artifact/probarion_vault.wasm
export FACTORY_WASM=contracts/target/ci-artifact/probarion_factory.wasm
export VAULT_HASH="$(node scripts/code-hash.mjs hash "$VAULT_WASM")"
ls -l "$VAULT_WASM" "$FACTORY_WASM"   # sizes in bytes; the vault wasm was 248,501 bytes, and the global publish burns 10 NEAR per 100 KB
```

## 1. Testnet (Day 7)

Testnet uses the keychain accounts of `docs/runbooks/testnet.md` §0.

Factory account budget: 1.8 NEAR (factory code) + 2.5 NEAR (stored vault wasm) + 1 NEAR (buffer) = 5.3 NEAR, so fund it with `'6 NEAR'`. Fund the factory before `store_code`: the storage stake of the stored wasm comes from the factory balance.

```bash
export ROOT=probarion.testnet FACTORY=vaults.probarion.testnet
export OWNER_ID=probarion-owner.testnet APPROVER_ID=probarion-approver.testnet
near account create-account fund-myself "$FACTORY" '6 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
  sign-as "$ROOT" network-config testnet sign-with-keychain send
near contract deploy "$FACTORY" use-file "$FACTORY_WASM" with-init-call new \
  json-args "{\"owner\":\"$OWNER_ID\",\"usdc\":\"usdc.probarion.testnet\",\"intents\":\"intents-stub.probarion.testnet\",\"allowed_assets\":[\"base-usdc.probarion.testnet\",\"sol-usdc.probarion.testnet\"],\"min_deposit\":\"500000000000000000000000\"}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

Global version (primary). Publish the vault code as a global contract by hash, then register it. The publish burns about 24.9 test NEAR (10 NEAR per 100 KB of the 248,501-byte wasm), and `ROOT` pays it after the 6 NEAR above, so `ROOT` must hold at least 26 NEAR when you run it. Check its balance first, and top `ROOT` up before the publish if it is lower (for example from `OWNER_ID`, as `docs/runbooks/testnet.md` §0.3 does):

```bash
near account view-account-summary "$ROOT" network-config testnet now
```

```bash
near contract deploy-as-global use-file "$VAULT_WASM" as-global-hash "$ROOT" network-config testnet sign-with-keychain send
near contract call-function as-transaction "$FACTORY" add_version \
  json-args "{\"code_hash\":\"$VAULT_HASH\",\"mode\":\"global\",\"notes\":\"vault 0.1.0 global (testnet)\"}" \
  prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config testnet sign-with-keychain send
near contract call-function as-transaction "$FACTORY" create_vault \
  json-args "{\"name\":\"smoke-global\",\"approvers\":[\"$APPROVER_ID\"],\"daily_backstop\":\"500000000\",\"held_ttl_ns\":\"259200000000000\"}" \
  prepaid-gas '300.0 Tgas' attached-deposit '1 NEAR' sign-as "$OWNER_ID" network-config testnet sign-with-keychain send
near account list-keys "smoke-global.$FACTORY" network-config testnet now
near contract call-function as-read-only "smoke-global.$FACTORY" get_config json-args '{}' network-config testnet now
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"optimistic","account_id":"smoke-global.vaults.probarion.testnet"}}' | grep -o '"global_contract_hash":"[^"]*"'
```

Expected:
- `create_vault` returns `"smoke-global.vaults.probarion.testnet"`.
- `list-keys` shows **no keys** (I9).
- `get_config` has `"owner": "probarion-owner.testnet"` and `"factory": "vaults.probarion.testnet"`.
- The `curl` prints `"global_contract_hash":"<hash>"` with `<hash>` equal to `$VAULT_HASH` (RPC `view_account` omits the field for an account that does not use global code, so no output means it does not).

Embedded version (fallback). Store the wasm, then register it. A vault from this version must receive `min_deposit` (0.5 NEAR here) plus the storage of its copy of the wasm (2.49 NEAR), so the `'4 NEAR'` below is enough. The embedded version becomes the current version, so add the global version again afterwards to make global current:

```bash
near contract call-function as-transaction "$FACTORY" store_code file-args "$VAULT_WASM" \
  prepaid-gas '300.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config testnet sign-with-keychain send
near contract call-function as-transaction "$FACTORY" add_version \
  json-args "{\"code_hash\":\"$VAULT_HASH\",\"mode\":\"embedded\",\"notes\":\"vault 0.1.0 embedded fallback (testnet)\"}" \
  prepaid-gas '50.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config testnet sign-with-keychain send
near contract call-function as-transaction "$FACTORY" create_vault \
  json-args "{\"name\":\"smoke-embedded\",\"approvers\":[\"$APPROVER_ID\"],\"daily_backstop\":\"500000000\",\"held_ttl_ns\":\"259200000000000\"}" \
  prepaid-gas '300.0 Tgas' attached-deposit '4 NEAR' sign-as "$OWNER_ID" network-config testnet sign-with-keychain send
near account list-keys "smoke-embedded.$FACTORY" network-config testnet now
near contract call-function as-transaction "$FACTORY" add_version \
  json-args "{\"code_hash\":\"$VAULT_HASH\",\"mode\":\"global\",\"notes\":\"vault 0.1.0 global, current (testnet)\"}" \
  prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config testnet sign-with-keychain send
near contract call-function as-read-only "$FACTORY" versions json-args '{}' network-config testnet now
```

Expected: `store_code` returns `$VAULT_HASH`, the embedded vault has no keys, and `versions` lists 3 versions with the last one `global`. Claude records the factory, versions and smoke vaults in `contracts/deployments/testnet.json`.

Gas and deposits (§1 and §2): `create_vault` attaches `'300.0 Tgas'` in both modes. An embedded `create_vault` reserves about 45 Tgas plus about 71 Mgas per byte of vault wasm (about 63 Tgas now), and a global one needs at least `'100.0 Tgas'`. The factory pays for its own registry entry, about 0.003 NEAR per vault, so keep the factory funded.

## 2. Mainnet (Day 7): factory with an embedded v1

Budget: about 12 NEAR for the factory account (the factory code, about 1.8 NEAR; the stored vault wasm, about 2.5 NEAR; the rest is the refund buffer and the registry), plus about 4 NEAR locked in the smoke vault (it must cover `min_deposit` of 1 NEAR plus the 2.49 NEAR of wasm storage). Fund the factory before `store_code`: the storage stake of the stored wasm comes from the factory balance. The Day 10 global publish is funded separately, in §3.

```bash
export ROOT=probarion.near FACTORY=vaults.probarion.near
export OWNER_ID="${OWNER_ID:?the factory owner wallet}" APPROVER_ID="${APPROVER_ID:?the approver wallet}"
```

**OWNER SIGNS** (moves 12 NEAR into the new factory account)
```bash
near account create-account fund-myself "$FACTORY" '12 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
  sign-as "$ROOT" network-config mainnet sign-with-keychain send
```

**OWNER SIGNS** (deploys the factory and initialises it with the mainnet constants)
```bash
near contract deploy "$FACTORY" use-file "$FACTORY_WASM" with-init-call new \
  json-args "{\"owner\":\"$OWNER_ID\",\"usdc\":\"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\",\"intents\":\"intents.near\",\"allowed_assets\":[\"base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near\",\"sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near\"],\"min_deposit\":\"1000000000000000000000000\"}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-keychain send
```

**OWNER SIGNS** (stores the vault wasm; its storage is staked from the factory balance)
```bash
near contract call-function as-transaction "$FACTORY" store_code file-args "$VAULT_WASM" \
  prepaid-gas '300.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

**OWNER SIGNS** (registers embedded v1)
```bash
near contract call-function as-transaction "$FACTORY" add_version \
  json-args "{\"code_hash\":\"$VAULT_HASH\",\"mode\":\"embedded\",\"notes\":\"vault 0.1.0 embedded, until the Day 10 global publish\"}" \
  prepaid-gas '50.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

**OWNER SIGNS** (creates one team smoke vault; its 4 NEAR stays in that vault)
```bash
near contract call-function as-transaction "$FACTORY" create_vault \
  json-args "{\"name\":\"team-smoke\",\"approvers\":[\"$APPROVER_ID\"],\"daily_backstop\":\"500000000\",\"held_ttl_ns\":\"259200000000000\"}" \
  prepaid-gas '300.0 Tgas' attached-deposit '4 NEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

Checks (free):

```bash
near account list-keys "team-smoke.$FACTORY" network-config mainnet now
near contract call-function as-read-only "team-smoke.$FACTORY" get_config json-args '{}' network-config mainnet now
near contract call-function as-read-only "$FACTORY" versions json-args '{}' network-config mainnet now
```

Expected: no keys; `"factory": "vaults.probarion.near"`; one embedded version.

**Claude records** (interfaces §16). Set each `*_TX` variable to the `Transaction ID` the OWNER pasted, then record the transactions in `docs/mainnet-proof.json`. Commit that file together with `contracts/deployments/mainnet.json` (`factory.deploy_tx`, `factory.versions`):

```bash
pnpm proof add-tx --id factory_deploy --hash "$FACTORY_DEPLOY_TX" --signer vaults.probarion.near --receiver vaults.probarion.near \
  --kind factory_init --signed-by deployer --what "Factory deployed and initialised with the mainnet constants"
pnpm proof add-tx --id factory_version_embedded --hash "$ADD_VERSION_TX" --signer "$OWNER_ID" --receiver vaults.probarion.near \
  --kind other --signed-by owner --what "Factory version 1: vault 0.1.0 as embedded code (until the Day 10 global publish)"
pnpm proof add-tx --id team_smoke_vault_created --hash "$CREATE_VAULT_TX" --signer "$OWNER_ID" --receiver vaults.probarion.near \
  --kind vault_created --signed-by owner --what "First factory vault on mainnet, created with zero access keys"
pnpm proof set accounts.factory vaults.probarion.near --source "docs/runbooks/factory.md section 2"
```

## 3. Mainnet Day 10 freeze: publish the global code

Take the CI artifacts of the frozen commit with §0 (the controller records them first), so that both `check` lines pass, and recompute `VAULT_HASH`. If the frozen code differs from embedded v1, first store it and register it as an embedded version with §2's `store_code` and `add_version`, using the new hash.

Publish the global code with **one** of the two options. The publish burns 10 NEAR per 100 KB of `$VAULT_WASM`, about 25 NEAR for the current 248,501-byte wasm (24.9 NEAR). Check `ls -l "$VAULT_WASM"` and adjust the amounts if the size changed.

**Option A: the factory publishes** (only if the deployed factory wasm has `publish_global`, the optional Task 21). The factory pays the burn from its own balance, so fund it first. `publish_global` publishes the wasm of the **current** version, which must be an embedded one (this is why the frozen code is stored and registered as embedded first), and it takes no arguments.

**OWNER SIGNS** (moves NEAR into the factory for the burn: about 25 NEAR for the current wasm, plus 2 NEAR margin)
```bash
near tokens "$ROOT" send-near "$FACTORY" '27 NEAR' network-config mainnet sign-with-keychain send
```

**OWNER SIGNS** (the factory deploys the current embedded version's wasm as a global contract by hash)
```bash
near contract call-function as-transaction "$FACTORY" publish_global json-args '{}' \
  prepaid-gas '300.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

```bash
export GLOBAL_SIGNER="$OWNER_ID" GLOBAL_RECEIVER="$FACTORY" GLOBAL_SIGNED_BY=owner
```

**Option B: near-cli-rs publishes** (if the deployed factory has no `publish_global`, for example because it was deployed before Task 21). `ROOT` pays the burn, so check its balance first:

```bash
near account view-account-summary "$ROOT" network-config mainnet now
```

**OWNER SIGNS** (burns about 25 NEAR for the current wasm; `ROOT` needs at least 26 NEAR)
```bash
near contract deploy-as-global use-file "$VAULT_WASM" as-global-hash "$ROOT" network-config mainnet sign-with-keychain send
```

```bash
export GLOBAL_SIGNER="$ROOT" GLOBAL_RECEIVER="$ROOT" GLOBAL_SIGNED_BY=deployer
```

Then, for either option:

**OWNER SIGNS** (makes the global version current)
```bash
near contract call-function as-transaction "$FACTORY" add_version \
  json-args "{\"code_hash\":\"$VAULT_HASH\",\"mode\":\"global\",\"notes\":\"vault 0.1.0 frozen Day 10\"}" \
  prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

**OWNER SIGNS** (creates the demo vault through the global path; 1 NEAR)
```bash
near contract call-function as-transaction "$FACTORY" create_vault \
  json-args "{\"name\":\"demo\",\"approvers\":[\"$APPROVER_ID\"],\"daily_backstop\":\"500000000\",\"held_ttl_ns\":\"259200000000000\"}" \
  prepaid-gas '300.0 Tgas' attached-deposit '1 NEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

Checks (free):

```bash
near account list-keys "demo.$FACTORY" network-config mainnet now
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"optimistic","account_id":"demo.vaults.probarion.near"}}' | grep -o '"global_contract_hash":"[^"]*"'
echo "$VAULT_HASH"
```

Expected: no keys, and the `curl` prints `"global_contract_hash":"<hash>"` with `<hash>` equal to the `echo` line (`$VAULT_HASH`). No `curl` output means the vault does not use global code.

**Claude records** (interfaces §16), in the same commit as the updated `contracts/deployments/mainnet.json` (`factory.versions`):

```bash
pnpm proof add-tx --id vault_global_code --hash "$GLOBAL_TX" --signer "$GLOBAL_SIGNER" --receiver "$GLOBAL_RECEIVER" \
  --kind global_code --signed-by "$GLOBAL_SIGNED_BY" --what "Vault 0.1.0 published as a global contract by hash (Day 10 freeze)"
pnpm proof add-tx --id factory_version_global --hash "$ADD_GLOBAL_VERSION_TX" --signer "$OWNER_ID" --receiver vaults.probarion.near \
  --kind other --signed-by owner --what "The global code becomes the current factory version"
pnpm proof add-tx --id demo_vault_created --hash "$DEMO_TX" --signer "$OWNER_ID" --receiver vaults.probarion.near \
  --kind vault_created --signed-by owner --what "Demo vault created by the factory from the global code, with zero access keys"
pnpm proof set accounts.demo_vault demo.vaults.probarion.near --source "docs/runbooks/factory.md section 3"
pnpm proof set code_hashes.vault "$VAULT_HASH" --source "scripts/build-reproducible.sh vault (CI artifact probarion-vault-wasm); RPC view_account global_contract_hash of demo.vaults.probarion.near"
pnpm proof set facts.factory_mode "global contract by hash" --source "docs/runbooks/factory.md section 3"
```

Optional, as an owner decision: lock the factory's own code by deleting its full-access key. `add_version` keeps working because the factory owner calls it from `$OWNER_ID`. Do this only after the final version is added.

**OWNER SIGNS** (irreversible)
```bash
near account delete-keys "$FACTORY" public-keys "$(near account list-keys "$FACTORY" network-config mainnet now | grep -o 'ed25519:[A-Za-z0-9]*' | head -n1)" \
  network-config mainnet sign-with-keychain send
```

If the factory is locked, Claude records it: `pnpm proof add-tx --id factory_lock --hash "$FACTORY_LOCK_TX" --signer vaults.probarion.near --receiver vaults.probarion.near --kind lock --signed-by deployer --what "Factory full-access key deleted"`.
