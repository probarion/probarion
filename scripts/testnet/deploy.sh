#!/usr/bin/env bash
# OWNER runs this from the repo root in Git Bash (Windows) or any Linux/macOS shell, after the
# build (see docs/runbooks/testnet.md). It creates and deploys the Probarion testnet contracts with
# near-cli-rs 0.30.1, locks the vault and funds it with test tokens. DRY_RUN=1 prints every command
# without running it (and runs no network check).
#
# Signing: every transaction is signed with sign-with-keychain. The keys of ROOT and of the accounts
# this script creates live in the OS keychain (Windows Credential Manager). The script never reads
# or writes key material.
#
# Environment:
#   OWNER_ID, APPROVER_ID   required: the vault owner and its approver (testnet accounts)
#   ROOT                    parent account of everything created here (default probarion.testnet)
#   VAULT_WASM              path to the vault wasm from the CI reproducible build (artifact
#                           probarion-vault-wasm). It must pass `code-hash.mjs check` (R6).
#   ALLOW_NON_REPRODUCIBLE  =1 lets this script deploy the LOCAL vault build when VAULT_WASM is unset
#                           (or an unrecorded VAULT_WASM), with a loud warning. Throwaway testnet only.
#   VAULT_NAME              vault sub-account name (default v0). A locked vault can never be deleted
#                           or redeployed, so a second attempt needs a new name (v1, ...)
#   TOKEN_NEAR, STUB_NEAR, VAULT_NEAR   initial balances in NEAR (see the defaults below)
#   RPC                     read-only RPC for the checks (default https://rpc.testnet.fastnear.com)
#
# test-ft and intents-stub are test-only contracts: they use the local build
# (bash scripts/build-contracts.sh). The vault does not, unless ALLOW_NON_REPRODUCIBLE=1.
set -euo pipefail

ROOT="${ROOT:-probarion.testnet}"
OWNER_ID="${OWNER_ID:?set OWNER_ID to the testnet owner account}"
APPROVER_ID="${APPROVER_ID:?set APPROVER_ID to the testnet approver account}"
export RPC="${RPC:-https://rpc.testnet.fastnear.com}"
VAULT_NAME="${VAULT_NAME:-v0}"
VAULT="$VAULT_NAME.$ROOT"
USDC="usdc.$ROOT"
BASE="base-usdc.$ROOT"
SOL="sol-usdc.$ROOT"
INTENTS="intents-stub.$ROOT"
NET=(network-config testnet)
DRY="${DRY_RUN:-0}"

# Initial balances (NEAR). Storage costs 1 NEAR per 100 KB of wasm, so test-ft (157 KB) needs 1.6,
# intents-stub (164 KB) 1.7 and the vault (the CI wasm is 248,501 bytes) 2.5; the rest is headroom for
# state and gas. These defaults add up to 10.3 NEAR (1.8 x3 + 1.9 + 3), and a faucet account holds 10:
# top ROOT up first (docs/runbooks/testnet.md, step 0.3). The preflight checks it.
TOKEN_NEAR="${TOKEN_NEAR:-1.8}"
STUB_NEAR="${STUB_NEAR:-1.9}"

show() {
  printf '+'
  local a
  for a in "$@"; do
    printf ' '
    quote "$a"
  done
  printf '\n'
}

# Prints an argument the way you would type it: bare when it is plain, else in single quotes.
quote() {
  local q="'\\''"
  case "$1" in
    '' | *[!A-Za-z0-9_@%+=:,./-]*) printf "'%s'" "${1//\'/$q}" ;;
    *) printf '%s' "$1" ;;
  esac
}

run() {
  show "$@"
  if [ "$DRY" != "1" ]; then "$@"; fi
}

fail() {
  echo "deploy.sh: $*" >&2
  exit 1
}

chain() { node scripts/testnet/chain.mjs "$@"; }

[ -f scripts/code-hash.mjs ] || fail "run this from the repo root (scripts/code-hash.mjs not found)"

# The wasm of a test-only contract: the local build.
local_wasm() {
  local p
  for p in "contracts/target/near/$1/$1.wasm" "contracts/target/near/$1.wasm"; do
    if [ -f "$p" ]; then
      echo "$p"
      return
    fi
  done
  if [ "$DRY" = "1" ]; then
    echo "contracts/target/near/$1/$1.wasm"
    return
  fi
  fail "missing $1.wasm: run bash scripts/build-contracts.sh first"
}

# R6: the vault wasm is the CI reproducible build. Resolve it before anything else, so that a
# refusal happens before the first transaction (also in a dry run).
if [ -n "${VAULT_WASM:-}" ]; then
  VAULT_WASM_PATH="$VAULT_WASM"
  VAULT_WASM_KIND="reproducible"
elif [ "${ALLOW_NON_REPRODUCIBLE:-0}" = "1" ]; then
  VAULT_WASM_PATH="$(local_wasm probarion_vault)"
  VAULT_WASM_KIND="local"
else
  cat >&2 <<'EOF'
deploy.sh: refusing to deploy the vault: VAULT_WASM is not set.

The vault wasm must be the CI reproducible build (artifact probarion-vault-wasm):
  gh run download <run-id> --repo probarion/probarion -n probarion-vault-wasm -D contracts/target/ci-artifact
  VAULT_WASM=contracts/target/ci-artifact/probarion_vault.wasm bash scripts/testnet/deploy.sh

For a throwaway testnet run only, ALLOW_NON_REPRODUCIBLE=1 deploys the local build instead
(bash scripts/build-contracts.sh first). Its code hash is not in contracts/code-hashes.json and
nobody can verify it. Production deployments never allow that fallback.
EOF
  exit 1
fi
TEST_FT_WASM="$(local_wasm test_ft)"
INTENTS_WASM="$(local_wasm intents_stub)"
# Storage costs 1 NEAR per 100 KB. The size of the file decides, rounded up with half a NEAR of headroom:
# the CI wasm (248,501 bytes) and the local build (about 245 KB) both get 3 NEAR. A dry run may run before
# the file is downloaded; it then assumes 250,000 bytes. (101,654 bytes is the size of the zipped artifact,
# not of the wasm.)
if [ -f "$VAULT_WASM_PATH" ]; then
  vault_bytes=$(($(wc -c <"$VAULT_WASM_PATH")))
else
  vault_bytes=250000
fi
VAULT_NEAR="${VAULT_NEAR:-$(((vault_bytes + 149999) / 100000))}"

# Verifies the vault wasm against contracts/code-hashes.json. It is read-only, so a dry run also does it
# when the file is there.
check_vault_wasm() {
  if [ "$VAULT_WASM_KIND" = "local" ]; then
    {
      echo "!!! WARNING: ALLOW_NON_REPRODUCIBLE=1. Deploying the LOCAL, NON-REPRODUCIBLE vault build"
      echo "!!!   $VAULT_WASM_PATH"
      echo "!!! Its code hash is not in contracts/code-hashes.json and cannot be verified by anyone."
      echo "!!! This is for a throwaway testnet run only. Production deployments never allow it."
    } >&2
    return
  fi
  if [ -f "$VAULT_WASM_PATH" ]; then
    if REQUIRE_RECORDED=1 node scripts/code-hash.mjs check probarion-vault vault "$VAULT_WASM_PATH"; then
      return
    fi
    if [ "${ALLOW_NON_REPRODUCIBLE:-0}" = "1" ]; then
      echo "!!! WARNING: ALLOW_NON_REPRODUCIBLE=1: deploying $VAULT_WASM_PATH although it does NOT match" >&2
      echo "!!! contracts/code-hashes.json. Throwaway testnet run only." >&2
      VAULT_WASM_KIND="unverified"
      return
    fi
    fail "$VAULT_WASM_PATH does not match the recorded reproducible build (see the message above)"
  fi
  if [ "$DRY" = "1" ]; then
    echo "(dry run) $VAULT_WASM_PATH not found yet. The real run first checks it:"
    echo "(dry run)   REQUIRE_RECORDED=1 node scripts/code-hash.mjs check probarion-vault vault $VAULT_WASM_PATH"
    return
  fi
  fail "VAULT_WASM $VAULT_WASM_PATH not found"
}

# Real runs only: nothing is sent unless these pass, so a failure leaves nothing half-created.
preflight() {
  local tool rc account
  for tool in near node curl; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool not found on PATH (in Git Bash: export PATH=\"\$HOME/.cargo/bin:\$PATH\")"
  done
  [ -f "$TEST_FT_WASM" ] || fail "missing $TEST_FT_WASM: run bash scripts/build-contracts.sh first"
  [ -f "$INTENTS_WASM" ] || fail "missing $INTENTS_WASM: run bash scripts/build-contracts.sh first"
  for account in "$USDC" "$BASE" "$SOL" "$INTENTS" "$VAULT"; do
    rc=0
    chain exists "$account" >/dev/null || rc=$?
    case "$rc" in
      1) ;;
      0) fail "$account already exists. create-account fails for an existing account; use another ROOT or VAULT_NAME" ;;
      *) fail "could not query $RPC for $account" ;;
    esac
  done
  for account in "$ROOT" "$OWNER_ID" "$APPROVER_ID"; do
    rc=0
    chain exists "$account" >/dev/null || rc=$?
    [ "$rc" = "0" ] || fail "$account does not exist on testnet"
  done
  chain enough "$ROOT" "$TOKEN_NEAR" "$TOKEN_NEAR" "$TOKEN_NEAR" "$STUB_NEAR" "$VAULT_NEAR" ||
    fail "$ROOT cannot fund the accounts. Top it up from the owner, for example: near tokens $OWNER_ID send-near $ROOT '3 NEAR' network-config testnet sign-with-keychain send (docs/runbooks/testnet.md, step 0.3)"
}

# create <account> <balance in NEAR>
create() {
  # --signature-scheme is explicit: without it near-cli-rs asks which scheme to use when stdin is a terminal.
  run near account create-account fund-myself "$1" "$2 NEAR" autogenerate-new-keypair \
    --signature-scheme ed25519 save-to-keychain sign-as "$ROOT" "${NET[@]}" sign-with-keychain send
}

# deploy_init <account> <wasm file> <init json args>
deploy_init() {
  run near contract deploy "$1" use-file "$2" with-init-call new json-args "$3" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' "${NET[@]}" sign-with-keychain send
}

# call <signer> <contract> <method> <json args> <deposit> <gas>
call() {
  run near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "$6" attached-deposit "$5" sign-as "$1" "${NET[@]}" sign-with-keychain send
}

echo "== 0. Checks before anything is sent"
check_vault_wasm
if [ "$DRY" = "1" ]; then
  echo "(dry run) the real run also checks: near, node and curl are installed; the five new accounts do not exist;"
  echo "(dry run) $ROOT, $OWNER_ID and $APPROVER_ID exist; $ROOT holds $TOKEN_NEAR x3 + $STUB_NEAR + $VAULT_NEAR NEAR plus gas."
else
  preflight
  echo "checks passed"
fi

echo "== 1. Test tokens: USDC and two POA-like tokens (test-ft)"
for spec in "$USDC|Probarion Test USDC" "$BASE|Probarion Test Base USDC (POA-like)" "$SOL|Probarion Test Solana USDC (POA-like)"; do
  id="${spec%%|*}"
  name="${spec#*|}"
  create "$id" "$TOKEN_NEAR"
  deploy_init "$id" "$TEST_FT_WASM" "{\"owner_id\":\"$ROOT\",\"name\":\"$name\",\"symbol\":\"USDC\",\"decimals\":6}"
done

echo "== 2. intents-stub (Intents has no testnet)"
create "$INTENTS" "$STUB_NEAR"
deploy_init "$INTENTS" "$INTENTS_WASM" '{}'

echo "== 3. Vault $VAULT ($VAULT_WASM_KIND wasm)"
create "$VAULT" "$VAULT_NEAR"
deploy_init "$VAULT" "$VAULT_WASM_PATH" \
  "{\"owner\":\"$OWNER_ID\",\"approvers\":[\"$APPROVER_ID\"],\"usdc\":\"$USDC\",\"intents\":\"$INTENTS\",\"allowed_assets\":[\"$BASE\",\"$SOL\"],\"daily_backstop\":\"500000000\",\"held_ttl_ns\":\"259200000000000\"}"

echo "== 4. Lock the vault: delete its only full-access key"
if [ "$DRY" = "1" ]; then
  FULL_ACCESS_KEYS="ed25519:DRY_RUN_FULL_ACCESS_KEY"
else
  FULL_ACCESS_KEYS=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    FULL_ACCESS_KEYS="$(chain full-access-keys "$VAULT")"
    if [ -n "$FULL_ACCESS_KEYS" ]; then break; fi
    sleep 2
  done
  [ -n "$FULL_ACCESS_KEYS" ] || fail "no full-access key found on $VAULT"
fi
run near account delete-keys "$VAULT" public-keys "$FULL_ACCESS_KEYS" "${NET[@]}" sign-with-keychain send

echo "== 5. Storage registrations and test funding"
call "$ROOT" "$USDC" storage_deposit "{\"account_id\":\"$OWNER_ID\",\"registration_only\":true}" '0.01 NEAR' '30 Tgas'
call "$ROOT" "$USDC" mint "{\"account_id\":\"$VAULT\",\"amount\":\"100000000\"}" '0 NEAR' '30 Tgas'
for token in "$BASE" "$SOL"; do
  # Registers the stub on the token, then ROOT gets 50 and moves it into the stub, credited to the vault.
  call "$ROOT" "$token" mint "{\"account_id\":\"$INTENTS\",\"amount\":\"0\"}" '0 NEAR' '30 Tgas'
  call "$ROOT" "$token" mint "{\"account_id\":\"$ROOT\",\"amount\":\"50000000\"}" '0 NEAR' '30 Tgas'
  call "$ROOT" "$token" ft_transfer_call "{\"receiver_id\":\"$INTENTS\",\"amount\":\"50000000\",\"msg\":\"$VAULT\"}" '1 yoctoNEAR' '100 Tgas'
done

echo "== 6. Checks"
if [ "$DRY" != "1" ]; then
  keys=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    keys="$(chain key-count "$VAULT")"
    if [ "$keys" = "0" ]; then break; fi
    sleep 2
  done
  [ "$keys" = "0" ] || fail "$VAULT still has $keys access keys"
  echo "vault has no access keys"
  deployed_hash="$(chain code-hash "$VAULT")"
  wasm_hash="$(node scripts/code-hash.mjs hash "$VAULT_WASM_PATH")"
  [ "$deployed_hash" = "$wasm_hash" ] || fail "$VAULT runs code_hash $deployed_hash but $VAULT_WASM_PATH hashes to $wasm_hash"
  echo "$VAULT code_hash $deployed_hash matches $VAULT_WASM_PATH"
else
  run node scripts/testnet/chain.mjs key-count "$VAULT"
  run node scripts/testnet/chain.mjs code-hash "$VAULT"
  run node scripts/code-hash.mjs hash "$VAULT_WASM_PATH"
fi
run near contract call-function as-read-only "$VAULT" get_config json-args '{}' "${NET[@]}" now
run near contract call-function as-read-only "$USDC" ft_balance_of json-args "{\"account_id\":\"$VAULT\"}" "${NET[@]}" now
for token in "$BASE" "$SOL"; do
  run near contract call-function as-read-only "$INTENTS" mt_balance_of json-args "{\"account_id\":\"$VAULT\",\"token_id\":\"nep141:$token\"}" "${NET[@]}" now
done
run near contract call-function as-read-only "$INTENTS" public_keys_of json-args "{\"account_id\":\"$VAULT\"}" "${NET[@]}" now

echo "== done. Next: record the code hash and run scripts/testnet/smoke.sh (docs/runbooks/testnet.md, steps 3 and 4)"
