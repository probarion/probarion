# Mainnet v0 runbook (2026-11 demo run)

The full runbook (planned for Day 4, 2026-11-04) aims at three mainnet transaction hashes from a locked vault `v0.probarion.near`:
- the first NEAR payment;
- the first Base payout (2 USDC);
- the first `NoMandate` refusal.

**The 2026-11 demo run is smaller.** It runs steps 0 to 5, 7, mandate 1 of step 8, 9 and 11: one vault funded with 3 native USDC, one payment of 1 USDC to the owner's own Meteor wallet under mandate 1, and one spend the contract refuses with `PROBARION:NoMandate`. Step 6 (the Intents top-up), mandate 2 of step 8 and step 10 (the Base payout) are **not in the 2026-11 demo run**: on 2026-11-11 no spike had shown a contract withdrawing Base POA USDC to Base on mainnet, so that run moved nothing through NEAR Intents and claimed no Base payout. There is no factory, no global contract and no change to the web app in this run: probarion.xyz keeps serving testnet.

**The 2026-11 demo run ran on 2026-11-11**, from 12:51 to 13:00 UTC (block times). The owner signed every step in their own terminal and in Meteor, and Claude signed nothing. Spend 1 paid 1 USDC to the owner's own Meteor wallet, and the spend against mandate 999 was refused on chain with `PROBARION:NoMandate`. Its vault's transactions are in `contracts/deployments/mainnet.json`, the ones the README cites are also in `docs/mainnet-proof.json`, and its record, with the verifier's output, is `docs/evidence/mainnet-v0/README.md`. Steps 6 and 10 and mandate 2 did not run in it, so that run made no Base payout.

**S1 ran on 2026-11-13**, from 07:11 to 07:25 UTC (block times), with a kit kept outside this repository that runs the SDK, in place of step 6, mandate 2 of step 8 and step 10. A 1Click swap topped the vault's Base USDC up inside `intents.near`, a third method beside step 6's two (`funding.intents_topup.method` is `"oneclick_swap"`). Mandate 2 pays 1.00 USDC once to the owner's own Base address, under its own purpose document `PO-M002`. The SDK paid INV-M002, a labeled test of the cross-chain path, as spend 2, decided by code rules alone after code refused two attested model proposals. The vault burned 1.00 USDC with `WITHDRAW_TO:` and mandate 2's address, and the POA bridge released 0.9976 USDC on Base. The owner signed every owner step, and Claude signed nothing. Its record is `docs/evidence/mainnet-v0/s1-2026-11-13/README.md`. Step 6, mandate 2 of step 8 and step 10 as written below (6 USDC, 5 USDC a payment, a 2 USDC payout) have not run.

**S2 ran on 2026-11-13**, from 11:39 to 11:41 UTC (block times), with a kit copied from S1's and changed for round 2, running SDK commit `c85f41b`, also in place of the Base steps below. The owner signed mandate 3, which pays 0.25 USDC once to the same Base address, under its own purpose document `PO-M003`. `z-ai/glm-5.3-flash` on NEAR AI Cloud proposed paying INV-M003, a second labeled test of the cross-chain path, every code rule passed, and the SDK paid it as spend 3, decided by an attested model and the code rules. The vault burned 0.25 USDC with `WITHDRAW_TO:` and mandate 3's address, and the POA bridge released 0.2476 USDC on Base. S2 added no USDC and no key. The owner signed every owner step, and Claude signed nothing. Its record is `docs/evidence/mainnet-v0/s2-2026-11-13/README.md`.

**Every step marked OWNER SIGNS is signed by the human owner, in their own wallet or near-cli-rs. Claude never signs.** The amounts are small on purpose, because the contract is unaudited. The vault is locked for good after step 3: the USDC in it can be taken back only with the owner's `withdraw` and `withdraw_intents` (see the end of this page), and the NEAR in it (3 NEAR) can never be taken back. Nothing else can be fixed after step 3 either: the vault has no method to change its `owner` or `approvers`, so check everything before the lock.

Run every command from the repo root, on the `dev` branch, in Git Bash. Put the cargo tools on the path first: `export PATH="$HOME/.cargo/bin:$PATH"`. Commands call `node.exe`, not `node`: in an interactive Git Bash window `node` is an alias for `winpty node.exe`, which breaks `| node -e` and `$(node ...)`. The command shapes for creating the account, deploying, locking, `add_agent`, `create_mandate` and the agent-key `spend` are the ones that ran on testnet on 2026-11-01 (`docs/runbooks/testnet.md`, `scripts/testnet/deploy.sh` and `smoke.sh`), checked again against near-cli-rs 0.30.1 `--help` on 2026-11-11. Testnet could not run the steps that need the real USDC, the real `intents.near` and the POA bridge (steps 4 to 6 and 10), nor the `check_spend` views and the recovery calls at the end. Amounts, gas and deposits follow `docs/runbooks/testnet.md` §5.

Signing: the vault owner is `probarion.near`, a near-cli account whose key is in the keychain (section 0.4), so the owner calls use `sign-with-keychain`. If the key is on a Ledger, replace `sign-with-keychain send` with `sign-with-ledger usb send`. The funder and the agent key sign with `sign-with-access-key-file`. Meteor cannot sign near-cli transactions, so the owner's Meteor wallet only sends: the NEAR for the funder (section 0.4) and the USDC for the vault (step 5), in Meteor's own screens. Keys are written only to the keychain (section 0.4 and step 1, `save-to-keychain`) or to the git-ignored `.keys/` folder (section 0.4 and step 7, `save-to-folder`), and no command prints one.

Recording: after each signed step, copy the `Transaction ID: …` value (or the hash from https://nearblocks.io) into the chat. Claude then does two things:
1. writes it into `contracts/deployments/mainnet.json` at the path named in the step;
2. for every transaction the README cites, runs the `pnpm proof add-tx …` line given in the step, with `H` set to the pasted hash. This writes `docs/mainnet-proof.json` (interfaces §16; the CLI comes from plan 05 Task 1).

Both files are committed together in step 12, in the same commit as the work.

## 0. Preconditions

- [ ] Day 3 gate passed: CI is green and the testnet smoke passed on 2026-11-01 (`docs/runbooks/testnet.md` §6). Its transaction ids are in `contracts/deployments/testnet.json`, under `smoke`.
- [ ] Spike S1 (a contract account on mainnet calls `ft_withdraw` for Base POA USDC with a `WITHDRAW_TO:` memo, and the USDC arrives on Base) is needed only for steps 6 and 10. **S1 was unproven on 2026-11-11, so the 2026-11 demo run skipped those steps. It ran on 2026-11-13**, with the OWNER signing: spend 2 of `v0.probarion.near` burned 1.00 Base POA USDC with a `WITHDRAW_TO:` memo, and 0.9976 USDC arrived on Base (`docs/evidence/mainnet-v0/s1-2026-11-13/README.md`). S2 paid 0.25 USDC the same way later that day, as spend 3, and 0.2476 USDC arrived (`docs/evidence/mainnet-v0/s2-2026-11-13/README.md`).
- [ ] `pnpm proof show` runs. Plan 05 Task 1 provides it and creates `docs/mainnet-proof.json`. Do not start step 1 without it.
- [ ] The checkout guard and the artifact guard in section 0.3 print `OK: HEAD is origin/dev` and `OK: artifact is the recorded build`.
- [ ] Budget:
  - about 4 NEAR in `probarion.near` (3.85 NEAR in the 2026-11 run), the account that signs and funds step 1, the owner calls and any top-up: 3 for the vault account, 0.5 kept for one top-up (step 9), the rest for the owner's deposits (0.01 NEAR for the USDC registration and 0.05 NEAR per mandate, the excess refunded) and gas. The `enough` check in step 1 asks for 3 + 0.5 plus a 0.3 gas margin. The NEAR comes from the owner's Meteor wallet through the funder (section 0.4): Meteor sends 3.95 NEAR to the funder, so Meteor needs about 4 NEAR;
  - the vault account's 3 NEAR: its storage is 250,733 bytes (248,501 of them the code), which at 0.00001 NEAR per byte is 2.507 NEAR, so 3 - 2.507 = about 0.49 NEAR stays free. **That free NEAR is the vault's storage runway, not a gas reserve.** Measured on testnet `v0.probarion.testnet` with `view_state`: a paid or burned spend leaves about 480 bytes in the vault for good (the spend record 291, the invoice 117, the ref about 72), which is about 0.0048 NEAR of storage stake; a failed spend leaves about 363 bytes, about 0.0036 NEAR; and gas is only about 0.0005 NEAR per spend. So storage is about 90% of what a spend uses, none of it is ever refunded, and the vault has no method to withdraw NEAR. About 0.49 free NEAR therefore lasts about 100 payments. The testnet run of the identical flow (deploy, lock, `add_agent`, 2 mandates, 3 spends), with the earlier 248,501-byte build `6tbERLAXWjaVKbSNzaivRDh7H9kCcjtmV1qGrgz7entR` rather than this wasm, ended with 0.4955 NEAR free, and its spends burned about 0.0016 NEAR of gas. When the free NEAR runs out, spends fail with the runtime error `LackBalanceForState`, not with a `PROBARION:` code. The remedy is one plain transfer (the top-up in step 9, which is due when free NEAR is below 0.2). The agent key's 0.25 NEAR allowance (step 7) is a cap on its gas, not a reserve, and each mandate's storage is paid by the owner's `create_mandate` deposit. NEAR in the locked vault can never come out. The recorded wasm is now 248,969 bytes (468 more than the measured one), so expect about 251,201 bytes, 2.512 NEAR staked and about 0.488 NEAR free (an estimate from the measured figures). If the wasm size is not 248,969 bytes, redo the storage figure (1 NEAR per 100 KB);
  - about 3 native USDC in the owner's Meteor wallet (token contract `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, 6 decimals), plus a little NEAR there for Meteor's own gas;
  - no Base USDC: the Base steps are not in the 2026-11 demo run.
- [ ] near-cli-rs 0.30.1 (`near --version`; do not self-update during the run), Node 24 (`node.exe --version`), `curl` and the GitHub CLI `gh` (logged in with `gh auth login`) are installed.
- [ ] The owner knows their Meteor mainnet account id exactly as Meteor shows it (a `.near` name or 64 hex characters). It is the approver and the payee of mandate 1 (section 0.2).

### 0.1 Protocol version

A testnet pass does not prove mainnet behaviour for anything that changed between the two networks. `contracts/deployments/testnet.json` records both networks at protocol 88 on 2026-11-11: mainnet moved from 86 to 88, the version every testnet run of this wasm used (testnet was already at 88 on 2026-11-01).

```bash
node.exe scripts/testnet/chain.mjs protocol-version mainnet
```

Expected: `88`. If it prints another number, stop and tell Claude: the testnet run has to be repeated first (`docs/runbooks/testnet.md`, top).

### 0.2 Shell variables

The owner of this vault is `probarion.near` itself, so near-cli can sign every owner call (Meteor cannot). The approver and the payee of mandate 1 are the owner's own Meteor account. The contract allows that: `new` checks only the number of approvers and the bounds, and `create_mandate` refuses only the vault itself as a NEAR payee. Owner and approver stay different accounts. Mandate 1's `approval_above` equals its `max_per_payment` (step 8), so no spend under it can be held and the approver never acts in this run. A vault that holds more should give the approver role to an account that is not a payee.

```bash
export ROOT=probarion.near
export VAULT=v0.probarion.near
export OWNER_ID=probarion.near
export METEOR_ID="${METEOR_ID:?your Meteor mainnet account, exactly as Meteor shows it}"
export APPROVER_ID="$METEOR_ID"
export PAYEE_ID="$METEOR_ID"
export USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
export BASE_ASSET=base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near
export SOL_ASSET=sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near
export RPC=https://rpc.mainnet.fastnear.com
```

`RPC` is read by `scripts/testnet/chain.mjs`, which does all the JSON reading in this runbook.

### 0.3 The vault wasm comes from CI, and only from CI

Mainnet never uses a local build and never sets `ALLOW_NON_REPRODUCIBLE`. This runbook has no such switch. The wasm is the artifact `probarion-vault-wasm` of the CI push run that built the commit recorded in `contracts/code-hashes.json` (R6, R9), and it must pass `check` against that record.

**Precondition: this checkout is `origin/dev`.** `recorded-commit` answers for the local `HEAD`, so on a stale checkout the guard below would approve a stale vault. Fetch, bring the `dev` branch to `origin/dev` (a fast-forward only, on a checkout with no changed tracked file; untracked files do not matter), then compare; the block prints `OK: HEAD is origin/dev` or `STOP`:

```bash
git fetch origin   # check needs the recorded build commit in this clone
if [ -z "$(git status --porcelain --untracked-files=no)" ]; then git switch dev && git merge --ff-only origin/dev; else echo "STOP: a tracked file is changed; commit or stash it first"; fi
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/dev)" ]; then
  echo "OK: HEAD is origin/dev"
else
  echo "STOP: HEAD is not origin/dev; update this checkout to the tip of dev, then start section 0.3 again"
fi
```

On `STOP`, stop and tell Claude: deploy nothing. Otherwise find the recorded commit and the CI run that built it. `recorded-commit` prints the commit for the current source; if it prints nothing, the source is not recorded, so stop. The run list is filtered by that commit (a list of the latest runs on `dev` is too short: the recorded run is older than the last 30).

```bash
RECORDED="$(node.exe scripts/code-hash.mjs recorded-commit probarion-vault vault)"
echo "$RECORDED"
gh run list --repo probarion/probarion --workflow ci --commit "$RECORDED" --json databaseId,headSha,event,conclusion
```

In the list, take the entry whose `event` is `push` and whose `conclusion` is `success`. Its `databaseId` is the run id. (On 2026-11-11 the recorded commit was `64ac3c0`, built by run 41602304226 with code_hash `3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1`, and its artifact is kept until 2027-02-01. That commit is the ledger-key fix, which supersedes `ba65435` (`54Ne1r…`), whose `set_ledger_key` could leave a vault unable to anchor. Do not copy these: derive them as above, because the record moves whenever the vault source changes.) If no run matches, or the artifact has expired, stop.

```bash
export RUN_ID="${RUN_ID:?the databaseId of the push run whose headSha equals $RECORDED}"
rm -rf contracts/target/ci-artifact-mainnet   # start from an empty folder, so it holds only this artifact
gh run download "$RUN_ID" --repo probarion/probarion -n probarion-vault-wasm -D contracts/target/ci-artifact-mainnet
export WASM=contracts/target/ci-artifact-mainnet/probarion_vault.wasm
ls -l "$WASM"
node.exe scripts/code-hash.mjs hash "$WASM"
```

`check` alone is not enough: it accepts the wasm of ANY recorded build, including an older commit's. The guard below ties the file to `$RECORDED`. It captures everything `check` prints (messages and errors), shows it, then prints `OK` only if that text names exactly the recorded commit:

```bash
CHECK_OUT="$(REQUIRE_RECORDED=1 node.exe scripts/code-hash.mjs check probarion-vault vault contracts/target/ci-artifact-mainnet/probarion_vault.wasm 2>&1)"
echo "$CHECK_OUT"
if [ "${#RECORDED}" = 40 ] && printf '%s\n' "$CHECK_OUT" | grep -qF "matches the recorded build (commit $RECORDED)"; then
  echo "OK: artifact is the recorded build"
else
  echo "STOP: wrong artifact, do not deploy"
fi
```

Expected: a `check` line of the form `probarion-vault: code_hash <hash> matches the recorded build (commit <sha>)` with `<sha>` equal to `$RECORDED`, then `OK: artifact is the recorded build`. The file is 248,969 bytes on 2026-11-11, and the hash printed above is the code hash that step 2 compares with the chain.

**On `STOP`, stop and tell Claude: deploy nothing.** The same goes if `check` fails (`not recorded`, `code_hash mismatch`, or `recorded at … but this wasm was built at …`) or if `check` names another commit (an older artifact). Recording a hash is a controller step done before this runbook (AGENTS.md, "Reproducible builds and code hashes").

### 0.4 A near-cli signer: the funder, then `probarion.near`

On 2026-11-11 `probarion.near` did not exist on mainnet, and only `probarion.near` can create `v0.probarion.near` (step 1). Meteor cannot sign near-cli transactions, so a near-cli "funder" comes first: an implicit account whose key file near-cli writes into `.keys/` (no transaction). Meteor funds it with a plain transfer, and the funder then creates `probarion.near`, whose new key goes to the keychain.

```bash
mkdir -p .keys
if git check-ignore -q .keys/mainnet-funder/x.json; then echo "OK: .keys/ is git-ignored"; else echo "STOP: .keys/ is not git-ignored"; fi
near account create-account fund-later use-auto-generation save-to-folder ./.keys/mainnet-funder
export FUNDER_FILE="$(ls ./.keys/mainnet-funder/*.json)"
export FUNDER_ID="$(basename "$FUNDER_FILE" .json)"
echo "$FUNDER_ID"
```

The folder must be new, so that `ls` finds exactly one file. `FUNDER_ID` is 64 hex characters: the implicit account id, which is public. The key file is like the agent key file of step 7: never commit it and never paste it anywhere.

**OWNER SIGNS** in Meteor (there is no near-cli command): send 3.95 NEAR to `$FUNDER_ID`, copied from the terminal. Check (repeat until it shows the NEAR):

```bash
node.exe scripts/testnet/chain.mjs balance "$FUNDER_ID"
```

**OWNER SIGNS** (registers `probarion.near` through the `near` registrar and moves 3.85 NEAR into it; the name is permanent)
```bash
near account create-account fund-myself "$ROOT" '3.85 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
  sign-as "$FUNDER_ID" network-config mainnet sign-with-access-key-file "$FUNDER_FILE" send
```

Check on mainnet (`chain.mjs` reads testnet unless `RPC` is set; section 0.2 exported it, and this line sets it again so it also works on its own):

```bash
RPC=https://rpc.mainnet.fastnear.com node.exe scripts/testnet/chain.mjs exists probarion.near   # must print yes
near account list-keys "$ROOT" network-config mainnet now
```

Expected: `yes`, and exactly one full-access key, the one near-cli just saved to the keychain. About 0.1 NEAR stays in the funder; it is not needed again.

## 1. Create `v0.probarion.near`

Read-only checks first: the vault name must be free, `probarion.near` and the owner, approver and payee accounts from section 0.2 must exist, and `probarion.near` must cover the 3 NEAR, one 0.5 NEAR top-up (step 9) and gas.

```bash
node.exe scripts/testnet/chain.mjs exists "$VAULT"   # prints no (exit code 1) for a free name
for account in "$ROOT" "$OWNER_ID" "$APPROVER_ID" "$PAYEE_ID"; do node.exe scripts/testnet/chain.mjs exists "$account"; done   # four lines of yes
node.exe scripts/testnet/chain.mjs enough "$ROOT" 3 0.5   # exit code 0
```

**OWNER SIGNS** (moves 3 NEAR from `probarion.near` to the new account)
```bash
near account create-account fund-myself "$VAULT" '3 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
  sign-as "$ROOT" network-config mainnet sign-with-keychain send
```

`--signature-scheme ed25519` is spelled out because near-cli-rs otherwise asks for the scheme in a terminal.

Expected: a line saying the new account was created, then `Transaction ID: …`. Record at `vault_v0.create_tx`.

## 2. Deploy and initialise with the mainnet constants

**Confirm the owner and the approver before the deploy.** They are permanent after the lock: the vault has no method to change them. Guard 1 below can only compare the chain with `$OWNER_ID` and `$APPROVER_ID`, so it cannot tell whether those variables name the right accounts. Print them:

```bash
echo "owner: $OWNER_ID  approver: $APPROVER_ID"
```

The owner confirms, account by account and character by character: `$OWNER_ID` is `probarion.near`, the account whose key the keychain holds (it signed step 1, and `near account list-keys "$OWNER_ID" network-config mainnet now` shows that one full-access key); and `$APPROVER_ID` is their own Meteor account, compared with the account screen of the Meteor app itself (not a note, a message or the clipboard history). **If either differs, do not deploy: stop and tell Claude.** This is the same pattern as the Base payee check in step 8.

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
  | node.exe -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const r=JSON.parse(s).result;if(!r||!r.result){console.log("STOP: no get_config result: "+s.slice(0,200));return}const c=JSON.parse(Buffer.from(r.result).toString());const e=process.env;const want={owner:e.OWNER_ID,approvers:[e.APPROVER_ID],usdc:e.USDC,intents:"intents.near",allowed_assets:[e.BASE_ASSET,e.SOL_ASSET],daily_backstop:"500000000",held_ttl_ns:"259200000000000",frozen:false,factory:null,version:"0.1.0",ledger_key:null};const bad=Object.keys(want).filter((k)=>JSON.stringify(c[k])!==JSON.stringify(want[k]));console.log(bad.length?"STOP: get_config differs in "+bad.join(", ")+": "+JSON.stringify(c):"OK: get_config is exactly what was meant")})'
```

Straight after the deploy, the only reply that means "try again" is `STOP: no get_config result`: wait a few seconds and run guard 1 again. Any other `STOP` is a real one.

Guard 2: the code on the chain is the CI wasm. Both hashes must be readable (non-empty) and equal; two empty values, from an RPC error and an unset `$WASM` together, are not a match:

```bash
DEPLOYED="$(node.exe scripts/testnet/chain.mjs code-hash "$VAULT")"
BUILT="$(node.exe scripts/code-hash.mjs hash "$WASM")"
echo "deployed: $DEPLOYED"
echo "ci wasm:  $BUILT"
if [ -n "$DEPLOYED" ] && [ -n "$BUILT" ] && [ "$DEPLOYED" = "$BUILT" ]; then
  echo "OK: the deployed code is the CI wasm"
else
  echo "STOP: the deployed code differs from the CI wasm, or one of the two hashes could not be read"
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

**Run this step only if every check of step 2 passed: the owner and approver were confirmed against the wallet apps (the keychain key for `probarion.near`, Meteor for the approver), both guards printed `OK`, and the config equalities hold.** Otherwise stop and tell Claude. Until the key is deleted, the account still has its full-access key and can still be fixed; after the lock nothing can. The vault has no method to change its `owner` or `approvers`, so a wrong value there is permanent after the lock.

Find the key (read-only) and let the guard check it:

```bash
FULL_ACCESS_KEY="$(node.exe scripts/testnet/chain.mjs full-access-keys "$VAULT")"
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
node.exe scripts/testnet/chain.mjs key-count "$VAULT"
```

Expected: `0` (no access keys). If it still prints `1`, wait a few seconds and run it again. Record the delete tx at `vault_v0.lock_tx`, and in the evidence file:

```bash
pnpm proof add-tx --id v0_lock --hash "$H" --signer "$VAULT" --receiver "$VAULT" \
  --kind lock --signed-by deployer --what "Vault v0 locked: its only full-access key deleted"
pnpm proof set accounts.v0_vault "$VAULT" --source "docs/runbooks/mainnet-v0.md step 3"
pnpm proof set code_hashes.vault_v0 "$(node.exe scripts/code-hash.mjs hash "$WASM")" --source "scripts/build-reproducible.sh vault; RPC view_account code_hash of v0.probarion.near"
```

## 4. Register the vault's storage on USDC

**OWNER SIGNS** (`probarion.near` attaches 0.01 NEAR; `registration_only` keeps the 0.00125 NEAR the registration costs and refunds the rest)
```bash
near contract call-function as-transaction "$USDC" storage_deposit \
  json-args "{\"account_id\":\"$VAULT\",\"registration_only\":true}" \
  prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

Check: `near contract call-function as-read-only "$USDC" storage_balance_of json-args "{\"account_id\":\"$VAULT\"}" network-config mainnet now` is not `null`. Record at `funding.usdc_storage_tx`.

## 5. Fund 3 native USDC from Meteor

The USDC is in the owner's Meteor wallet, and Meteor cannot sign near-cli transactions, so this step has no near-cli command.

**OWNER SIGNS** in Meteor (moves 3 USDC): send 3 USDC to `v0.probarion.near`. Check before sending that the token is native USDC, contract `$USDC` (`17208628...36133a1`), not a bridged USDC. Meteor should sign an `ft_transfer` on the USDC contract (the vault is already registered in step 4, so no storage deposit is needed). In the run of 2026-11-11 it did: the transaction at `funding.usdc_float_tx` is one `ft_transfer` of `3000000` to the vault, signed by the Meteor account. The check below reads the vault's balance, not the method, so confirm the method from the real hash on any later run.

Check: `near contract call-function as-read-only "$USDC" ft_balance_of json-args "{\"account_id\":\"$VAULT\"}" network-config mainnet now` prints `"3000000"`. Record the hash from Meteor's activity screen (or from https://nearblocks.io/address/v0.probarion.near) at `funding.usdc_float_tx`, and in the evidence file, since the README cites it:

```bash
pnpm proof add-tx --id v0_usdc_float --hash "$H" --signer "$METEOR_ID" --receiver "$USDC" \
  --kind other --signed-by approver --amount 3.00 --what "The owner's Meteor wallet, the vault's approver, sent 3 native USDC to the vault (ft_transfer)"
```

In the 2026-11 run Claude ran this line after the run, on 2026-11-11.

## 6. Top up Base POA USDC inside the vault's `intents.near` account

**Not in the 2026-11 demo run.** S1 on 2026-11-13 topped the vault up with a 1Click swap instead of either option below, and recorded the method `"oneclick_swap"`. Skip to step 7. The rest of this step is for a later run.

Use the path spike S0/S1 proved, and do only one of the two options. Record the method (`"mt_transfer"` or `"poa_deposit"`) at `funding.intents_topup.method` (S1 recorded `"oneclick_swap"` there). Testnet cannot exercise this step (the stub has no `mt_transfer` and there is no POA bridge there), so the `mt_balance_of` check below is the proof: if it shows less than you sent, stop.

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
export AGENT_PK="$(node.exe scripts/testnet/chain.mjs public-key "$AGENT_KEY_FILE")"
echo "$AGENT_PK"
```

The key file holds `public_key`, `private_key` and a seed phrase. `.keys/` is git-ignored. Never commit the file and never paste it anywhere, chat included. Only the public key is ever printed.

**OWNER SIGNS** (owner call; the key may only call `spend` on the vault, and its 0.25 NEAR allowance caps the gas it can spend from the vault's own balance. Each spend must have about 0.02 NEAR of allowance left when it is sent (its 200 Tgas), but the allowance only goes down by the gas the call really burns: measured on testnet `v0.probarion.testnet`, a paid spend took 0.000718 NEAR and a refused one 0.000165 NEAR, exactly the vault's balance change. So 0.25 NEAR is a total cap of 0.25 NEAR of gas, hundreds of calls, not a dozen, and a leaked key can burn at most about half of the vault's free NEAR)
```bash
near contract call-function as-transaction "$VAULT" add_agent \
  json-args "{\"public_key\":\"$AGENT_PK\",\"allowance\":\"250000000000000000000000\",\"label\":\"v0 agent\"}" \
  prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

Check:

```bash
node.exe scripts/testnet/chain.mjs key-count "$VAULT"
near contract call-function as-read-only "$VAULT" list_agents json-args '{}' network-config mainnet now
near account list-keys "$VAULT" network-config mainnet now
```

Expected: `1`; `list_agents` shows `$AGENT_PK` with the label `v0 agent`; `list-keys` shows exactly one function-call key, with receiver `v0.probarion.near` and method `spend`. Record at `setup.add_agent_tx`, and in the evidence file:

```bash
pnpm proof add-tx --id v0_agent_added --hash "$H" --signer "$OWNER_ID" --receiver "$VAULT" \
  --kind agent_added --signed-by owner --what "Owner added the spend-only agent key (FC key on the vault, method spend)"
```

## 8. Mandates

Mandate 1's purpose document is `docs/evidence/mainnet-v0/po-PO-M001.txt`, and its `purpose_hash` is the sha256 of the file's bytes, which is what the console computes for an uploaded file. Expected: `3bc57742e1153e0cf14254077ee4fe96569836fa0f49dbdc8bb74ba7cea7c4db`.

```bash
export PURPOSE="$(sha256sum docs/evidence/mainnet-v0/po-PO-M001.txt | cut -d' ' -f1)"
echo "$PURPOSE"
export EXPIRES=1801353600000000000   # 2027-01-31T00:00:00Z; check with: date -u -d @1801353600
```

**The payees decide where the money goes, and a variable proves nothing about an address.** A wrong payee cannot be changed: the only fix is to revoke the mandate. So the owner checks each payee against what the contract stored. The NEAR payee (mandate 1) gets the on-chain check plus the owner's confirmation that they control that account. The Base payee (mandate 2) gets one more check: the address is compared with the wallet app twice, first the value about to be sent (before the mandate is created), then the value the contract stored (on the chain afterwards).

Mandate 1 caps the run: at most 1 USDC per payment, 2 USDC in total, 2 payments, until 2027-01-31. `approval_above` is 1 USDC: the contract holds a spend only when its amount is above `approval_above`, so a 1 USDC spend is paid at once, and no spend under this mandate can be held.

**OWNER SIGNS** (mandate 1, NEAR payee; the 0.05 NEAR covers storage and the payee's USDC registration, and the excess is refunded)
```bash
near contract call-function as-transaction "$VAULT" create_mandate \
  json-args "{\"input\":{\"payee\":{\"type\":\"near\",\"account_id\":\"$PAYEE_ID\"},\"purpose_hash\":\"$PURPOSE\",\"max_per_payment\":\"1000000\",\"max_total\":\"2000000\",\"max_uses\":2,\"expires_at_ns\":\"$EXPIRES\",\"approval_above\":\"1000000\",\"agent_pk\":\"$AGENT_PK\",\"label\":\"v0 near payee\"}}" \
  prepaid-gas '100 Tgas' attached-deposit '0.05 NEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

Expected result: `1`. Record at `setup.near_mandate_tx`, and in the evidence file:

```bash
pnpm proof add-tx --id v0_mandate_near --hash "$H" --signer "$OWNER_ID" --receiver "$VAULT" \
  --kind mandate_created --signed-by owner --what "Mandate 1: NEAR payee, at most 1 USDC per payment, 2 USDC total"
```

Check mandate 1 on the chain:

```bash
near contract call-function as-read-only "$VAULT" get_mandate json-args '{"mandate_id":1}' network-config mainnet now
```

Expected: the payee `account_id` is `$PAYEE_ID`, `"status": "active"`, `"purpose_hash"` is `$PURPOSE`, `"approval_above": "1000000"`, and `"agent_pk"` is `$AGENT_PK`. The owner confirms that they control that account: it is the account Meteor shows. **If the payee is not an account the owner controls, do not run step 9.** Send the `revoke_mandate` command from "If anything looks wrong" with `{"mandate_id":1}`, then stop and tell Claude: the evidence files name mandate 1.

**Mandate 2 is not in the 2026-11 demo run.** S1 on 2026-11-13 created mandate 2 with its own terms (1.00 USDC once, to the owner's own Base address, purpose `PO-M002`); the command below has not run, and in a later run it creates the next free mandate id, not `2`. Skip to step 9. The rest of this step is for a later run. Its purpose document is the original `docs/evidence/v0-po.txt`, which covers the Base payee:

```bash
export PURPOSE_V0="$(sha256sum docs/evidence/v0-po.txt | cut -d' ' -f1)"
export BASE_PAYEE_ADDRESS="${BASE_PAYEE_ADDRESS:?the owner's Base wallet, 0x plus 40 hex digits}"
```

Before mandate 2, print the Base address and compare it, character by character, with the Receive screen of your own Base wallet app (the app itself, not a message, a file or the clipboard history):

```bash
echo "$BASE_PAYEE_ADDRESS"
```

One wrong character sends the 2 USDC to an address nobody controls, and it cannot be recovered. Stop if even one character differs.

**OWNER SIGNS** (mandate 2, Base payee)
```bash
near contract call-function as-transaction "$VAULT" create_mandate \
  json-args "{\"input\":{\"payee\":{\"type\":\"intents\",\"chain\":\"base\",\"address\":\"$BASE_PAYEE_ADDRESS\",\"asset\":\"$BASE_ASSET\"},\"purpose_hash\":\"$PURPOSE_V0\",\"max_per_payment\":\"5000000\",\"max_total\":\"20000000\",\"max_uses\":5,\"expires_at_ns\":\"$EXPIRES\",\"approval_above\":\"5000000\",\"agent_pk\":\"$AGENT_PK\",\"label\":\"v0 base payee\"}}" \
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

## 9. First NEAR payment (1 USDC)

First check that the vault has NEAR left for gas and storage (read-only; each paid spend keeps about 0.0048 NEAR of storage). Free NEAR is the vault's balance minus its storage stake (`storage_usage` bytes at 0.00001 NEAR per byte):

```bash
curl -s "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$VAULT\"}}" \
  | node.exe -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const a=JSON.parse(s).result;const free=BigInt(a.amount)-BigInt(a.storage_usage)*10n**19n;console.log("storage_usage",a.storage_usage,"bytes; free NEAR:",Number(free)/1e24)})'
```

Expected: about 0.48 NEAR free, which is the vault's runway of about 100 payments (section 0, Budget). **Top-up rule:** if free NEAR is below 0.2, top the vault up with one plain transfer before you sign any spend. The vault pays each spend's gas from this balance and keeps about 0.0048 NEAR of storage for every paid spend, and with no free NEAR left a spend fails with `LackBalanceForState`, not with a `PROBARION:` code. Check it again after step 11, and again before the vault takes any payment beyond these.

**OWNER SIGNS** (only if free NEAR is below 0.2; moves 0.5 NEAR from `probarion.near` to the vault)
```bash
near tokens "$ROOT" send-near "$VAULT" '0.5 NEAR' network-config mainnet sign-with-keychain send
```

Read the payee's USDC balance now, so that the payment can be checked against it:

```bash
near contract call-function as-read-only "$USDC" ft_balance_of json-args "{\"account_id\":\"$PAYEE_ID\"}" network-config mainnet now
```

Write the number down. Then check the spend (free view). The invoice is `docs/evidence/mainnet-v0/invoice-INV-M001.txt` and the owner's decision is `docs/evidence/v0-decision-m001.json`:

```bash
export INVOICE1="$(sha256sum docs/evidence/mainnet-v0/invoice-INV-M001.txt | cut -d' ' -f1)"
export DECISION1="$(sha256sum docs/evidence/v0-decision-m001.json | cut -d' ' -f1)"
near contract call-function as-read-only "$VAULT" check_spend \
  json-args "{\"request\":{\"mandate_id\":1,\"amount\":\"1000000\",\"invoice_hash\":\"$INVOICE1\",\"ref\":\"INV-M001\",\"decision_hash\":\"$DECISION1\"},\"signer_pk\":\"$AGENT_PK\"}" \
  network-config mainnet now
```

Expected: `{"ok": true, "code": null, "would_hold": false}`. **If `ok` is not `true`, or `would_hold` is `true`, do not sign the spend: stop and tell Claude with the output.**

**OWNER SIGNS** (moves 1 USDC; signed on the owner's machine with the agent key file)
```bash
near contract call-function as-transaction "$VAULT" spend \
  json-args "{\"request\":{\"mandate_id\":1,\"amount\":\"1000000\",\"invoice_hash\":\"$INVOICE1\",\"ref\":\"INV-M001\",\"decision_hash\":\"$DECISION1\"}}" \
  prepaid-gas '200 Tgas' attached-deposit '0 NEAR' sign-as "$VAULT" network-config mainnet sign-with-access-key-file "$AGENT_KEY_FILE" send
```

Expected:
- `EVENT_JSON` logs for `spend_submitted` and, from the callback receipt, `spend_paid`;
- the result `{"spend_id":1,"status":"paid"}`;
- a `Transaction ID: …`.

If near-cli-rs prints only some receipts' logs, open `https://nearblocks.io/txns/<hash>` and confirm `spend_paid` there. Read `ft_balance_of` for `$PAYEE_ID` again (the command above): it must be exactly 1000000 higher than the number you wrote down. Record at `proof.first_near_payment_tx`, and in the evidence file. The signer is the vault, because the agent FC key signs as the vault account:

```bash
pnpm proof add-tx --id first_near_payment --hash "$H" --signer "$VAULT" --receiver "$VAULT" \
  --kind near_payment --signed-by agent_key --spend-id 1 --amount 1.00 --what "First NEAR USDC payment under mandate 1"
```

## 10. First Base payout (2 USDC)

**Not in the 2026-11 demo run.** S1 on 2026-11-13 made the first Base payout, spend 2 (1.00 USDC), and S2 the second, spend 3 (0.25 USDC), with the SDK instead of the commands below, which have not run. Skip to step 11. The rest of this step is for a later run, after the Base mandate of step 8 exists; that run tops the vault's USDC up first, uses the mandate id and spend id it gets instead of `2`, and records its payout under a new id, since `first_base_payout` is S1's spend 2 and `attested_base_payout` is S2's spend 3.

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

Record the NEAR tx at `proof.first_base_payout_tx`. Within minutes, Base USDC arrives at `$BASE_PAYEE_ADDRESS`. Expect 2 USDC minus the POA withdrawal fee, which was 0.0024 USDC on 2026-10-20 (confirm the fee in spike S0) and again on 2026-11-13, when S1 and S2 paid it. Find the transfer on https://basescan.org and record its hash at `proof.first_base_payout_base_tx`. Then record both in the evidence file, with `BASE_H` set to the Base hash:

```bash
pnpm proof add-tx --id first_base_payout --hash "$H" --signer "$VAULT" --receiver "$VAULT" \
  --kind base_payout --signed-by agent_key --spend-id 2 --amount 2.00 --base-tx "$BASE_H" \
  --what "First Base payout: ft_withdraw with WITHDRAW_TO memo built from mandate 2"
```

If nothing arrives within 30 minutes, treat the spend as "burned, awaiting bridge": do not resend, and raise it in the hackathon Discord with both tx hashes. In that case record the NEAR transaction now without `--base-tx`; the Day 4 gate (step 12) allows `proof.first_base_payout_base_tx` to stay pending until then. When the Base transfer lands, add `pnpm proof set links.first_base_payout_base "https://basescan.org/tx/$BASE_H" --source "docs/runbooks/mainnet-v0.md step 10"`.

## 11. First `NoMandate` refusal

```bash
export INVOICE3="$(sha256sum docs/evidence/v0-invoice-refusal.txt | cut -d' ' -f1)"
export DECISION3="$(sha256sum docs/evidence/v0-decision-refusal.json | cut -d' ' -f1)"
near contract call-function as-read-only "$VAULT" check_spend \
  json-args "{\"request\":{\"mandate_id\":999,\"amount\":\"1000000\",\"invoice_hash\":\"$INVOICE3\",\"ref\":\"V0-INV-999\",\"decision_hash\":\"$DECISION3\"},\"signer_pk\":\"$AGENT_PK\"}" \
  network-config mainnet now
```

Expected: `{"ok": false, "code": "NoMandate", "would_hold": false}`. If the view says anything else, do not send the refusal: stop and tell Claude with the output.

**OWNER SIGNS** (moves no USDC and stores nothing; the gas is paid from the vault's own NEAR, within the agent key's allowance)
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
  | node.exe -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const failed=JSON.parse(s).account_txs.filter((t)=>t.is_success===false).sort((a,b)=>b.tx_block_height-a.tx_block_height);console.log(failed.length?failed[0].transaction_hash:"")})')"
echo "$REFUSAL_TX"
```

Confirm it with the RPC (read-only). The hash is the refusal only if the status shows `Smart contract panicked: PROBARION:NoMandate`: a failed `spend` with that error is how you recognise it, and any other failed transaction of the vault is not it.

```bash
curl -s "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tx\",\"params\":{\"tx_hash\":\"$REFUSAL_TX\",\"sender_account_id\":\"$VAULT\",\"wait_until\":\"NONE\"}}" \
  | node.exe -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify(r.result?.status ?? r.error))})'
```

Expected: `{"Failure":{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: PROBARION:NoMandate"}}}}}`. The regular RPC keeps a transaction for a few days only: for an older one, use `https://archival-rpc.mainnet.fastnear.com` instead of `$RPC`.

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

- Done for the 2026-11 run on 2026-11-11. Claude fills `contracts/deployments/mainnet.json`, checks `pnpm proof show` lists every id above (in the 2026-11 run: the ids of steps 2, 3, 5, 7, mandate 1 of step 8, 9 and 11; `v0_intents_topup`, `v0_mandate_base` and `first_base_payout` were not created then), adds the mainnet rows to `AGENTS.md`, and commits everything in one commit: `git add contracts/deployments/mainnet.json docs/mainnet-proof.json AGENTS.md`.
- The v0 spends carry pre-ledger decision hashes: the sha256 of `docs/evidence/v0-decision-*.json` (in the 2026-11 run, `v0-decision-m001.json` for spend 1). Plan 03's verifier lists them in `Snapshot.pre_ledger_decision_hashes`, and check (d) reports them as "pre-ledger (documented)".
- Day 4 gate: `proof.first_near_payment_tx`, `proof.first_base_payout_tx` and `proof.first_no_mandate_refusal_tx` in `contracts/deployments/mainnet.json` are non-null, and so is `proof.first_base_payout_base_tx`, with one exception: if step 10 ended as "burned, awaiting bridge", that one field (`first_base_payout_base_tx`) may be pending and is filled when the Base transfer lands. The Base payout's `ft_burn` memo equals `WITHDRAW_TO:` plus the mandate's address.
- Done for S1 on 2026-11-13. `contracts/deployments/mainnet.json` has `funding.intents_topup` (method `"oneclick_swap"` and its `near_tx`), `setup.base_mandate_tx`, `proof.first_base_payout_tx` and `proof.first_base_payout_base_tx`. `pnpm proof show` adds `v0_oneclick_storage`, `v0_intents_topup`, `v0_ledger_key`, `v0_mandate_base`, `v0_anchor_1` to `v0_anchor_3` and `first_base_payout`, and `links.first_base_payout_base`. The vault's signed ledger is committed as `docs/evidence/mainnet-v0/s1-2026-11-13/ledger-2026-11-13.jsonl`.
- Done for S2 on 2026-11-13. `contracts/deployments/mainnet.json` has `setup.s2_base_mandate_tx`, `proof.attested_base_payout_tx` and `proof.attested_base_payout_base_tx`. `docs/mainnet-proof.json` adds `v0_mandate_base_s2`, `attested_base_payout` and `v0_anchor_4`, and `links.attested_base_payout_base`. A script wrote them in the format of `pnpm proof add-tx` and `pnpm proof set`, not those commands, so their `recorded_at` and the file's `updated_at` are the one time of that write. The vault's signed ledger after S2, 6 entries, is committed as `docs/evidence/mainnet-v0/s2-2026-11-13/ledger-2026-11-13.jsonl`; S1's copy of 4 entries stays as it is.
- 2026-11 demo gate (2026-11-11): `proof.first_near_payment_tx` and `proof.first_no_mandate_refusal_tx` are non-null; `proof.first_base_payout_tx` and `proof.first_base_payout_base_tx` stayed `null` until S1 ran, and every page that mentioned the Base payout said it had not run on mainnet.
- S1 gate (2026-11-13): `proof.first_base_payout_tx` and `proof.first_base_payout_base_tx` are non-null, spend 2 is `burned` with an `ft_burn` memo of `WITHDRAW_TO:` plus mandate 2's address, and `verify --network mainnet` with `--ledger docs/evidence/mainnet-v0/s1-2026-11-13/ledger-2026-11-13.jsonl` passed checks a to h (i skipped) that morning; since S2 the chain's anchors cover 6 entries, so a live run needs S2's ledger. Until S2, every page that told the Base payout said it ran once, a test to the owner's own Base address, decided by code rules alone; the S2 gate below replaced that rule.
- S2 gate (2026-11-13): `proof.attested_base_payout_tx` and `proof.attested_base_payout_base_tx` are non-null, spend 3 is `burned` with an `ft_burn` memo of `WITHDRAW_TO:` plus mandate 3's address, its decision (ledger entry 4) is `allow` by `model+rules` with attested evidence, and `verify --network mainnet` with `--ledger docs/evidence/mainnet-v0/s2-2026-11-13/ledger-2026-11-13.jsonl` and the invoice texts INV-M002 and INV-M003 passes checks a to h (i skips). Every page that tells the Base payouts says both were tests to the owner's own Base address, 1.00 USDC decided by code rules alone and 0.25 USDC decided by an attested model and the code rules: for the docs pages and the rules for agents, a test in `apps/web/test/docs-content.test.ts` holds each paragraph that tells them to that; the README, `JUDGES.md`, `SECURITY.md` and the site copy were read for it by hand on 2026-11-13.
- **OWNER:** publish the build-in-public post with the nearblocks links.

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

`withdraw` sends the USDC to the owner, `probarion.near`, so `probarion.near` must be registered on USDC first.

**OWNER SIGNS** (registers `probarion.near` on USDC; attaches 0.01 NEAR, and the excess over the 0.00125 NEAR registration is refunded)
```bash
near contract call-function as-transaction "$USDC" storage_deposit \
  json-args "{\"account_id\":\"$OWNER_ID\",\"registration_only\":true}" \
  prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

**OWNER SIGNS** (native USDC back to the owner; set the amount to the vault's `ft_balance_of`, step 5 check)
```bash
near contract call-function as-transaction "$VAULT" withdraw json-args '{"amount":"2000000"}' \
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

**OWNER SIGNS** (sends that USDC on from `probarion.near` to the Meteor wallet; set the same amount)
```bash
near contract call-function as-transaction "$USDC" ft_transfer \
  json-args "{\"receiver_id\":\"$METEOR_ID\",\"amount\":\"2000000\",\"memo\":\"probarion v0 withdraw\"}" \
  prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" network-config mainnet sign-with-keychain send
```

The owner must be registered on the POA token before Intents can pay them back on NEAR (only after a later run funded step 6).

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
