# @probarion/mcp

An MCP server that gives an AI agent a Probarion vault to pay from. The agent can see its mandates, dry-run
a payment, pay under a mandate and read a payment's status. It can pay only the payee of a mandate the owner
signed for its key: no tool takes an address, and the vault contract pays the mandate's payee.

**Unaudited beta.** Testnet first; use small amounts. MIT licensed.

**Not on npm yet.** Today the server runs from a clone of the repository, as Set it up below shows.
Every `npx` line below is marked *after the 0.1.1 release*, and none of them works before that release.

<!-- TODO(release): at the 0.1.1 release, drop the "Not on npm yet" paragraph and the "after the 0.1.1 release" marks, and lead each client with its npx line. -->

## The five tools

| Tool | What it does | Sends a transaction |
| --- | --- | --- |
| `list_mandates` | The vault's mandates: payee, cap per payment, total cap and what is left, uses left, approval threshold, expiry and the agent key each is bound to, beside this server's own | No |
| `check_spend` | Asks the vault contract (`check_spend`, a free view) whether it would pay this amount under this mandate | No |
| `request_spend` | Pays under a mandate: Probarion's rules (`decide()` in `@probarion/core`) decide, the contract's `spend` checks again and pays the mandate's payee, and the decision goes into the vault's signed ledger. A second request with the same ref pays nothing: it is refused, and names the vault's spend under that ref as `earlier_spend` | Yes, `spend` with the agent key |
| `get_spend_status` | Reads a spend by id: held, pending, paid, burned, failed, rejected or expired. `burned` is final for the vault: Probarion does not watch the release on the other chain yet, so do not poll a burned spend or send it again | No |
| `verify` | Runs Probarion's verifier on the vault and the ledger file at `PROBARION_LEDGER_PATH`: ledger signatures, hash links, anchors, a decision behind every spend, keys, code | No |

Amounts go in as USDC decimal strings (`"0.01"`, `"25.50"`). Every input rejects fields it does not know, so
a prompt-injected `"to": "0xBAD"` is refused before anything runs. No tool creates, changes or removes a
mandate, a key or the vault's settings: those are the owner's, signed in the owner's wallet.

## What the agent's keys can do

The server holds two function-call keys of the vault and no owner key:

- `PROBARION_AGENT_KEY` can call `spend` and nothing else, with no deposit.
- `PROBARION_LEDGER_KEY` can call `anchor` and nothing else. It also signs each ledger entry.

Leave both out and the server runs read-only: `request_spend` is off, the other four tools work. `verify`
then needs `PROBARION_LEDGER_PATH` set to a copy of the vault's ledger; on an empty ledger, the checks that
read it fail, and the answer says so.

## Set it up

Node 24 or newer. Build it from a clone of the repository:

```sh
git clone https://github.com/probarion/probarion.git
cd probarion
pnpm install --frozen-lockfile
pnpm build
```

The server is then `node packages/mcp/dist/bin.js` in that folder. It speaks MCP over stdio and reads its
settings from its environment:

| Variable | Required | Meaning |
| --- | --- | --- |
| `PROBARION_VAULT_ID` | Yes | The vault account, e.g. `acme.vaults.probarion.testnet` |
| `NEAR_NETWORK` | When the vault's name ends in neither `.near` nor `.testnet` | `mainnet` or `testnet` |
| `PROBARION_AGENT_KEY` | With `PROBARION_LEDGER_KEY`, or neither | `ed25519:…`, the vault's spend-only key |
| `PROBARION_LEDGER_KEY` | With `PROBARION_AGENT_KEY`, or neither | `ed25519:…`, the vault's anchor-only key |
| `NEAR_RPC_URLS` | No | Comma-separated `https://` RPC URLs in failover order, with no user name or password in a URL (`http://` only for a node on this machine) |
| `NEAR_ARCHIVAL_RPC_URLS` | No | The archival RPC URLs `verify` reads old transactions from, with the same rules |
| `PROBARION_LEDGER_PATH` | No | The ledger file. Default `~/.probarion/<vault>/ledger.jsonl` |

`node packages/mcp/dist/bin.js --help` lists the commands and `--version` prints the version. With no
argument, the binary is the MCP server and writes only JSON-RPC to stdout.

The owner makes the keys and the mandates with the
[`probarion` CLI](https://github.com/probarion/probarion/tree/main/packages/cli): `agent keygen` once for each
key, `agent add` for the agent key, `ledger set-key` for the ledger key, and `mandate create`. The CLI prints
each owner transaction for the owner's wallet to sign.

## Try it: the read-only demo

One command, with no key and no wallet, run in the clone's folder once it is built:

```sh
node packages/mcp/dist/bin.js demo
```

After the 0.1.1 release: `npx -y @probarion/mcp@0.1.1 demo`.

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
agent pay, use your own vault and add `PROBARION_AGENT_KEY` and `PROBARION_LEDGER_KEY` beside
`PROBARION_VAULT_ID`. Use the full path of your clone in place of `/path/to/probarion`. If a client cannot
find `node`, give its full path (`which node`, or `where node` on Windows).

On Windows, `npx` is a batch file that most clients cannot start directly: run it through `cmd /c`, as the
Windows lines show. `node` needs no `cmd /c`. The first `npx` run downloads the package and its
dependencies, which can outlast a client's start-up timeout; after the 0.1.1 release,
`npm install -g @probarion/mcp@0.1.1` once and then the command `probarion-mcp` avoids that.

### Claude Code

From a clone:

```sh
claude mcp add probarion \
  -e PROBARION_VAULT_ID=demo.vaults.probarion.testnet \
  -- node /path/to/probarion/packages/mcp/dist/bin.js
```

After the 0.1.1 release:

```sh
claude mcp add probarion -e PROBARION_VAULT_ID=demo.vaults.probarion.testnet -- npx -y @probarion/mcp@0.1.1
```

On Windows, after the 0.1.1 release:

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

After the 0.1.1 release, `command = "npx"` and `args = ["-y", "@probarion/mcp@0.1.1"]`; on Windows,
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

After the 0.1.1 release, `"command": "npx"` and `"args": ["-y", "@probarion/mcp@0.1.1"]`; on Windows,
`"command": "cmd"` and `"args": ["/c", "npx", "-y", "@probarion/mcp@0.1.1"]`. In JSON, a Windows path
needs its backslashes doubled, or forward slashes.

### Cursor

Put the same `mcpServers` block as for Claude Desktop in `.cursor/mcp.json` in your project, or in
`~/.cursor/mcp.json` for every project. The npx and Windows forms are the same too.

### Keys in a config file

With keys, the `env` block holds them in plain text, so keep that file private, and give the server a vault
that holds only what the agent may spend.

## One ledger per vault

A vault has one hash-chained ledger, anchored on chain. Before every payment the server checks that its own
ledger file holds every entry the vault's latest anchor covers, with the same root at that count. If another
process with another ledger file has anchored the vault, `request_spend` stops with `LEDGER_FORK_RISK` and
sends nothing. A writer that has not anchored yet is not caught here: `verify` check d finds its spends
later, since this ledger has no decision behind them. Run one writer per vault, or point
`PROBARION_LEDGER_PATH` at the file the other process uses on the same machine.

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
