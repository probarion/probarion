# Factory runbook (Day 7, plus the Day 10 freeze)

**Global code is the primary path.** A vault account uses the vault code published once as a global contract and referenced by hash (NEP-591). Every vault then runs the same immutable code for well under 0.001 NEAR. **Embedded wasm is the fallback.** It costs about 1 NEAR of storage per 100 KB per vault: 2.49 NEAR for the current 248,501-byte vault wasm.

To control cost (spec §7.2), the global code is published on **mainnet** only at the Day 10 freeze. Until then the mainnet factory serves an embedded version, so the console can create vaults from Day 8. On testnet both modes are exercised on Day 7.

**OWNER** runs the testnet commands. Every mainnet command that sends a transaction is **OWNER SIGNS**. Run every command from the repo root, in Git Bash (Windows) or any Linux/macOS shell. In Git Bash, put the cargo tools on the path first: `export PATH="$HOME/.cargo/bin:$PATH"`. Keys are written only to the OS keychain (`create-account ... save-to-keychain` stores each new key there) or sit on a Ledger. Signing uses `sign-with-keychain`; if the key is on a Ledger, replace it with `sign-with-ledger`. No command here prints a private key.

**Protocol versions differ.** `protocol_versions` in `contracts/deployments/testnet.json` records testnet at 88 and mainnet at 86 on 2026-11-01. A testnet pass does not prove mainnet behaviour for anything that changed between the two. Check both before each deploy, and re-run the testnet part whenever either number changes (as `docs/runbooks/testnet.md` does). Global contracts work on both networks.

```bash
node scripts/testnet/chain.mjs protocol-version testnet
node scripts/testnet/chain.mjs protocol-version mainnet
```

## 0. Get the wasm files from CI

A local build is never a source of code hashes (R6), and the Windows dev machine has no Docker. Both wasm files therefore come from the CI reproducible build. Each comes from a CI **push** run whose `headSha` is the commit recorded in `contracts/code-hashes.json` for that crate (`commit` of the `probarion-vault` and `probarion-factory` entries). The two crates are recorded on their own and can sit at different commits, because the factory source can change without the vault's, so every step below treats each crate separately. `recorded-commit` prints the commit recorded for the current source of one crate; if it prints nothing, that source is not recorded, so stop.

**Precondition: this checkout is the commit you mean to deploy.** `recorded-commit` answers for the local `HEAD`, so on a stale checkout the guards below would approve a stale build, and a stale vault could be published as immutable global code. On Day 7 `HEAD` must be `origin/dev`. On the Day 10 freeze it must be the freeze tag (a `v*` tag the controller names): set `WANT_REF` to that tag first (`export WANT_REF=` followed by the tag name).

```bash
git fetch origin --tags   # check also needs the recorded build commits in this clone
export WANT_REF="${WANT_REF:-origin/dev}"   # Day 10: the freeze tag
if [ "$(git rev-parse HEAD)" = "$(git rev-parse "$WANT_REF^{commit}")" ]; then
  echo "OK: HEAD is $WANT_REF"
else
  echo "STOP: HEAD is not $WANT_REF; check it out, then start section 0 again"
fi
```

Find the recorded commits and the CI runs that built them:

```bash
RECORDED_VAULT="$(node scripts/code-hash.mjs recorded-commit probarion-vault vault)"
RECORDED_FACTORY="$(node scripts/code-hash.mjs recorded-commit probarion-factory factory)"
echo "vault   $RECORDED_VAULT"
echo "factory $RECORDED_FACTORY"
gh run list --repo probarion/probarion --workflow ci --branch dev --limit 30 --json databaseId,headSha,event,conclusion
```

In the list, find the entry whose `headSha` equals the crate's recorded commit, whose `event` is `push` and whose `conclusion` is `success`. Its `databaseId` is that crate's run id. A recorded commit that is empty, or not 40 characters long, means the source is not recorded: stop.

`check` alone is not enough: it accepts the wasm of ANY recorded build, including an older commit's. So each guard below captures everything `check` prints (messages and errors), shows it, and prints `OK` only if that text names exactly this crate's recorded commit. Do the vault first:

```bash
export RUN_ID="${RUN_ID:?the CI push run whose headSha is the recorded commit}"
gh run download "$RUN_ID" --repo probarion/probarion -n probarion-vault-wasm -D contracts/target/ci-artifact
CHECK_VAULT="$(REQUIRE_RECORDED=1 node scripts/code-hash.mjs check probarion-vault vault contracts/target/ci-artifact/probarion_vault.wasm 2>&1)"
echo "$CHECK_VAULT"
if [ "${#RECORDED_VAULT}" = 40 ] && printf '%s\n' "$CHECK_VAULT" | grep -qF "matches the recorded build (commit $RECORDED_VAULT)"; then
  echo "OK: vault artifact is the recorded build"
else
  echo "STOP: wrong vault artifact, do not deploy"
fi
```

Then the factory. If `$RECORDED_FACTORY` equals `$RECORDED_VAULT`, the same `RUN_ID` serves both crates and the first line changes nothing. If they differ, the two crates have different commits: export `RUN_ID` again, with the run whose `headSha` is `$RECORDED_FACTORY`, before this block.

```bash
export RUN_ID="${RUN_ID:?the CI push run whose headSha is the recorded commit}"
gh run download "$RUN_ID" --repo probarion/probarion -n probarion-factory-wasm -D contracts/target/ci-artifact
CHECK_FACTORY="$(REQUIRE_RECORDED=1 node scripts/code-hash.mjs check probarion-factory factory contracts/target/ci-artifact/probarion_factory.wasm 2>&1)"
echo "$CHECK_FACTORY"
if [ "${#RECORDED_FACTORY}" = 40 ] && printf '%s\n' "$CHECK_FACTORY" | grep -qF "matches the recorded build (commit $RECORDED_FACTORY)"; then
  echo "OK: factory artifact is the recorded build"
else
  echo "STOP: wrong factory artifact, do not deploy"
fi
```

Expected: each `check` line has the form `<crate>: code_hash <hash> matches the recorded build (commit <sha>)` with `<sha>` equal to that crate's recorded commit, then `OK`. **On `STOP`, stop and tell Claude: deploy nothing.** The same goes if a `check` fails (`not recorded`, `code_hash mismatch`, or `recorded at … but this wasm was built at …`): the artifact is not the recorded build, and nothing may be deployed from it. Recording a hash is a controller step done before this runbook (AGENTS.md, "Reproducible builds and code hashes"), not a step here.

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

Global version (primary). Publish the vault code as a global contract by hash, then register it. This near-cli-rs publish is Option B of section 3, so this section rehearses Option B. The publish burns about 24.9 test NEAR (10 NEAR per 100 KB of the 248,501-byte wasm), and `ROOT` pays it after the 6 NEAR above, so `ROOT` must hold at least 26 NEAR when you run it. Check its balance first, and top `ROOT` up before the publish if it is lower (for example from `OWNER_ID`, as `docs/runbooks/testnet.md` §0.3 does):

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
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"optimistic\",\"account_id\":\"smoke-global.$FACTORY\"}}" | grep -o '"global_contract_hash":"[^"]*"'
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

**Liquidity rule.** Keep at least the largest deposit you expect a `create_vault` call to attach (for example 5 NEAR) as free balance in the factory, above its storage stake. A failed creation is refunded to the owner from the factory's own balance, and the runtime's own refund of the failed transfer may land after that callback, so a deposit larger than the factory's free NEAR could not be paid back. `create_vault` checks the vault's init bounds itself (1 to 10 approvers, a positive `daily_backstop`, a `held_ttl_ns` from 1 ns to 30 days) and refuses with `PROBARION:InvalidInput` before anything is created, so the one failure left is a taken name. The check before the first vault is below.

```bash
export ROOT=probarion.near FACTORY=vaults.probarion.near
export OWNER_ID="${OWNER_ID:?the factory owner wallet}" APPROVER_ID="${APPROVER_ID:?the approver wallet}"
```

**OWNER SIGNS** (moves 12 NEAR into the new factory account)
```bash
near account create-account fund-myself "$FACTORY" '12 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
  sign-as "$ROOT" network-config mainnet sign-with-keychain send
```

**Runway note (`min_deposit`).** A global-mode vault's deposit is its NEAR runway, and none of it ever comes back: the vault has no NEAR-withdraw method. A global-mode vault holds almost no storage of its own, so nearly the whole deposit is free NEAR, and that pays for its payments. Measured on testnet `v0.probarion.testnet` with `view_state`: a paid or burned spend leaves about 480 bytes in the vault for good, which is about 0.0048 NEAR of storage stake; a failed spend leaves about 363 bytes, about 0.0036 NEAR; and gas is about 0.0005 NEAR per spend. Storage is about 90% of what a vault uses, so the deposit buys about 200 payments at 1 NEAR and about 100 at 0.5 NEAR. `min_deposit` cannot be changed after `new`, and every vault from this factory takes it, so the value is an **OWNER decision before Day 7**; the recommendation is 0.5 NEAR. The command below keeps 1 NEAR (the last field of its `json-args`) until the OWNER decides. When a vault's free NEAR runs out, its spends fail with the runtime error `LackBalanceForState`, not with a `PROBARION:` code; a plain `send-near` transfer to the vault tops it up.

**OWNER SIGNS** (deploys the factory and initialises it with the mainnet constants)
```bash
# min_deposit is the last field of json-args and is fixed after this call: 1 NEAR here.
# OWNER decides; see the runway note
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

Check the liquidity rule first (read-only; run it again before each later batch of vault creations). Free NEAR is the balance minus the storage stake (`storage_usage` bytes at 0.00001 NEAR per byte):

```bash
export MIN_FLOAT_NEAR="${MIN_FLOAT_NEAR:-5}"   # the largest deposit a create_vault call will attach, in NEAR
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$FACTORY\"}}" \
  | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const a=JSON.parse(s).result;if(!a){console.log("STOP: no view_account result: "+s.slice(0,200));return}const free=BigInt(a.amount)-BigInt(a.storage_usage)*10n**19n;const need=BigInt(process.env.MIN_FLOAT_NEAR)*10n**24n;console.log("free NEAR:",Number(free)/1e24);console.log(free>=need?"OK: the factory can refund the largest deposit":"STOP: top the factory up before creating vaults")})'
```

On `STOP`, send more NEAR to the factory (`near tokens "$ROOT" send-near "$FACTORY" ...`, OWNER SIGNS) and run it again before any `create_vault`.

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

Take the CI artifacts of the frozen commit with §0 (the controller records them first, and `WANT_REF` is the freeze tag), so that the checkout guard and both artifact guards print `OK`, and recompute `VAULT_HASH`. If the frozen code differs from embedded v1, first store it and register it as an embedded version with §2's `store_code` and `add_version`, using the new hash.

Publish the global code with **one** of the two options. The publish burns 10 NEAR per 100 KB of `$VAULT_WASM`, about 25 NEAR for the current 248,501-byte wasm (24.9 NEAR). Check `ls -l "$VAULT_WASM"` and adjust the amounts if the size changed.

**Publish once.** A global contract by hash is immutable and costs the full burn each time it is published. Option A has no run-once check: `publish_global` called twice burns twice. Option B is safer on this point: near-cli-rs 0.30.1 describes `as-global-hash` as "immutable, skips if already deployed". Either way, first check read-only that the hash is not published yet. A node answers a `view_global_contract_code` query by code hash with the code when the hash is published, and with the error `NO_GLOBAL_CONTRACT_CODE` when it is not; `chain.mjs global-code` runs that query:

```bash
GLOBAL_STATE="$(RPC=https://rpc.mainnet.fastnear.com node scripts/testnet/chain.mjs global-code "$VAULT_HASH")"
echo "$GLOBAL_STATE"
case "$GLOBAL_STATE" in
  "not published") echo "OK: not published yet, publish once" ;;
  published) echo "STOP: already published, do not publish again; go on with add_version" ;;
  *) echo "STOP: could not tell, do not publish" ;;
esac
```

On `STOP`, publish nothing. If the answer was `published`, skip the publish and continue with `add_version` below. If it could not tell (an RPC error), run the check again. After the publish, run the same command once more (give the node a few seconds): it prints `published`.

Testnet section 1 rehearses Option B (the same near-cli-rs command on testnet). Option A is proven in the sandbox only: `contracts/integration-tests/tests/factory.rs`, test `publish_global_lets_the_factory_create_vaults_from_the_global_code`, publishes from the factory and then creates a vault from the global code. It has not run on a live network.

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

**Names are first come, first served.** From the day the mainnet factory is live (Day 7) until this step, anyone can create `demo` or `canary` (or any other free name) in it, and a `create_vault` for a taken name fails and refunds the deposit. The OWNER may reserve `demo` right after the global switch: run the `create_vault` below straight after `add_version`. Or pick a name nobody would guess, for example `probarion-demo`. The command keeps the hard-coded `demo`; if you use another name, change it in the command and in the checks and records below that name `demo`.

**OWNER SIGNS** (creates the demo vault through the global path; 1 NEAR)
```bash
# "demo" is first come, first served: if it is taken, use a less guessable name such as probarion-demo.
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

Optional, as an owner decision: lock the factory's own code by deleting its full-access key. `add_version` keeps working because the factory owner calls it from `$OWNER_ID`. Do this only after the final version is added. Find the key (read-only) and let the guard check it first: the command below deletes whatever it is given, and a comma-separated value would delete several keys at once.

```bash
FULL_ACCESS_KEY="$(RPC=https://rpc.mainnet.fastnear.com node scripts/testnet/chain.mjs full-access-keys "$FACTORY")"
echo "$FULL_ACCESS_KEY"
case "$FULL_ACCESS_KEY" in
  ""|*,*) echo "STOP: expected exactly one full-access key" ;;
  ed25519:*) echo "OK: one full-access key" ;;
  *) echo "STOP: not an ed25519 key" ;;
esac
```

Expected: `OK: one full-access key`. On any `STOP`, do not run the next command. If the key list is empty, wait a few seconds and run the block again; if it still `STOP`s, stop and tell Claude.

**OWNER SIGNS** (irreversible)
```bash
near account delete-keys "$FACTORY" public-keys "$FULL_ACCESS_KEY" network-config mainnet sign-with-keychain send
```

Check: `RPC=https://rpc.mainnet.fastnear.com node scripts/testnet/chain.mjs key-count "$FACTORY"` must print `0`.

If the factory is locked, Claude records it: `pnpm proof add-tx --id factory_lock --hash "$FACTORY_LOCK_TX" --signer vaults.probarion.near --receiver vaults.probarion.near --kind lock --signed-by deployer --what "Factory full-access key deleted"`.
