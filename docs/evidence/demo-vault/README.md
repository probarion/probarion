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
afterwards. The owner did both again on 2026-11-12,
[below](#2026-11-12-filmed-a-second-invoice-paid-on-its-own-freeze-and-unfreeze).

| Time (UTC) | What | Transaction |
| --- | --- | --- |
| 17:13:50 | The owner freezes the vault from the console | [`E2DjWAHD…`](https://testnet.nearblocks.io/txns/E2DjWAHDwm11ARDw3gzd3iofhLv7CjRarDmoLFVj2aV3) |
| 17:14:19 | The owner unfreezes it (1 yoctoNEAR) | [`3ASttDax…`](https://testnet.nearblocks.io/txns/3ASttDaxksgoTRiwixoQUS39MZpmTA62zQrZHF19vYz7) |

The same day three invoices went through Payables here with an attested NEAR AI model, and the code refused all
three. No transaction was sent, and mandate 1 kept its uses. So that day the Payables agent had not yet paid an invoice
on its own with an attested model; it did on 2026-11-12,
[below](#2026-11-12-payables-pays-on-its-own-with-an-attested-model). Entries 10 and 11 used `z-ai/glm-5.3-flash`,
the SDK's first choice. For entry 12 the site's model was pinned to `Qwen/Qwen3.8-27B` with `NEARAI_MODEL`.

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

### The files of 2026-11-11

[`ledger-2026-11-11.jsonl`](ledger-2026-11-11.jsonl) is the ledger as the proof page served it after entry 12:
thirteen entries. Entries 10 to 12 hold each model response in full, the inputs of each request with the invoice text
only as its sha256, the sha256 of the whole request, and the attestation evidence. Entries 7 to 9 are an invoice from
the evening of 2026-11-09, `invoice-INV-2004.txt` in the console, that this record does not otherwise cover: 4 test
USDC, sha256 `366f44db…`, refused while the owner had not confirmed it, then confirmed and held as spend 3, which the
chain shows paid. The ledger of 2026-11-12, [below](#check-it-again), starts with these thirteen entries, unchanged.

[`verify-2026-11-11.txt`](verify-2026-11-11.txt) is a live run of release 0.1.1 from npm with that ledger, at
23:44 UTC, which read the chain itself: checks a to i pass, and check e finds 3 attested decisions that pass A1 to
A7. [`verify-online-2026-11-11.txt`](verify-online-2026-11-11.txt) is an earlier run with `--online`, at 18:52 UTC,
on the ledger as it was then, the first twelve entries of this file: for entries 10 and 11, Intel DCAP finds a genuine
TDX quote bound to the request (O1), and NVIDIA NRAS verifies a GPU payload bound to the request nonce (O2). An online
run after entry 12, at 23:45 UTC, failed four times because Intel's quote collateral could not be fetched
(`quote.collateral_unavailable`), so that day O1 and O2 were not recorded for entry 12. The online run of 2026-11-12
records them. The live run of 2026-11-11 wrote [`snapshot-2026-11-11.json`](snapshot-2026-11-11.json), which still
checks offline:

```bash
npx probarion verify --offline docs/evidence/demo-vault/snapshot-2026-11-11.json
```

A live run reads the chain as it is now, so run it with the newest ledger, as in
[the files of the filmed run](#the-files-of-the-filmed-run).

## 2026-11-12: Payables pays on its own with an attested model

At 01:09 UTC [`invoice-INV-2009.txt`](invoice-INV-2009.txt), a copy of INV-2008 with only the number changed, went in
with [`po-PO-1001.txt`](po-PO-1001.txt) on this vault's Payables page, in the console signed in as the owner. Claude
drove the console in the owner's browser. probarion.xyz ran `main` as promoted by
[PR #121](https://github.com/probarion/probarion/pull/121), and `NEARAI_MODEL` was still `Qwen/Qwen3.8-27B`. No wallet
signature was needed: the vault's agent key signs spends. The console's row for the invoice reads "Paid on NEAR".

| Ledger entries | Invoice | What the model answered | What the code and the contract did |
| --- | --- | --- | --- |
| 13, at 01:09:12, and 14, at 01:09:28 | [`invoice-INV-2009.txt`](invoice-INV-2009.txt): 2.00 test USDC to the mandate's payee, the same invoice with a new number | Pay 2.00 USDC under mandate 1 with confidence 0.98, with a payee hint that put the mandate's own payee, `probarion-payee.testnet`, in `near_account` and as the name, with no chain and no address. Its reasoning says the payee matches the mandate's, the amount is within `max_per_payment` and what is left, and the purpose hash matches | Every rule passed, and entry 13 records `allow`, decided by `model+rules`. The agent key sent spend 4 at 01:09:25 ([`EA7MbLts…`](https://testnet.nearblocks.io/txns/EA7MbLtsRjQUBbycfNyh6u1ieLNU5WXtyGy2K8eiPBuU)), and the contract paid 2.00 test USDC to `probarion-payee.testnet` (`ft_transfer` with the memo `probarion:4`). Entry 14 records spend 4 as paid. At 01:09:32 the ledger key anchored all 15 entries ([`CWjStzJd…`](https://testnet.nearblocks.io/txns/CWjStzJd9T7Qfwp1LEELx62NQTwvjrU1Y2a8kSeNYkjW)) |

After the payment, `get_spend` read spend 4 as paid to `probarion-payee.testnet`. Mandate 1 had spent 12 of its 20
test USDC and used 4 of its 5 payments, so one was left, with nothing reserved. The vault held 13 test USDC.

The payee hint of entry 13 named the account in `near_account`, with no chain and no address. The rule took that shape
as the mandate's payee before [PR #120](https://github.com/probarion/probarion/pull/120) too, so this payment did not
depend on #120. A model's answer is not the same from run to run. For invoices that differ only in their number,
`z-ai/glm-5.3-flash` gave the mandate's account next to the chain `base` in entry 10, then another account with the
chain `solana` in entry 11, and `Qwen/Qwen3.8-27B` put the mandate's account in `address` next to `base` in entry 12
and in `near_account` alone in entry 13.

That was one invoice, on testnet, with test tokens that have no value. Payables has not run on mainnet. The invoice's
sha256 is the `invoice_hash` of entry 13 and of spend 4. The proof page shows the decision, with the model's answer
and its attestation: [entry 13](https://probarion.xyz/proof/demo.vaults.probarion.testnet#seq-13).

### Check it again

[`ledger-2026-11-12.jsonl`](ledger-2026-11-12.jsonl) is the vault's ledger after entry 14: fifteen entries, the first
thirteen of them the file of 2026-11-11. Entries 10 to 13 hold each model response in full, the inputs of each request
with the invoice text only as its sha256, the sha256 of the whole request, and the attestation evidence.

[`verify-2026-11-12.txt`](verify-2026-11-12.txt) is a live run of release 0.1.1 from npm with that ledger, at
01:10 UTC, which read the chain itself: checks a to i pass (`9 passed, 0 failed, 0 unproven`), check c finds 11
anchors and no entry after the last anchored count of 15, check d finds 4 spends on chain, each bound to its own
decision, and check e finds 4 attested decisions that pass A1 to A7.
[`verify-online-2026-11-12.txt`](verify-online-2026-11-12.txt) is a second live run with that ledger and `--online`,
14 seconds later: for all four attested decisions, entries 10 to 13, Intel DCAP finds a genuine TDX quote bound to
the request (O1), and NVIDIA NRAS verifies a GPU payload bound to the request nonce (O2). The TEE measurement is not
pinned, so O1 does not show which image the TD runs, and A8, which would check the request against the invoice, was
not run. With the committed ledger, the commands are:

```bash
npx probarion verify --network testnet --vault demo.vaults.probarion.testnet --ledger docs/evidence/demo-vault/ledger-2026-11-12.jsonl
npx probarion verify --network testnet --vault demo.vaults.probarion.testnet --ledger docs/evidence/demo-vault/ledger-2026-11-12.jsonl --online
```

Once the vault anchors entries this file does not hold, a live run with it can stop passing check c. That happened at
09:52 UTC the same day: anchor 12 covers 17 entries, so a live run with this file now fails check c, and check d too,
since the decision of spend 5 is entry 15. For a live run, use the ledger of
[the filmed run](#the-files-of-the-filmed-run). The first run wrote
[`snapshot-2026-11-12.json`](snapshot-2026-11-12.json), which keeps checking offline:

```bash
npx probarion verify --offline docs/evidence/demo-vault/snapshot-2026-11-12.json
```

## 2026-11-12, filmed: a second invoice paid on its own, freeze and unfreeze

At 09:52 UTC [`invoice-INV-2010.txt`](invoice-INV-2010.txt), a copy of INV-2009 with a new number and no other change,
went in with [`po-PO-1001.txt`](po-PO-1001.txt) on this vault's Payables page, in the console signed in as the owner,
in a run filmed for the [demo video](https://x.com/probarionhq/status/2120882499689836651). probarion.xyz ran `main` as promoted by
[PR #130](https://github.com/probarion/probarion/pull/130), which holds
[PR #120](https://github.com/probarion/probarion/pull/120). No wallet signature was needed for the payment: the
vault's agent key signs spends. The console's page for the invoice read "Decided: Paid on NEAR."

| Ledger entries | Invoice | What the model answered | What the code and the contract did |
| --- | --- | --- | --- |
| 15, at 09:52:10, and 16, at 09:52:40 | [`invoice-INV-2010.txt`](invoice-INV-2010.txt): 2.00 test USDC to the mandate's payee, the same invoice with a new number | `Qwen/Qwen3.8-27B` proposed paying 2.00 test USDC under mandate 1 with confidence 0.98, with a payee hint that put the mandate's own payee, `probarion-payee.testnet`, in `address` and as the name, next to the chain `base`. Its reasoning says the invoice's payee matches the mandate's, the amount is within `max_per_payment` and what is left, and the PO and purpose hashes match | Every rule passed, and entry 15 records `allow`, decided by `model+rules`; the payee rule's detail reads "destination is the mandate payee near:probarion-payee.testnet". The agent key sent spend 5 at 09:52:36 ([`3YEGw5Qd…`](https://testnet.nearblocks.io/txns/3YEGw5Qdp9RbnR5LXFbAKXWPPhgiz7hf6vdDapfXvEE4), block 277346837), and the contract paid 2.00 test USDC to `probarion-payee.testnet` (`ft_transfer` with the memo `probarion:5`). Entry 16 records spend 5 as paid. At 09:52:44 the ledger key anchored all 17 entries ([`3n99Suaq…`](https://testnet.nearblocks.io/txns/3n99Suaq6scqcr9KLXKdmuiJiaEU5er4WzqQZYmb3WGn), anchor 12, block 277346850) |

After the payment the chain read spend 5 as paid to `probarion-payee.testnet`. Mandate 1 had spent 14 of its 20 test
USDC and used all 5 of its payments, with nothing reserved, so its status reads `exhausted`. The vault held 11 test
USDC.

Entry 15's payee hint has the same fields and values as entry 12's, which the rule refused on 2026-11-11
(`mandate.payee_mismatch`, a false positive, [above](#2026-11-11-freeze-unfreeze-and-attested-decisions)). With
[PR #120](https://github.com/probarion/probarion/pull/120) the rule took the account in `address` as the mandate's
payee, so this payment, unlike the one of entry 13, depended on #120.

With the invoice of 01:09 UTC, that makes two invoices that Payables paid on its own with an attested model, both on
testnet, with test tokens that have no value. Payables has not run on mainnet. The TEE measurement is not pinned, so
this does not show which model image ran, and A8 was not run. The invoice's sha256 is the `invoice_hash` of entry 15
and of spend 5. The proof page shows the decision, with the model's answer and its attestation, and the spend:
[entry 15](https://probarion.xyz/proof/demo.vaults.probarion.testnet#seq-15) and
[spend 5](https://probarion.xyz/proof/demo.vaults.probarion.testnet#spend-5).

### Freeze and unfreeze again

At 10:05 UTC, later in the same filming, the owner froze this vault from the console's Freeze button and unfroze it
again, both signed in Meteor with the same access key as on 2026-11-11 (`ed25519:4Zu6sqAx…`). This is a second, dated
record of the two buttons, after the one of [2026-11-11](#2026-11-11-freeze-unfreeze-and-attested-decisions).
`get_config` read `frozen: true` at block 277348237, between the two, and `frozen: false` at block 277348260, after
the unfreeze.

| Time (UTC) | What | Transaction |
| --- | --- | --- |
| 10:05:31 | The owner freezes the vault from the console | [`EFzfZejb…`](https://testnet.nearblocks.io/txns/EFzfZejbWZmrQoaBx27jC24RiVGZYTfh1yceXRPCxTXi) |
| 10:05:58 | The owner unfreezes it (1 yoctoNEAR) | [`GnmaUkKX…`](https://testnet.nearblocks.io/txns/GnmaUkKXsKkgoMn6EaLZ5joyvaFLi6fQZjKi3NLyJrh7) |

The freeze is in block 277348192 and the unfreeze in block 277348238. The ledger the proof page served at 10:28 UTC
has no entry after entry 16: no decision was made while the vault was frozen, so this record does not show a spend
refused by the freeze.

### The files of the filmed run

[`ledger-2026-11-12-video.jsonl`](ledger-2026-11-12-video.jsonl) is the vault's ledger as the proof page served it at
10:28 UTC, after the freeze and unfreeze: seventeen entries, of which entries 0 to 14 are
[`ledger-2026-11-12.jsonl`](ledger-2026-11-12.jsonl), byte for byte. Entry 15 holds the model response in full, the
inputs of the request with the invoice text replaced by its sha256, the sha256 of the whole request, and the
attestation evidence; entry 16 is the payment result.

[`snapshot-2026-11-12-video.json`](snapshot-2026-11-12-video.json) is the proof page's snapshot download
(`/proof/<vault>/snapshot.json`), taken at 10:28:54 UTC: the same seventeen entries and the chain data the site read.
[`verify-2026-11-12-video.txt`](verify-2026-11-12-video.txt) is the offline run on it of the CLI built from this
repository: checks a to i pass (`9 passed, 0 failed, 0 unproven`), check c finds 12 anchors and no entry after the
last anchored count of 17, check d finds 5 spends on chain, each bound to its own decision, and check e finds 5
attested decisions that pass A1 to A7. The online run of 2026-11-12 ([output](verify-online-2026-11-12.txt)) was at
01:10 UTC, before entry 15, so O1 and O2 were not run on entry 15. From a clone of the repository:

```bash
npx probarion verify --offline docs/evidence/demo-vault/snapshot-2026-11-12-video.json
npx probarion verify --network testnet --vault demo.vaults.probarion.testnet --ledger docs/evidence/demo-vault/ledger-2026-11-12-video.jsonl
```

The second command reads the chain as it is now, so once the vault anchors entries this file does not hold, it can stop
passing check c. With `--online` it also runs O1 and O2.

## 2026-11-12: A8 with the invoices in this folder

The ledger holds each invoice only as its sha256, so A1 to A7 and the online checks O1 and O2 do not show what text the
model was sent. A8 does, for someone who holds the invoice: it rebuilds the request from the invoice text, the inputs
the entry records and the ledger nonce, checks that it hashes to the request the model signed, and checks that the
mandates the model was shown are the vault's. `probarion verify` takes the texts with `--invoice <file>` or
`--invoices <dir>` (every `.txt` file of the folder), in the CLI built from this repository; release 0.1.1 on npm does
not have these flags. The files are read on the computer that runs verify and used for A8 only: the report names each
file, and `--json` adds its sha256, but not its text.

[`verify-a8-2026-11-12.txt`](verify-a8-2026-11-12.txt) is the offline run on
[`snapshot-2026-11-12-video.json`](snapshot-2026-11-12-video.json) with this folder, its command on the first line:
checks a to i pass (`9 passed, 0 failed, 0 unproven`), and check e finds that A8 passes on all five attested
decisions, entries 10 to 13 and 15, each against the file whose sha256 is its `invoice_hash`
([`invoice-INV-2006.txt`](invoice-INV-2006.txt) to [`invoice-INV-2010.txt`](invoice-INV-2010.txt)). The run read 15
`.txt` files. INV-2001 to INV-2003 match only entries that are not attested decisions (rules-only decisions and payment
results), and the PO and the earlier verify outputs match no ledger entry. The report lists both groups, and neither
fails the run. A run now also reads the output files committed with it, and lists them as matching no entry too.

[`verify-online-a8-2026-11-12.txt`](verify-online-a8-2026-11-12.txt) is a live run of the same CLI 26 seconds later,
on Node.js 24.22.2, with [the ledger of the filmed run](ledger-2026-11-12-video.jsonl), `--online` and this folder. It
read the chain itself: checks a to i pass, check c finds 12 anchors and no entry after the last anchored count of 17,
and check e finds 5 attested decisions that pass A1 to A7 and A8. For all five, entry 15 among them, Intel DCAP finds a
genuine TDX quote bound to the request (O1), and NVIDIA NRAS verifies a GPU payload bound to the request nonce (O2).
The TEE measurement is not pinned, so this does not show which model image ran. A8 shows that the model was sent these
invoice texts in the standard request; it does not show that an invoice is authentic. Check e also notes that mandate
1's `remaining` and `status` now differ from what the model was shown, because the vault has paid since then: the values
at decision time need archival state, so these are notes, not failures. From a clone of the repository, after
`pnpm install` and `pnpm --filter "./packages/*" run build`:

```bash
node packages/cli/dist/bin.js verify --offline docs/evidence/demo-vault/snapshot-2026-11-12-video.json --invoices docs/evidence/demo-vault
node packages/cli/dist/bin.js verify --network testnet --vault demo.vaults.probarion.testnet --ledger docs/evidence/demo-vault/ledger-2026-11-12-video.jsonl --online --invoices docs/evidence/demo-vault
```

The second command reads the chain as it is now, so once the vault anchors entries the ledger file does not hold, it
can stop passing check c. The online checks need Node.js 24.22.1 or newer, which `@nearai/inference-sdk` declares.
