#!/usr/bin/env bash
# Reproducible (Docker) build of one contract from the committed source.
# Usage: bash scripts/build-reproducible.sh <dir> <lib>      e.g. vault probarion_vault
# Output, in contracts/target/reproducible/<dir>/:
#   <lib>.wasm              the reproducible wasm
#   <lib>.build-info.json   crate, commit, source keys, code_hash and sha256 of that wasm
# Prints the NEAR code hash of the wasm.
#
# This runs in CI (job `reproducible`: ubuntu, Docker). The Windows dev machine has no Docker, and
# a local `--no-abi` build is never a source of code hashes (R6): record hashes only from the
# `probarion-vault-wasm` artifact of a CI push run (scripts/code-hash.mjs record).
#
# SRC_DIR: the checkout to build. Default: this repo. CI points it at a clone of the recorded commit,
# because the wasm embeds the commit it was built from (see scripts/code-hash.mjs).
#
# R9: any change to contracts/vault, contracts/Cargo.toml or contracts/Cargo.lock makes the recorded
# hash stale. Re-record it from the CI artifact of the push that changes them.
set -euo pipefail
dir="$1"
lib="$2"
here="$(cd "$(dirname "$0")" && pwd)"
cd "${SRC_DIR:-$here/..}"
if [ -n "$(git status --porcelain -- contracts)" ]; then
  echo "commit contracts/ first: the reproducible build uses the committed source" >&2
  exit 1
fi
out="contracts/target/reproducible/$dir"
# Drop any earlier output so a stale (e.g. non-reproducible) wasm can never be picked up.
rm -rf "$out"
rm -f "contracts/target/near/$lib/$lib.wasm" "contracts/target/near/$lib.wasm"
cargo near build reproducible-wasm --manifest-path "contracts/$dir/Cargo.toml"
mkdir -p "$out"
for p in "contracts/target/near/$lib/$lib.wasm" "contracts/target/near/$lib.wasm"; do
  if [ -f "$p" ]; then
    cp "$p" "$out/$lib.wasm"
    node "$here/code-hash.mjs" info "$dir" "$out/$lib.wasm" > "$out/$lib.build-info.json"
    node "$here/code-hash.mjs" hash "$out/$lib.wasm"
    exit 0
  fi
done
echo "reproducible build finished but $lib.wasm was not found under contracts/target/near" >&2
exit 1
