# @probarion/mcp

An MCP server that gives an AI agent a Probarion vault to pay from. The agent can see its mandates, dry-run
a payment, pay under a mandate and read a payment's status. It can pay only the payee of a mandate the owner
signed for its key: no tool takes an address, and the vault contract pays the mandate's payee.

**Unaudited beta.** Testnet first; use small amounts. MIT licensed.

**On npm since release 0.1.1, published on 2026-11-11.** `npx -y @probarion/mcp@0.1.1` runs it with no clone,
and the official MCP registry lists it as `io.github.probarion/probarion`. A clone of the repository builds
the same server, as Set it up below shows, and the lines below give both forms: from npm and from a clone.

## The five tools

| Tool | What it does | Sends a transaction |
| --- | --- | --- |
| `list_mandates` | The vault's mandates: payee, cap per payment, total cap and what is left, uses left, approval threshold, expiry and the agent key each is bound to, beside this server's own | No |
| `check_spend` | Asks the vault contract (`check_spend`, a free view) whether it would pay this amount under this mandate | No |
| `request_spend` | Pays under a mandate: Probarion's rules (`decide()` in `@probarion/core`) decide, the contract's `spend` checks again and pays the mandate's payee, and the decision goes into the vault's signed ledger. A second request with the same ref pays nothing: it is refused, and names the vault's spend under that ref as `earlier_spend` | Yes, `spend` with the agent key |
| `get_spend_status` | Reads a spend by id: held, pending, paid, burned, failed, rejected or expired. `burned` is final for the vault: Probarion does not watch the release on the other chain yet (on testnet nothing leaves NEAR), so do not poll a burned spend or send it again | No |
| `verify` | Runs Probarion's verifier on the vault and the ledger file at `PROBARION_LEDGER_PATH`: ledger signatures, hash links, anchors, a decision behind every spend, keys, code | No |

Amounts go in as USDC decimal strings (`"0.01"`, `"25.50"`). Every input rejects fields it does not know, so
a prompt-injected `"to": "0xBAD"` is refused before anything runs. No tool creates, changes or removes a
mandate, a key or the vault's settings: those are the owner's, signed in the owner's wallet.

When a client connects, the server also gives it instructions for the model (the MCP `instructions` field;
each client decides whether its model sees them), under 1,200 characters. Where a tool description or an
answer's note already states a rule, the instructions use the same sentence, and a few words of their own
orient the model: only the payee of an active mandate bound to this server's key can be paid; `check_spend`
first when unsure, since it sends no transaction; each ref and each invoice hash pays at most once; a `held`
spend is polled with `get_spend_status` until it leaves held or its `held_until` passes (the contract
approves no hold after that), not sent again; an `unconfirmed` spend may have paid, so it is not sent again
under a new ref; a refusal is final for that request; and `burned` is final for the vault, in the words for
the server's network. A server with no keys adds that `request_spend` is off.

## What the agent's keys can do

The server holds two function-call keys of the vault and no owner key:

- The agent key can call `spend` and nothing else, with no deposit.
- The ledger key can call `anchor` and nothing else. It also signs each ledger entry.

Both stay on the machine that runs the server, in a keys file that `probarion-mcp init` writes. With no keys
the server runs read-only: `request_spend` is off, the other four tools work. `verify` then needs
`PROBARION_LEDGER_PATH` set to a copy of the vault's ledger; on an empty ledger, the checks that read it
fail, and the answer says so.

## Set it up

Node 24 or newer. Run it from npm with `npx -y @probarion/mcp@0.1.1`, or build it from a clone of the
repository:

```sh
git clone https://github.com/probarion/probarion.git
cd probarion
pnpm install --frozen-lockfile
pnpm --filter "@probarion/mcp..." run build
```

The last line builds the server and the two packages it needs, `@probarion/core` and `@probarion/sdk`. The
server is then `node packages/mcp/dist/bin.js` in that folder; the steps below write `probarion-mcp` for
it. From npm, `npx -y @probarion/mcp@0.1.1` runs the same commands with no clone. `init` and
`status` print their own commands the way you started them, so from a clone the commands they print begin
with `node` and the full path of `bin.js`.

Testnet first. Mainnet works the same way: the vault's name says its network (`.near` is mainnet, `.testnet`
is testnet). The console does not serve mainnet yet, so on mainnet `init` and `status` give the `probarion`
CLI's owner transactions and no console link.

### 1. Make the keys on your machine

```sh
node packages/mcp/dist/bin.js init --vault acme.vaults.probarion.testnet
```

`init` makes the agent key and the ledger key and writes both to `~/.probarion/<vault>/keys.json`, a file
only you can read (mode 0600; on Windows the file gets its folder's permissions, and `init` warns about that,
and about a file inside a git repository). It prints only the two public keys, the file's path and the next
steps. Run it again and it changes nothing: it checks the file and prints the same public keys.
`--keys-file <path>` puts the file somewhere else.

Back up that folder: `ledger.jsonl` there is the only copy of the agent's signed record once the server
writes it. The folder also holds `keys.json`, so the backup holds the two secret keys: keep it as private as
the file itself, and out of any shared or synced folder in the clear. A backup restored from a zip or a cloud
folder may come back readable by others; `status` fails a keys file that other users can read (outside
Windows) and names the `chmod 600` that fixes it. The ledger file is the part that cannot be made again: new
keys can, and the owner then adds them.

Mode 0600 keeps out other users, not your own programs. An agent host that runs shell commands as you can
read `keys.json`, and with both keys it can sign its own allowing decisions and spends without the server's
`decide()`. The money still goes only to a mandate's payee, within its caps, but the ledger then records
decisions the code did not make, and `verify` cannot tell. When the agent host has a shell tool, run the
server as another OS user, or in a container the agent cannot read. The same holds for keys given in
`PROBARION_AGENT_KEY` and `PROBARION_LEDGER_KEY`: keep them out of a client config the agent can read.

### 2. The owner adds the two public keys to the vault

The vault's owner signs two transactions, `add_agent` and `set_ledger_key`, which the CLI printers of the
[`probarion` CLI](https://github.com/probarion/probarion/tree/main/packages/cli) print:

```sh
probarion agent add --vault acme.vaults.probarion.testnet --pk <agent public key>
probarion ledger set-key --vault acme.vaults.probarion.testnet --pk <ledger public key>
```

Each command prints the transaction for the owner's wallet to sign; `init` prints both with the keys filled
in. On testnet the owner can paste the two public keys on the console's Agent (MCP) tab instead
(`https://probarion.xyz/console/<vault>/agent`), which `init` and `status` link to; the console does not
serve mainnet yet. The owner also signs a mandate for the agent key (the console's
Mandates tab, or `probarion mandate create`) and puts USDC in the vault.

### 3. Check that the vault is ready

```sh
PROBARION_VAULT_ID=acme.vaults.probarion.testnet node packages/mcp/dist/bin.js status
```

In PowerShell, set the variable first: `$env:PROBARION_VAULT_ID = "acme.vaults.probarion.testnet"`.
`status` reads the same settings as the server and prints one line per check, each `ok`, `not yet` or
`fail`: the keys were found, in a keys file only you can read; the agent key is one of the vault's agent
keys, a function-call key limited to `spend` with allowance left; the vault's ledger key is this ledger key,
limited to `anchor`; the vault is not frozen; an active mandate is bound to the agent key; the vault's USDC;
and the local ledger file against the vault's latest anchor (the server's single-writer check, run dry: the
anchored entries are this file's, and this server's ledger key signed every entry after them). When the
vault is not ready it ends with one next step: the first `fail` that has one, else the first `not yet`. It
only reads: nothing is signed or sent. Exit code 0 when ready, 1 when not, 2 for a configuration error.

### 4. Give the MCP client the vault id

The client's config carries only `PROBARION_VAULT_ID`, and `PROBARION_KEYS_FILE` when the keys file is not
in its default place. The server finds the keys in the keys file. The client lines are below.

### Settings

The server and `status` read these from their environment:

| Variable | Required | Meaning |
| --- | --- | --- |
| `PROBARION_VAULT_ID` | Yes | The vault account, e.g. `acme.vaults.probarion.testnet` |
| `NEAR_NETWORK` | When the vault's name ends in neither `.near` nor `.testnet` | `mainnet` or `testnet` |
| `PROBARION_KEYS_FILE` | No | The keys file `init --keys-file` wrote, as an absolute path. It must exist. Default `~/.probarion/<vault>/keys.json`, used when it exists |
| `PROBARION_AGENT_KEY` | With `PROBARION_LEDGER_KEY`, or neither | `ed25519:...`, the vault's spend-only key, in place of a keys file (see the fallback below) |
| `PROBARION_LEDGER_KEY` | With `PROBARION_AGENT_KEY`, or neither | `ed25519:...`, the vault's anchor-only key, in place of a keys file |
| `NEAR_RPC_URLS` | No | Comma-separated `https://` RPC URLs in failover order, with no user name or password in a URL (`http://` only for a node on this machine) |
| `NEAR_ARCHIVAL_RPC_URLS` | No | The archival RPC URLs `verify` reads old transactions from, with the same rules |
| `PROBARION_LEDGER_PATH` | No | The ledger file, as an absolute path: a relative one is taken from the folder the MCP client starts the server in. Default `~/.probarion/<vault>/ledger.jsonl` |

The keys come from the first of these that is set: both `PROBARION_AGENT_KEY` and `PROBARION_LEDGER_KEY`;
the file `PROBARION_KEYS_FILE` names; `~/.probarion/<vault>/keys.json`. With none, the server is read-only.
One key from the environment and the other from a file is refused. A keys file must be for this vault and
its network, and each secret key in it must match the public key beside it; a problem is named by the file
and the field, with no value from the file. The server's first line on stderr says where its keys came
from, and no key.

`node packages/mcp/dist/bin.js --help` lists the commands and `--version` prints the version. With no
argument, the binary is the MCP server and writes only JSON-RPC to stdout.

## Try it: the read-only demo

One command, with no key and no wallet, run in the clone's folder once it is built:

```sh
node packages/mcp/dist/bin.js demo
```

From npm, with no clone: `npx -y @probarion/mcp@0.1.1 demo`.

The demo starts the MCP server over stdio with no key in its environment, against the public testnet vault
`demo.vaults.probarion.testnet` (`--vault <id>` picks another testnet vault). Each step prints what it
expects and what came back:

1. `tools/list`: the five tools, and that no input field names a recipient.
2. `list_mandates`: the mandate's payee, caps, uses and expiry, read live from the vault contract.
3. `check_spend`, the contract's free dry run, at three amounts taken from those caps: one it pays, one it
   holds for an approver, and one over the per-payment cap that it refuses with `OverPerPayment`.
4. `request_spend` with an injected `"to"` field, refused by the input schema before the tool runs.
5. `get_spend_status` on a paid spend.
6. `verify` on the vault's signed ledger, downloaded from its public
   [proof page](https://probarion.xyz/proof/demo.vaults.probarion.testnet). When the download fails, the
   step says so and is skipped.

Nothing is signed or sent: the server has no key, and every step is a read, a dry run or a refusal. The
numbers it prints are read live, so they change as the vault is used. When the mandate's uses are used up or
it has expired, the demo says so, shows the contract refusing, and still exits 0. It exits 1 when a step
does not answer as expected.

## Add it to an MCP client

The lines below give the server the public demo vault in read-only mode, which needs no key. To let the
agent pay, put your own vault's id in their place once `init` and `status` are done (Set it up, above): the
server takes the keys from `~/.probarion/<vault>/keys.json`, so the config still holds only
`PROBARION_VAULT_ID`. For a keys file elsewhere, add `PROBARION_KEYS_FILE` with its absolute path (with
`claude mcp add`, a second `-e PROBARION_KEYS_FILE=/path/to/keys.json`). Use the full path of your clone in
place of `/path/to/probarion`. If a client cannot find `node`, give its full path (`which node`, or
`where node` on Windows).

On Windows, `npx` is a batch file that most clients cannot start directly: run it through `cmd /c`, as the
Windows lines show. `node` needs no `cmd /c`. The first `npx` run downloads the package and its
dependencies, which can outlast a client's start-up timeout; `npm install -g @probarion/mcp@0.1.1` once
and then the command `probarion-mcp` avoids that. On Windows the global `probarion-mcp` is a batch file too,
so the command there is `cmd /c probarion-mcp`.

### Claude Code

From a clone:

```sh
claude mcp add probarion \
  -e PROBARION_VAULT_ID=demo.vaults.probarion.testnet \
  -- node /path/to/probarion/packages/mcp/dist/bin.js
```

From npm:

```sh
claude mcp add probarion -e PROBARION_VAULT_ID=demo.vaults.probarion.testnet -- npx -y @probarion/mcp@0.1.1
```

From npm, on Windows:

```sh
claude mcp add probarion -e PROBARION_VAULT_ID=demo.vaults.probarion.testnet -- cmd /c npx -y @probarion/mcp@0.1.1
```

### Codex CLI

From a clone:

```sh
codex mcp add probarion \
  --env PROBARION_VAULT_ID=demo.vaults.probarion.testnet \
  -- node /path/to/probarion/packages/mcp/dist/bin.js
```

Or in `~/.codex/config.toml` (on Windows, write the path with forward slashes, e.g.
`C:/path/to/probarion/packages/mcp/dist/bin.js`):

```toml
[mcp_servers.probarion]
command = "node"
args = ["/path/to/probarion/packages/mcp/dist/bin.js"]
env = { PROBARION_VAULT_ID = "demo.vaults.probarion.testnet" }
```

From npm, `command = "npx"` and `args = ["-y", "@probarion/mcp@0.1.1"]`; on Windows,
`command = "cmd"` and `args = ["/c", "npx", "-y", "@probarion/mcp@0.1.1"]`.

### Claude Desktop

Add this to `claude_desktop_config.json` (on macOS in `~/Library/Application Support/Claude/`, on Windows
in `%APPDATA%\Claude\`), then restart Claude Desktop. From a clone:

```json
{
  "mcpServers": {
    "probarion": {
      "command": "node",
      "args": ["/path/to/probarion/packages/mcp/dist/bin.js"],
      "env": {
        "PROBARION_VAULT_ID": "demo.vaults.probarion.testnet"
      }
    }
  }
}
```

From npm, `"command": "npx"` and `"args": ["-y", "@probarion/mcp@0.1.1"]`; on Windows,
`"command": "cmd"` and `"args": ["/c", "npx", "-y", "@probarion/mcp@0.1.1"]`. In JSON, a Windows path
needs its backslashes doubled, or forward slashes.

### Cursor

Put the same `mcpServers` block as for Claude Desktop in `.cursor/mcp.json` in your project, or in
`~/.cursor/mcp.json` for every project. The npx and Windows forms are the same too.

### Fallback: keys in the client's config

`PROBARION_AGENT_KEY` and `PROBARION_LEDGER_KEY` in the `env` block work too, and win over any keys file
(both, or neither). They are then secrets in plain text in the client's config file, which the client may
sync, back up or show: keep that file private, and give the server a vault that holds only what the agent
may spend. A keys file from `init` keeps them out of the client's config.

## One ledger per vault

A vault has one hash-chained ledger, anchored on chain. Before every payment the server checks that its own
ledger file holds every entry the vault's latest anchor covers, with the same root at that count. If another
process with another ledger file has anchored the vault, `request_spend` stops with `LEDGER_FORK_RISK` and
sends nothing. A writer that has not anchored yet is not caught here: `verify` check d finds its spends
later, since this ledger has no decision behind them. Run one writer per vault, or point
`PROBARION_LEDGER_PATH` at the file the other process uses on the same machine.

The server also checks that its own ledger key signed every entry after the vault's latest anchor. The
vault's next anchor covers those entries under the vault's ledger key of that moment, and `verify` check a
fails for any entry in that range that another key signed. That happens when the keys file changes while the
ledger file stays: `init` run again after the old `keys.json` was moved away, a restored backup, or
`PROBARION_KEYS_FILE` pointed at another file. Then `request_spend` stops with `LEDGER_KEY_MISMATCH` and sends
nothing. Anchor those entries with the key that signed them, while it is the vault's ledger key, and only
then have the owner set the new one (`probarion ledger set-key`, which deletes the old key).

`probarion-mcp status` runs both checks without paying, so a vault that another ledger has anchored, or a
ledger tail another key signed, shows up before the first payment. When the vault's ledger key is another key
and the ledger it anchors is not on this machine, `status` does not suggest setting this server's key: that
would delete the other process's key, and this server still could not pay.

## What it records

The server makes no model call of its own: the MCP client decides. `request_spend` stores the client's
`reasoning` in the decision entry as an unattested proposal (prefixed `mcp:`), and Probarion's rules decide.
`verify` reports these decisions as rules-only, not as failures.

The client names the mandate by id. Its caps, uses, expiry and agent key apply, each invoice hash and ref
pays once, and then the contract checks again. No invoice text or purpose document is read, so the purpose
rule (`invoice.po_mismatch`) passes: the mandate the client picked is the purpose.

## Example: pay per call

[`examples/402`](https://github.com/probarion/probarion/tree/main/examples/402) is an HTTP endpoint that
answers `402 Payment Required` with a price, and an agent that pays it through these tools under a mandate
of 20 uses, then retries and gets the data. The 21st call is refused.

## Using it as a library

`createServer(port, info)` builds the server on any `ProbarionPort` (five methods, none that names a
recipient); `buildPort(config)` is the one over `@probarion/sdk`. `main()` is what the binary runs.
