# S1 on mainnet, 2026-11-13: a Base payout from `v0.probarion.near`

Spike S1 asks one thing: can a contract account on NEAR mainnet call `ft_withdraw` for Base POA USDC with a
`WITHDRAW_TO:` memo, and does the USDC arrive on Base? On 2026-11-13, between 07:11 and 07:25 UTC (block times), it
did. The vault `v0.probarion.near` paid invoice INV-M002, 1.00 USDC, under a new mandate 2 whose payee is a Base
address. The vault burned 1.00 Base USDC inside NEAR Intents with the memo
`WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27`, and the POA bridge released 0.9976 USDC on Base. The bridge
kept 0.0024 USDC as its fee; Probarion took none.

**A test, not a customer payment.** INV-M002 is a labeled sample: a test of the cross-chain path, paid to the owner's
own Base address. The amounts are small on purpose, because the contract is unaudited.

**Decided rules-only.** The payment was decided by the code rules alone, with no model. Two earlier cycles on the same
invoice asked an attested model on NEAR AI Cloud. Both models proposed paying, and code refused both proposals, as the
section [Why the payout was decided rules-only](#why-the-payout-was-decided-rules-only) explains. So no payment on
mainnet has been made on a model's proposal yet.

**Who signed.** The owner ran every step in their own terminal, with a kit kept outside this repository that runs the
SDK of this repository at commit `4ab41ca` (main on 2026-11-13). The owner signed the owner calls with near-cli-rs, and
the 1Click deposit from their own wallet in Meteor. The kit's last step signed the spend with the vault's existing
spend-only agent key, and the ledger entries and anchors with a new ledger key that can call `anchor` only; both key
files stayed on the owner's machine. Claude signed nothing on mainnet.

## What ran, in order

Times are block times in UTC. NEAR transactions open on nearblocks, the Base one on Basescan.

| Time | What | Transaction | Signed by |
| --- | --- | --- | --- |
| 07:11:23 | The owner registers the 1Click deposit address `c4c0c41f…08b2` on native USDC (`storage_deposit`, registration only) | [`HbtByK1K…`](https://nearblocks.io/txns/HbtByK1K6nTYvjYuHmiKaJxEjoTkthztW7HLQ8zqr1KJ) | `probarion.near` |
| 07:12:56 | The owner's Meteor wallet sends 1.5 native USDC to that address (`ft_transfer`) | [`DWUMvM58…`](https://nearblocks.io/txns/DWUMvM58dH3MpH9Jj838ycrfvCMjNJpgFsr43qu8u6mw) | `probarion-duong.near` |
| 07:13:31 | 1Click settles the swap: `intents.near` `execute_intents` moves 1499823 Base USDC (`base-0x8335…omft.near`) from 1Click's deposit account to the vault (`mt_transfer`); 1Click's status is `SUCCESS` | [`FJA7rehn…`](https://nearblocks.io/txns/FJA7rehnWXuMHeZkD1RBojqnEgAvkiJHtZtttCcDEUUU) | 1Click, through `intents.near` |
| 07:14:08 | `set_ledger_key`: the ledger key `ed25519:RY7kjsaRStq4gt27RpNgErr9AjuKuZdzCXd6atSrzKK`, a function-call key on the vault for `anchor` only, allowance 0.25 NEAR | [`CFhtVrCA…`](https://nearblocks.io/txns/CFhtVrCA3Cjumcx68kixLbR5r6Xo8Fp1PTueK8z968jb) | `probarion.near` |
| 07:16:58 | `create_mandate` returns `2`: payee `0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27` on Base through NEAR Intents (the owner's own Base wallet), at most 1.00 USDC a payment and 1.00 in all, 1 payment, until 2026-11-20 00:00 UTC, `approval_above` 1.00, purpose `PO-M002` | [`77cC8nMq…`](https://nearblocks.io/txns/77cC8nMq6qWynU51FsPn8mkFAb3NEuDmEG7ZXjX6483g) | `probarion.near` |
| 07:17:47 | Ledger entry 0: `z-ai/glm-5.3-flash` proposes paying (confidence 0.95); code refuses with `mandate.payee_mismatch`. Nothing is sent | None (off chain) | the ledger key |
| 07:18:24 | Anchor 1 of the ledger (1 entry) | [`8REzPLVw…`](https://nearblocks.io/txns/8REzPLVwoQJrkccMQeFCTLaQHu8m7AczxsMzEH9PLvPp) | the ledger key |
| 07:22:23 | Ledger entry 1: `Qwen/Qwen3.8-27B` proposes paying (confidence 0.9); code refuses the same way. Nothing is sent | None (off chain) | the ledger key |
| 07:22:48 | Anchor 2 (2 entries) | [`6ULZZvGa…`](https://nearblocks.io/txns/6ULZZvGa7M99jR7Uk5f1Md4KCdD1Cnd5au2s8fAZDMqY) | the ledger key |
| 07:24:26 | Ledger entry 2: a rules-only decision, `allow` (the kit's `S1_MODEL=off`). Its body hash `d64f0de7…2336` is the spend's `decision_hash` | None (off chain) | the ledger key |
| 07:24:29 | `spend` on mandate 2 for 1.00 USDC, ref `INV-M002`: spend 2 `burned`. The vault calls `ft_withdraw` on `intents.near`, which logs an NEP-245 `mt_burn` of 1000000 from the vault's balance; the token `base-0x8335…omft.near` then logs an `ft_burn` from `intents.near` with the memo `WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27`, and the vault logs `spend_burned` | [`BdN7oB76…`](https://nearblocks.io/txns/BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9) | the agent key |
| 07:24:33 | Ledger entry 3: the payment, with the spend's transaction | None (off chain) | the ledger key |
| 07:24:34 | Anchor 3 (4 entries) | [`65eBfw6v…`](https://nearblocks.io/txns/65eBfw6vMettw5GFc3R2A2WHvDiGeyXs7STGojCveA9Q) | the ledger key |
| 07:24:38 | On Base, block 56821514: the USDC contract `0x8335…2913` logs a `Transfer` of 997600 (0.9976 USDC) from `0x2cff…2680` to `0xb22e…eb27`. The POA bridge's status for spend 2 is `COMPLETED`, with this transfer, `withdrawal_fee` 2400 and `withdraw_amount` 997600 | [`0xc2df8f87…`](https://basescan.org/tx/0xc2df8f8799467834cdaed0e8f23638af49334483387560fd34ef360939e1ea71) | the POA bridge |

Ledger entry times are the ledger's own `at` fields. The hashes on chain and the files behind them:

| Hash on chain | Value | The sha256 of |
| --- | --- | --- |
| Mandate 2 `purpose_hash` | `359d7ee21bafe38b1d1a948bd9df884ee1bb85c75ac12ce05a8a0cdbc92b3452` | [`po-PO-M002.txt`](po-PO-M002.txt) |
| Spend 2 `invoice_hash` | `bd45f2327fb0c2c1e960606e5c0bb91e3cfec7883f21315e94f454a83fee8357` | [`invoice-INV-M002.txt`](invoice-INV-M002.txt) |
| Spend 2 `decision_hash` | `d64f0de77c38294cf103439e6b5b0c2623b96b114962afd50f5a3c553df2a336` | The body of entry 2 of [`ledger-2026-11-13.jsonl`](ledger-2026-11-13.jsonl) (its `body_hash`) |

## Why the payout was decided rules-only

The first cycle (entry 0) asked `z-ai/glm-5.3-flash` on NEAR AI Cloud, with its TEE attestation. The model proposed
`pay` for mandate 2 and 1000000 (1.00 USDC), with confidence 0.95 and the right Base address in its payee hint. It also
put the mandate's asset account, `base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` (Base USDC as a NEAR
token), in the hint's `near_account` field. The invoice names no NEAR account.

The code rule `mandate.payee_mismatch` refused it. For a mandate that pays a Base or Solana address, any NEAR account in
the payee hint contradicts the payee, whatever account it is (`payeeHintContradiction` in
[`packages/core/src/policy.ts`](../../../../packages/core/src/policy.ts)). The rule's own words in the entry: "invoice
names NEAR account base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near; the mandate pays
base:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27" (the rule's message says "invoice" for any payee hint; this one came
from the model's proposal, since the code's own reading of the invoice found no NEAR account and passes the same rule
in entry 2). The second cycle (entry 1) asked `Qwen/Qwen3.8-27B`, which proposed
`pay` with confidence 0.9 and the same `near_account`, and the same rule refused it.

That rule is strict. For a NEAR payee the code accepts the mandate's own account in the hint (the "model hint names the
mandate's NEAR account" cases in [`packages/core/test/policy.test.ts`](../../../../packages/core/test/policy.test.ts),
added after testnet runs), but it has no such case for a Base payee, so even the mandate's own asset account counts as
another payee. Both proposals had the right amount and Base address, so these were false refusals: they cost two tries
and no money, and the code was not changed for this run. Each refusal is a signed ledger entry, anchored on chain
before the next cycle began. The owner then ran the cycle a third time with no model (the kit's `S1_MODEL=off`, which
runs the SDK's `Probarion.process()` with no proposer, so the entry has no model rule). The SDK decided with the code rules alone: all 14 rules passed (entry 2), and it sent
the spend.

## The vault after the run

Read with view calls on 2026-11-13, after the run:

- Native USDC 2.000000, as before the run, and 0.499823 Base USDC inside `intents.near` (`mt_balance_of`).
- Mandate 1: `active`, 1 USDC and 1 payment left, paying `probarion-duong.near`. Mandate 2: `exhausted`, its 1 payment
  made.
- Spends: spend 1 `paid` (2026-11-11, pre-ledger) and spend 2 `burned`, memo `WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27`.
- Access keys: no full-access key. The agent key `ed25519:GADeVCXtgcxS3E5JrcVpEWTuZiNMJ4gu17iyuEgyCycd` (`spend` only,
  allowance 0.2476 NEAR) and the ledger key (`anchor` only, allowance 0.2494 NEAR). No public key in `intents.near`.
- Code hash `3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1`, unchanged.

Spend 2 burned 15.35 Tgas, 0.001423 NEAR, summed over the transaction and its receipts from an archival node
([record](gas-spend-2.json)).

## The files

| File | What it is |
| --- | --- |
| [`ledger-2026-11-13.jsonl`](ledger-2026-11-13.jsonl) | The vault's signed ledger, entries 0 to 3, byte for byte as the run wrote it, and it stays so. If the vault signs and anchors more entries later, the full ledger is committed as a new dated file beside this one, and the live verify commands (README, JUDGES.md, the testnet-and-mainnet docs page and `MAINNET_V0_LEDGER` in scripts/judge.mjs) move to it |
| [`snapshot-2026-11-13.json`](snapshot-2026-11-13.json) | The chain data and ledger the verifier read at 07:24:42 UTC |
| [`verify-2026-11-13.txt`](verify-2026-11-13.txt), [`verify-2026-11-13.json`](verify-2026-11-13.json) | The verifier's live run at 07:24:43 UTC, with the ledger and the invoice text, as text and as JSON. Its invoices line names the file's path on the owner's machine; the committed copy is `invoice-INV-M002.txt`, with the same sha256 (`bd45f232…`) |
| [`invoice-INV-M002.txt`](invoice-INV-M002.txt), [`po-PO-M002.txt`](po-PO-M002.txt) | The invoice and the purchase order, whose sha256 are on chain |
| `outcome-20261113T071746Z.json`, `outcome-20261113T072221Z.json`, `outcome-20261113T072425Z.json` | What the kit recorded for each cycle: `refused_by_code` twice, then `burned` |
| [`burn.json`](burn.json) | The burn the kit found in the spend's transaction: memo, owner and amount |
| [`poa-status.json`](poa-status.json) | The POA bridge's withdrawal status for spend 2 |
| [`oneclick-status-final.json`](oneclick-status-final.json) | 1Click's final status for the top-up: `SUCCESS`, 1500000 in, 1499823 out |
| `oneclick-quote-dry-20261113T070639Z.json`, `oneclick-quote-wet-20261113T070650Z.json` | The two 1Click quotes, the second with the deposit address |
| [`txs.log`](txs.log) | The kit's log of every transaction, by label (its times are when the kit logged each one) |
| [`gas-spend-2.json`](gas-spend-2.json) | The gas spend 2 burned, read from an archival node on 2026-11-13 |

## Check it

The verifier, read-only, from a clone after `pnpm install --frozen-lockfile` and `pnpm build`:

```bash
node packages/cli/dist/bin.js verify --network mainnet --vault v0.probarion.near \
  --ledger docs/evidence/mainnet-v0/s1-2026-11-13/ledger-2026-11-13.jsonl --invoice docs/evidence/mainnet-v0/s1-2026-11-13/invoice-INV-M002.txt \
  --evidence docs/evidence --proof docs/mainnet-proof.json
```

At 07:24:43 UTC the kit's live run printed `8 passed, 0 failed, 0 unproven, 1 skipped` and `RESULT: PASS`
([output](verify-2026-11-13.txt)). Checks a to h pass, and check i skips, because no factory made this vault:

- a, b and c: the 4 entries carry valid signatures by the ledger key, their hash links recompute, and the 3 anchors on
  chain match the ledger.
- d: spend 2 is bound to its own `allow` decision, entry 2 (same invoice, mandate and amount). Spend 1 is exempt as
  pre-ledger: its decision is a file in [`docs/evidence`](../../), and it was created before the first anchor.
- e: the 2 attested decisions, entries 0 and 1, pass A1 to A7, and A8 passes on both with the invoice text. Entry 2 is
  reported as rules-only, not failed.
- f and g: no full-access key, every key is the ledger key or the spend-only agent key, and no key is registered for
  the vault in `intents.near`.
- h: spend 2 has one matched burn pair: the `ft_burn` memo is `WITHDRAW_TO:` plus the mandate's address, and the
  vault's `mt_burn` is for the spend's amount.

Without the ledger, checks c and d fail: the chain's anchors cover 4 entries, and spend 2's decision is in no entry.
`--invoice` gives A8 the invoice text, which matches entries 0 and 1. The kit's run read the invoice from its own
folder, so its output names that local path; from a clone the verifier reads the committed copy, and A8 checks the
same invoice. To check the recorded run offline, with no network:

```bash
node packages/cli/dist/bin.js verify --offline docs/evidence/mainnet-v0/s1-2026-11-13/snapshot-2026-11-13.json --invoice docs/evidence/mainnet-v0/s1-2026-11-13/invoice-INV-M002.txt
```

The Base transfer, from Base's public RPC, with no key:

```bash
curl -s https://mainnet.base.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0xc2df8f8799467834cdaed0e8f23638af49334483387560fd34ef360939e1ea71"]}'
```

It answers `"status":"0x1"` and `"blockNumber":"0x363070a"` (56821514), with one log on the USDC contract
`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`: the `Transfer` topic, from `0x2cff890f0378a11913b6129b2e97417a2c302680`
to `0xb22eacdf11177d6d635e8956bbbbdd54b3e6eb27`, and data that ends in `f38e0`, which is 997600.

The vault's own views, with near-cli-rs:

```bash
near contract call-function as-read-only v0.probarion.near list_spends json-args '{"from_index":0,"limit":10}' network-config mainnet now
near contract call-function as-read-only v0.probarion.near get_mandate json-args '{"mandate_id":2}' network-config mainnet now
```

The transactions are also in [`contracts/deployments/mainnet.json`](../../../../contracts/deployments/mainnet.json)
(the top-up, mandate 2, spend 2 and the Base transfer) and in [`docs/mainnet-proof.json`](../../../mainnet-proof.json)
(the eight NEAR ones the owner and the kit signed, and the Base transfer as spend 2's `base_tx`). 1Click's settlement,
`FJA7rehn…`, is in neither: 1Click signed it.
