# The mainnet drill, 2026-11-14: a refused over-cap spend, a freeze, a refused spend while frozen, an unfreeze

On 2026-11-14, between 01:06 and 01:13 UTC (block times), the owner ran a drill on `v0.probarion.near`, the
[mainnet vault](../README.md), from their own Git Bash with near-cli-rs 0.30.1. Four transactions, in this order:

1. **A**, signed with the vault's spend-only agent key: `spend` of 50 USDC on mandate 1, whose cap is 1 USDC a
   payment. Refused on chain with `PROBARION:OverPerPayment`.
2. **B**, signed by the owner, `probarion.near`: `freeze`. It succeeded, and the vault logged its `frozen` event.
3. **C**, signed with the agent key while the vault was frozen: `spend` of 2 USDC on mandate 1, also over its cap.
   Refused on chain with `PROBARION:Frozen`.
4. **D**, signed by the owner: `unfreeze`, with 1 yoctoNEAR. It succeeded, and the vault logged its `unfrozen` event.

**Rehearsed by the team; a hijacked agent key could send exactly this. No USDC moved.** The team chose both spends,
and the owner signed them with the vault's own agent key, as a hijacked agent host holding that key could. They are
not an outside attack. Both spends were over mandate 1's cap of 1 USDC a payment, so neither could have paid even if
the vault had not been frozen. Each carried 15 Tgas of gas, a safety margin that played no part in the refusals: the
contract refused A at its per-payment cap check and C at its freeze check, before it reserved anything, and the
vault's receipt burned 1.43 Tgas for A and 1.34 Tgas for C.

The owner signed all four transactions in their own terminal: A and C with the agent key file, B and D with
`probarion.near`'s key in the keychain. Claude signed nothing on mainnet. It wrote the runbook, which is kept outside
this repository, and read the chain before, during and after, with view calls and archival reads. Every transaction
value below (hashes, signers, keys, nonces, actions, arguments, statuses, logs, gas and block times) was read again,
read-only, from an archival NEAR node (`https://archival-rpc.mainnet.fastnear.com`, method `tx` with each
transaction's own signer as `sender_account_id`, and `block` for the block times) on 2026-11-14 after the drill. The
views (frozen, mandate 1, `check_spend`, the vault's USDC, spends, anchors, and the agent key's nonce and allowance)
are as read at the times given, with near-cli-rs view calls. Later on 2026-11-14 Claude read the same views again from
the archival node at four block heights around the drill
([views-archival-2026-11-14.txt](views-archival-2026-11-14.txt)), and every value that both reads cover matches.

## What ran, in order

Times are UTC. A to D are at the block time of the block that includes each transaction, as in
[`txs.log`](txs.log); the views are at the time each read ran.

| Time | Step | Signed by | What | Result | Transaction |
| --- | --- | --- | --- | --- | --- |
| 01:04:41 | Views before | Nobody (view calls, by the owner) | The runbook's `status` | Not frozen; mandate 1 at 1 of 2 uses; `check_spend` of requests A and C `OverPerPayment`, of request E ok; 2.000000 USDC; 3 spends; last anchor 4 ([views-before.txt](views-before.txt)) | None |
| 01:06:22 | (a) | The agent key, as `v0.probarion.near` | `spend` of request A: 50 USDC on mandate 1 | Failure: `Smart contract panicked: PROBARION:OverPerPayment` | [`G6WJcTZA…`](https://nearblocks.io/txns/G6WJcTZA67NBSrLV8zhS7Ay5BQKt6qCSao7dndm1tF1c) |
| 01:08:45 | (b) | `probarion.near` | `freeze`, no deposit | Success. The vault's receipt, in the next block at 01:08:46, logged the `frozen` event | [`6oPDe77z…`](https://nearblocks.io/txns/6oPDe77z5FmendyMQPTeKMdA5jsgpboks9uyUNGLvX6Z) |
| 01:09:44 | Views while frozen | Nobody (view calls, by Claude) | `get_config` and `check_spend` of request C | `"frozen":true`; request C `Frozen` ([views-during.txt](views-during.txt)) | None |
| 01:11:54 | (c) | The agent key, as `v0.probarion.near` | `spend` of request C: 2 USDC on mandate 1 | Failure: `Smart contract panicked: PROBARION:Frozen` | [`DwXRPZHW…`](https://nearblocks.io/txns/DwXRPZHWWKaBcNpvp6F1rsaFzvM5wyi6A4Z6sckF8ifg) |
| About 01:12:30 | Views while frozen | Nobody (view calls, by Claude) | Mandate 1, the vault's USDC, `get_config` | Mandate 1 still 0 reserved, 1000000 spent, 1 use; 2.000000 USDC; still frozen | None |
| 01:13:00 | (d) | `probarion.near` | `unfreeze`, 1 yoctoNEAR | Success. The vault's receipt, in the next block at 01:13:00, logged the `unfrozen` event | [`H4qf84Tw…`](https://nearblocks.io/txns/H4qf84TwG1U7k8MRVp6VJHJcwryJFUPzPrRDv3yEAu8T) |
| 01:13:17 | Views after | Nobody (view calls, by the owner) | The runbook's `status` | Not frozen; all else as before, apart from the agent key's nonce and allowance ([views-after.txt](views-after.txt)) | None |
| 01:16:46 | Views again | Nobody (view calls, by Claude) | The same `status` | The same as at 01:13:17 ([views-after.txt](views-after.txt)) | None |

## Each transaction on chain

| | A | B | C | D |
| --- | --- | --- | --- | --- |
| Hash | `G6WJcTZA67NBSrLV8zhS7Ay5BQKt6qCSao7dndm1tF1c` | `6oPDe77z5FmendyMQPTeKMdA5jsgpboks9uyUNGLvX6Z` | `DwXRPZHWWKaBcNpvp6F1rsaFzvM5wyi6A4Z6sckF8ifg` | `H4qf84TwG1U7k8MRVp6VJHJcwryJFUPzPrRDv3yEAu8T` |
| Signer | `v0.probarion.near` | `probarion.near` | `v0.probarion.near` | `probarion.near` |
| Public key | `ed25519:GADeVCXtgcxS3E5JrcVpEWTuZiNMJ4gu17iyuEgyCycd`, the agent key, which can call `spend` on the vault and nothing else | `ed25519:4jHJSmeUGvpJzXDTUvBkKzGUgXMb3jMXmyKT44htnUxc`, the owner's full-access key | The agent key | The owner's key |
| Nonce | 224068463000005 | 224067894000009 | 224068463000006 | 224067894000010 |
| Receiver | `v0.probarion.near` | `v0.probarion.near` | `v0.probarion.near` | `v0.probarion.near` |
| Action | One `FunctionCall`: `spend`, 15 Tgas, deposit 0 | One `FunctionCall`: `freeze`, 30 Tgas, deposit 0 | One `FunctionCall`: `spend`, 15 Tgas, deposit 0 | One `FunctionCall`: `unfreeze`, 30 Tgas, deposit 1 yoctoNEAR |
| Arguments | Request A ([below](#the-three-requests)) | `{}` | Request C ([below](#the-three-requests)) | `{}` |
| Status | `Failure` | `SuccessValue`, empty | `Failure` | `SuccessValue`, empty |
| Logs of the vault's receipt | None | The `frozen` event | None | The `unfrozen` event |
| Gas burnt: converting the transaction, the vault's receipt, the gas refund | 0.3086, 1.4271 and 0.2232 Tgas | 0.3084, 1.4800 and 0.2232 Tgas | 0.3086, 1.3410 and 0.2232 Tgas | 0.3085, 1.4808 and 0.2232 Tgas |
| Gas burnt in all | 1.9589 Tgas | 2.0117 Tgas | 1.8728 Tgas | 2.0125 Tgas |
| NEAR burnt | 0.0001735731424659, paid by the vault within the agent key's allowance | 0.0001788476556682, paid by `probarion.near` | 0.0001649607941, paid by the vault within the agent key's allowance | 0.0001789312856806, paid by `probarion.near` |

The gas refund receipt burns gas but no NEAR. Every outcome, with its receipt id, is in
[`gas-2026-11-14.json`](gas-2026-11-14.json).

The blocks, read with the archival node's `block` method:

| | Block of the transaction | Block of the vault's receipt |
| --- | --- | --- |
| A | 224442801, `9X3r7XuoB3yW3vsBZ2pyAuJpJ3v5Ck2AGZwSFLXNnCSP`, 2026-11-14 01:06:22.867 | The same block |
| B | 224443055, `D9RpeKAy4HXoFCzTTugkx4md7gSVCYPWqsEqYqtG3XSg`, 2026-11-14 01:08:45.511 | 224443056, `EJz4733PwkcRyQWDLRu6dr6piFTGSouWz4SZqGdQ7kpa`, 2026-11-14 01:08:46.217 |
| C | 224443389, `75JTmLQY775PGjhbeeS2orLQTK9W1NQProUTzUXmoE2u`, 2026-11-14 01:11:54.151 | The same block |
| D | 224443506, `8apxdJzNedPrWTTK922nwcZSNLRXxUdU4as6H4kemjBL`, 2026-11-14 01:13:00.339 | 224443507, `ENGYPLo4Wk94UgBHxoXsRkqYYM61U4vJKsAJQaaedBka`, 2026-11-14 01:13:00.755 |

A and C were signed by the vault account for itself, so their receipt ran in the block that included them.

## The exact errors and events

The `status` of A, as the archival node returns it, and the same in the vault's receipt:

```json
{"Failure":{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: PROBARION:OverPerPayment"}}}}}
```

The `status` of C:

```json
{"Failure":{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: PROBARION:Frozen"}}}}}
```

The logs in `receipts_outcome`. B's vault receipt `9bvuWic4iMPDkrgPEyFMSTHA1jAXrhztyqa86WNP7K8q`, executor
`v0.probarion.near`:

```text
EVENT_JSON:{"standard":"probarion","version":"1.0.0","event":"frozen","data":{"by":"probarion.near"}}
```

D's vault receipt `6j5hXUo3HMwbt1ekbN1NcCgEXjijNsKJJGS1gFYB3gCv`, executor `v0.probarion.near`:

```text
EVENT_JSON:{"standard":"probarion","version":"1.0.0","event":"unfrozen","data":{"by":"probarion.near"}}
```

A's and C's receipts logged nothing: the contract refused them before any event. The gas refund receipts of all
four logged nothing.

## check_spend before, while frozen and after

`check_spend` is the vault's free view of the checks `spend` runs, here with `signer_pk` the agent key. Request A and
request C are the two spends that were sent; request E, 1 USDC on mandate 1, was checked and not sent.

| Request | Before, 01:04:41 (the owner) | While frozen, 01:09:44 (Claude) | After, 01:13:17 (the owner) | Again, 01:16:46 (Claude) |
| --- | --- | --- | --- | --- |
| A, 50 USDC | `OverPerPayment` | Not read | `OverPerPayment` | `OverPerPayment` |
| C, 2 USDC | `OverPerPayment` | `Frozen` | `OverPerPayment` | `OverPerPayment` |
| E, 1 USDC | ok | Not read: the owner skipped that check of the runbook | ok | ok |

In full, `OverPerPayment` was `{"code":"OverPerPayment","ok":false,"would_hold":false}`, `Frozen` was
`{"code":"Frozen","ok":false,"would_hold":false}`, and ok was `{"code":null,"ok":true,"would_hold":false}`. Request
E is not held, because 1 USDC is not above mandate 1's `approval_above` of 1 USDC.

Claude's later archival read, made after the drill, fills the cells marked "Not read" from the chain's history. It is
not the owner's check of the runbook's step (b), which was skipped. At block 224443200 (after B's receipt, before C)
and block 224443450 (after C, before D), requests A, C and E each answered `Frozen`; at block 224442800 (before A) and
block 224443520 (after D's receipt), A and C answered `OverPerPayment` and E ok
([views-archival-2026-11-14.txt](views-archival-2026-11-14.txt)).

Request C shows the freeze: the same request answered `Frozen` while the vault was frozen and `OverPerPayment`
before and after, because the contract checks the freeze before the mandate and its cap
([`checks.rs`](../../../../contracts/vault/src/checks.rs)). That request E answers ok again after D shows that a spend
within the cap would pass again. It does not test what A and C left behind: E has its own invoice and ref, and A and C
were refused before the invoice and ref checks. During the drill, E was not read while the vault was frozen; the later
archival read gives `Frozen` for it at both frozen blocks and ok after D. A spend within a cap answering `Frozen` while
frozen, and ok again after `unfreeze`, is also what the contract's unit test
`a_frozen_vault_refuses_spends_until_unfrozen` checks ([`admin.rs`](../../../../contracts/vault/src/admin.rs)).

## The vault before and after

| | Before, 01:04:41 | After, 01:13:17 | Again, 01:16:46 |
| --- | --- | --- | --- |
| Frozen | false | false | false |
| Mandate 1 | `active`, 1 of 2 uses, `spent` 1000000 (1 USDC), `reserved` 0 | The same | The same |
| Native USDC of the vault | 2000000 (2.000000 USDC) | 2000000 | 2000000 |
| Spends | 3 | 3 | 3 |
| Anchors | 4, the last `seq` 4 | The same | The same |
| Agent key nonce | 224068463000004 | 224068463000006 | 224068463000006 |
| Agent key allowance | 0.2462193502381326 NEAR | 0.2458808163015667 NEAR | 0.2458808163015667 NEAR |

A refused spend stores nothing. `spend` runs every check before it reserves anything
([`spend.rs`](../../../../contracts/vault/src/spend.rs)), and each `PROBARION:<Code>` is a panic, which reverts every
state change of the call ([`errors.rs`](../../../../contracts/vault/src/errors.rs)). The part a view shows: mandate 1
still has 0 reserved and 1 use, there are still 3 spends and 4 anchors, and the vault still holds 2 USDC. The agent
key's nonce rose by 2, for A and C, and its allowance fell by 0.0003385339365659 NEAR, which is the NEAR that A and C
burned together.

## The three requests

A and C were sent; E was checked with `check_spend` and not sent. Each `invoice_hash` and `decision_hash` is the sha256
of a fixed label text, so anyone can recompute it. They label the drill: no invoice and no model decision is behind
them.

The `request` argument as the runbook defines it (`REQ_A`, `REQ_C` and `REQ_E`), one a line:

```text
{"mandate_id":1,"amount":"50000000","invoice_hash":"5efe2da8ff3bd449dcb5a3ed4fc32daea2b4b3e5448f8b80de6b39a970811e77","ref":"DRILL-20261114-A","decision_hash":"44d510ba5fb27c89310eac956a16d76d760d084288458181abd94a42b6f83dcc"}
{"mandate_id":1,"amount":"2000000","invoice_hash":"bd06270bef9d7b1c0e8a53b8c2c3927ff20ade95e93ea9e971edc270ca4db423","ref":"DRILL-20261114-C","decision_hash":"afff8021adf63356e5d4803b6a9d85d944169ca4f76c2abdb5f072f29040646e"}
{"mandate_id":1,"amount":"1000000","invoice_hash":"80e2656af9b007bed47562b68c7ce3cf88a3c382177c97b2194bf3b375fd05d4","ref":"DRILL-20261114-E-VIEW-ONLY","decision_hash":"6fe8d389a4e3211fc5039553e3a693a375e6bf9388043b26c513612f94d33b14"}
```

On chain, A's and C's arguments are `{"request":{...}}` with the same five fields, which near-cli-rs sent with their
keys in alphabetical order, one a line:

```text
{"request":{"amount":"50000000","decision_hash":"44d510ba5fb27c89310eac956a16d76d760d084288458181abd94a42b6f83dcc","invoice_hash":"5efe2da8ff3bd449dcb5a3ed4fc32daea2b4b3e5448f8b80de6b39a970811e77","mandate_id":1,"ref":"DRILL-20261114-A"}}
{"request":{"amount":"2000000","decision_hash":"afff8021adf63356e5d4803b6a9d85d944169ca4f76c2abdb5f072f29040646e","invoice_hash":"bd06270bef9d7b1c0e8a53b8c2c3927ff20ade95e93ea9e971edc270ca4db423","mandate_id":1,"ref":"DRILL-20261114-C"}}
```

| Request | Field | Value | The sha256 of the text |
| --- | --- | --- | --- |
| A (sent) | `invoice_hash` | `5efe2da8ff3bd449dcb5a3ed4fc32daea2b4b3e5448f8b80de6b39a970811e77` | `PROBARION MAINNET DRILL 2026-11-14 A invoice: 50 USDC on mandate 1 (per-payment cap 1 USDC)` |
| A (sent) | `decision_hash` | `44d510ba5fb27c89310eac956a16d76d760d084288458181abd94a42b6f83dcc` | `PROBARION MAINNET DRILL 2026-11-14 A decision: none, a team rehearsal of a hijacked agent key, no model` |
| C (sent) | `invoice_hash` | `bd06270bef9d7b1c0e8a53b8c2c3927ff20ade95e93ea9e971edc270ca4db423` | `PROBARION MAINNET DRILL 2026-11-14 C invoice: 2 USDC on mandate 1 (per-payment cap 1 USDC) while the vault is frozen` |
| C (sent) | `decision_hash` | `afff8021adf63356e5d4803b6a9d85d944169ca4f76c2abdb5f072f29040646e` | `PROBARION MAINNET DRILL 2026-11-14 C decision: none, a team rehearsal of a hijacked agent key sending 2 USDC over the cap while frozen, no model` |
| E (checked, not sent) | `invoice_hash` | `80e2656af9b007bed47562b68c7ce3cf88a3c382177c97b2194bf3b375fd05d4` | `PROBARION MAINNET DRILL 2026-11-14 E invoice: 1 USDC on mandate 1, a check_spend view only, never sent` |
| E (checked, not sent) | `decision_hash` | `6fe8d389a4e3211fc5039553e3a693a375e6bf9388043b26c513612f94d33b14` | `PROBARION MAINNET DRILL 2026-11-14 E decision: none, a check_spend view only, never sent, no model` |

Each text is the exact bytes hashed, with no newline at the end. Claude recomputed all six on 2026-11-14 and each
matches. For example:

```bash
printf '%s' 'PROBARION MAINNET DRILL 2026-11-14 A invoice: 50 USDC on mandate 1 (per-payment cap 1 USDC)' | sha256sum
```

## Check it

Each transaction opens on nearblocks: [A](https://nearblocks.io/txns/G6WJcTZA67NBSrLV8zhS7Ay5BQKt6qCSao7dndm1tF1c),
[B](https://nearblocks.io/txns/6oPDe77z5FmendyMQPTeKMdA5jsgpboks9uyUNGLvX6Z),
[C](https://nearblocks.io/txns/DwXRPZHWWKaBcNpvp6F1rsaFzvM5wyi6A4Z6sckF8ifg),
[D](https://nearblocks.io/txns/H4qf84TwG1U7k8MRVp6VJHJcwryJFUPzPrRDv3yEAu8T). An archival node gives the same with
no key, in Bash (Git Bash on Windows too):

```bash
tx() { curl -s https://archival-rpc.mainnet.fastnear.com -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tx\",\"params\":{\"tx_hash\":\"$1\",\"sender_account_id\":\"$2\",\"wait_until\":\"FINAL\"}}"; }
tx G6WJcTZA67NBSrLV8zhS7Ay5BQKt6qCSao7dndm1tF1c v0.probarion.near | grep -o 'PROBARION:[A-Za-z]*' | sort -u   # PROBARION:OverPerPayment
tx 6oPDe77z5FmendyMQPTeKMdA5jsgpboks9uyUNGLvX6Z probarion.near | grep -o 'event\\":\\"[a-z]*' | sort -u       # event\":\"frozen
tx DwXRPZHWWKaBcNpvp6F1rsaFzvM5wyi6A4Z6sckF8ifg v0.probarion.near | grep -o 'PROBARION:[A-Za-z]*' | sort -u   # PROBARION:Frozen
tx H4qf84TwG1U7k8MRVp6VJHJcwryJFUPzPrRDv3yEAu8T probarion.near | grep -o 'event\\":\\"[a-z]*' | sort -u       # event\":\"unfrozen
```

Claude ran these four lines on 2026-11-14, after the drill, and each printed the line after its `#`. With
near-cli-rs, in any shell, `near transaction view-status <hash> network-config mainnet` prints the same status and
logs (tried with near-cli-rs 0.30.1 on A, B and C).

The vault's views now, free and with no key:

```bash
near contract call-function as-read-only v0.probarion.near get_config json-args '{}' network-config mainnet now
near contract call-function as-read-only v0.probarion.near get_mandate json-args '{"mandate_id":1}' network-config mainnet now
near contract call-function as-read-only v0.probarion.near check_spend json-args '{"request":{"mandate_id":1,"amount":"2000000","invoice_hash":"bd06270bef9d7b1c0e8a53b8c2c3927ff20ade95e93ea9e971edc270ca4db423","ref":"DRILL-20261114-C","decision_hash":"afff8021adf63356e5d4803b6a9d85d944169ca4f76c2abdb5f072f29040646e"},"signer_pk":"ed25519:GADeVCXtgcxS3E5JrcVpEWTuZiNMJ4gu17iyuEgyCycd"}' network-config mainnet now
near account list-keys v0.probarion.near network-config mainnet now
```

At 01:16 UTC on 2026-11-14 they gave `"frozen": false`, mandate 1 `active` with 1 of 2 uses, `OverPerPayment` for
request C, and the agent key at nonce 224068463000006 with an allowance of 0.2458808163015667 NEAR. A later spend or
a new mandate changes these answers; the transactions above stay as they are.

The four transactions are also in [`docs/mainnet-proof.json`](../../../mainnet-proof.json), as `v0_drill_over_cap`,
`v0_drill_freeze`, `v0_drill_frozen_refused` and `v0_drill_unfreeze`, each with its signer.

## What this does not show

- It is a drill the team rehearsed, not an outside attack: the team chose the requests and the owner sent them.
- Request E was not sent, and during the drill it was not read while the vault was frozen. Its `Frozen` answers at
  blocks 224443200 and 224443450 come from Claude's later archival read, not from a check made at the time.
- The owner froze the vault with the full-access key of `probarion.near`. A function-call key on `probarion.near`
  whose receiver is `v0.probarion.near` (and whose method list allows `freeze`) can also call `freeze`, which takes no
  deposit; that path was not used here. The NEAR protocol limits a function-call key to its receiver and its methods,
  so a wallet's sign-in key for another contract cannot call `freeze` on the vault.
- That 15 Tgas could not carry a payout is a reading of the code (a payout reserves 15 Tgas for `ft_transfer` and
  15 Tgas for its callback, [`lib.rs`](../../../../contracts/vault/src/lib.rs)), not tested on chain. Neither spend got
  that far.

## The files

| File | What it is |
| --- | --- |
| [`txs.log`](txs.log) | The four transactions, tab-separated: block time, label, hash, signer, receiver, status |
| [`views-before.txt`](views-before.txt) | The views before the drill: the owner's read at 01:04:41 UTC, and Claude's reads of 2026-11-13 |
| [`views-during.txt`](views-during.txt) | Claude's views while the vault was frozen, at 01:09:44 UTC and about 01:12:30 UTC |
| [`views-after.txt`](views-after.txt) | The views after the drill: the owner's read at 01:13:17 UTC, and Claude's re-read from 01:16:46 to 01:16:53 UTC |
| [`views-archival-2026-11-14.txt`](views-archival-2026-11-14.txt) | Claude's later archival read of the same views at blocks 224442800, 224443200, 224443450 and 224443520: before A, frozen before C, frozen after C, and after D |
| [`gas-2026-11-14.json`](gas-2026-11-14.json) | The gas and NEAR each transaction burned, every outcome summed, from the archival node |
