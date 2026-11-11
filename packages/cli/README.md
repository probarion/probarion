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

Three commands only read: `check` dry-runs a spend against the vault's own rules, `verify` checks a
vault's ledger against the chain (or a saved snapshot, with no network at all), and `ledger export`
copies the ledger. They do not sign or send anything either.

## Install

```sh
npm install -g probarion
probarion --help
```

Or run it without installing: `npx probarion --help`. Node 24 or newer. You also need `near-cli-rs`
(the `near` command) to sign what the CLI prints.

To build it from source instead, from a clone of the repository (pnpm 10):

```sh
git clone https://github.com/probarion/probarion.git
cd probarion
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/bin.js --help
```

In the repository folder, `node packages/cli/dist/bin.js` is the `probarion` command of the examples
below.

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

## Check a spend, verify a vault

```text
probarion check --vault <vault> --mandate 1 --amount 25 --invoice invoice.txt --ref INV-002
probarion verify --vault <vault>
probarion verify --vault <vault> --snapshot snapshot.json   # also saves the snapshot it verified
probarion verify --offline snapshot.json                    # checks a saved snapshot, with no network
probarion verify --vault <vault> --online                   # adds O1 and O2 to check e
probarion verify --vault <vault> --burn-tx 2=<tx hash>@<approver account>
probarion verify --vault <vault> --proof evidence.json
probarion ledger export --out ledger-copy.jsonl
```

To try `verify` with nothing set up, run it on the TEST FIXTURE snapshot in a clone of the repository
(after `pnpm install` and `pnpm build`). It needs no network and no keys, and exits 0:

```sh
node packages/cli/dist/bin.js verify --offline packages/core/test/fixtures/valid-snapshot.json
```

```text
Probarion verify: x.vaults.probarion.testnet (testnet)
entries 5, anchors 3, generated 2026-11-03T09:41:13.810Z
snapshot taken 2026-11-05T12:00:00.000Z: its chain data is the file's and was not read from the chain again

a  ledger-signatures      PASS      5 entries: each body_hash recomputes from its body and carries a valid signature by the ledger key ...
b  hash-links             PASS      5 entries: every body_hash and link recomputes, chained from the zero link
...
h  burn-memos             PASS      1 burned spend has a matched burn pair: the POA ft_burn memo is WITHDRAW_TO:<destination address> ...
i  factory-version        PASS      created by vaults.probarion.testnet at version 1

9 passed, 0 failed, 0 unproven
RESULT: PASS
```

(Rows c to g and the ends of the long details are cut here.)

### check

`check` asks the vault's free `check_spend` view whether it would accept a spend, and prints
`OK: the vault would accept this spend.` (with `and hold it for an approver` above the mandate's
approval threshold) or `REFUSED: PROBARION:<Code>`, for example `OverPerPayment` or
`DuplicateInvoice`. `--json` prints the request, the signer and the verdict.

- `--invoice` takes the extracted invoice text, the text the agent processes, as a UTF-8 file. Its
  `invoice_hash` is computed the way the SDK computes it. A file that is not UTF-8 text (a PDF, a
  scan) is a usage error (exit 64): extract its text first.
- The check runs as `--agent-pk`, else as the public key of `PROBARION_AGENT_KEY`, else as the
  mandate's agent. Only the public key is printed.
- `--ref` is 1 to 64 bytes. The vault refuses a ref or an invoice it has already seen.

| Exit code | `check` |
|---|---|
| 0 | the vault would accept the spend (it may hold it for an approver) |
| 1 | the vault would refuse it, or the check could not run (`error:` on stderr) |
| 64 | usage error: a missing, malformed or conflicting flag, or an `--invoice` that is not UTF-8 text |

### verify

`verify` runs the nine checks of the verifier on the vault's chain state and your ledger file:
ledger signatures (a), hash links (b), anchors (c), a decision for every spend (d), attestations (e),
the vault's keys and code (f), its intents keys (g), the burn of every cross-chain payout (h) and the
factory version (i). It prints one row per check with what it found, then the counts and the result.
`--json` prints the report instead.

| Exit code | `verify` |
|---|---|
| 0 | every check passes |
| 1 | a check fails (a fail always wins over unproven), or verify could not run (`error:` on stderr, no `RESULT` line) |
| 2 | no check fails, but at least one is unproven |
| 64 | usage error: a missing, malformed or conflicting flag |

**UNPROVEN** is not a pass. It means that verify could not look at what a check needs. Today only
check h can be unproven: a payout's burn is in a transaction that verify did not read. The row lists
the spends, the reason and what to do:

```text
h  burn-memos             UNPROVEN  0 of 1 burned spend has a proven burn pair; not proven, so the report is not ok: ...
   unproven: spend 2 (approver_tx): supply the burn tx with --burn-tx or --proof

8 passed, 0 failed, 1 unproven
RESULT: UNPROVEN (no check failed; what the UNPROVEN rows name is not proven)
```

| Reason | What happened | What to do |
|---|---|---|
| `approver_tx` | a held payout that an approver paid: its burn is in the approver's tx, which your ledger does not record | `--burn-tx` or `--proof` |
| `not_recorded` | a spend bound to its decision, with no payment entry naming its tx | `--burn-tx` or `--proof` |
| `pre_ledger_no_tx` | a mainnet v0 spend from before the ledger, with no tx supplied | `--burn-tx` or `--proof` |
| `tx_unavailable` | the tx could not be read right now: no node gave a definite answer (for example, the archival node was unreachable) | re-run, or add `--archival-rpc` |

The flags:

- `--burn-tx <spend_id>=<tx hash>[@<signer>]` names a transaction that holds a spend's burn, for
  example the approver's `approve` tx. It can be repeated. verify still reads each transaction and
  looks for the burn in it: when none of the transactions it reads holds the burn, check h fails.
  A malformed value exits 64.
- `--proof <file>` takes the vault's transactions from an evidence file in the format of
  `docs/mainnet-proof.json`. They are tried after the `--burn-tx` ones. Without `--proof`, verify
  reads no evidence file, not even a `docs/mainnet-proof.json` in the working directory. A `--proof`
  file that is not there is an error.
- `--archival-rpc <urls>` is the archival node used for burn transactions older than about 2.5 days.
  It defaults to `NEAR_ARCHIVAL_RPC_URLS`, else FastNEAR's archival node.
- `--online` also runs O1 and O2 on every attested decision and looks burns up in FastNEAR's
  transaction index. O1 checks that the TDX quote is DCAP-genuine and bound to this request; the
  measurement is not pinned yet, so O1 does not show which image the TEE runs. O2 checks that the GPU
  payload carries the request nonce and that NVIDIA NRAS verifies it. Check e's row says how many
  quotes and GPU payloads were checked.
  - What it needs: the network, and `@nearai/inference-sdk`. `probarion` lists that package as an
    optional dependency, so `pnpm install` in the clone installs it too, unless it cannot (an optional
    dependency that fails to install is left out). The package declares Node 24.22.1 or newer.
  - When the package cannot be loaded, verify prints `online: O1 and O2 did not run (<reason>)`, in the
    report and on stderr, and check e keeps its offline result.
  - When O1 or O2 ran, the report adds an `online legend` line that says what each one checks. When
    there was nothing to check (no attested decision, or no GPU payload), it says that O1 and O2, or O2,
    did not run.
  - When O2 fails because NVIDIA's token is `not_yet_valid` by this computer's clock (a few seconds behind
    is enough), check e fails and the report adds an `online hint` line: sync the clock and run again.
- `--snapshot <file>` writes the snapshot that was verified to a new file. It refuses a file that
  already exists, and the ledger file under any name (exit 64).
- `--offline <file>` verifies such a snapshot as it is, with no network, so it refuses `--vault`,
  `--ledger`, `--evidence`, `--burn-tx`, `--proof`, `--archival-rpc`, `--online`, `--rpc` and
  `--network`. It runs every check on what the file holds: it shows that the ledger and the chain data
  recorded in the snapshot agree with each other, as of the time the snapshot was taken (the report
  prints it). It does not read the chain, so it takes the file's chain data as it is. A snapshot
  whose `vault`, `network` or `taken_at` is malformed is refused (exit 64), and the human report
  shows control characters from a snapshot as `�` (U+FFFD) rather than passing them to the terminal.
- `--ledger <path>` is the ledger file. It defaults to `PROBARION_LEDGER_PATH`, else
  `.probarion/ledger.jsonl`; an empty `PROBARION_LEDGER_PATH` counts as unset. verify warns when the
  file is not there, and then fails the spends it cannot bind to a decision.
- `--evidence <dir>` (default `docs/evidence`) holds the Day-4 decision records of
  `v0.probarion.near`, whose first spends predate the ledger. It is read for that vault on mainnet
  only. Run verify from the repository, or pass the directory: without the records, check d fails
  those spends.

### ledger export

`ledger export --out <file>` writes the ledger as JSONL, one entry per line. It reads the same
`--ledger` file as verify. It refuses an `--out` file that already exists, and the ledger itself.
