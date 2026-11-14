# S2 on mainnet, 2026-11-13: a Base payout decided by an attested model and the code rules

Round 1 of 2026-11-13, [S1](../s1-2026-11-13/README.md), showed that `v0.probarion.near` can pay a Base address
through NEAR Intents (the mandate, the burn and the POA bridge) with a decision made by the code rules alone. Round 2,
S2, ran the same path with the decision made by an attested model on NEAR AI Cloud and the code rules together. On
2026-11-13, between 11:39 and 11:41 UTC (block times), the vault paid invoice INV-M003, 0.25 USDC, under a new
mandate 3 whose payee is the same Base address. `z-ai/glm-5.3-flash` proposed paying it, every code rule passed, and
the vault burned 0.25 Base USDC inside NEAR Intents with the memo
`WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27`. The POA bridge released 0.2476 USDC on Base and kept
0.0024 USDC as its fee; Probarion took none.

**A test, not a customer payment.** INV-M003 is a labeled sample: the second test of the cross-chain path, paid to
the owner's own Base address, the address round 1 paid. The amount is small on purpose, because the contract is
unaudited.

**Decided by an attested model and the code rules.** Ledger entry 4 is the decision: verdict `allow`, `decided_by`
`model+rules`. The model proposed `pay` for mandate 3 and 250000 (0.25 USDC), with confidence 0.92 and a payee hint
that names the mandate's Base address and no NEAR account. All 16 code rules passed: the 14 of round 1's rules-only
decision, plus `model.refused` and `model.low_confidence`. Before the SDK counted the answer, it checked the model's
evidence with A1 to A7 (the signature, the response, the recorded proposal and the attestation report agree with
each other and with ledger position 4) and with A8 (the request rebuilt from the invoice text). The TDX quote and the
GPU evidence are checked by `verify --online` (O1 and O2), which had not run on this decision when this record was
written ([it passed later that day](#the-online-check-2026-11-13)), and the TEE measurement is not pinned, so this
does not show which model image ran.

**The payee rule's later changes were not exercised.** Round 1's refusals came from a NEAR account in the model's payee
hint ([why round 1 was rules-only](../s1-2026-11-13/README.md#why-the-payout-was-decided-rules-only)). This hint
had no `near_account`, so `mandate.payee_mismatch` passed on the Base address alone: neither the rule change of
[PR #142](https://github.com/probarion/probarion/pull/142) nor the asset label of
[PR #144](https://github.com/probarion/probarion/pull/144) was exercised on mainnet.

**Who signed.** The owner ran the mainnet steps in their own terminal, with a second kit, copied from round 1's and
changed for round 2, kept outside this repository, that runs the SDK of this repository at commit `c85f41b` (`dev`
on 2026-11-13, with PR #144); the kit's digest was `b0b348ea…59c4`. The owner signed `create_mandate` with `probarion.near`. The kit signed the spend with the vault's
spend-only agent key, and the ledger entries and the anchor with the vault's ledger key, which can call `anchor`
alone; both key files stayed on the owner's machine. Claude signed nothing on mainnet. Round 2 added no USDC and no
key: it paid from the 0.499823 Base USDC that round 1 left in `intents.near`, wrote on round 1's ledger with the same
ledger key, and its kit had no rules-only path on mainnet.

**Rehearsed on testnet before mainnet.** The records of the rehearsals stay with the kit, outside this repository.

- Rehearsal 1, on `s2-rehearsal-1.vaults.probarion.testnet`, was refused by code: the model wrote
  `base-usdc.probarion.testnet (asset)`, the mandate's asset account with a label, in the hint's `near_account`, and
  `mandate.payee_mismatch` refused it. That led to PR #144, which reads a model's asset account given with such a
  short label as the mandate's own asset.
- Rehearsal 2, on `s2-rehearsal-2.vaults.probarion.testnet`, ran three cases with one set of kit files: a rules-only
  `allow`, which the kit's ledger guard refused (exit 5, nothing written or sent); a simulated model failure, tried
  once more and then stopped (exit 3, nothing written or sent); and a payment decided by an attested model and the
  code rules, spend [`DxYzHjvm…`](https://testnet.nearblocks.io/txns/DxYzHjvmauPKRG1neipDUJ23riw6GdKbajqvzterQTC2)
  and anchor [`37FgXGAQ…`](https://testnet.nearblocks.io/txns/37FgXGAQ9TVfS8w1Mm8ER1rPkgpHt7PQjhir2GADShaN), after
  which `verify` passed 9 of 9 checks.
- Then the mainnet steps ran. Each one compared the kit's files and the built SDK, byte for byte, with rehearsal 2's
  record before it sent anything.

These values were read again, read-only, from an archival NEAR node and from Base's public RPC on 2026-11-13.

## What ran, in order

Times are block times in UTC. NEAR transactions open on nearblocks, the Base one on Basescan.

| Time | What | Transaction | Signed by |
| --- | --- | --- | --- |
| 11:39:27 | `create_mandate` returns `3`: payee `0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27` on Base through NEAR Intents (the owner's own Base wallet), asset `base-0x8335…omft.near`, at most 0.25 USDC a payment and 0.25 in all, 1 payment, until 2026-11-20 00:00 UTC, `approval_above` 0.25 (so a payment of 0.25 is not held), label `s2 attested base payee`, purpose `PO-M003` | [`4cmSz4b3…`](https://nearblocks.io/txns/4cmSz4b3zHeWnbcw3HU6RJJ6afZa9zysu4SptE7mXT3T) | `probarion.near` |
| 11:40:29 | Ledger entry 4: `z-ai/glm-5.3-flash` proposes paying 0.25 USDC (confidence 0.92; it answered on attempt 1, in 38.2 s), and every code rule passes: `allow`, `model+rules`. Its body hash `d3807956…32aa` is the spend's `decision_hash` | None (off chain) | the ledger key |
| 11:41:10 | `spend` on mandate 3 for 0.25 USDC, ref `INV-M003`: spend 3 `burned`. The vault logs `spend_submitted` and calls `ft_withdraw` on `intents.near`, which logs an NEP-245 `mt_burn` of 250000 from the vault's balance; the token `base-0x8335…omft.near` then logs an `ft_burn` from `intents.near` with the memo `WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27`, and the vault logs `spend_burned` | [`5amtgb8M…`](https://nearblocks.io/txns/5amtgb8MujUkiydS5Ht9Ut6AX6pN9SGegHUCHGsX9NGH) | the agent key |
| 11:41:13 | Ledger entry 5: the payment, with the spend's transaction | None (off chain) | the ledger key |
| 11:41:16 | Anchor 4 of the ledger (6 entries) | [`6jRY21z9…`](https://nearblocks.io/txns/6jRY21z9FfGMnx5BbT3V1G3xBZp4FUaQ8p88N3TMbLyG) | the ledger key |
| 11:41:20 | On Base, block 56898526: the USDC contract `0x8335…2913` logs a `Transfer` of 247600 (0.2476 USDC) from `0x2cff…2680` to `0xb22e…eb27`. The POA bridge's status for spend 3 is `COMPLETED`, with this transfer, `withdrawal_fee` 2400 and `withdraw_amount` 247600 | [`0xc6c4507e…`](https://basescan.org/tx/0xc6c4507e098b558bdff1b5836600f5e3365fee5a63037d399db58e1db4547ab7) | the POA bridge |

Ledger entry times are the ledger's own `at` fields. The hashes on chain and the files behind them:

| Hash on chain | Value | The sha256 of |
| --- | --- | --- |
| Mandate 3 `purpose_hash` | `14a43998b80e8d3078c8ef34bfc6891fb094f2249ea3885100cf21a74df27ea2` | [`po-PO-M003.txt`](po-PO-M003.txt) |
| Spend 3 `invoice_hash` | `c246134881e52b147f9d4416f447e7151b7049d0e31cefcafa0db25027d683b6` | [`invoice-INV-M003.txt`](invoice-INV-M003.txt) |
| Spend 3 `decision_hash` | `d3807956b1e0a0481656862a50a2147d2b0a1f04834a30829529311c9cec32aa` | The body of entry 4 of [`ledger-2026-11-13.jsonl`](ledger-2026-11-13.jsonl) (its `body_hash`) |
| Anchor 4 `root` | `fcacffdcb0271ed35422ad8589b8435d32cf371f0d41c4cb1c959d583cb2c037` | Not a file hash: the `link` of entry 5, the last of the 6 entries |

## The ledger

The vault's signed ledger now holds 6 entries, anchored on chain 4 times, all signed by the ledger key round 1 set.
[`ledger-2026-11-13.jsonl`](ledger-2026-11-13.jsonl) in this folder is the whole ledger, byte for byte as the run
wrote it. Its leading 252113 bytes, entries 0 to 3, are round 1's file
([`../s1-2026-11-13/ledger-2026-11-13.jsonl`](../s1-2026-11-13/ledger-2026-11-13.jsonl)) byte for byte, and both files
stay as they are. Round 1's README says a longer ledger would be committed as a new dated file beside its own; this is
that file, in its own folder.

| Entry | Kind | Round | What |
| --- | --- | --- | --- |
| 0 | decision | 1 | `z-ai/glm-5.3-flash` proposed paying INV-M002; code refused it with `mandate.payee_mismatch` |
| 1 | decision | 1 | `Qwen/Qwen3.8-27B` proposed paying INV-M002; code refused it the same way |
| 2 | decision | 1 | A rules-only `allow` for INV-M002, the decision behind spend 2 |
| 3 | payment | 1 | Spend 2 `burned`, 1.00 USDC |
| 4 | decision | 2 | `z-ai/glm-5.3-flash` proposed paying INV-M003; `allow`, `model+rules`, the decision behind spend 3 |
| 5 | payment | 2 | Spend 3 `burned`, 0.25 USDC |

## The vault after the run

Read with view calls on 2026-11-13, after the run (block 224359161):

- Native USDC 2.000000, unchanged, and 0.249823 Base USDC inside `intents.near` (`mt_balance_of`), 0.25 less than the
  0.499823 before round 2.
- Mandate 1: `active`, 1 USDC and 1 payment left, paying `probarion-duong.near`. Mandates 2 and 3: `exhausted`, each
  with its 1 payment made.
- Spends: spend 1 `paid` (2026-11-11, pre-ledger), and spends 2 and 3 `burned`, each with the memo
  `WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27`.
- Access keys: no full-access key. The agent key (`spend` alone, allowance 0.2462 NEAR) and the ledger key (`anchor`
  alone, allowance 0.2492 NEAR). No public key in `intents.near`.
- Code hash `3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1`, unchanged.

Spend 3 burned 15.36 Tgas, 0.001424 NEAR, summed over the transaction and its receipts from an archival node
([record](gas-spend-3.json)).

## The files

| File | What it is |
| --- | --- |
| [`ledger-2026-11-13.jsonl`](ledger-2026-11-13.jsonl) | The vault's signed ledger, entries 0 to 5, byte for byte as the run wrote it |
| [`snapshot-2026-11-13.json`](snapshot-2026-11-13.json) | The chain data and ledger the verifier read at 11:41:25 UTC |
| [`verify-2026-11-13.txt`](verify-2026-11-13.txt), [`verify-2026-11-13.json`](verify-2026-11-13.json) | The verifier's output with the ledger and the two invoice texts: as text, the live run at 11:41:26 UTC, and as JSON, the kit's offline report on the snapshot that run wrote, at 11:41:27 UTC. The invoices line names the files' paths on the owner's machine; the committed copies are [`../s1-2026-11-13/invoice-INV-M002.txt`](../s1-2026-11-13/invoice-INV-M002.txt) and [`invoice-INV-M003.txt`](invoice-INV-M003.txt), with the same sha256 (`bd45f232…` and `c2461348…`) |
| [`verify-online-2026-11-13.txt`](verify-online-2026-11-13.txt) | The verifier's output of a later read-only run with `--online`, at 17:52 UTC on 2026-11-13 ([the online check](#the-online-check-2026-11-13)) |
| [`invoice-INV-M003.txt`](invoice-INV-M003.txt), [`po-PO-M003.txt`](po-PO-M003.txt) | The invoice and the purchase order, whose sha256 are on chain |
| [`outcome-20261113T114028Z.json`](outcome-20261113T114028Z.json) | What the kit recorded for the cycle: `burned`, the model's proposal, its tokens and attempts, and the model rules |
| [`spend-decision-20261113T114124Z.json`](spend-decision-20261113T114124Z.json) | The decision behind spend 3, as the kit read it: entry 4, `allow`, `model+rules`, attested |
| [`burn.json`](burn.json) | The burn the kit found in the spend's transaction: memo, owner and amount |
| [`poa-status.json`](poa-status.json) | The POA bridge's withdrawal status for spend 3 |
| [`base-receipt.json`](base-receipt.json) | The kit's read of the Base transfer: status, block, the USDC transfer it found and the one it expected |
| [`txs.log`](txs.log) | The kit's log of every transaction, by label (its times are when the kit logged each one) |
| [`gas-spend-3.json`](gas-spend-3.json) | The gas spend 3 burned, read from an archival node on 2026-11-13 |

## Check it

The verifier, read-only, from a clone after `pnpm install --frozen-lockfile` and `pnpm build`:

```bash
node packages/cli/dist/bin.js verify --network mainnet --vault v0.probarion.near \
  --ledger docs/evidence/mainnet-v0/s2-2026-11-13/ledger-2026-11-13.jsonl \
  --invoice docs/evidence/mainnet-v0/s1-2026-11-13/invoice-INV-M002.txt --invoice docs/evidence/mainnet-v0/s2-2026-11-13/invoice-INV-M003.txt \
  --evidence docs/evidence --proof docs/mainnet-proof.json
```

At 11:41:26 UTC the kit's live run printed `8 passed, 0 failed, 0 unproven, 1 skipped` and `RESULT: PASS`
([output](verify-2026-11-13.txt)). Checks a to h pass, and check i skips, because no factory made this vault:

- a, b and c: the 6 entries carry valid signatures by the ledger key, their hash links recompute, and the 4 anchors on
  chain match the ledger.
- d: spends 2 and 3 are each bound to their own `allow` decision, entries 2 and 4 (same invoice, mandate and
  amount). Spend 1 is exempt as pre-ledger: its decision is a file in [`docs/evidence`](../../), and it was created
  before anchor 1.
- e: the 3 attested decisions, entries 0, 1 and 4, pass A1 to A7, and A8 passes on all three with the two invoice
  texts. Entry 2 is reported as rules-only, not failed. Check e also notes, not as failures, that each model was shown
  its mandate as active with budget left, while the chain now holds it as `exhausted`, and that the quote is not
  verified offline.
- f and g: no full-access key, every key is the ledger key or the spend-only agent key, and no key is registered for
  the vault in `intents.near`.
- h: spends 2 and 3 each have one matched burn pair: the `ft_burn` memo is `WITHDRAW_TO:` plus the mandate's address,
  and the vault's `mt_burn` is for the spend's amount.

The kit ran these checks from its own SDK clone at `c85f41b`, not with the command above as written: with that
clone's `docs/evidence`, the two burn transactions given with `--burn-tx` in place of `--proof` (that commit's proof
file had no spend 3), both invoices read from the kit's own folder with `--invoices`, so its output names those local
paths, and the snapshot written with `--snapshot`. The command above, with `--proof docs/mainnet-proof.json` and
`--invoice` twice for the committed copies, gives the same `8 passed, 0 failed, 0 unproven, 1 skipped`, and A8 checks
the same texts: the judge's `live-verify-mainnet-v0` step runs it. With round 1's ledger of 4 entries
in place of this one, check c fails, because the chain's last anchor covers 6 entries, and check d fails, because
spend 3's decision is in none of them. To check the recorded run offline, with no network:

```bash
node packages/cli/dist/bin.js verify --offline docs/evidence/mainnet-v0/s2-2026-11-13/snapshot-2026-11-13.json \
  --invoice docs/evidence/mainnet-v0/s1-2026-11-13/invoice-INV-M002.txt --invoice docs/evidence/mainnet-v0/s2-2026-11-13/invoice-INV-M003.txt
```

The Base transfer, from Base's public RPC, with no key:

```bash
curl -s https://mainnet.base.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0xc6c4507e098b558bdff1b5836600f5e3365fee5a63037d399db58e1db4547ab7"]}'
```

It answers `"status":"0x1"` and `"blockNumber":"0x36433de"` (56898526), with one log on the USDC contract
`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`: the `Transfer` topic, from `0x2cff890f0378a11913b6129b2e97417a2c302680`
to `0xb22eacdf11177d6d635e8956bbbbdd54b3e6eb27`, and data that ends in `3c730`, which is 247600.

The vault's own views, with near-cli-rs:

```bash
near contract call-function as-read-only v0.probarion.near list_spends json-args '{"from_index":0,"limit":10}' network-config mainnet now
near contract call-function as-read-only v0.probarion.near get_mandate json-args '{"mandate_id":3}' network-config mainnet now
```

The transactions are also in [`contracts/deployments/mainnet.json`](../../../../contracts/deployments/mainnet.json)
(mandate 3, spend 3 and the Base transfer) and in [`docs/mainnet-proof.json`](../../../mainnet-proof.json) (the three
NEAR ones, with the Base transfer as spend 3's `base_tx`).

## The online check, 2026-11-13

On 2026-11-13 at 17:52 UTC a later read-only run of the command in [Check it](#check-it), with `--online` added and
`--snapshot` to a scratch file, passed O1 and O2 for all three attested decisions, entries 0, 1 and 4
([output](verify-online-2026-11-13.txt)). It printed `8 passed, 0 failed, 0 unproven, 1 skipped` and `RESULT: PASS`.
Check e: the three pass A1 to A7 and A8, and online it found 3 DCAP-genuine TDX quotes bound to their requests (O1:
debug off, an accepted TCB status, report_data matches) and 3 GPU payloads bound to the request nonce and verified by
NVIDIA NRAS (O2). The measurement is not pinned, so O1 does not show which image ran, and `quote_verified` stays false.
That run's snapshot is not committed. The CLI runs O1 and O2 in a live run with `--online`, and its `verify --offline`
refuses `--online`, so the offline command above checks the recorded snapshot of 11:41:25 UTC without them.
