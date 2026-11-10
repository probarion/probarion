# The 402 example on testnet, 2026-11-09

`percall.vaults.probarion.testnet` is a vault created through the testnet factory for the
[pay-per-call example](../../../examples/402). An endpoint charged 0.01 test USDC per call; an agent paid each
`402` through [`@probarion/mcp`](../../../packages/mcp) under one mandate of 20 uses and got the data. The agent
asked a 21st time, and Probarion's rules refused it before any transaction.

Test tokens only: `usdc.probarion.testnet` is `test-ft` acting as USDC, and has no value.

## Accounts

| Role | Account |
| --- | --- |
| Vault | `percall.vaults.probarion.testnet`, factory version 1, code hash `3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1` |
| Owner | `probarion-owner.testnet`, signing with near-cli-rs (`sign-with-keychain`) |
| Approver | `probarion-approver.testnet` (no payment here needed one) |
| Seller (payee) | `probarion-payee.testnet` |
| Agent key | `ed25519:4sYFZAht1g5D3gN91Fu6Hq8sXq6Qunh9HpSeLeCeAS7N`, label `402-agent`, can call `spend` only |
| Ledger key | `ed25519:9DDfsL2KF4qTjcSHpMKn7ZwRbEn7C7bURLnRYYRmxzFP`, can call `anchor` only |

## The mandate

Mandate 1, "402 example: 0.01 per call, 20 calls": pays `probarion-payee.testnet`, at most 0.01 USDC a payment
and 0.20 in all, 20 payments, until 2026-12-31, and holds a payment above 0.01 USDC for an approver (so none
here). Its purpose hash is the sha256 of [`purpose.txt`](purpose.txt).

## The run

[`agent-run-2026-11-09.txt`](agent-run-2026-11-09.txt) is what the agent printed. For each call the endpoint
answered `402` with a quote; the agent called `list_mandates`, found mandate 1 for the quote's payee, called
`request_spend` with the quote's sha256 as the invoice hash and `402:<quote id>` as the ref, and sent the request
again with the spend id. The endpoint read that spend from the vault, checked that it paid this quote in full to
`probarion-payee.testnet`, and served the data.

The run used the example and the server as of commit `affa086`. After a review on 2026-11-10 the endpoint also
gives each 402 a redeem token that the retry must carry, and judges a quote's expiry by the spend's block time;
this record shows the run as it happened, without the token.

| Calls | Result |
| --- | --- |
| 1 to 20 | Spends 1 to 20 paid 0.01 USDC each, from 18:12:52 to 18:16:20 UTC, and each call got its data |
| 21 | Refused by code, rule `mandate.uses_exhausted`, at 18:16:25. Nothing was sent; the refusal is the ledger's last entry (seq 40). The contract's own `check_spend` on the same payment answered `UsesExhausted` |

After the run the vault held 0.80 test USDC of the 1.00 minted, and the payee 0.20 more than before.

## Transactions

| Time (UTC) | What | Transaction |
| --- | --- | --- |
| 18:10:00 | The owner creates the vault through the factory | [`C6wKYLT2…`](https://testnet.nearblocks.io/txns/C6wKYLT2pF6sTistAUHo3TRE8GTiRSoPoypH975Eu6ih) |
| 18:10:31 | The owner adds the agent key | [`8EG2iB6i…`](https://testnet.nearblocks.io/txns/8EG2iB6ifydnsqnyR2FipSgqKKFGTaKVmBu5Lpg2Vdzn) |
| 18:10:37 | The owner sets the ledger key | [`E1NJ2Coj…`](https://testnet.nearblocks.io/txns/E1NJ2CojCGqhGjAJEqxCtedymtzTTLNoRVSQvNLuR62y) |
| 18:11:09 | The owner signs mandate 1 | [`Cw5iwWHz…`](https://testnet.nearblocks.io/txns/Cw5iwWHzNFkeZLjtt9X1rexF6o7AdMhPaLfPnTaxsusn) |
| 18:11:31 | `probarion.testnet` mints 1 test USDC into the vault | [`5uwxw1ou…`](https://testnet.nearblocks.io/txns/5uwxw1ouvRoH1tvYNtxU2EXKLU1BFJJ9CargEwdwGkKT) |
| 18:12:52 | Spend 1, paid | [`8q5qwWhz…`](https://testnet.nearblocks.io/txns/8q5qwWhzxKnZYgMbXLGvBJmvVT2HFyLJVQhDqLBf561H) |
| 18:16:20 | Spend 20, paid | [`4T3zW2KU…`](https://testnet.nearblocks.io/txns/4T3zW2KUAxZsiUPkyGyGwSKPX13pT4fYWrZN6auHNY69) |

The other 18 spends are in the agent's output and in the ledger's payment entries. The ledger key anchored the
ledger after every call: 21 anchors.

## Check it

[`verify-2026-11-09.txt`](verify-2026-11-09.txt) is a live run that read the chain itself: checks a to i pass,
`RESULT: PASS`. Check e lists the 21 decisions as rules-only: the MCP client's reasoning is recorded, unattested,
and the code decided. That run wrote [`snapshot-2026-11-09.json`](snapshot-2026-11-09.json); offline, the verifier
checks that file against itself, with no network:

```bash
npx probarion verify --offline docs/evidence/402-vault/snapshot-2026-11-09.json
```

[`ledger-2026-11-09.jsonl`](ledger-2026-11-09.jsonl) is the vault's ledger after the run: 41 entries, 21
decisions and 20 payment results. To read the chain again:
`npx probarion verify --network testnet --vault percall.vaults.probarion.testnet --ledger docs/evidence/402-vault/ledger-2026-11-09.jsonl`.
