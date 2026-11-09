# Pay per call with a mandate (402 example)

An HTTP endpoint charges 0.01 test USDC per call. Without a payment it answers `402 Payment Required` with a
quote: a price, a payee and a short text to pay. An agent pays that text's hash through
[`@probarion/mcp`](../../packages/mcp) under a mandate, sends the request again with the payment's spend id,
and gets the data.

The owner's mandate allows 0.01 USDC per payment and 20 uses. The agent does not count: it asks to pay every
time. The 21st payment is refused by Probarion's rules (`mandate.uses_exhausted`, written to the vault's
signed ledger, nothing sent), and the vault contract's own dry run says `UsesExhausted` too.

Testnet only, with test USDC. This is a small example of paying per call through a mandate, not an
implementation of x402 or any other payment protocol.

## What each side checks

- **The agent** reads the payee from the quote text and looks for a mandate that pays that NEAR account. If
  none does, it pays nothing. If one does, the vault pays the mandate's payee, whatever the 402 said
  elsewhere: `request_spend` has no recipient field.
- **Probarion and the contract** check the mandate's cap per payment, total, uses and expiry, and pay each
  quote hash and each ref at most once.
- **The seller** reads the spend from the buyer's vault on NEAR and serves the call only if the vault was
  created by Probarion's factory, the spend is `paid`, to the seller's account, for the full price, and for
  this quote's hash. Each quote serves one call.

## Run it on testnet

You need a testnet vault with a mandate for the seller's account (0.01 per payment, 20 uses, approval above
0.01), the vault's agent key and ledger key, and a little test USDC in the vault. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
```

In one terminal, start the endpoint (it is paid at `probarion-payee.testnet` unless you set `PAYWALL_PAYEE`):

```sh
pnpm --filter @probarion/example-402 server
```

In another, run the agent with the vault's keys in the environment (they go to the MCP server it starts,
and are not printed):

```sh
PROBARION_VAULT_ID=<your vault>.vaults.probarion.testnet \
PROBARION_AGENT_KEY=ed25519:... PROBARION_LEDGER_KEY=ed25519:... \
pnpm --filter @probarion/example-402 agent
```

You see 20 lines like `#01 402 for 0.01 USDC -> paid, spend 1 https://testnet.nearblocks.io/txns/... -> 200`,
then `#21 ... -> refused_by_code (mandate.uses_exhausted)` with the contract's `UsesExhausted`.

## Run it without a network

```sh
pnpm --filter @probarion/example-402 test
```

`test/pay-per-call.test.ts` runs the same 21 calls against the SDK's fake chain.
