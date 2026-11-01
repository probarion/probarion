# Mainnet v0 runbook (Day 4, 2026-11-04)

The goal is three mainnet transaction hashes from a locked vault `v0.probarion.near`:
- the first NEAR payment;
- the first Base payout (2 USDC);
- the first `NoMandate` refusal.

**Every step marked OWNER SIGNS is signed by the human owner, in their own wallet or near-cli-rs. Claude never signs.** The amounts are small on purpose, because the contract is unaudited. The vault is locked for good after step 3: the USDC in it can be taken back only with the owner's `withdraw` and `withdraw_intents` (see the end of this page), and the NEAR in it (3 NEAR) can never be taken back. Nothing else can be fixed after step 3 either: the vault has no method to change its `owner` or `approvers`, so check everything before the lock.

Run every command from the repo root, in Git Bash. Put the cargo tools on the path first: `export PATH="$HOME/.cargo/bin:$PATH"`. The command shapes for creating the account, deploying, locking, `add_agent`, `create_mandate` and the agent-key `spend` are the ones that ran on testnet on 2026-11-01 (`docs/runbooks/testnet.md`, `scripts/testnet/deploy.sh` and `smoke.sh`). Testnet could not run the steps that need the real USDC, the real `intents.near` and the POA bridge (steps 4 to 6 and 10), nor the `check_spend` views and the recovery calls at the end. Amounts, gas and deposits follow `docs/runbooks/testnet.md` §5.

Signing: the commands use `sign-with-keychain`. If the key is on a Ledger, replace it with `sign-with-ledger`. Agent-key spends use `sign-with-access-key-file`. No command here prints or stores a private key.

Recording: after each signed step, copy the `Transaction ID: …` value (or the hash from https://nearblocks.io) into the chat. Claude then does two things:
1. writes it into `contracts/deployments/mainnet.json` at the path named in the step;
2. for every transaction the README cites, runs the `pnpm proof add-tx …` line given in the step, with `H` set to the pasted hash. This writes `docs/mainnet-proof.json` (interfaces §16; the CLI comes from plan 05 Task 1).

Both files are committed together in step 12, in the same commit as the work.

## 0. Preconditions

- [ ] Day 3 gate passed: CI is green and the testnet smoke passed on 2026-11-01 (`docs/runbooks/testnet.md` §6). Its transaction ids are in `contracts/deployments/testnet.json`, under `smoke`.
- [ ] Spike S1 proved, on mainnet, that a contract account can `ft_withdraw` Base POA USDC with a `WITHDRAW_TO:` memo and that the USDC arrived on Base. Run it just before Day 4, with the OWNER signing. If S1 failed, stop and use the fallback in report §8 (i).
- [ ] `pnpm proof show` runs. Plan 05 Task 1 provides it and creates `docs/mainnet-proof.json`. Do not start step 1 without it.
- [ ] The artifact guard in section 0.3 prints `OK: artifact is the recorded build`.
- [ ] Budget:
  - about 3.5 NEAR in `probarion.near`, the account that signs and funds step 1: 3 for the vault account, the rest for gas;
  - the vault account's 3 NEAR: its storage is 250,733 bytes (248,501 of them the code), which at 0.00001 NEAR per byte is 2.507 NEAR, so 3 - 2.507 = about 0.49 NEAR stays free for gas. The testnet run of the identical flow with the identical wasm (deploy, lock, `add_agent`, 2 mandates, 3 spends) ended with 0.4955 NEAR free, and its spends burned about 0.0016 NEAR of gas. The agent key's 1 NEAR allowance is a cap on its gas, not a reserve, and each mandate's storage is paid by the owner's `create_mandate` deposit. NEAR in the locked vault can never come out, while a shortfall is one plain transfer (the top-up in step 9). If the wasm size is not 248,501 bytes, redo the storage figure (1 NEAR per 100 KB);
  - about 0.5 NEAR in `$OWNER_ID` for its own deposits (0.05 NEAR per mandate, the excess refunded; 0.01 NEAR for the USDC registration) and gas;
  - about 10 native USDC in the owner wallet;
  - about 6 USDC on Base, or 6 Base POA USDC already inside the owner's own `intents.near` account.
- [ ] near-cli-rs 0.30.1 (`near --version`), Node 24, `curl` and the GitHub CLI `gh` (logged in with `gh auth login`) are installed.
- [ ] `probarion.near` exists on mainnet and its key is in the keychain or on a Ledger. Step 1 creates `v0.probarion.near` as its sub-account, which only `probarion.near` can sign. On 2026-11-01 the account did not exist yet (the owner creates it, spec §19). Check it on mainnet (`chain.mjs` reads testnet unless `RPC` is set, and section 0.2 exports `RPC` only later, so set it on this line):

  ```bash
  RPC=https://rpc.mainnet.fastnear.com node scripts/testnet/chain.mjs exists probarion.near   # must print yes
  ```

### 0.1 Protocol version

A testnet pass does not prove mainnet behaviour for anything that changed between the two networks. `contracts/deployments/testnet.json` says mainnet ran protocol 86 when the smoke passed.

```bash
node scripts/testnet/chain.mjs protocol-version mainnet
```

Expected: `86`. If it prints another number, stop and tell Claude: the testnet run has to be repeated first (`docs/runbooks/testnet.md`, top).

### 0.2 Shell variables

The four values marked `:?` are the owner's own accounts (spec §19); export them first.

```bash
export ROOT=probarion.near
export VAULT=v0.probarion.near
export OWNER_ID="${OWNER_ID:?the owner wallet account, full access}"
export APPROVER_ID="${APPROVER_ID:?the approver wallet account}"
export PAYEE_ID="${PAYEE_ID:?a NEAR account the owner controls; it receives the first payment}"
export BASE_PAYEE_ADDRESS="${BASE_PAYEE_ADDRESS:?the owner's Base wallet, 0x plus 40 hex digits}"
export USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
export BASE_ASSET=base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near
export SOL_ASSET=sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near
export RPC=https://rpc.mainnet.fastnear.com
```

`RPC` is read by `scripts/testnet/chain.mjs`, which does all the JSON reading in this runbook.

### 0.3 The vault wasm comes from CI, and only from CI

Mainnet never uses a local build and never sets `ALLOW_NON_REPRODUCIBLE`. This runbook has no such switch. The wasm is the artifact `probarion-vault-wasm` of the CI push run that built the commit recorded in `contracts/code-hashes.json` (R6, R9), and it must pass `check` against that record.

Find the recorded commit. `recorded-commit` prints it for the current source; if it prints nothing, the source is not recorded, so stop.

```bash
git fetch origin   # check needs the recorded build commit in this clone
RECORDED="$(node scripts/code-hash.mjs recorded-commit probarion-vault vault)"
echo "$RECORDED"
gh run list --repo probarion/probarion --workflow ci --branch dev --limit 30 --json databaseId,headSha,event,conclusion
```

In the list, find the entry whose `headSha` equals `$RECORDED`, whose `event` is `push` and whose `conclusion` is `success`. Its `databaseId` is the run id. (On 2026-11-01 the recorded commit was `ba65435`, built by run 41296983756 with code_hash `54Ne1r9g2Smf2Qtrt9VznmPpEAAHzvK4hbQSJ9voQmuD`. Do not copy these: derive them as above, because the record moves whenever the vault source changes.) If no run matches, or the artifact has expired, stop.

```bash
export RUN_ID="${RUN_ID:?the databaseId of the push run whose headSha equals $RECORDED}"
gh run download "$RUN_ID" --repo probarion/probarion -n probarion-vault-wasm -D contracts/target/ci-artifact-mainnet
export WASM=contracts/target/ci-artifact-mainnet/probarion_vault.wasm
ls -l "$WASM"
node scripts/code-hash.mjs hash "$WASM"
```

`check` alone is not enough: it accepts the wasm of ANY recorded build, including an older commit's. The guard below ties the file to `$RECORDED`. It prints the `check` line, then `OK` only if that line names exactly the recorded commit:

```bash
if [ "${#RECORDED}" = 40 ] && REQUIRE_RECORDED=1 node scripts/code-hash.mjs check probarion-vault vault contracts/target/ci-artifact-mainnet/probarion_vault.wasm | tee /dev/stderr | grep -qF "matches the recorded build (commit $RECORDED)"; then
  echo "OK: artifact is the recorded build"
else
  echo "STOP: wrong artifact, do not deploy"
fi
```

Expected: a `check` line of the form `probarion-vault: code_hash <hash> matches the recorded build (commit <sha>)` with `<sha>` equal to `$RECORDED`, then `OK: artifact is the recorded build`. The file is 248,501 bytes on 2026-11-01, and the hash printed above is the code hash that step 2 compares with the chain.

**On `STOP`, stop and tell Claude: deploy nothing.** The same goes if `check` fails (`not recorded`, `code_hash mismatch`, or `recorded at … but this wasm was built at …`) or if `check` names another commit (an older artifact). Recording a hash is a controller step done before this runbook (AGENTS.md, "Reproducible builds and code hashes").

## 1. Create `v0.probarion.near`

Read-only checks first: the vault name must be free, `probarion.near` and the owner, approver and payee accounts from section 0.2 must exist, and `probarion.near` must cover the 3 NEAR plus gas.

```bash
node scripts/testnet/chain.mjs exists "$VAULT"   # prints no (exit code 1) for a free name
for account in "$ROOT" "$OWNER_ID" "$APPROVER_ID" "$PAYEE_ID"; do node scripts/testnet/chain.mjs exists "$account"; done   # four lines of yes
node scripts/testnet/chain.mjs enough "$ROOT" 3   # exit code 0
```

**OWNER SIGNS** (moves 3 NEAR from `probarion.near` to the new account)
```bash
near account create-account fund-myself "$VAULT" '3 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
  sign-as "$ROOT" network-config mainnet sign-with-keychain send
```

`--signature-scheme ed25519` is spelled out because near-cli-rs otherwise asks for the scheme in a terminal.

Expected: a line saying the new account was created, then `Transaction ID: …`. Record at `vault_v0.create_tx`.

## 2. Deploy and initialise with the mainnet constants

**OWNER SIGNS** (signed by the new account's own full-access key)
```bash
near contract deploy "$VAULT" use-file "$WASM" with-init-call new \
  json-args "{\"owner\":\"$OWNER_ID\",\"approvers\":[\"$APPROVER_ID\"],\"usdc\":\"$USDC\",\"intents\":\"intents.near\",\"allowed_assets\":[\"$BASE_ASSET\",\"$SOL_ASSET\"],\"daily_backstop\":\"500000000\",\"held_ttl_ns\":\"259200000000000\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-keychain send
```

Expected: the deploy succeeds with a `Transaction ID: …`. Record at `vault_v0.deploy_tx`, and in the evidence file:

```bash
pnpm proof add-tx --id v0_deploy --hash "$H" --signer "$VAULT" --receiver "$VAULT" \
  --kind deploy --signed-by deployer --what "Vault v0 deployed from the reproducible build and initialised with the mainnet constants"
```

Check (free views). Read the config, then let the two guards decide:

```bash
near contract call-function as-read-only "$VAULT" get_config json-args '{}' network-config mainnet now
```

Guard 1: the config is exactly what was meant. It reads `get_config` over RPC and compares every field with the values you exported:

```bash
curl -s "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"optimistic\",\"account_id\":\"$VAULT\",\"method_name\":\"get_config\",\"args_base64\":\"e30=\"}}" \
  | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const r=JSON.parse(s).result;if(!r||!r.result){console.log("STOP: no get_config result: "+s.slice(0,200));return}const c=JSON.parse(Buffer.from(r.result).toString());const e=process.env;const want={owner:e.OWNER_ID,approvers:[e.APPROVER_ID],usdc:e.USDC,intents:"intents.near",allowed_assets:[e.BASE_ASSET,e.SOL_ASSET],daily_backstop:"500000000",held_ttl_ns:"259200000000000",frozen:false,factory:null,version:"0.1.0",ledger_key:null};const bad=Object.keys(want).filter((k)=>JSON.stringify(c[k])!==JSON.stringify(want[k]));console.log(bad.length?"STOP: get_config differs in "+bad.join(", ")+": "+JSON.stringify(c):"OK: get_config is exactly what was meant")})'
```

Straight after the deploy, the only reply that means "try again" is `STOP: no get_config result`: wait a few seconds and run guard 1 again. Any other `STOP` is a real one.

Guard 2: the code on the chain is the CI wasm:

```bash
if [ "$(node scripts/testnet/chain.mjs code-hash "$VAULT")" = "$(node scripts/code-hash.mjs hash "$WASM")" ]; then
  echo "OK: the deployed code is the CI wasm"
else
  echo "STOP: the deployed code differs from the CI wasm"
fi
```

Expected, by hand as well (all of these, not most of them):
- `owner` is `$OWNER_ID`;
- `approvers` is exactly `["$APPROVER_ID"]`;
- `usdc` is `$USDC`;
- `intents` is `intents.near`;
- `allowed_assets` is exactly `["$BASE_ASSET", "$SOL_ASSET"]`;
- `"daily_backstop": "500000000"`, `"held_ttl_ns": "259200000000000"`, `"frozen": false`, `"factory": null`, `"version": "0.1.0"` and `"ledger_key": null`;
- the code hash is equal to the one `check` accepted in section 0.3. Record it at `vault_v0.code_hash`.

## 3. Lock: delete the full-access key

**Run this step only if every check of step 2 passed: both guards printed `OK`, and the config equalities hold.** Otherwise stop and tell Claude. Until the key is deleted, the account still has its full-access key and can still be fixed; after the lock nothing can. The vault has no method to change its `owner` or `approvers`, so a wrong value there is permanent after the lock.

Find the key (read-only) and let the guard check it:

```bash
FULL_ACCESS_KEY="$(node scripts/testnet/chain.mjs full-access-keys "$VAULT")"
echo "$FULL_ACCESS_KEY"
case "$FULL_ACCESS_KEY" in
  ""|*,*) echo "STOP: expected exactly one full-access key" ;;
  ed25519:*) echo "OK: one full-access key" ;;
  *) echo "STOP: not an ed25519 key" ;;
esac
```

Expected: `OK: one full-access key`. A comma-separated value would delete several keys at once, so on any `STOP` do not run the next command. If the key list is empty, wait a few seconds and run the block again; if it still `STOP`s, stop and tell Claude.

**OWNER SIGNS** (irreversible: from now on only the contract code controls the account)
```bash
near account delete-keys "$VAULT" public-keys "$FULL_ACCESS_KEY" network-config mainnet sign-with-keychain send
```

Check:

```bash
node scripts/testnet/chain.mjs key-count "$VAULT"
```

Expected: `0` (no access keys). If it still prints `1`, wait a few seconds and run it again. Record the delete tx at `vault_v0.lock_tx`, and in the evidence file:

```bash
pnpm proof add-tx --id v0_lock --hash "$H" --signer "$VAULT" --receiver "$VAULT" \
  --kind lock --signed-by deployer --what "Vault v0 locked: its only full-access key deleted"
pnpm proof set accounts.v0_vault "$VAULT" --source "docs/runbooks/mainnet-v0.md step 3"
pnpm proof set code_hashes.vault_v0 "$(node scripts/code-hash.mjs hash "$WASM")" --source "scripts/build-reproducible.sh vault; RPC view_account code_hash of v0.probarion.near"
```

## 4. Register the vault's storage on USDC

**OWNER SIGNS** (attaches 0.01 NEAR; `registration_only` keeps the 0.00125 NEAR the registration costs and refunds the rest)
```bash
near contract call-function as-transaction "$USDC" storage_deposit \
  json-args "{\"account_id\":\"$VAULT\",\"registration_only\":true}" \
  prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

Check: `near contract call-function as-read-only "$USDC" storage_balance_of json-args "{\"account_id\":\"$VAULT\"}" network-config mainnet now` is not `null`. Record at `funding.usdc_storage_tx`.

## 5. Fund about 10 native USDC

**OWNER SIGNS** (moves 10 USDC)
```bash
near contract call-function as-transaction "$USDC" ft_transfer \
  json-args "{\"receiver_id\":\"$VAULT\",\"amount\":\"10000000\",\"memo\":\"probarion v0 float\"}" \
  prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

Check: `near contract call-function as-read-only "$USDC" ft_balance_of json-args "{\"account_id\":\"$VAULT\"}" network-config mainnet now` prints `"10000000"`. Record at `funding.usdc_float_tx`.

## 6. Top up Base POA USDC inside the vault's `intents.near` account

Use the path spike S0/S1 proved, and do only one of the two options. Record the method (`"mt_transfer"` or `"poa_deposit"`) at `funding.intents_topup.method`. Testnet cannot exercise this step (the stub has no `mt_transfer` and there is no POA bridge there), so the `mt_balance_of` check below is the proof: if it shows less than you sent, stop.

**Option A.** The owner already holds Base POA USDC inside their own `intents.near` account.

**OWNER SIGNS** (moves 6 Base POA USDC inside Intents, from the owner to the vault)
```bash
near contract call-function as-transaction intents.near mt_transfer \
  json-args "{\"receiver_id\":\"$VAULT\",\"token_id\":\"nep141:$BASE_ASSET\",\"amount\":\"6000000\"}" \
  prepaid-gas '50 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

Record at `funding.intents_topup.near_tx`, and in the evidence file:

```bash
pnpm proof add-tx --id v0_intents_topup --hash "$H" --signer "$OWNER_ID" --receiver intents.near \
  --kind intents_topup --signed-by owner --amount 6.00 --what "Owner moved 6 Base POA USDC into the vault's intents.near balance"
```

**Option B.** Deposit from the owner's Base wallet through the POA bridge, credited directly to the vault's Intents account. First get the deposit address (read-only). The reply is one line of JSON; the deposit address is its `address` field:

```bash
curl -s https://bridge.chaindefuser.com/rpc -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"deposit_address\",\"params\":[{\"account_id\":\"$VAULT\",\"chain\":\"eth:8453\"}]}"
```

**OWNER SIGNS** in the Base wallet app (there is no near-cli command): send 6 USDC (Base USDC contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) to the returned `address`. The minimum is 0.15 USDC. Record the Base tx hash at `funding.intents_topup.base_tx`. It is a Base hash, not a NEAR one, so the evidence file gets a link: `pnpm proof set links.v0_intents_topup_base "https://basescan.org/tx/$BASE_H" --source "docs/runbooks/mainnet-v0.md step 6 option B"`.

Check, after finality:

```bash
near contract call-function as-read-only intents.near mt_balance_of json-args "{\"account_id\":\"$VAULT\",\"token_id\":\"nep141:$BASE_ASSET\"}" network-config mainnet now
near contract call-function as-read-only intents.near public_keys_of json-args "{\"account_id\":\"$VAULT\"}" network-config mainnet now
near contract call-function as-read-only intents.near is_auth_by_predecessor_id_enabled json-args "{\"account_id\":\"$VAULT\"}" network-config mainnet now
```

Expected: `"6000000"` (or the amount that arrived), then `[]`, then `true`.

## 7. Agent key

Generate the keypair offline (no transaction). The folder must be new, so that `ls` finds exactly one file:

```bash
mkdir -p .keys
near account create-account fund-later use-auto-generation save-to-folder ./.keys/mainnet-agent
export AGENT_KEY_FILE="$(ls ./.keys/mainnet-agent/*.json)"
export AGENT_PK="$(node scripts/testnet/chain.mjs public-key "$AGENT_KEY_FILE")"
echo "$AGENT_PK"
```

The key file holds `public_key`, `private_key` and a seed phrase. `.keys/` is git-ignored. Never commit the file and never paste it anywhere, chat included. Only the public key is ever printed.

**OWNER SIGNS** (owner call; the 1 NEAR allowance is spent from the vault's own balance as gas is used)
```bash
near contract call-function as-transaction "$VAULT" add_agent \
  json-args "{\"public_key\":\"$AGENT_PK\",\"allowance\":\"1000000000000000000000000\",\"label\":\"v0 agent\"}" \
  prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

Check:

```bash
node scripts/testnet/chain.mjs key-count "$VAULT"
near contract call-function as-read-only "$VAULT" list_agents json-args '{}' network-config mainnet now
near account list-keys "$VAULT" network-config mainnet now
```

Expected: `1`; `list_agents` shows `$AGENT_PK` with the label `v0 agent`; `list-keys` shows exactly one function-call key, with receiver `v0.probarion.near` and method `spend`. Record at `setup.add_agent_tx`, and in the evidence file:

```bash
pnpm proof add-tx --id v0_agent_added --hash "$H" --signer "$OWNER_ID" --receiver "$VAULT" \
  --kind agent_added --signed-by owner --what "Owner added the spend-only agent key (FC key on the vault, method spend)"
```

## 8. Mandates

```bash
export PURPOSE="$(sha256sum docs/evidence/v0-po.txt | cut -d' ' -f1)"
export EXPIRES=1798675200000000000   # 2026-12-31T00:00:00Z; check with: date -u -d @1798675200
```

**The payees decide where the money goes, and a variable proves nothing about an address.** A wrong payee cannot be changed: the only fix is to revoke the mandate. So the owner checks both payees against their own wallets, twice: before the mandate is created, and on the chain afterwards.

**OWNER SIGNS** (mandate 1, NEAR payee; the 0.05 NEAR covers storage and the payee's USDC registration, and the excess is refunded)
```bash
near contract call-function as-transaction "$VAULT" create_mandate \
  json-args "{\"input\":{\"payee\":{\"type\":\"near\",\"account_id\":\"$PAYEE_ID\"},\"purpose_hash\":\"$PURPOSE\",\"max_per_payment\":\"5000000\",\"max_total\":\"20000000\",\"max_uses\":5,\"expires_at_ns\":\"$EXPIRES\",\"approval_above\":\"5000000\",\"agent_pk\":\"$AGENT_PK\",\"label\":\"v0 near payee\"}}" \
  prepaid-gas '100 Tgas' attached-deposit '0.05 NEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

Expected result: `1`. Record at `setup.near_mandate_tx`, and in the evidence file:

```bash
pnpm proof add-tx --id v0_mandate_near --hash "$H" --signer "$OWNER_ID" --receiver "$VAULT" \
  --kind mandate_created --signed-by owner --what "Mandate 1: NEAR payee, at most 5 USDC per payment, 20 USDC total"
```

Check mandate 1 on the chain:

```bash
near contract call-function as-read-only "$VAULT" get_mandate json-args '{"mandate_id":1}' network-config mainnet now
```

Expected: the payee `account_id` is `$PAYEE_ID`, and `"status": "active"`. The owner confirms that they control that account (they can sign in to it). **If the payee is not an account the owner controls, do not run step 9.** Send the `revoke_mandate` command from "If anything looks wrong" with `{"mandate_id":1}`, then stop and tell Claude: the evidence files name mandate 1.

Before mandate 2, print the Base address and compare it, character by character, with the Receive screen of your own Base wallet app (the app itself, not a message, a file or the clipboard history):

```bash
echo "$BASE_PAYEE_ADDRESS"
```

One wrong character sends the 2 USDC to an address nobody controls, and it cannot be recovered. Stop if even one character differs.

**OWNER SIGNS** (mandate 2, Base payee)
```bash
near contract call-function as-transaction "$VAULT" create_mandate \
  json-args "{\"input\":{\"payee\":{\"type\":\"intents\",\"chain\":\"base\",\"address\":\"$BASE_PAYEE_ADDRESS\",\"asset\":\"$BASE_ASSET\"},\"purpose_hash\":\"$PURPOSE\",\"max_per_payment\":\"5000000\",\"max_total\":\"20000000\",\"max_uses\":5,\"expires_at_ns\":\"$EXPIRES\",\"approval_above\":\"5000000\",\"agent_pk\":\"$AGENT_PK\",\"label\":\"v0 base payee\"}}" \
  prepaid-gas '100 Tgas' attached-deposit '0.05 NEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

Expected result: `2`. Record at `setup.base_mandate_tx`, and in the evidence file:

```bash
pnpm proof add-tx --id v0_mandate_base --hash "$H" --signer "$OWNER_ID" --receiver "$VAULT" \
  --kind mandate_created --signed-by owner --what "Mandate 2: Base address payee via NEAR Intents, at most 5 USDC per payment"
```

Check mandate 2 on the chain:

```bash
near contract call-function as-read-only "$VAULT" get_mandate json-args '{"mandate_id":2}' network-config mainnet now
```

Expected: `"status": "active"`, and the `address` in the reply is the address of the owner's own Base wallet. **Compare the address in this reply, which is what the contract stored, with the Receive screen of the Base wallet app, character by character. Do not compare it with `$BASE_PAYEE_ADDRESS`**: the variable is what was sent, so it would match even when it is wrong. **If they differ, do not run step 10.** Send the `revoke_mandate` command from "If anything looks wrong" with `{"mandate_id":2}` (as it is written there), then stop and tell Claude: the evidence files name mandate 2.

## 9. First NEAR payment (2 USDC)

First check that the vault has NEAR left for gas (read-only). Free NEAR is the vault's balance minus its storage stake (`storage_usage` bytes at 0.00001 NEAR per byte):

```bash
curl -s "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$VAULT\"}}" \
  | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const a=JSON.parse(s).result;const free=BigInt(a.amount)-BigInt(a.storage_usage)*10n**19n;console.log("storage_usage",a.storage_usage,"bytes; free NEAR:",Number(free)/1e24)})'
```

Expected: about 0.49 NEAR free. **Top-up rule:** if free NEAR is below 0.2, top the vault up with one plain transfer before you sign any spend (the vault pays each spend's prepaid gas from this balance, and a spend it cannot pay for is rejected). Check it again after step 11.

**OWNER SIGNS** (only if free NEAR is below 0.2; moves 0.5 NEAR from `probarion.near` to the vault)
```bash
near tokens "$ROOT" send-near "$VAULT" '0.5 NEAR' network-config mainnet sign-with-keychain send
```

Read the payee's USDC balance now, so that the payment can be checked against it:

```bash
near contract call-function as-read-only "$USDC" ft_balance_of json-args "{\"account_id\":\"$PAYEE_ID\"}" network-config mainnet now
```

Write the number down. Then check the spend (free view):

```bash
export INVOICE1="$(sha256sum docs/evidence/v0-invoice-1.txt | cut -d' ' -f1)"
export DECISION1="$(sha256sum docs/evidence/v0-decision-1.json | cut -d' ' -f1)"
near contract call-function as-read-only "$VAULT" check_spend \
  json-args "{\"request\":{\"mandate_id\":1,\"amount\":\"2000000\",\"invoice_hash\":\"$INVOICE1\",\"ref\":\"V0-INV-1\",\"decision_hash\":\"$DECISION1\"},\"signer_pk\":\"$AGENT_PK\"}" \
  network-config mainnet now
```

Expected: `{"ok": true, "code": null, "would_hold": false}`. **If `ok` is not `true`, or `would_hold` is `true`, do not sign the spend: stop and tell Claude with the output.**

**OWNER SIGNS** (moves 2 USDC; signed on the owner's machine with the agent key file)
```bash
near contract call-function as-transaction "$VAULT" spend \
  json-args "{\"request\":{\"mandate_id\":1,\"amount\":\"2000000\",\"invoice_hash\":\"$INVOICE1\",\"ref\":\"V0-INV-1\",\"decision_hash\":\"$DECISION1\"}}" \
  prepaid-gas '200 Tgas' attached-deposit '0 NEAR' sign-as "$VAULT" network-config mainnet sign-with-access-key-file "$AGENT_KEY_FILE" send
```

Expected:
- `EVENT_JSON` logs for `spend_submitted` and, from the callback receipt, `spend_paid`;
- the result `{"spend_id":1,"status":"paid"}`;
- a `Transaction ID: …`.

If near-cli-rs prints only some receipts' logs, open `https://nearblocks.io/txns/<hash>` and confirm `spend_paid` there. Read `ft_balance_of` for `$PAYEE_ID` again (the command above): it must be exactly 2000000 higher than the number you wrote down. Record at `proof.first_near_payment_tx`, and in the evidence file. The signer is the vault, because the agent FC key signs as the vault account:

```bash
pnpm proof add-tx --id first_near_payment --hash "$H" --signer "$VAULT" --receiver "$VAULT" \
  --kind near_payment --signed-by agent_key --spend-id 1 --amount 2.00 --what "First NEAR USDC payment under mandate 1"
```

## 10. First Base payout (2 USDC)

```bash
export INVOICE2="$(sha256sum docs/evidence/v0-invoice-2.txt | cut -d' ' -f1)"
export DECISION2="$(sha256sum docs/evidence/v0-decision-2.json | cut -d' ' -f1)"
near contract call-function as-read-only "$VAULT" check_spend \
  json-args "{\"request\":{\"mandate_id\":2,\"amount\":\"2000000\",\"invoice_hash\":\"$INVOICE2\",\"ref\":\"V0-INV-2\",\"decision_hash\":\"$DECISION2\"},\"signer_pk\":\"$AGENT_PK\"}" \
  network-config mainnet now
```

Expected: `{"ok": true, "code": null, "would_hold": false}`. **If `ok` is not `true`, or `would_hold` is `true`, do not sign the spend: stop and tell Claude with the output.** Do not start this step either unless the mandate 2 address check in step 8 passed against the wallet app.

**OWNER SIGNS** (moves 2 Base POA USDC out of the vault's Intents balance and burns it for release on Base)
```bash
near contract call-function as-transaction "$VAULT" spend \
  json-args "{\"request\":{\"mandate_id\":2,\"amount\":\"2000000\",\"invoice_hash\":\"$INVOICE2\",\"ref\":\"V0-INV-2\",\"decision_hash\":\"$DECISION2\"}}" \
  prepaid-gas '200 Tgas' attached-deposit '0 NEAR' sign-as "$VAULT" network-config mainnet sign-with-access-key-file "$AGENT_KEY_FILE" send
```

Expected:
- `spend_submitted`, then `spend_burned` with `"memo":"WITHDRAW_TO:$BASE_PAYEE_ADDRESS"`;
- the result `{"spend_id":2,"status":"burned"}`;
- on nearblocks, in the same transaction:
  - an `intents.near` receipt with an NEP-245 `mt_burn` (`owner_id` = `v0.probarion.near`, amount `2000000`, `token_ids` = `["nep141:$BASE_ASSET"]`);
  - a receipt on `base-0x8335…omft.near` with an NEP-300 `ft_burn` (`owner_id` = `intents.near`) carrying the same `WITHDRAW_TO:` memo.

  Verifier check (h) matches these two.

Check the vault's own record of both payments:

```bash
near contract call-function as-read-only "$VAULT" list_spends json-args '{"from_index":0,"limit":10}' network-config mainnet now
```

Expected: spend 1 `paid`; spend 2 `burned` with `"memo": "WITHDRAW_TO:"` followed by `$BASE_PAYEE_ADDRESS`.

Record the NEAR tx at `proof.first_base_payout_tx`. Within minutes, Base USDC arrives at `$BASE_PAYEE_ADDRESS`. Expect 2 USDC minus the POA withdrawal fee, which was 0.0024 USDC on 2026-10-20 (confirm the fee in spike S0). Find the transfer on https://basescan.org and record its hash at `proof.first_base_payout_base_tx`. Then record both in the evidence file, with `BASE_H` set to the Base hash:

```bash
pnpm proof add-tx --id first_base_payout --hash "$H" --signer "$VAULT" --receiver "$VAULT" \
  --kind base_payout --signed-by agent_key --spend-id 2 --amount 2.00 --base-tx "$BASE_H" \
  --what "First Base payout: ft_withdraw with WITHDRAW_TO memo built from mandate 2"
```

If nothing arrives within 30 minutes, treat the spend as "burned, awaiting bridge": do not resend, and raise it in the hackathon Discord with both tx hashes. In that case record the NEAR transaction now without `--base-tx`. When the Base transfer lands, add `pnpm proof set links.first_base_payout_base "https://basescan.org/tx/$BASE_H" --source "docs/runbooks/mainnet-v0.md step 10"`.

## 11. First `NoMandate` refusal

```bash
export INVOICE3="$(sha256sum docs/evidence/v0-invoice-refusal.txt | cut -d' ' -f1)"
export DECISION3="$(sha256sum docs/evidence/v0-decision-refusal.json | cut -d' ' -f1)"
```

**OWNER SIGNS** (moves no funds; the gas comes out of the agent key's allowance)
```bash
near contract call-function as-transaction "$VAULT" spend \
  json-args "{\"request\":{\"mandate_id\":999,\"amount\":\"1000000\",\"invoice_hash\":\"$INVOICE3\",\"ref\":\"V0-INV-999\",\"decision_hash\":\"$DECISION3\"}}" \
  prepaid-gas '200 Tgas' attached-deposit '0 NEAR' sign-as "$VAULT" network-config mainnet sign-with-access-key-file "$AGENT_KEY_FILE" send
```

Expected: the command fails with `Smart contract panicked: PROBARION:NoMandate`. The failed transaction is still on chain, but **the CLI prints no transaction id for a refused spend** (testnet showed this), so find the hash as below.

**Find the hash with FastNEAR (primary).** Its transactions API lists failed transactions too. The newest entry with `"is_success":false` is the refusal (read-only; it can lag by a few seconds, so repeat if it prints nothing):

```bash
REFUSAL_TX="$(curl -s -X POST https://tx.main.fastnear.com/v0/account -H 'content-type: application/json' \
  -d '{"account_id":"v0.probarion.near","is_signer":true,"max_block_height":null}' \
  | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const failed=JSON.parse(s).account_txs.filter((t)=>t.is_success===false).sort((a,b)=>b.tx_block_height-a.tx_block_height);console.log(failed.length?failed[0].transaction_hash:"")})')"
echo "$REFUSAL_TX"
```

Confirm it with the RPC (read-only). The hash is the refusal only if the status shows `Smart contract panicked: PROBARION:NoMandate`: a failed `spend` with that error is how you recognise it, and any other failed transaction of the vault is not it.

```bash
curl -s "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tx\",\"params\":{\"tx_hash\":\"$REFUSAL_TX\",\"sender_account_id\":\"$VAULT\",\"wait_until\":\"NONE\"}}" \
  | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify(r.result?.status ?? r.error))})'
```

Expected: `{"Failure":{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: PROBARION:NoMandate"}}}}}`.

**Fallback: NearBlocks.** If FastNEAR is down or lists nothing, open https://nearblocks.io/address/v0.probarion.near and take the newest failed `spend` of `v0.probarion.near`, or read the NearBlocks API (read-only):

```bash
curl -s "https://api.nearblocks.io/v1/account/v0.probarion.near/txns?per_page=5"
```

Print the raw JSON and find the newest entry whose method is `spend` and whose outcome is failed. Open `https://nearblocks.io/txns/<hash>` and confirm the error `PROBARION:NoMandate` there before you use the hash.

Record the hash at `proof.first_no_mandate_refusal_tx`, and in the evidence file:

```bash
pnpm proof add-tx --id refused_no_mandate --hash "$H" --signer "$VAULT" --receiver "$VAULT" \
  --kind refused_on_chain --signed-by agent_key --expect failure --error-code NoMandate \
  --what "spend() against mandate 999, which does not exist: refused on chain"
```

## 12. After the run

- Claude fills `contracts/deployments/mainnet.json`, checks `pnpm proof show` lists every id above, adds the mainnet rows to `AGENTS.md`, and commits everything in one commit: `git add contracts/deployments/mainnet.json docs/mainnet-proof.json AGENTS.md`.
- The three Day 4 spends carry pre-ledger decision hashes: the sha256 of `docs/evidence/v0-decision-*.json`. Plan 03's verifier lists them in `Snapshot.pre_ledger_decision_hashes`, and check (d) reports them as "pre-ledger (documented)".
- Day 4 gate: all four `proof.*` fields in `contracts/deployments/mainnet.json` are non-null, and the Base payout's `ft_burn` memo equals `WITHDRAW_TO:` plus the mandate's address.
- **OWNER:** publish the build-in-public post with the three nearblocks links.

## If anything looks wrong

**OWNER SIGNS** (stops all spends and approvals; callbacks still settle)
```bash
near contract call-function as-transaction "$VAULT" freeze json-args '{}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

**OWNER SIGNS** (revokes a mandate, for a wrong payee: change `2` to the mandate's id; the mandate then refuses every new spend)
```bash
near contract call-function as-transaction "$VAULT" revoke_mandate json-args '{"mandate_id":2}' \
  prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

**OWNER SIGNS** (removes the agent key, for example after the key file leaked; this makes the agent unable to sign any spend)
```bash
near contract call-function as-transaction "$VAULT" remove_agent json-args "{\"public_key\":\"$AGENT_PK\"}" \
  prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

**OWNER SIGNS** (native USDC back to the owner; set the amount to the vault's `ft_balance_of`, step 5 check)
```bash
near contract call-function as-transaction "$VAULT" withdraw json-args '{"amount":"8000000"}' \
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

The owner must be registered on the POA token before Intents can pay them back on NEAR.

**OWNER SIGNS** (registers the owner on the Base POA token; attaches 0.01 NEAR, and the excess over the 0.00125 NEAR registration is refunded)
```bash
near contract call-function as-transaction "$BASE_ASSET" storage_deposit \
  json-args "{\"account_id\":\"$OWNER_ID\",\"registration_only\":true}" \
  prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

**OWNER SIGNS** (the vault's Base POA balance in Intents back to the owner's NEAR account; set the amount to the vault's `mt_balance_of`, step 6 check)
```bash
near contract call-function as-transaction "$VAULT" withdraw_intents \
  json-args "{\"token\":\"$BASE_ASSET\",\"amount\":\"4000000\"}" \
  prepaid-gas '150 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```
