# Probarion and the NEAR AI Agent Market (November 2026)

**Status: not built.** Probarion has no Agent Market integration. This page records how the market at
[market.near.ai](https://market.near.ai) says jobs are posted and paid, why a Probarion agent key cannot pay it the
way the market asks, and what a mandate that pays the market would need.

The market's public docs were read on 2026-11-13, between 19:21 and 19:36 UTC, with plain HTTP GETs. Nothing was
posted, bid, signed or paid. The market's docs are its own description, not something this page tested, and they
change: the worker skill was at version 0.63.0 and the buyer skill at 0.46.0 when read. Check the
[sources](#sources) before you rely on a line here.

## The short answer

- **Board jobs are paid from a market balance.** A buyer posts a job, workers bid, and the person who awards a bid
  has its amount escrowed from their balance on the market. The market releases it to the worker's owner when the
  buyer accepts the work.
- **Per-call hires are paid with x402.** The caller signs one NEP-366 delegate action, an `ft_transfer` of USDC to
  the market's treasury, and the market settles it when the agent delivers.
- **A Probarion agent key cannot sign that delegate action, by design.** It is a function-call key on the vault for
  `spend` and nothing else. Under NEP-366 a function-call key signs a delegate action for the key's own receiver
  and methods and nothing else, and `spend` takes no address.
- **A mandate could name the treasury as its payee.** The market would then have to accept a transfer the vault
  already made, and the contract still could not see which listed agent a payment was for.

## How the market says jobs are posted and paid

### Board jobs

- **Posting.** A buyer posts a job in the web app, or from an AI client with the `post_job` tool of the market's
  MCP endpoint, which mirrors the web app's job board. The fields include a title, a description, an optional
  `budget_amount`, which is a guide for bidders, and a `token`, `USD` or `USDC`, the balance the award pays from.
  The job is public once posted.
- **Bids and the award.** Each bid names its own amount. The award escrows that amount. Over MCP, `award_bid`
  answers with a link, and the person awards on the job page, where the amount is taken from their balance.
- **Balances.** An account holds three balances: `usd`, `credit_usd` and `usdc`. A USDC hire draws `credit_usd`
  before `usdc`. The API description of `GET /v1/wallet/balance` says the USDC balance is read from OutLayer,
  and `GET /v1/wallet/crypto/deposit-intents` lists the account's crypto deposits. A hire can also pay in USD,
  once the agent's builder has connected a Stripe account for bank payouts.
- **Payout.** When the buyer accepts the work, the market's payout worker releases the escrow, less the market's
  fee, to the worker's owner account. A worker agent's `aat_` token cannot move funds or read its owner's wallet.

### Per-call hires (A2A and x402)

- **The quote.** A caller sends the task to a listed agent's A2A endpoint with no payment, and gets HTTP 402 with
  rows of `network`, `asset`, `amount`, `payTo` and `maxTimeoutSeconds`.
- **The rows.** On 2026-11-13, `https://market.near.ai/.well-known/x402` listed one row: network `near:mainnet`,
  asset `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, and payee
  `ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc`, a 64-hex implicit account. The asset is
  native USDC on NEAR, the token the mainnet vault `v0.probarion.near` holds
  ([`contracts/deployments/mainnet.json`](../contracts/deployments/mainnet.json), key `usdc`).
- **The payment.** On a `near:*` row the caller signs one NEP-366 delegate action: `ft_transfer` on the asset to
  `payTo` for `amount`, with 1 yoctoNEAR attached and 30 Tgas, valid for `maxTimeoutSeconds` blocks. It goes in the
  `X-PAYMENT` header, and a relayer pays the gas. The market holds the signed action as the job's escrow and
  settles it when the agent delivers. A rejected, failed or cancelled task is not charged.
- **Payout.** The payment settles into the market treasury, and a treasury sweep pays the agent owner's share in
  USDC to their market account.

## Why a spend-only key cannot sign a delegated `ft_transfer`

- **What the agent key is.** `add_agent` adds a function-call key to the vault's own account. Its receiver is the
  vault and its one method is `spend`
  ([`contracts/vault/src/keys.rs`](../contracts/vault/src/keys.rs)). The ledger key is the same kind of key, for
  `anchor`.
- **Whose USDC it would move.** The USDC sits in the vault's account on the USDC contract. A delegated
  `ft_transfer` that paid from it would have the vault as its sender and the USDC contract as its receiver.
- **What NEP-366 allows a function-call key.** One `FunctionCall` action, whose receiver must match the key's
  receiver and whose method must be in the key's method names
  ([NEP-366](https://github.com/near/NEPs/blob/master/neps/nep-0366.md)). The agent key names the vault and
  `spend`, so the protocol refuses a delegate action for `ft_transfer` on the USDC contract signed with it.
- **No other key can sign it.** The vault has no full-access key, which check f of `verify` reads on chain. The
  mainnet run of 2026-11-13 passed it
  ([`verify-2026-11-13.txt`](evidence/mainnet-v0/s2-2026-11-13/verify-2026-11-13.txt)).
- **Why it is built this way.** A key that could sign `ft_transfer` could pay any account. The agent's request to
  the vault, `SpendRequest`, has a mandate id, an amount, an invoice hash, a ref and a decision hash, and no address
  field ([`contracts/vault/src/types.rs`](../contracts/vault/src/types.rs)). The vault pays the payee the owner
  wrote into the mandate. The x402 exact scheme on NEAR says function-call access keys must be rejected for this
  flow, as the [comparison page](comparison-2026-11.md) notes from sources read on 2026-11-11.

## What a mandate whose payee is the market treasury would need

None of this is built. Each item says what exists today and what is missing.

1. **The payee.** A mandate pays one NEAR account, or a Base or Solana address through NEAR Intents. The treasury
   is a NEAR account, so the owner could sign a mandate that names it, in native USDC. The vault would pay it with
   `ft_transfer` and the memo `probarion:<spend id>`
   ([`contracts/vault/src/spend.rs`](../contracts/vault/src/spend.rs)). Exists today: this payee kind. Missing: a
   run of it. No Probarion mandate has paid the market.
2. **A proof of payment the market accepts.** The market settles a signed delegate action. A vault payment is a
   transfer that already happened. The market would have to accept that transfer instead, tied to one quote: for
   example the quote in the spend's `ref` and the sha256 of the task text as its `invoice_hash`. The docs read on
   2026-11-13 describe no such path. This is on the market's side.
3. **Paying at delivery, not at the request.** The vault pays when `spend` runs, before the work is done. On the
   market, x402 money moves on delivery, and a failed task moves none. Paying before delivery needs a refund path
   from the treasury back to the vault. The other way exists in the contract today: an `approval_above` below the
   price makes the vault hold each spend until an approver approves it, which an approver could do after
   delivery. That puts a person in every call.
4. **Which agent is paid.** One treasury collects for every listed agent. A mandate that names it lets the agent
   pay for any agent on the market, within the caps. The caps still bound the loss: per payment, in total, the
   number of uses, the expiry and the vault's daily backstop. An off-chain `custom.*` rule could check the hired
   agent's handle before the spend, but the contract cannot.
5. **Board jobs.** These are paid from the buyer's market balance, not by one transfer per job. A mandate could
   top up that balance, if the deposit address is one a mandate can name. From then on the market's wallet holds
   the money, and the mandate's limits stop at the deposit.
6. **The price.** A listed agent's price is in US dollars per call, paid 1:1 in USDC, and the 402 restates it in
   atomic units. The mandate's per-payment cap would be set at or above that price, and the MCP server's
   `check_spend` asks the contract before the agent pays.

## What exists today that is close

- **The 402 example.** [`examples/402`](../examples/402) is a seller that answers `402` with a price and a payee,
  and an agent that pays through `@probarion/mcp` under a mandate, then sends the spend id as its proof. It uses
  its own 402 format, not x402. On testnet on 2026-11-09, 20 calls paid 0.01 test USDC each and the 21st was refused
  ([the record](evidence/402-vault/README.md)).
- **The MCP server.** `npx -y @probarion/mcp@0.1.1 demo` lists its five tools. None takes an address.

## What this page does not show

- No request was made to the market beyond public GETs of its docs, its API description and its x402 rows.
- The market's docs were not tested against the market.
- Probarion's code is unaudited. Its mainnet payments so far are tests to the owner's own addresses.

## Sources

Read on 2026-11-13, 19:21 to 19:36 UTC:

- Market index for agents: https://market.near.ai/llms.txt
- Worker skill (version 0.63.0): https://market.near.ai/skill/SKILL.md
- Worker lifecycle: https://market.near.ai/skill/flows/worker-lifecycle.md
- A2A and x402 for workers: https://market.near.ai/skill/flows/a2a-x402.md
- Buyer skill over MCP (version 0.46.0), sections 3 to 5: https://market.near.ai/skill/mcp-buyer/SKILL.md
- x402 caller skill (version 0.2.0): https://market.near.ai/skill/x402-caller/SKILL.md
- x402 payment rows: https://market.near.ai/.well-known/x402
- API description: https://market.near.ai/openapi.json
- NEP-366, meta transactions: https://github.com/near/NEPs/blob/master/neps/nep-0366.md
- Access keys in the NEAR protocol spec: https://nomicon.io/DataStructures/AccessKey
