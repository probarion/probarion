# The testnet demo vault, 2026-11-09

`demo.vaults.probarion.testnet` is a vault created through the testnet factory from the web console at
[probarion.xyz](https://probarion.xyz), on 2026-11-09. A person signed every owner and approver step in their own
wallet or near-cli keychain, and the console's Payables agent sent each spend with the vault's agent key. Its proof
page is public: [probarion.xyz/proof/demo.vaults.probarion.testnet](https://probarion.xyz/proof/demo.vaults.probarion.testnet).

Test tokens only: `usdc.probarion.testnet` is `test-ft` acting as USDC, and has no value.

## Accounts

| Role | Account |
| --- | --- |
| Vault | `demo.vaults.probarion.testnet`, factory version 1, code hash `3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1` |
| Owner | `35008ecd0f274c7af302e0ecbcfe39211231069c3953cdb228ff5eca1399242b`, signing in Meteor Wallet |
| Approver | `probarion-approver.testnet`, signing with near-cli-rs (`sign-with-keychain`) |
| Payee | `probarion-payee.testnet` |
| Agent key | `ed25519:7qyNHfvNm2jpiGUVkmLo9gLWhe3C2XehtzhnKcFvSSuA`, label `demo-agent`, can call `spend` only |
| Ledger key | `ed25519:A5uLDeBHrSNB5nJQDmpzR3BHPhg4bN3YKQ6yhJwMh7vN`, can call `anchor` only |

## The four invoices

Mandate 1, "Sample PO-1001": pays `probarion-payee.testnet`, at most 5 USDC a payment and 20 in all, 5 payments,
until 2026-12-09, and holds a payment above 3 USDC for an approver. Its purpose hash is the sha256 of
[`po-PO-1001.txt`](po-PO-1001.txt). Each invoice went in with that PO attached. No attested model was set, so the
code read the amount and the owner confirmed it with a NEP-413 signature before anything was sent.

| Invoice | What it asks | What happened |
| --- | --- | --- |
| [`invoice-INV-2001.txt`](invoice-INV-2001.txt) | 2 USDC to the mandate's payee | The owner confirmed it, and spend 1 paid 2 USDC |
| `invoice-INV-2001.txt` again | The same file a second time | The console refused it on upload as a duplicate of the same text. Nothing was decided or sent, so the ledger has no entry for it |
| [`invoice-INV-2002.txt`](invoice-INV-2002.txt) | "We changed banks": 2 USDC to `new-account.testnet` | Refused by code, rule `mandate.payee_mismatch`. Nothing was sent. The refusal is ledger entry 3 |
| [`invoice-INV-2003.txt`](invoice-INV-2003.txt) | 4 USDC, above the 3 USDC approval limit | The owner confirmed it, and the vault held spend 2. The approver approved it from their own key, and it paid 4 USDC |

Each invoice's sha256 is the `invoice_hash` of its ledger entries and of its spend on chain.

## Transactions

| Time (UTC) | What | Transaction |
| --- | --- | --- |
| 11:21:48 | The owner creates the vault through the factory | [`9NzRf9XV…`](https://testnet.nearblocks.io/txns/9NzRf9XVahsLNVCewTmaHnHVN5KW89fSTusmwUuiC2MB) |
| 11:39:16 | The owner adds the agent key | [`BT4a9ES8…`](https://testnet.nearblocks.io/txns/BT4a9ES8KXtnCGWeyWvw4t2oCYNWqhf2P1Xmazo7X2Ug) |
| 11:40:37 | The owner sets the ledger key | [`CDTnjRub…`](https://testnet.nearblocks.io/txns/CDTnjRubFuosXhmA7jP9YdLPtRsPTVTWiuFMeTcaXpkY) |
| 11:41:36 | The testnet faucet mints 25 test USDC into the vault | [`9GGZoC1a…`](https://testnet.nearblocks.io/txns/9GGZoC1aaAtmj366JXoTV2FkJBfbax3jsHYCqjcXjd5m) |
| 11:45:32 | The owner signs mandate 1 | [`F8Qj4yNA…`](https://testnet.nearblocks.io/txns/F8Qj4yNAK8eTqTtjs7QbQuxMHCrm228jWNfGJHEiHpav) |
| 11:47:29 | Spend 1, INV-2001, paid | [`HFyW61UZ…`](https://testnet.nearblocks.io/txns/HFyW61UZXfwpqhgqWq9bXnRXaYiEnpk4WPUHDAEydQp1) |
| 11:53:34 | Spend 2, INV-2003, held | [`6oDNZEUB…`](https://testnet.nearblocks.io/txns/6oDNZEUBWMSZxLq2ANXMhWNxzii3irVAcqoXf7eHy2Tb) |
| 11:56:02 | The approver approves spend 2, which pays | [`47VCARhw…`](https://testnet.nearblocks.io/txns/47VCARhwsG2B7xbaFDS3f6nZdqR2gnQvBMofcP9FNCJf) |

The ledger key anchored the ledger five times, at 11:46:28, 11:47:36, 11:49:22, 11:50:39 and 11:53:40. The
approval is on chain only: no code writes an approver's decision to the ledger.

## Check it

[`verify-2026-11-09.txt`](verify-2026-11-09.txt) is the output of a live run at 2026-11-09T11:58Z, with release
0.1.0 from npm, which read the chain itself: checks a to i pass, `RESULT: PASS`.

That run wrote [`snapshot-2026-11-09.json`](snapshot-2026-11-09.json), the ledger and the chain data it read. Offline,
the verifier checks that file against itself, with no network:

```bash
npx probarion verify --offline docs/evidence/demo-vault/snapshot-2026-11-09.json
```

To read the chain again instead, download the vault's current ledger from its proof page and run
`npx probarion verify --network testnet --vault demo.vaults.probarion.testnet --ledger <file>`. The vault may have
acted since, so the counts can be higher than here. [`ledger-2026-11-09.jsonl`](ledger-2026-11-09.jsonl) is the
ledger as the proof page served it after the run: seven entries, five decisions and two payment results.

[`payments-2026-11-09.csv`](payments-2026-11-09.csv) is that snapshot as the proof page's payments download
(`/proof/<vault>/payments.csv`) writes it, for a spreadsheet: one row per decision, newest first, with its payment
entry and its spend's status on chain when the snapshot read it. Spend 2 reads `paid` there, though its payment entry
says `held`: the approver paid it on chain before the snapshot. Its Spend transaction is the spend tx that created the
hold and moved no USDC; the approve tx that paid it, `approve_tx` in
[`contracts/deployments/testnet.json`](../../../contracts/deployments/testnet.json), is in no ledger entry, so it is
not in the file. The three decisions with no spend on chain have an empty Payee: nothing was sent.
`apps/web/test/demo-vault.test.ts` makes the file from the snapshot and fails when the committed copy differs by a
byte.

## 2026-11-11: freeze, unfreeze and attested decisions

During the owner run recorded in [the trial vault's record](../trial-vault/README.md), the owner froze this vault
from the console's Freeze button and unfroze it again, both signed in Meteor. `get_config` read `frozen: false`
afterwards.

| Time (UTC) | What | Transaction |
| --- | --- | --- |
| 17:13:50 | The owner freezes the vault from the console | [`E2DjWAHD…`](https://testnet.nearblocks.io/txns/E2DjWAHDwm11ARDw3gzd3iofhLv7CjRarDmoLFVj2aV3) |
| 17:14:19 | The owner unfreezes it (1 yoctoNEAR) | [`3ASttDax…`](https://testnet.nearblocks.io/txns/3ASttDaxksgoTRiwixoQUS39MZpmTA62zQrZHF19vYz7) |

The same day three invoices went through Payables here with an attested NEAR AI model, and the code refused all
three. No transaction was sent, and mandate 1 kept its uses. So the Payables agent has not yet paid an invoice on its
own with an attested model. Entries 10 and 11 used `z-ai/glm-5.3-flash`, the SDK's first choice. For entry 12 the
site's model was pinned to `Qwen/Qwen3.8-27B` with `NEARAI_MODEL`.

| Ledger entry | Invoice | What the model answered | Why the code refused |
| --- | --- | --- | --- |
| 10, at 17:09:53 | [`invoice-INV-2006.txt`](invoice-INV-2006.txt): 2.00 test USDC to the mandate's payee | Pay, with a payee hint that named the mandate's own payee, `probarion-payee.testnet`, next to the chain `base` and no address (the proposal schema lets the chain be only `base` or `solana`) | `mandate.payee_mismatch`, a false positive: the rule read the chain alone as another destination. [PR #116](https://github.com/probarion/probarion/pull/116) fixed the rule, and it was live on probarion.xyz by 18:23 UTC |
| 11, at 18:24:14 | [`invoice-INV-2007.txt`](invoice-INV-2007.txt): the same invoice with a new number, since INV-2006 was now a duplicate | Pay 2.00 USDC with confidence 0.95, with reasoning that says the invoice's payee matches the mandate's. But its payee hint named `acme-cloud.near` and the name "Acme Cloud Services", which are in neither the invoice nor the prompt, with the chain `solana`, one of the two chains the schema allows | `mandate.payee_mismatch`: the code compares the model's payee hint with the mandate's payee, so a payee the model made up is refused like an invoice that names another payee |
| 12, at 23:35:56 | [`invoice-INV-2008.txt`](invoice-INV-2008.txt): the same invoice with a new number | Pay 2.00 USDC with confidence 0.98. Its reasoning, which says it did not know the schema, drafted the payee as the NEAR account `probarion-payee.testnet` with the chain `near`. Its JSON answer, which must match the schema, put that account in `address` next to the chain `base` | `mandate.payee_mismatch`, a false positive: the rule read the mandate's own account in `address` as another destination. Every other rule passed |

Entries 10 and 12 come from one gap in the proposal schema of template v1: it has no NEAR chain, and no field for a
NEAR account but `near_account`, so a model may name the mandate's own NEAR account next to a chain from the schema, or
in `address`. [PR #120](https://github.com/probarion/probarion/pull/120) lets the rule take that account in either
field as the mandate's payee, unless it is also a Base or Solana address. Entry 11 is a correct refusal: the account it
names is not the mandate's.

Each invoice's sha256 is the `invoice_hash` of its ledger entry. The proof page shows the three decisions, with the
model's answer and its attestation:
[entry 10](https://probarion.xyz/proof/demo.vaults.probarion.testnet#seq-10),
[entry 11](https://probarion.xyz/proof/demo.vaults.probarion.testnet#seq-11) and
[entry 12](https://probarion.xyz/proof/demo.vaults.probarion.testnet#seq-12).

### Check it again

[`ledger-2026-11-11.jsonl`](ledger-2026-11-11.jsonl) is the ledger as the proof page served it after entry 12:
thirteen entries. Entries 10 to 12 hold each model response in full, the inputs of each request with the invoice text
only as its sha256, the sha256 of the whole request, and the attestation evidence. Entries 7 to 9 are an invoice from
the evening of 2026-11-09, `invoice-INV-2004.txt` in the console, that this record does not otherwise cover: 4 test
USDC, sha256 `366f44db…`, refused while the owner had not confirmed it, then confirmed and held as spend 3, which the
chain shows paid.

[`verify-2026-11-11.txt`](verify-2026-11-11.txt) is a live run of release 0.1.1 from npm with that ledger, at
23:44 UTC, which read the chain itself: checks a to i pass, and check e finds 3 attested decisions that pass A1 to
A7. [`verify-online-2026-11-11.txt`](verify-online-2026-11-11.txt) is an earlier run with `--online`, at 18:52 UTC,
on the ledger as it was then, the first twelve entries of this file: for entries 10 and 11, Intel DCAP finds a genuine
TDX quote bound to the request (O1), and NVIDIA NRAS verifies a GPU payload bound to the request nonce (O2). An online
run after entry 12, at 23:45 UTC, failed four times because Intel's quote collateral could not be fetched
(`quote.collateral_unavailable`), so O1 and O2 are not recorded for entry 12. The TEE measurement is not pinned, so O1 does not show which image the
TD runs, and A8, which would check the request against the invoice, was not run. With the committed ledger, the
commands are:

```bash
npx probarion verify --network testnet --vault demo.vaults.probarion.testnet --ledger docs/evidence/demo-vault/ledger-2026-11-11.jsonl
npx probarion verify --network testnet --vault demo.vaults.probarion.testnet --ledger docs/evidence/demo-vault/ledger-2026-11-11.jsonl --online
```

The first run wrote [`snapshot-2026-11-11.json`](snapshot-2026-11-11.json), which checks offline:

```bash
npx probarion verify --offline docs/evidence/demo-vault/snapshot-2026-11-11.json
```
