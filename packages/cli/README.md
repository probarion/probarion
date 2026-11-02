# probarion (CLI)

The command line for [Probarion](https://github.com/probarion/probarion), a mandate layer for AI agents
on NEAR: spend by mandate, prove every payment.

**Unaudited beta.** Versions 0.x may change the commands in a minor release. MIT licensed.

The owner of a vault does the sensitive things: create the vault, set a mandate, add or remove an
agent key, freeze, withdraw, approve a held payment. This CLI does not sign any of them. For each one
it checks your input against the contract's own rules, writes the arguments to a JSON file and prints
the matching [`near-cli-rs`](https://github.com/near/near-cli-rs) command, so that you review the
arguments and sign with your own wallet, keychain or Ledger. Where the vault requires exactly 1
yoctoNEAR, the printed command carries it.

## Install

```sh
npm install --global probarion
probarion --help
```

Node 24 or newer. You also need `near-cli-rs` (the `near` command) to sign what the CLI prints.

## Commands

```text
probarion agent keygen --out agent-key.json        # saved with owner-only access, not overwritten if it exists; prints the public key
probarion agent keygen --print-secret              # prints the secret key to this terminal instead

probarion vault create --name acme --approvers cfo.testnet --daily-backstop 500 --held-ttl-hours 72
probarion mandate create --vault acme.vaults.probarion.testnet --payee near:vendor.testnet \
  --max-per 100 --max-total 1000 --uses 10 --expires 2026-12-31 --approval-above 50 \
  --agent-pk ed25519:... --purpose po.pdf --label "Contractor"
probarion mandate revoke --vault <vault> --mandate 1
probarion agent add --vault <vault> --pk ed25519:... --allowance 1
probarion agent remove --vault <vault> --pk ed25519:...
probarion ledger set-key --vault <vault> --pk ed25519:...

probarion spend approve --vault <vault> --spend 3  # printed for an APPROVER to sign
probarion spend reject --vault <vault> --spend 3
probarion vault freeze --vault <vault>             # printed with no deposit
probarion vault unfreeze --vault <vault>
probarion vault withdraw --vault <vault> --amount 25
probarion vault withdraw-intents --vault <vault> --token base --amount 25
```

- `--vault` falls back to `PROBARION_VAULT_ID`. `--network mainnet|testnet` falls back to
  `NEAR_NETWORK`, then `testnet`. `--rpc` takes comma-separated URLs and falls back to `NEAR_RPC_URLS`.
- `--sign-as <account>` puts the signer into the printed command, and `--out-dir <dir>` chooses where
  the arguments file goes. The file is named after the method and the hash of its content, so a
  command you printed earlier keeps pointing at the arguments you reviewed.
- Amounts are in USDC with up to 6 decimals (`--max-per 100` is 100 USDC). Deposits and allowances are
  in NEAR. A mandate's payee is fixed once it exists: a new payee needs a new mandate.
- A mandate payee is `near:<account>`, `base:<0x address>` or `solana:<address>`. `--purpose` is a PO
  or contract file that is hashed with sha256, or a 64-character hex hash.
- The printed command ends with `sign-with-keychain send`. For a Ledger, replace that with
  `sign-with-ledger usb send`. Run it in bash, zsh or PowerShell, not `cmd.exe`.

### Keys

`agent keygen` needs one of two flags. `--out <file>` saves the key pair to a file with owner-only
access (on Windows the folder's permissions apply, and the CLI says so), does not overwrite an
existing file and prints the public key only. It warns when the file is inside a git repository, so
make sure the file is ignored and not tracked. `--print-secret` prints the secret
to the terminal, where it stays in your scrollback. Give the public key to the vault owner, who adds
it with `agent add` (for the agent's `spend` key) or `ledger set-key` (for the key that signs the
ledger and anchors it). Keep the secret on your server and out of the repository.

### In progress

The commands that read a vault, `check`, `verify` and `ledger export`, are not in this version yet.
For now, use `verify()` from [`@probarion/sdk`](https://www.npmjs.com/package/@probarion/sdk).
<!-- TODO(release): replace this section when the check, verify and ledger export commands land (plan 03 Task 16), add them to CHANGELOG.md, and restore the description in packages/cli/package.json (dry-run spends, verify a vault's ledger, anchors, attestations and keys) -->
