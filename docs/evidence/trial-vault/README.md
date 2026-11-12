# The testnet trial vault and a real MCP client, 2026-11-11

`trial.vaults.probarion.testnet` is a vault the owner created through the testnet factory from the web console at
[probarion.xyz](https://probarion.xyz), signed in with Meteor, on 2026-11-05. On 2026-11-11, from 17:15 to 17:50
UTC, the owner tried the console's Top-up tab, its Agent (MCP) tab and its approval page on it with that wallet, and a
real MCP client paid through [`@probarion/mcp`](../../../packages/mcp) 0.1.1, run from npm. Claude drove the console
in the owner's browser, and the owner signed each wallet prompt in Meteor: the top-up, the keys, the mandate and the
approvals. The spends were signed by the vault's own `spend`-only agent key and the anchors by its `anchor`-only
ledger key, both held by the MCP server on the owner's machine.

The same session also froze and unfroze the demo vault from the console: that is in the
[demo vault's record](../demo-vault/README.md#2026-11-11-freeze-unfreeze-and-attested-decisions).

Test tokens only: `usdc.probarion.testnet` is `test-ft` acting as USDC, and has no value.

## Accounts

| Role | Account |
| --- | --- |
| Vault | `trial.vaults.probarion.testnet`, factory version 1, code hash `3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1` |
| Owner | `35008ecd0f274c7af302e0ecbcfe39211231069c3953cdb228ff5eca1399242b`, signing in Meteor Wallet. It is also on the vault's approver list |
| Approver | `probarion-approver.testnet`, the vault's other approver (it signed nothing here) |
| Payee | `probarion-payee.testnet` |
| Agent key | `ed25519:A8PQcwDn4d2ccaHsskz1WRLL3g83uRyD3zuqcLqsHchN`, label `mcp-claude`, can call `spend` only |
| Ledger key | `ed25519:2TszM3hZgwi6z31yUhiqdkqeaJxn9EKzjqJwaiu7Wwvg`, can call `anchor` only |

## The mandate

Mandate 1, "MCP try": pays `probarion-payee.testnet`, at most 3 USDC a payment and 5 in all, 5 payments, until
2026-12-31 23:59:59 UTC, and holds a payment above 1 USDC for an approver. Its purpose hash,
`30739be9a9186c8884c598e6f46ef54a7ebc14c401548f59b43b512b0496278d`, is the sha256 of the demo vault's purchase order
[`po-PO-1001.txt`](../demo-vault/po-PO-1001.txt), the same PO.

## The run

1. **Top-up.** On the console's Top-up tab the owner sent 5 test USDC from their own wallet: one transaction that
   registers the vault on `usdc.probarion.testnet` (`storage_deposit`) and transfers the USDC (`ft_transfer`, memo
   `probarion:fund`). This is the USDC transfer on NEAR; the Base top-up through 1Click was not tried, since
   testnet has no 1Click.
2. **Keys.** On the owner's Windows machine, `npx -y @probarion/mcp@0.1.1 init --vault trial.vaults.probarion.testnet`
   made the agent key and the ledger key. Only their public halves were pasted into the console's Agent (MCP) tab,
   and the owner signed `add_agent` (label `mcp-claude`) and `set_ledger_key` in Meteor.
3. **Mandate.** The owner signed mandate 1 in the console. The Agent (MCP) tab then showed "Ready on chain.", and
   `npx -y @probarion/mcp@0.1.1 status` printed 7 ok lines and "Ready: an MCP client can start the server with only
   PROBARION_VAULT_ID=trial.vaults.probarion.testnet."
4. **The MCP client.** Claude Code 2.1.289, run headless (`claude -p ... --mcp-config mcp.json --strict-mcp-config`),
   started the server as `cmd /c npx -y @probarion/mcp@0.1.1`, with only `PROBARION_VAULT_ID` set. It ran three
   times. Each prompt gave the tool arguments (the mandate id, the amount, the invoice's sha256, the ref and the
   reasoning text), so the client did not read the invoices itself.
   [`mcp-client-2026-11-11.jsonl`](mcp-client-2026-11-11.jsonl) holds each run's init line (Claude Code version,
   model and tool list) and the probarion tool calls and their results of the three runs (`pay`, `pay3`, `check`),
   and nothing else of the transcripts.

   | Run | Tool call | Result |
   | --- | --- | --- |
   | `pay` | `list_mandates` | Mandate 1, active, bound to the server's agent key |
   | `pay` | `request_spend` 0.50 USDC, [`invoice-INV-3001.txt`](invoice-INV-3001.txt), ref `mcp-try:INV-3001` | `paid`: spend 1 paid 0.50 test USDC, ledger entry 1 |
   | `pay` | `request_spend` 2.00 USDC, [`invoice-INV-3002.txt`](invoice-INV-3002.txt), ref `mcp-try:INV-3002` | `held`: spend 2, above the 1 USDC approval limit, ledger entry 3 |
   | `pay3` | `request_spend` 1.50 USDC, [`invoice-INV-3003.txt`](invoice-INV-3003.txt), ref `mcp-try:INV-3003` | `held`: spend 3, ledger entry 5 |
   | `check` | `get_spend_status` 1, 2, 3 | `paid`, `paid`, `paid` (after the approvals below) |
   | `check` | `verify` | `ok: true`, 6 entries, 3 anchors, checks a to i pass, nothing unproven |

   Each invoice's sha256 is the `invoice_hash` of its ledger entries and of its spend on chain. For each spend the
   server decided with the code's rules, signed the decision into the ledger, sent the spend and anchored the ledger.
   The rules allowed all three; the vault held spends 2 and 3 on chain because each is above the mandate's
   `approval_above`.
5. **Telegram.** The owner made a bot, set `TELEGRAM_BOT_TOKEN` in the production deployment, registered its
   webhook with `pnpm --filter @probarion/web telegram-webhook` ("Webhook was set") and linked a Telegram chat to
   the vault from the console's Alerts tab, and the bot replied that the chat was linked. Spends 1 and 2 were
   already recorded by the watcher before that alert existed, and alerts treat earlier events as history, so no
   message went out for them. Spend 3 was sent after the chat was linked, so that an alert would fire. The
   screenshots kept show two real messages: at 17:46 UTC, "Approval needed: 1.5 USDC" for spend 3, with the hold's
   end (2026-11-14 17:45 UTC) and a link to
   `https://probarion.xyz/console/trial.vaults.probarion.testnet/approve/3`; at 17:48 UTC, "Paid 2 USDC" for spend
   2. Each came within two minutes of its event (spend 3 at 17:45:24, the approval of spend 2 at 17:47:42), and no
   invoice upload on this vault started the watcher, so the two messages point to a schedule of about a
   minute running that day; this record does not read that schedule in Supabase. This record holds no message
   for spend 3's payment. The chat id and the screenshots are kept private.
6. **Approvals.** The owner approved spend 2 and then spend 3 on the console's approval page,
   `/console/trial.vaults.probarion.testnet/approve/<spend>`, signing each `approve` in Meteor. Each approval paid
   its spend to `probarion-payee.testnet` (`spend_approved`, `ft_transfer`, `spend_paid`). The screenshots of
   these steps are from a desktop browser: this run does not show the page used on a phone.

After the run mandate 1 has spent 4.00 of its 5 USDC and 3 of its 5 uses, with nothing reserved.

## Transactions

| Time (UTC) | What | Transaction |
| --- | --- | --- |
| 2026-11-05 16:54:32 | The owner creates the vault through the factory | [`HdyCcZkU…`](https://testnet.nearblocks.io/txns/HdyCcZkUDPQZnmCLLFW6VTBTymqvRNqc1F9DtELvJ42r) |
| 2026-11-11 17:15:11 | Top-up tab: the owner's wallet registers the vault and sends it 5 test USDC | [`6GhCUDS8…`](https://testnet.nearblocks.io/txns/6GhCUDS8up1rycRDTg9ToXFNVokARSutWLamWn5twmKA) |
| 17:20:03 | Agent (MCP) tab: the owner adds the agent key `mcp-claude` | [`54BJdWv6…`](https://testnet.nearblocks.io/txns/54BJdWv6xkMboc25qYpzabtcvWVaqcYUc4jmuq6AZ3ce) |
| 17:20:49 | Agent (MCP) tab: the owner sets the ledger key | [`2BukLJLx…`](https://testnet.nearblocks.io/txns/2BukLJLxcGBzezRXvCMvBGozTnvwhbvn7DoJH3SVbHpV) |
| 17:22:29 | The owner signs mandate 1 | [`32i14YJZ…`](https://testnet.nearblocks.io/txns/32i14YJZkht4vAdjuoJiHv3vCpDa3BCdj1K9MBa7bMrD) |
| 17:28:58 | Spend 1, INV-3001, paid 0.50 | [`CJu2sN5E…`](https://testnet.nearblocks.io/txns/CJu2sN5E6Z76c9Cfm29hmTNvh8BwpxgELFJmhjDFAfce) |
| 17:29:03 | Anchor 1, the ledger's first 2 entries | [`J1mg9fog…`](https://testnet.nearblocks.io/txns/J1mg9fogfXi5KJqXSQzQK5bPujw9fbzijTwxwsNMCKgj) |
| 17:29:11 | Spend 2, INV-3002, held (2.00) | [`Ef7v4LED…`](https://testnet.nearblocks.io/txns/Ef7v4LEDw7hYYodtG4Gm6TesKNvc4ELKsuCHnhS65oeJ) |
| 17:29:15 | Anchor 2, 4 entries | [`HMxTzFFL…`](https://testnet.nearblocks.io/txns/HMxTzFFL8AwcVVkGmVpNv8ziBGm4LbUyNMGZpHyWbWeQ) |
| 17:45:24 | Spend 3, INV-3003, held (1.50) | [`GfnYgust…`](https://testnet.nearblocks.io/txns/GfnYgustdSog18Y49L5ZyxXbAVZ2Hco2mhNpSHAQzhK4) |
| 17:45:28 | Anchor 3, 6 entries | [`2nUgxP4R…`](https://testnet.nearblocks.io/txns/2nUgxP4RjdFdqt5kFi71EiprvV3VScsJh3zhiYH4DsMM) |
| 17:47:42 | The owner approves spend 2 on the approval page, which pays 2.00 | [`37JR54ru…`](https://testnet.nearblocks.io/txns/37JR54ruMHQdhRDiJdctQPwBaCu3YTnGU3YwPn45uiit) |
| 17:49:56 | The owner approves spend 3 on the approval page, which pays 1.50 | [`5f2cMTQA…`](https://testnet.nearblocks.io/txns/5f2cMTQAK6iD4SfV7TcAA3Gpsx6xXbAf89gTHnKdTfUo) |

The times are block times (the rows after the first are 2026-11-11). [`docs/mainnet-proof.json`](../../mainnet-proof.json) records each transaction of the run
(its testnet entries `trial_*`), and the deployment record has the vault under `trial_vault`. The approvals are on
chain only: no code writes an approver's decision to the ledger, so the ledger's payment entries for spends 2 and 3
still say `held`, and the chain says `paid`.

## Check it

After the run, release 0.1.1 from npm read the chain itself,
`npx -y probarion@0.1.1 verify --vault trial.vaults.probarion.testnet --ledger <the ledger> --snapshot <out>`, and
printed `9 passed, 0 failed, 0 unproven` and `RESULT: PASS`. That run wrote
[`snapshot-2026-11-11.json`](snapshot-2026-11-11.json), the ledger and the chain data it read at 17:52:51 UTC.
[`verify-2026-11-11.txt`](verify-2026-11-11.txt) is the verifier on that file, offline: checks a to i pass, with 6
entries, 3 anchors and 3 spends, each bound to its own decision. Check e lists the three decisions (seq 0, 2 and 4)
as rules-only, which it reports and does not fail. Offline, with no network:

```bash
npx probarion verify --offline docs/evidence/trial-vault/snapshot-2026-11-11.json
```

[`ledger-2026-11-11.jsonl`](ledger-2026-11-11.jsonl) is the vault's ledger after the run: 6 entries, 3 decisions and
3 payment results, signed by the ledger key above. It holds public keys, hashes and decisions, and no secret. To read
the chain again:

```bash
npx probarion verify --network testnet --vault trial.vaults.probarion.testnet --ledger docs/evidence/trial-vault/ledger-2026-11-11.jsonl
```

The vault may act again later. A live run with this file then counts more on chain, and fails check c once a newer
anchor covers entries the file does not hold; the offline command above keeps passing. The PO's sha256 is the
purpose hash above, and each invoice's is the `invoice_hash` of its entries in the ledger file and of its spend in
the snapshot: `sha256sum docs/evidence/trial-vault/invoice-INV-300*.txt docs/evidence/demo-vault/po-PO-1001.txt`.

## What this does not show

- **No attested model.** The MCP path has no attested model: each decision is rules-only. The `reasoning` text of
  each `request_spend`, which the prompt also gave word for word, is recorded in the ledger unattested (the server
  adds the prefix `mcp:`), and the code decided. The demo vault's three decisions with an attested NEAR AI model,
  made by Payables the same day, paid nothing
  ([their record](../demo-vault/README.md#2026-11-11-freeze-unfreeze-and-attested-decisions)).
- **No invoice reading.** The prompt gave each `request_spend` its mandate id, amount, invoice hash, ref and
  reasoning text. The client did not read the invoices, so this shows the MCP server, the ledger and the vault at
  work, and not an agent judging an invoice.
- **No phone.** The approvals were made on the console's approval page in the owner's wallet. The screenshots are
  from a desktop browser, and the owner has not confirmed a phone.
- **One person.** The owner is also on the vault's approver list, so the owner approved the spends of their own
  agent. `probarion-approver.testnet` signed nothing in this run.
- **No Base top-up.** Only the USDC transfer on NEAR from the owner's wallet was tried. The Base top-up through
  1Click was not, since testnet has no 1Click.
- **No email.** The Telegram messages were real. No email alert has been sent.
- **Test tokens.** Nothing here moved real money.
