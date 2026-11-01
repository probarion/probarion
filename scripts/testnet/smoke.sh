#!/usr/bin/env bash
# OWNER runs this from the repo root in Git Bash (Windows) or any Linux/macOS shell, after
# deploy.sh, on a fresh vault (mandate ids 1 and 2 are created here).
# It adds the agent key, creates a NEAR and a Base mandate, pays 1 USDC on each, and sends one
# spend that the contract must refuse with PROBARION:NoMandate. DRY_RUN=1 prints only.
#
# The owner's calls are signed with sign-with-keychain. The spends are signed by the agent key, a
# function-call key on the vault itself, from AGENT_KEY_FILE (a near-cli-rs key file, git-ignored).
# This script reads only its public_key. Nothing here prints or stores a private key.
#
# Environment: OWNER_ID, PAYEE_ID and AGENT_KEY_FILE are required. ROOT (probarion.testnet),
# VAULT_NAME (v0) and BASE_ADDRESS (an EVM address) are optional.
set -euo pipefail

ROOT="${ROOT:-probarion.testnet}"
OWNER_ID="${OWNER_ID:?set OWNER_ID to the testnet owner account}"
PAYEE_ID="${PAYEE_ID:?set PAYEE_ID to a testnet account that receives the NEAR payment}"
AGENT_KEY_FILE="${AGENT_KEY_FILE:?set AGENT_KEY_FILE to the agent key JSON (see docs/runbooks/testnet.md)}"
BASE_ADDRESS="${BASE_ADDRESS:-0x1111111111111111111111111111111111111111}"
VAULT_NAME="${VAULT_NAME:-v0}"
VAULT="$VAULT_NAME.$ROOT"
BASE="base-usdc.$ROOT"
INTENTS="intents-stub.$ROOT"
NET=(network-config testnet)
DRY="${DRY_RUN:-0}"

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
  echo "smoke.sh: $*" >&2
  exit 1
}

# capture <command...>: like run, but keeps the command's output in OUT (shown as well) and never
# stops the script, even when the command fails. The checks below read OUT.
OUT=""
capture() {
  show "$@"
  OUT=""
  if [ "$DRY" != "1" ]; then
    OUT="$("$@" 2>&1)" || true
    printf '%s\n' "$OUT"
  fi
}

PROBLEMS=0
# expect <what> <text>: OUT, without spaces and line breaks, must contain <text>.
expect() {
  if [ "$DRY" = "1" ]; then return 0; fi
  local flat
  flat="$(printf '%s' "$OUT" | tr -d ' \t\r\n')"
  case "$flat" in
    *"$2"*) echo "OK: $1" ;;
    *)
      echo "MISMATCH: $1: expected the output to contain $2" >&2
      PROBLEMS=$((PROBLEMS + 1))
      ;;
  esac
}

# The id of the transaction whose output is in OUT.
tx_id() { printf '%s' "$OUT" | grep -o 'Transaction ID: [A-Za-z0-9]*' | head -n 1 | cut -d' ' -f3 || true; }

sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1
}

if [ -f "$AGENT_KEY_FILE" ]; then
  AGENT_PK="$(node scripts/testnet/chain.mjs public-key "$AGENT_KEY_FILE")"
elif [ "$DRY" = "1" ]; then
  AGENT_PK="ed25519:DRY_RUN_AGENT_PUBLIC_KEY"
else
  fail "AGENT_KEY_FILE $AGENT_KEY_FILE not found (docs/runbooks/testnet.md, step 0.4)"
fi
EXPIRES="$(($(date -u +%s) + 30 * 86400))000000000"
PURPOSE="$(printf 'probarion testnet smoke purchase order' | sha256_hex)"
RUN_ID="$(date -u +%s)-$RANDOM"

# owner_call <method> <json args> <deposit> [gas]: the owner signs with the keychain. Plain calls
# need 30 Tgas; create_mandate may call usdc.storage_deposit, so it gets 100.
owner_call() {
  run near contract call-function as-transaction "$VAULT" "$1" json-args "$2" \
    prepaid-gas "${4:-100 Tgas}" attached-deposit "$3" sign-as "$OWNER_ID" "${NET[@]}" sign-with-keychain send
}

# spend <mandate id> <label>: signed by the agent key. A spend to an Intents payee cascades into
# ft_withdraw (100 Tgas) and a callback (15 Tgas), so the agent attaches 200 Tgas explicitly.
spend() {
  local invoice decision
  invoice="$(printf 'invoice %s %s' "$RUN_ID" "$2" | sha256_hex)"
  decision="$(printf 'decision %s %s' "$RUN_ID" "$2" | sha256_hex)"
  capture near contract call-function as-transaction "$VAULT" spend \
    json-args "{\"request\":{\"mandate_id\":$1,\"amount\":\"1000000\",\"invoice_hash\":\"$invoice\",\"ref\":\"SMOKE-$RUN_ID-$2\",\"decision_hash\":\"$decision\"}}" \
    prepaid-gas '200 Tgas' attached-deposit '0 NEAR' sign-as "$VAULT" "${NET[@]}" sign-with-access-key-file "$AGENT_KEY_FILE" send
}

mandate() {
  echo "{\"input\":{\"payee\":$1,\"purpose_hash\":\"$PURPOSE\",\"max_per_payment\":\"5000000\",\"max_total\":\"20000000\",\"max_uses\":5,\"expires_at_ns\":\"$EXPIRES\",\"approval_above\":\"5000000\",\"agent_pk\":\"$AGENT_PK\",\"label\":\"$2\"}}"
}

echo "== 1. Agent key (spend-only FC key, 1 NEAR allowance)"
owner_call add_agent "{\"public_key\":\"$AGENT_PK\",\"allowance\":\"1000000000000000000000000\",\"label\":\"testnet smoke agent\"}" '1 yoctoNEAR' '30 Tgas'

echo "== 2. Mandates: 1 = NEAR payee, 2 = Base payee"
owner_call create_mandate "$(mandate "{\"type\":\"near\",\"account_id\":\"$PAYEE_ID\"}" "smoke near")" '0.05 NEAR'
owner_call create_mandate "$(mandate "{\"type\":\"intents\",\"chain\":\"base\",\"address\":\"$BASE_ADDRESS\",\"asset\":\"$BASE\"}" "smoke base")" '0.05 NEAR'

echo "== 3. Payments (expect status paid, then burned)"
spend 1 near
expect "the NEAR payment is paid" '"status":"paid"'
NEAR_TX="$(tx_id)"
spend 2 base
expect "the Base payment is burned" '"status":"burned"'
BASE_TX="$(tx_id)"

echo "== 4. NoMandate refusal (expect PROBARION:NoMandate)"
spend 999 refusal
expect "the vault refuses mandate 999 with NoMandate" 'PROBARION:NoMandate'

echo "== 5. Views"
capture near contract call-function as-read-only "$VAULT" list_spends json-args '{"from_index":0,"limit":10}' "${NET[@]}" now
expect "list_spends shows a paid spend" '"status":"paid"'
expect "list_spends shows a burned spend" '"status":"burned"'
expect "list_spends shows the Base memo" "\"memo\":\"WITHDRAW_TO:$BASE_ADDRESS\""
capture near contract call-function as-read-only "$INTENTS" burns json-args '{"from_index":0,"limit":10}' "${NET[@]}" now
expect "the stub recorded the burn memo" "WITHDRAW_TO:$BASE_ADDRESS"
capture near contract call-function as-read-only "$INTENTS" public_keys_of json-args "{\"account_id\":\"$VAULT\"}" "${NET[@]}" now
expect "the vault registered no Intents key (I8)" '[]'

if [ "$DRY" = "1" ]; then
  echo "== dry run: nothing was sent or checked"
  exit 0
fi

echo "== Transaction ids for contracts/deployments/testnet.json (smoke.*)"
echo "near_payment_tx: ${NEAR_TX:-not found in the output above}"
echo "base_burn_tx:    ${BASE_TX:-not found in the output above}"
echo "no_mandate_tx:   a refused call prints no id: copy the failed spend from https://testnet.nearblocks.io/address/$VAULT"
if [ "$PROBLEMS" != "0" ]; then
  fail "$PROBLEMS check(s) did not match; read the output above"
fi
echo "smoke passed"
