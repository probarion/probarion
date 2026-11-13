# Probarion for judges

The mechanism and the five links below take two minutes; the rest is the evidence, the limits and the business
hypothesis. Each claim links its evidence here or on chain; times are UTC; the full record is the [README](README.md).

**The mechanism.** The agent's NEAR key is a function-call key that can call `spend` and nothing else, and `spend` takes
no address, so the vault contract pays the payee of a mandate the owner signed, within its caps per payment and in
total, its number of uses and its expiry; a private model in a TEE on NEAR AI Cloud may propose a payment,
deterministic code rules decide, and the contract checks again; and every decision Probarion's code makes, refusals
included, is signed into a hash-chained Ed25519 ledger whose root is anchored on the vault once it has a ledger key.

## Open these five links

1. **The demo vault's proof page.** [probarion.xyz/proof/demo.vaults.probarion.testnet](https://probarion.xyz/proof/demo.vaults.probarion.testnet)
   runs checks a to i on the testnet demo vault's signed ledger and chain data (the ledger's signatures, hash links and
   anchors on chain, a decision behind every spend, the attestations, a vault with no full-access key, Intents keys,
   burn memos and factory version), and A1 to A7 for each decision made with model output (offline checks that the
   model answer's signature, attestation report and nonce agree with each other and with its ledger entry). On it,
   press **Check the TEE now** ([direct link](https://probarion.xyz/proof/demo.vaults.probarion.testnet#tee-check)): for
   a nonce your browser draws it shows nonce bound, signer bound, O1 (Intel DCAP) and O2 (NVIDIA NRAS) for the TEE that
   serves the model now. On 2026-11-12 all four passed on probarion.xyz ([evidence](docs/evidence/tee-check/live-2026-11-12.json)).
2. **Ask the contract.** The landing page's [live `check_spend`](https://probarion.xyz/#try) sends a spend you pick (a
   normal invoice, a hijacked prompt, mandate 999, someone else's key) from your browser to the testnet vault
   `v0.probarion.testnet` and shows the contract's answer word for word.
3. **Mainnet, 2026-11-11.** On `v0.probarion.near`, with real USDC, spend 1 paid 1 USDC under mandate 1 ([`22oqhgru…`](https://nearblocks.io/txns/22oqhgruo7JqdpPg5Cb2ts25mLK2fto8y1YAxNA56ieE)),
   and a spend against mandate 999 was refused on chain with `PROBARION:NoMandate` ([`2Dabq4uM…`](https://nearblocks.io/txns/2Dabq4uMh9VvttH3uj85samfYoX2wbQheADHS96AtwYh)).
   The owner sent both with the vault's spend-only key from their own terminal, without the SDK ([the run](README.md#near-mainnet-2026-11-11)).
4. **Mainnet, 2026-11-13: a Base payout.** On the same vault, spend 2 burned 1.00 USDC inside NEAR Intents with the
   memo `WITHDRAW_TO:` and mandate 2's Base address ([`BdN7oB76…`](https://nearblocks.io/txns/BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9)),
   and the POA bridge released 0.9976 USDC on Base ([`0xc2df8f87…`](https://basescan.org/tx/0xc2df8f8799467834cdaed0e8f23638af49334483387560fd34ef360939e1ea71)).
   It is a test paid to the owner's own Base address, not a customer payment, and code rules alone decided it, after
   code refused two attested model proposals for the same invoice. The vault's signed ledger is committed, and the
   live `verify` passed checks a to h on it that morning ([the run](docs/evidence/mainnet-v0/s1-2026-11-13/README.md)).
5. **Mainnet, 2026-11-13: a Base payout decided by an attested model and the code rules.** On the same vault, `z-ai/glm-5.3-flash` on NEAR
   AI Cloud proposed paying INV-M003, every code rule passed, and spend 3 burned 0.25 USDC inside NEAR Intents with the
   memo `WITHDRAW_TO:` and mandate 3's Base address ([`5amtgb8M…`](https://nearblocks.io/txns/5amtgb8MujUkiydS5Ht9Ut6AX6pN9SGegHUCHGsX9NGH));
   the POA bridge released 0.2476 USDC on Base ([`0xc6c4507e…`](https://basescan.org/tx/0xc6c4507e098b558bdff1b5836600f5e3365fee5a63037d399db58e1db4547ab7)).
   It is a second test paid to the owner's own Base address, not a customer payment. The SDK checked the model's
   evidence (A1 to A8) before counting its answer; `verify --online` (O1 and O2: the TDX quote and the GPU evidence)
   has not run on it. With the ledger of 6 entries, the live `verify` passes checks a to h
   ([the run](docs/evidence/mainnet-v0/s2-2026-11-13/README.md)).

## Run it

```bash
git clone https://github.com/probarion/probarion.git
cd probarion
pnpm install --frozen-lockfile
pnpm judge --offline --quick   # no network and no package tests
pnpm judge                     # also the live read-only steps on testnet and mainnet, and the package tests
```

It needs Node.js 24 and pnpm 10, prints one row per step with the README line it proves, and exits 0 when no step
failed. On 2026-11-13 an offline quick run at commit 6193a71 ended so (the time varies; the EXPECTED-FAIL is the
Canary's snapshot of 2026-11-10, which has no ledger):

```text
judge: 19 PASS, 1 EXPECTED-FAIL, 14 SKIPPED, 0 FAIL in 30.4 s. Nothing was signed or sent. Report: judge-report.json. Exit 0.
```

Later commits add steps. Since S2 the same run also checks S2's snapshot and A8 on the mainnet vault's 3 attested
decisions, with the two committed invoices, so it ends with 21 PASS, 1 EXPECTED-FAIL, 14 SKIPPED, 0 FAIL.

- `verify --online`, which runs O1 and O2, uses `@nearai/inference-sdk`, whose `engines` field declares Node.js 24.22.1
  or newer; the CLI loads it without checking the Node version. When it cannot be loaded, the report says
  `online: O1 and O2 did not run (<reason>)` and check e keeps its offline result.
- With no clone, `npx -y @probarion/mcp@0.1.1 demo` lists the five MCP tools (none takes an address), asks the contract
  about three amounts, shows an injected recipient refused by the schema and runs verify on the testnet demo vault's
  public ledger. Its last line ends `Nothing was signed or sent.`
- In a clone, `npx probarion verify --offline docs/evidence/demo-vault/snapshot-2026-11-12-video.json` prints
  `9 passed, 0 failed, 0 unproven` and `RESULT: PASS`, with 5 attested decisions passing A1 to A7 ([output](docs/evidence/demo-vault/verify-2026-11-12-video.txt)).

## What is proven

| Claim | Evidence | Transactions |
| --- | --- | --- |
| The contract enforces the mandate on testnet | The agent key's spend of 6 test USDC on a mandate capped at 5 a payment: `PROBARION:OverPerPayment`. A spend on mandate 999: `PROBARION:NoMandate`. The landing page's [live `check_spend`](https://probarion.xyz/#try) asks the same contract from your browser | [`4715d4nb…`](https://testnet.nearblocks.io/txns/4715d4nbYn6cq981nmLU5y8efCoX2w3SbgW8PPq4Vsr1), [`AkjyVPmb…`](https://testnet.nearblocks.io/txns/AkjyVPmb6LdMES7ykpzJQR7EXXGvw3kYH6Nhem9YdzgY) |
| The contract enforces the mandate on mainnet | 1 USDC paid under mandate 1 (`spend_paid`), and mandate 999 refused with `PROBARION:NoMandate` ([evidence](docs/evidence/mainnet-v0)) | [`22oqhgru…`](https://nearblocks.io/txns/22oqhgruo7JqdpPg5Cb2ts25mLK2fto8y1YAxNA56ieE), [`2Dabq4uM…`](https://nearblocks.io/txns/2Dabq4uMh9VvttH3uj85samfYoX2wbQheADHS96AtwYh) |
| Payouts through NEAR Intents on mainnet | On 2026-11-13 spend 2 of `v0.probarion.near` burned 1.00 USDC inside `intents.near` with the memo `WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27`, which the vault built from mandate 2, and the POA bridge released 0.9976 USDC to that Base address. A test to the owner's own address, decided by code rules alone. The vault's signed ledger is committed, and the live `verify` with it printed `8 passed, 0 failed, 0 unproven, 1 skipped`, check h matching the burn pair ([output](docs/evidence/mainnet-v0/s1-2026-11-13/verify-2026-11-13.txt), [the run](docs/evidence/mainnet-v0/s1-2026-11-13/README.md)). Later that day spend 3 burned 0.25 USDC the same way under mandate 3, for the same address, and the bridge released 0.2476 USDC; the live `verify` with the ledger of 6 entries printed the same counts, check h matching both burn pairs ([output](docs/evidence/mainnet-v0/s2-2026-11-13/verify-2026-11-13.txt), [the run](docs/evidence/mainnet-v0/s2-2026-11-13/README.md)) | [`BdN7oB76…`](https://nearblocks.io/txns/BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9), [`0xc2df8f87…`](https://basescan.org/tx/0xc2df8f8799467834cdaed0e8f23638af49334483387560fd34ef360939e1ea71) (Base), [`5amtgb8M…`](https://nearblocks.io/txns/5amtgb8MujUkiydS5Ht9Ut6AX6pN9SGegHUCHGsX9NGH), [`0xc6c4507e…`](https://basescan.org/tx/0xc6c4507e098b558bdff1b5836600f5e3365fee5a63037d399db58e1db4547ab7) (Base) |
| S1's two attested decisions on mainnet, both refused by code | For INV-M002, `z-ai/glm-5.3-flash` and then `Qwen/Qwen3.8-27B` on NEAR AI Cloud proposed paying. Each payee hint named a NEAR account, the mandate's asset account, for a Base payee, and code refused both: rule `mandate.payee_mismatch`, ledger entry 0, and rule `mandate.payee_mismatch`, ledger entry 1. Both proposals had the right amount and Base address, so these were false refusals by a strict rule, at the cost of two tries and no money; [PR #142](https://github.com/probarion/probarion/pull/142) changed the rule after the run, for a model's hint only. Both decisions pass A1 to A7, and A8 with the invoice text; nothing was sent on either, and each was anchored before the next cycle ([the run](docs/evidence/mainnet-v0/s1-2026-11-13/README.md#why-the-payout-was-decided-rules-only)) | [`8REzPLVw…`](https://nearblocks.io/txns/8REzPLVwoQJrkccMQeFCTLaQHu8m7AczxsMzEH9PLvPp), [`6ULZZvGa…`](https://nearblocks.io/txns/6ULZZvGa7M99jR7Uk5f1Md4KCdD1Cnd5au2s8fAZDMqY) (the anchors) |
| A payment on an attested model's proposal on mainnet | On 2026-11-13, for INV-M003, `z-ai/glm-5.3-flash` on NEAR AI Cloud proposed paying 0.25 USDC under mandate 3, with a payee hint that named the mandate's Base address and no NEAR account. Every code rule passed (ledger entry 4: `allow`, `model+rules`), and spend 3 paid it to the owner's own Base address, a test. The decision passes A1 to A7, and A8 with the invoice text; O1 and O2 have not run on it ([the run](docs/evidence/mainnet-v0/s2-2026-11-13/README.md)) | [`4cmSz4b3…`](https://nearblocks.io/txns/4cmSz4b3zHeWnbcw3HU6RJJ6afZa9zysu4SptE7mXT3T) (mandate 3), [`5amtgb8M…`](https://nearblocks.io/txns/5amtgb8MujUkiydS5Ht9Ut6AX6pN9SGegHUCHGsX9NGH) (spend 3), [`6jRY21z9…`](https://nearblocks.io/txns/6jRY21z9FfGMnx5BbT3V1G3xBZp4FUaQ8p88N3TMbLyG) (the anchor) |
| A gullible model's 50 USDC ask, refused on chain | The Canary rehearsal of 2026-11-10: a model given a deliberately gullible prompt proposed 50 USDC under a mandate of 1 USDC a payment. Code refused it with `invoice.amount_invalid` (no amount it could read, so the cap rule did not run) and with the Canary's rule that refuses every attempt. The same spend, sent raw with the agent key, was refused on chain with `PROBARION:OverPerPayment` ([evidence](docs/evidence/canary-vault)) | [`6XuxN42d…`](https://testnet.nearblocks.io/txns/6XuxN42dDWaboaqaiCuRGKCoA1UrypcDfvat48v6z8DH) |
| Payables paid two invoices on its own with an attested model | On 2026-11-12 `Qwen/Qwen3.8-27B` proposed paying INV-2009 and then INV-2010, every code rule passed, and spends 4 and 5 paid 2.00 test USDC each to the mandate's payee ([evidence](docs/evidence/demo-vault/README.md#2026-11-12-payables-pays-on-its-own-with-an-attested-model)) | [`EA7MbLts…`](https://testnet.nearblocks.io/txns/EA7MbLtsRjQUBbycfNyh6u1ieLNU5WXtyGy2K8eiPBuU), [`3YEGw5Qd…`](https://testnet.nearblocks.io/txns/3YEGw5Qdp9RbnR5LXFbAKXWPPhgiz7hf6vdDapfXvEE4) |
| A1 to A8, O1 and O2 on recorded decisions | The demo vault's 5 attested decisions pass A1 to A7 offline, A8 with the committed invoices ([output](docs/evidence/demo-vault/verify-a8-2026-11-12.txt)), and O1 and O2 in a live run at 16:13 UTC on 2026-11-12 ([output](docs/evidence/demo-vault/verify-online-a8-2026-11-12.txt)). The Canary's 2 pass A1 to A7, O1 and O2 ([output](docs/evidence/canary-vault/verify-online-2026-11-11.txt)). On mainnet, the 3 of `v0.probarion.near` of 2026-11-13, entries 0, 1 and 4, pass A1 to A7 and, with the two committed invoices, A8 offline ([output](docs/evidence/mainnet-v0/s2-2026-11-13/verify-2026-11-13.txt)); O1 and O2 have not run on them | None |
| The live TEE check | On 2026-11-12, after the promote that put main at b3baa82, the route and the card passed all four checks for `Qwen/Qwen3.8-27B`, and a cross-site call got `403 bad_origin` ([evidence](docs/evidence/tee-check/live-2026-11-12.json)) | None |
| Pay per call (HTTP 402) | On 2026-11-09 an agent paid 20 calls at 0.01 test USDC each through the MCP server, and code refused the 21st when the mandate's 20 uses ran out ([evidence](docs/evidence/402-vault)). The example is not an implementation of x402 | [`8q5qwWhz…`](https://testnet.nearblocks.io/txns/8q5qwWhzxKnZYgMbXLGvBJmvVT2HFyLJVQhDqLBf561H) (spend 1), [`4T3zW2KU…`](https://testnet.nearblocks.io/txns/4T3zW2KUAxZsiUPkyGyGwSKPX13pT4fYWrZN6auHNY69) (spend 20) |
| The MCP server from npm, in a real client | `@probarion/mcp` 0.1.1 is on npm and in the official MCP registry as `io.github.probarion/probarion`. On 2026-11-11 Claude Code, run headless with nothing in its config but the vault id, paid through it on testnet ([evidence](docs/evidence/trial-vault/README.md)) | [`CJu2sN5E…`](https://testnet.nearblocks.io/txns/CJu2sN5E6Z76c9Cfm29hmTNvh8BwpxgELFJmhjDFAfce) (spend 1) |
| Eval: the model fully fooled | An offline run hands `decide()` the payment each of 20 synthetic invoices asks a fooled model to make, marked attested: money moved wrongly 0/20 (0.00 USDC), and the code's rules refused all 14 wrong proposals. No model is asked, and the contract column is core's mirror of the contract's checks ([results](eval/results/adversary.md)) | None |
| Reproducible builds | CI rebuilds both contracts in Docker with cargo-near 0.22.0 and compares their code hashes with [`contracts/code-hashes.json`](contracts/code-hashes.json) ([script](scripts/build-reproducible.sh)). `v0.probarion.near` and the factory's vaults run the recorded build `3cQXYDvf…`; check f of `verify` reads it on chain | None |

## Assume breach

| If this is compromised | What still bounds the loss |
| --- | --- |
| The model is fooled, for example by text injected into an invoice | Its proposal is advice: code rules decide (only the Canary's raw mode skips them, and its ledger entry says so), and the contract checks every spend. See the eval's fully fooled run above (code stopped 14 of 14 wrong proposals) and the Canary rehearsal (the contract refused the raw spend) |
| The software inside the TEE | The contract does not read the model's answer: `spend` checks that `decision_hash` is 64 hex characters and stores it ([`checks.rs`](contracts/vault/src/checks.rs)). The mandate's payee and caps apply whatever the model said |
| The agent key | NEAR refuses any transaction the key signs for a method other than `spend` or with a deposit; [`ihitl.rs`](contracts/integration-tests/tests/ihitl.rs), run by CI's sandbox job, replays the self-approval attack of the I-HITL paper ([arXiv:2610.35835](https://arxiv.org/abs/2610.35835)) with the agent key and checks each refusal by its exact NEAR error |
| The agent host, calling `spend` with that key | The money goes to each mandate's payee, within `max_per_payment`, what is left of `max_total`, `max_uses`, `expires_at_ns` and the vault's daily backstop; a spend above `approval_above` waits for an approver; the owner stops every new spend with one `freeze` transaction, with no deposit. This holds while the owner's and the approvers' keys are not on that host ([README](README.md#safety-architecture)); a host that can sign as an approver can approve its own held spend, still only to the mandate's payee within its caps |
| The agent host holds the ledger key too | It can skip `decide()` and sign an allowing decision, and `verify` still passes, since it does not run the policy again ([SECURITY.md](SECURITY.md#what-is-not-proven-yet)). The vault bounds the money as in the row above |

**Why the TEE verdict is not enforced on chain.** The model proposes and the contract does not trust it, so a compromised
host that calls `spend` directly gets what the mandate allows and no more. Enforcing the verdict on chain would add a
check but not change that bound: a host that writes the invoice text can try to talk the model into "pay" (the Canary's
deliberately gullible model proposed 50 USDC), and models of one family share a signing key, with no pinned measurement,
so a signature check could not name the instance or image that signed ([trust assumptions](docs/THREAT_MODEL.md#trust-assumptions)). More: [attacks](docs/THREAT_MODEL.md#attacks), [blast radius](docs/THREAT_MODEL.md#blast-radius-if-probarion-is-breached), [if the agent's key leaks](README.md#safety-architecture), [loss bounds](apps/web/content/docs/trust/security-model.mdx).

## Worst case, priced

With the agent key public, the most that can move is what the mandates naming that key have left, to each mandate's own
payee and no one else, within the bounds above, plus gas from the vault's NEAR up to the key's allowance. On 2026-11-13,
after both Base payouts, the view calls `get_mandate` and `view_access_key_list` read three mandates on
`v0.probarion.near`: mandate 1, with 1 USDC and 1 payment left, paying `probarion-duong.near`, the owner's own wallet,
and mandates 2 and 3, `exhausted`, with nothing left. The agent key's allowance was 0.2462 NEAR: at most 1 USDC, to the
owner, and 0.2462 NEAR of gas. The ledger key can call `anchor` only and moves no USDC; with it public, a forger could
sign ledger entries and spend up to its 0.2492 NEAR allowance on gas.

## Who it is for

A hypothesis, not traction: no one pays for Probarion today and no price is set. Buyers: finance and accounts-payable
teams that let an agent pay supplier invoices (Payables, the console's reference agent), agent platforms through MCP,
and sellers that charge agents per call with HTTP 402 ([the pay-per-call example](examples/402)). The SDK, CLI, MCP server
and verifier stay free under the MIT license; the hosted console would be paid, per vault per month or per verified payment.

| Unit cost | Measured or recorded |
| --- | --- |
| Gas per spend | On mainnet, summed over the transaction and its receipts from an archival node on 2026-11-13 ([record](docs/evidence/mainnet-v0/gas-2026-11-13.json)): the paid spend [`22oqhgru…`](https://nearblocks.io/txns/22oqhgruo7JqdpPg5Cb2ts25mLK2fto8y1YAxNA56ieE) burned 8.35 Tgas (0.000769 NEAR) and the refusal [`2Dabq4uM…`](https://nearblocks.io/txns/2Dabq4uMh9VvttH3uj85samfYoX2wbQheADHS96AtwYh) 1.87 Tgas (0.000165 NEAR); the Base payout [`BdN7oB76…`](https://nearblocks.io/txns/BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9) burned 15.35 Tgas (0.001423 NEAR) ([record](docs/evidence/mainnet-v0/s1-2026-11-13/gas-spend-2.json)), and the attested Base payout [`5amtgb8M…`](https://nearblocks.io/txns/5amtgb8MujUkiydS5Ht9Ut6AX6pN9SGegHUCHGsX9NGH) 15.36 Tgas (0.001424 NEAR) ([record](docs/evidence/mainnet-v0/s2-2026-11-13/gas-spend-3.json)). On testnet, 0.000718 and 0.000165 NEAR ([runbook](docs/runbooks/mainnet-v0.md#7-agent-key)). [/usage](https://probarion.xyz/usage) still shows gas per spend as not measured yet: this record is not wired into it |
| Storage per paid spend | About 480 bytes, about 0.0048 NEAR of storage stake that is not refunded (testnet, `view_state`, [runbook](docs/runbooks/mainnet-v0.md#0-preconditions)) |
| NEAR AI tokens per decision | 1,064 to 1,692 (prompt and completion) for the demo vault's 5 attested decisions, from the `usage` of each answer in [the ledger](docs/evidence/demo-vault/ledger-2026-11-12-video.jsonl) |
| USD per decision | Not measured: the repository records no dated NEAR AI Cloud price yet (`NEARAI_PRICE` is `null` in [`pricing.ts`](apps/web/src/lib/usage/pricing.ts)) |
| Bridge fee per Base payout | Paid and measured twice, on mainnet on 2026-11-13: 0.0024 USDC each time, the POA bridge's `withdrawal_fee` of 2400 base units, on spend 2, which burned 1.00 USDC (0.9976 arrived on Base), and on spend 3, which burned 0.25 USDC (0.2476 arrived) ([status](docs/evidence/mainnet-v0/s1-2026-11-13/poa-status.json), [Base transfer](https://basescan.org/tx/0xc2df8f8799467834cdaed0e8f23638af49334483387560fd34ef360939e1ea71); [status](docs/evidence/mainnet-v0/s2-2026-11-13/poa-status.json), [Base transfer](https://basescan.org/tx/0xc6c4507e098b558bdff1b5836600f5e3365fee5a63037d399db58e1db4547ab7)). The same fee on both amounts, so it weighs more on a small payout: about 1% of 0.25 USDC. The runbook had quoted the same fee on 2026-10-20 ([runbook](docs/runbooks/mainnet-v0.md#10-first-base-payout-2-usdc)). The 1Click swap that topped the vault up took 0.000177 of 1.5 USDC ([status](docs/evidence/mainnet-v0/s1-2026-11-13/oneclick-status-final.json)) |
| Hosting and RPC | Not measured |

## Not yet, as of 2026-11-13

- **The mainnet model decisions are not checked online.** Spend 1 was sent without the SDK, spend 2 was decided by code
  rules alone after code refused two attested proposals, and spend 3, 0.25 USDC to the owner's own Base address, was
  decided by an attested model and the code rules. `verify --online` has not run on the three attested decisions of
  2026-11-13, so O1 and O2 have not checked their TDX quotes or GPU evidence. Spend 3's hint named no NEAR account, so
  the payee rule's later reading of a Base mandate's own asset account in a model's hint (PR #142 and PR #144), which
  the SDK of the run holds, was not exercised on mainnet: the hint gave it nothing to read.
- **NEAR Intents is a stand-in on testnet.** `intents-stub.probarion.testnet` stands in for `intents.near`, so a
  testnet burn does not leave NEAR; the real Intents payouts are the two mainnet tests of 2026-11-13.
- **No outside users yet.** [/usage](https://probarion.xyz/usage) on testnet showed 0 external owners, 0 Canary
  participants and 0 pilots, beside 2 team vaults; the Canary's board showed 0 visitor attempts and 6 by the team.
- **The TEE measurement is not pinned**, so no check shows which model image ran ([why](docs/measurement-pin-2026-11.md)).
- **No audit.** No third party has audited the contracts or the packages.
- **No end-to-end encryption.** The request to NEAR AI Cloud is plain JSON over HTTPS, the hosted console reads each
  invoice, and the signed ledger keeps the model's answer, which can restate it ([Privacy](README.md#privacy--private-ai)).
- **Mainnet is one small vault.** `v0.probarion.near` is standalone, with no mainnet factory. It received 3 USDC, and
  1.499823 Base USDC through a 1Click swap. It paid 1 USDC to the owner's own wallet, pre-ledger, and burned 1.00 USDC
  for the owner's own Base address with the SDK, decided rules-only, then 0.25 USDC for the same address, decided by an
  attested model and the code rules; 0.9976 and 0.2476 arrived on Base after the bridge fee. All three payments went
  back to the owner, and Payables has not run on mainnet.
