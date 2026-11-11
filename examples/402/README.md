# Pay per call with a mandate (402 example)

An HTTP endpoint sells data per call. Without a payment it answers `402 Payment Required` with a quote: a
price, a payee and a short text to pay. An agent pays that text's hash through
[`@probarion/mcp`](../../packages/mcp) under a mandate, sends the request again with the payment's spend id,
and gets the data.

When the price is above what the mandate allows in one payment, the agent counters once at that limit. The
seller takes the counter (a new quote at the countered price) or refuses it, and the agent pays the new quote
or walks away without asking for any payment. After each paid call it checks the data it bought and writes a
receipt line.

Testnet only, with test USDC. This is a small example of paying per call through a mandate, not an
implementation of x402 or any other payment protocol.

## Try it in one line

From the repository root, after `pnpm install --frozen-lockfile` and `pnpm build`:

```sh
pnpm --filter @probarion/example-402 run demo
```

It needs no keys and no network: the SDK's test double chain runs on 127.0.0.1 with its public test keys,
and the MCP server runs in the same process. It runs offline even when vault keys are in your environment: it
names the ones it found and does not use them. One agent, three sellers, three calls. You see:

```text
Probarion 402 demo, offline: the SDK's test double chain on 127.0.0.1 and its public test keys. No network, nothing real is paid.
Mandate 1 (active) pays near:vendor.testnet at most 0.01 USDC a payment, 1 of 1 payments left.
Sellers (paid at near:vendor.testnet): GET /premium lists at 0.05 USDC, GET /forecast at 0.012, GET /basic at 0.01. Each has a floor it does not send.

1. A counter below the seller's floor
#1 402 for 0.05 USDC, above the mandate's 0.01: countered once at 0.01 -> 409 below_floor. Walked away: no payment was asked for.

2. A negotiated sale
#2 402 for 0.012 USDC, above the mandate's 0.01: countered once at 0.01, taken as quote q_... -> paid 0.01, spend 1 test-double tx ... -> 200, data check passed {"call":1,...}
   Receipt, appended to <a new temp folder>/receipts.jsonl:
   {"v":1,...,"countered":true,"list_price_usdc":"0.012","paid_usdc":"0.01","spend_id":1,"request_status":"paid",...,"data_check":{"ok":true,...},"test_double":true}

3. A call the mandate refuses
#3 402 for 0.01 USDC (mandate 1 has no payment left) -> refused_by_code (mandate.uses_exhausted): ... The contract's own check_spend says: UsesExhausted.

request_spend was called 2 times: for calls 2 and 3, and not for the walk-away.
Payout: near:vendor.testnet got 0.01 USDC; the vault paid 0.01 USDC in all.
All three calls ended as expected.
Demo finished in 1.7 s (limit 120 s).
```

It takes a second or two, and exits 0 only when the three calls end as shown: a walk-away from a
`409 below_floor`, a paid sale whose data check passes and whose payout reaches the seller, and a refusal for
the mandate's uses (`mandate.uses_exhausted` by Probarion's rules, or `UsesExhausted` by the contract) that the
contract's own dry run shares, all within 120 s. The mandate allows one payment of at most 0.01 USDC. Call 1
is a seller whose floor is above 0.01, so the agent walks away while the mandate can still pay. Call 2 pays
the mandate's one payment at the countered price. Call 3 is a price within the cap, refused by Probarion's
rules because the mandate has no payment left, and the vault contract's own dry run agrees.

With `--testnet`, and `PROBARION_VAULT_ID`, `PROBARION_AGENT_KEY` and `PROBARION_LEDGER_KEY` set, the same
three calls run on NEAR testnet, through the MCP server over stdio, and pay real test USDC to `PAYWALL_PAYEE`
(default `probarion-payee.testnet`):

```sh
pnpm --filter @probarion/example-402 run demo --testnet
```

It needs a mandate for that payee of at most 0.01 USDC a payment and one payment, which
`probarion mandate create ... --max-per 0.01 --uses 1` prints for the owner to sign. A missing key is refused
before anything is sent. The run prints the ledger file the MCP server writes (`PROBARION_LEDGER_PATH`, else the server's default
under `~/.probarion`) and the receipts file (`RECEIPTS_PATH`, default `examples/402/receipts.jsonl`, which git
ignores) before the first call. A relative path in either is read from the folder you ran `pnpm` in. Offline,
the receipts always go to a new temp folder, and `RECEIPTS_PATH` is not used.

## Negotiation

- **The seller** has a list price and a floor: the least it takes for a counter. The first quote is at the
  list price. `POST /counter` takes `{"quote_id", "amount", "redeem_token", "reason"}`, with the amount in USDC
  smallest units and the redeem token of the 402 that carried the quote. A counter below the quote and at or
  above the floor gets a new quote: a new id, the same resource and payee, the countered price, and a new
  redeem token. A counter it judges and does not take, or one for a quote that is closed, gets `409` with a
  reason (`below_floor`, `not_below_quote`, `already_countered`, `quote_already_used`, `quote_expired`). A
  counter with the wrong redeem token gets `403`, one for an unknown quote (or one past its 10 minutes of
  grace) `404`, and a malformed body `400`, or `413` above 4 KB. Each quote takes one counter, taken or not,
  and a counter's quote takes none. The floor is not in any answer.
- **The agent** reads its mandate's limit from `list_mandates`: the cap per payment, or what is left of the
  mandate's total when that is less. When the quote is above it, the agent counters once at that limit, with
  a short reason. It pays the new quote only if its text parses, it has a new id, the first quote's resource,
  payee and network, the counter as its amount, an expiry still ahead, and a redeem token comes with it.
  Otherwise, or when the seller answers anything but a new quote, it walks away: no `request_spend`, no
  transaction. Under a mandate that cannot pay (no payment left, expired, revoked) it does not counter, since
  it could not pay what it offered; see below.
- **The payee comes from the mandate.** The quote's payee only picks the mandate (one that pays that NEAR
  account), and `request_spend` has no recipient field: the vault pays the mandate's payee. The quote parser
  refuses any line it does not know, so a quote cannot slip in another payee.

## Receipts

After a paid `200`, the seller's answer carries `data_sha256`: the sha256 of the RFC 8785 canonical JSON of
the data. The agent checks the data against a schema (a city and 1 to 14 temperatures), recomputes the sha256,
and appends one JSON line to `receipts.jsonl`: the resource, the seller (the mandate's payee), the vault and
mandate, the first and the countered quote ids, the list price, the price paid, whether it countered, the
spend id, what this call's `request_spend` answered (`request_status`), that request's transaction hash and
explorer link, its ledger seq and decision hash, the data check, and the time. With `request_status` `paid`,
the transaction and the ledger entries are the payment's own. With `held` (or `unconfirmed`) the spend was
read until it was paid, and they point at the request that created it, not at the approval that paid it. With
a refusal, the request was refused as a duplicate and named an earlier spend of this same quote (same
mandate, amount, invoice hash and ref), which the agent redeemed: the ledger seq and decision hash are the
refusal's, and there is no transaction.

The check runs after the payment. A failed check is written as failed, with a note that the money moved and is
not refunded. A paid call the seller does not serve gets no receipt line; the agent's output and the vault's
ledger still show the payment.

## What each side checks

- **The agent** reads the payee from the quote text and looks for a mandate that pays that NEAR account. A
  live one is bound to its key, active, with a payment and some of its total left, and not expired. It takes
  the lowest-numbered live one whose limit takes the price; else the live one with the highest limit (the
  lowest-numbered on a tie), to counter at. When no mandate for that account is live, it takes the
  lowest-numbered one anyway and asks `request_spend` for the quote as it is, with no counter, so that
  Probarion's refusal (and the contract's dry run) names the reason. If no mandate pays that account, it pays
  nothing. It refuses a 402 without a redeem token before any tool call. A spend held for an approver, or sent
  with no answer yet, is read until it is paid and is not sent again. When a refusal, or a send with no
  answer, names an earlier spend under the same ref, the agent uses that spend only when it pays this very
  quote (same mandate, amount, invoice hash and ref).
- **Probarion and the contract** check the mandate's cap per payment, total, uses and expiry, and pay each
  quote hash and each ref at most once.
- **The seller** gives each 402 a redeem token, outside the quote text, so it does not reach the chain. It
  serves the call only if the retry carries that token, the vault was created by Probarion's factory, and
  the spend is `paid`, to the seller's account, for the full price of that quote, for its hash, at a block
  time before the quote expired. Each quote serves one call, and a quote paid in time can be redeemed up to 10
  minutes after it expires. The quote id and the spend id are public on chain; the token is what ties the
  call to the client that paid. It builds the paid answer, and its `data_sha256`, before it marks the quote
  used: if the data cannot be built, the answer is `500` and the same payment can be redeemed again.

## Limits

- Not x402, and not any other payment protocol: the 402 body, the quote text and `POST /counter` are this
  example's own.
- The floor is the seller's, and the seller can set it anywhere. The agent learns only whether its counter
  was taken. A buyer can ask for new quotes and counter each once, so the floor protects the seller's minimum,
  not its secrecy. The agent's counter states its limit.
- The agent counters only above its mandate's limit, only once, and only at that limit. It does not bargain
  under it.
- A failed data check does not refund anything. The matching sha256 shows the data arrived as the seller
  hashed it, not that it is true. The receipts file is the agent's own unsigned record; the payment's record
  is the vault's signed ledger and the chain, which the receipt points to.
- Two testnet runs are recorded ([evidence](../../docs/evidence/402-vault)). On 2026-11-09, before negotiation
  and receipts, the agent paid 20 calls at the list price of 0.01 and the 21st was refused. On 2026-11-11,
  `run demo --testnet` ran the three calls above: the walk-away, a sale countered from 0.012 to 0.01 and paid
  (spend 21), and the refusal.

## Run it on testnet, call by call

You need a testnet vault with a mandate for the seller's account (0.01 per payment, 20 uses, approval above
0.01), the vault's agent key and ledger key, and a little test USDC in the vault. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
```

In one terminal, start the endpoint (it is paid at `probarion-payee.testnet` unless you set `PAYWALL_PAYEE`;
`PAYWALL_PRICE_USDC` sets the list price and `PAYWALL_FLOOR_USDC` the floor, by default the price):

```sh
pnpm --filter @probarion/example-402 run paywall
```

In another, run the agent with the vault's keys in the environment (they go to the MCP server it starts,
and are not printed):

```sh
PROBARION_VAULT_ID=<your vault>.vaults.probarion.testnet \
PROBARION_AGENT_KEY=ed25519:... PROBARION_LEDGER_KEY=ed25519:... \
pnpm --filter @probarion/example-402 run agent
```

You see 20 lines like `#01 402 for 0.01 USDC -> paid, spend 1 https://testnet.nearblocks.io/txns/... -> 200`,
then `#21 ... -> refused_by_code (mandate.uses_exhausted)` with the contract's `UsesExhausted`. Each paid
call appends a receipt line to `RECEIPTS_PATH` (default `examples/402/receipts.jsonl`); the agent prints that
file and the ledger file before the first call, and reads a relative path in `RECEIPTS_PATH` or
`PROBARION_LEDGER_PATH` from the folder you ran `pnpm` in.

## Run the tests

```sh
pnpm --filter @probarion/example-402 run test
```

`test/pay-per-call.test.ts` runs 21 calls against the SDK's fake chain, and a negotiated sale and a
walk-away. `test/counter.test.ts` and `test/negotiate.test.ts` cover the seller's and the agent's side of a
counter, the payee, the redeem token, the receipts and the data check; `test/agent.test.ts` covers the choice
of mandate and earlier spends; and `test/demo.test.ts` runs `run demo` offline, with and without keys in the
environment, and checks the testnet settings without a network.
