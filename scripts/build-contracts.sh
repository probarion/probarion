#!/usr/bin/env bash
# Builds every contract crate with cargo-near (non-reproducible; for tests and testnet).
# Output: contracts/target/near/<lib>/<lib>.wasm or contracts/target/near/<lib>.wasm
set -euo pipefail
cd "$(dirname "$0")/../contracts"

# cargo-near generates the embedded ABI by linking the crate as a native cdylib. The MSVC linker
# cannot resolve the NEAR host functions in that step (LNK2019), so on native Windows (Git Bash)
# the ABI is skipped. The wasm itself is identical in behaviour. Linux and CI keep the ABI.
# Override with NEAR_BUILD_NO_ABI=1 (skip) or NEAR_BUILD_NO_ABI=0 (force).
abi_flag=""
case "${NEAR_BUILD_NO_ABI:-auto}" in
  1) abi_flag="--no-abi" ;;
  0) ;;
  *)
    case "$(uname -s)" in
      MINGW* | MSYS* | CYGWIN*) abi_flag="--no-abi" ;;
    esac
    ;;
esac

for crate in test-ft intents-stub vault factory; do
  if [ -f "$crate/Cargo.toml" ]; then
    echo "== cargo near build $crate"
    # shellcheck disable=SC2086
    cargo near build non-reproducible-wasm --manifest-path "$crate/Cargo.toml" --locked $abi_flag
  fi
done
