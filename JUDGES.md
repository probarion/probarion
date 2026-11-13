# Probarion for judges

Probarion in two minutes. Each claim links its evidence here or on chain; times are UTC; the full record is the [README](README.md).

**The mechanism.** The agent's NEAR key is a function-call key that can call `spend` and nothing else, and `spend` takes
no address, so the vault contract pays the payee of a mandate the owner signed, within its caps; a private model in a
TEE on NEAR AI Cloud may propose a payment and does not decide; and every decision Probarion's code makes, refusals
included, is signed into a hash-chained Ed25519 ledger whose root is anchored on the vault once it has a ledger key.

## Open these three links

1. **The live TEE check.** Press **Check the TEE now** on the [demo vault's proof page](https://probarion.xyz/proof/demo.vaults.probarion.testnet#tee-check):
   for a nonce your browser draws it shows nonce bound, signer bound, O1 (Intel DCAP) and O2 (NVIDIA NRAS), for the TEE
   that serves the model now. On 2026-11-12 all four passed on probarion.xyz ([evidence](docs/evidence/tee-check/live-2026-11-12.json)).
2. **The proof page.** [probarion.xyz/proof/demo.vaults.probarion.testnet](https://probarion.xyz/proof/demo.vaults.probarion.testnet)
   runs checks a to i on the testnet demo vault's signed ledger and chain data, with A1 to A7 for each decision made with model output.
3. **Mainnet, 2026-11-11.** On `v0.probarion.near`, with real USDC, spend 1 paid 1 USDC under mandate 1 ([`22oqhgru…`](https://nearblocks.io/txns/22oqhgruo7JqdpPg5Cb2ts25mLK2fto8y1YAxNA56ieE)),
   and a spend against mandate 999 was refused on chain with `PROBARION:NoMandate` ([`2Dabq4uM…`](https://nearblocks.io/txns/2Dabq4uMh9VvttH3uj85samfYoX2wbQheADHS96AtwYh)).
   The owner sent both with the vault's spend-only key from their own terminal, without the SDK ([the run](README.md#near-mainnet-2026-11-11)).

<!-- judges:mainnet-base-payout. If it runs, a later pull request replaces the next line with its NEAR and Basescan txs. -->
Mainnet Base payout through NEAR Intents: has not run (see [Not yet](#not-yet-as-of-2026-11-13)).

## Run it

```bash
git clone https://github.com/probarion/probarion.git
cd probarion
pnpm install --frozen-lockfile
pnpm judge --offline --quick   # no network and no package tests
pnpm judge                     # also the live read-only steps on testnet and mainnet, and the package tests
```

It needs Node.js 24 and pnpm 10, prints one row per step with the README line it proves, and exits 0 when no step
failed. On 2026-11-13 the offline quick run of this branch ended so (the time varies; the EXPECTED-FAIL is the Canary's
snapshot of 2026-11-10, which has no ledger):

```text
judge: 18 PASS, 1 EXPECTED-FAIL, 14 SKIPPED, 0 FAIL in 41.6 s. Nothing was signed or sent. Report: judge-report.json. Exit 0.
```

- `verify --online`, which runs O1 and O2, needs Node.js 24.22.1 or newer, which `@nearai/inference-sdk` declares. On an
  older Node 24 the report says `online: O1 and O2 did not run (<reason>)` and check e keeps its offline result.
- With no clone, `npx -y @probarion/mcp@0.1.1 demo` lists the five MCP tools, none of which takes an address, refuses an
  injected recipient and verifies the testnet demo vault's public ledger. Its last line ends `Nothing was signed or sent.`
- In a clone, `npx probarion verify --offline docs/evidence/demo-vault/snapshot-2026-11-12-video.json` prints
  `9 passed, 0 failed, 0 unproven` and `RESULT: PASS`, with 5 attested decisions passing A1 to A7 ([output](docs/evidence/demo-vault/verify-2026-11-12-video.txt)).

## What is proven

| Claim | Evidence | Transactions |
| --- | --- | --- |
| The contract enforces the mandate on testnet | The agent key's spend of 6 test USDC on a mandate capped at 5 a payment: `PROBARION:OverPerPayment`. A spend on mandate 999: `PROBARION:NoMandate`. The landing page's [live `check_spend`](https://probarion.xyz/#try) asks the same contract from your browser | [`4715d4nb…`](https://testnet.nearblocks.io/txns/4715d4nbYn6cq981nmLU5y8efCoX2w3SbgW8PPq4Vsr1), [`AkjyVPmb…`](https://testnet.nearblocks.io/txns/AkjyVPmb6LdMES7ykpzJQR7EXXGvw3kYH6Nhem9YdzgY) |
| The contract enforces the mandate on mainnet | 1 USDC paid under mandate 1 (`spend_paid`), and mandate 999 refused with `PROBARION:NoMandate` ([evidence](docs/evidence/mainnet-v0)) | [`22oqhgru…`](https://nearblocks.io/txns/22oqhgruo7JqdpPg5Cb2ts25mLK2fto8y1YAxNA56ieE), [`2Dabq4uM…`](https://nearblocks.io/txns/2Dabq4uMh9VvttH3uj85samfYoX2wbQheADHS96AtwYh) |
| A fooled model, refused twice | The Canary rehearsal of 2026-11-10: the model proposed 50 USDC under a mandate of 1 USDC a payment, the code refused it, and the contract refused the same spend on chain with `PROBARION:OverPerPayment` ([evidence](docs/evidence/canary-vault)) | [`6XuxN42d…`](https://testnet.nearblocks.io/txns/6XuxN42dDWaboaqaiCuRGKCoA1UrypcDfvat48v6z8DH) |
| Payables paid two invoices on its own with an attested model | On 2026-11-12 `Qwen/Qwen3.8-27B` proposed paying INV-2009 and then INV-2010, every code rule passed, and spends 4 and 5 paid 2.00 test USDC each to the mandate's payee ([evidence](docs/evidence/demo-vault/README.md#2026-11-12-payables-pays-on-its-own-with-an-attested-model)) | [`EA7MbLts…`](https://testnet.nearblocks.io/txns/EA7MbLtsRjQUBbycfNyh6u1ieLNU5WXtyGy2K8eiPBuU), [`3YEGw5Qd…`](https://testnet.nearblocks.io/txns/3YEGw5Qdp9RbnR5LXFbAKXWPPhgiz7hf6vdDapfXvEE4) |
| A1 to A8, O1 and O2 on recorded decisions | The demo vault's 5 attested decisions pass A1 to A7 offline, A8 with the committed invoices ([output](docs/evidence/demo-vault/verify-a8-2026-11-12.txt)), and O1 and O2 in a live run at 16:13 UTC on 2026-11-12 ([output](docs/evidence/demo-vault/verify-online-a8-2026-11-12.txt)). The Canary's 2 pass A1 to A7, O1 and O2 ([output](docs/evidence/canary-vault/verify-online-2026-11-11.txt)) | None |
| The live TEE check | On 2026-11-12, after the promote that put main at b3baa82, the route and the card passed all four checks for `Qwen/Qwen3.8-27B`, and a cross-site call got `403 bad_origin` ([evidence](docs/evidence/tee-check/live-2026-11-12.json)) | None |
| Pay per call (HTTP 402) | On 2026-11-09 an agent paid 20 calls at 0.01 test USDC each through the MCP server, and code refused the 21st when the mandate's 20 uses ran out ([evidence](docs/evidence/402-vault)). The example is not an implementation of x402 | [`8q5qwWhz…`](https://testnet.nearblocks.io/txns/8q5qwWhzxKnZYgMbXLGvBJmvVT2HFyLJVQhDqLBf561H) (spend 1), [`4T3zW2KU…`](https://testnet.nearblocks.io/txns/4T3zW2KUAxZsiUPkyGyGwSKPX13pT4fYWrZN6auHNY69) (spend 20) |
| The MCP server from npm, in a real client | `@probarion/mcp` 0.1.1 is on npm and in the official MCP registry as `io.github.probarion/probarion`. On 2026-11-11 Claude Code, run headless with nothing in its config but the vault id, paid through it on testnet ([evidence](docs/evidence/trial-vault/README.md)) | [`CJu2sN5E…`](https://testnet.nearblocks.io/txns/CJu2sN5E6Z76c9Cfm29hmTNvh8BwpxgELFJmhjDFAfce) (spend 1) |
| Eval: the model fully fooled | An offline run hands `decide()` the payment each of 20 synthetic invoices asks a fooled model to make, marked attested: money moved wrongly 0/20 (0.00 USDC), and the code's rules refused all 14 wrong proposals. No model is asked, and the contract column is core's mirror of the contract's checks ([results](eval/results/adversary.md)) | None |
| Reproducible builds | CI rebuilds both contracts in Docker with cargo-near 0.22.0 and compares their code hashes with [`contracts/code-hashes.json`](contracts/code-hashes.json) ([script](scripts/build-reproducible.sh)). `v0.probarion.near` and the factory's vaults run the recorded build `3cQXYDvf…`; check f of `verify` reads it on chain | None |

## Assume breach

| If this is compromised | What still bounds the loss |
| --- | --- |
| The model is fooled, for example by text injected into an invoice | Its proposal is advice: `decide()`'s built-in rules run on every decision, and the contract checks every spend. See the Canary rehearsal and the eval's fully fooled run above |
| The software inside the TEE | The contract does not read the model's answer: `spend` checks that `decision_hash` is 64 hex characters and stores it ([`checks.rs`](contracts/vault/src/checks.rs)). The mandate's payee and caps apply whatever the model said |
| The agent host or the agent key | NEAR refuses any transaction the key signs for a method other than `spend` or with a deposit; [`ihitl.rs`](contracts/integration-tests/tests/ihitl.rs), run by CI's sandbox job, replays the self-approval attack of the I-HITL paper ([arXiv:2610.35835](https://arxiv.org/abs/2610.35835)) with the agent key and checks each refusal by its exact NEAR error. The money goes to each mandate's payee, within `max_per_payment`, what is left of `max_total`, `max_uses`, `expires_at_ns` and the vault's daily backstop; a spend above `approval_above` waits for an approver; the owner stops every new spend with one `freeze` transaction, with no deposit |
| The agent host holds the ledger key too | It can skip `decide()` and sign an allowing decision, and `verify` still passes, since it does not run the policy again ([SECURITY.md](SECURITY.md#what-is-not-proven-yet)). The vault bounds the money as in the row above |

**Why the TEE verdict is not enforced on chain.** The model proposes and the contract does not trust it, so a compromised
host that calls `spend` directly gets what the mandate allows and no more. Enforcing the verdict on chain would add a
check but not change that bound: a host that writes the invoice text can try to talk the model into "pay" (the Canary's
deliberately gullible model proposed 50 USDC), and models of one family share a signing key, with no pinned measurement,
so a signature check could not name the instance or image that signed ([trust assumptions](docs/THREAT_MODEL.md#trust-assumptions)). More: [attacks](docs/THREAT_MODEL.md#attacks), [blast radius](docs/THREAT_MODEL.md#blast-radius-if-probarion-is-breached), [if the agent's key leaks](README.md#safety-architecture), [loss bounds](apps/web/content/docs/trust/security-model.mdx).

## Worst case, priced

With the agent key public, the most that can move is what the mandates naming that key have left, to each mandate's own
payee and no one else, within the bounds above, plus gas from the vault's NEAR up to the key's allowance. On 2026-11-13,
by view calls, `v0.probarion.near` had one mandate, with 1 USDC and 1 payment left, paying `probarion-duong.near`, the
owner's own wallet, and an agent key allowance of 0.249 NEAR: at most 1 USDC, to the owner, and 0.249 NEAR of gas.

## Who it is for (a hypothesis)

A hypothesis, not traction: no one pays for Probarion today and no price is set. Buyers: finance and accounts-payable
teams that let an agent pay supplier invoices (Payables, the console's reference agent), agent platforms through MCP,
and sellers that charge agents per call with HTTP 402 ([the pay-per-call example](examples/402)). The SDK, CLI, MCP server
and verifier stay free under the MIT license; the hosted console would be paid, per vault per month or per verified payment.

| Unit cost | Measured |
| --- | --- |
| Gas per spend | On mainnet, summed over the transaction and its receipts from an archival node on 2026-11-13: the paid spend [`22oqhgru…`](https://nearblocks.io/txns/22oqhgruo7JqdpPg5Cb2ts25mLK2fto8y1YAxNA56ieE) burned 8.35 Tgas (0.00077 NEAR) and the refusal [`2Dabq4uM…`](https://nearblocks.io/txns/2Dabq4uMh9VvttH3uj85samfYoX2wbQheADHS96AtwYh) 1.87 Tgas (0.00016 NEAR). On testnet, 0.000718 and 0.000165 NEAR ([runbook](docs/runbooks/mainnet-v0.md#7-agent-key)) |
| Storage per paid spend | About 480 bytes, about 0.0048 NEAR of storage stake that is not refunded (testnet, `view_state`, [runbook](docs/runbooks/mainnet-v0.md#0-preconditions)) |
| NEAR AI tokens per decision | 1,064 to 1,692 (prompt and completion) for the demo vault's 5 attested decisions, from the `usage` of each answer in [the ledger](docs/evidence/demo-vault/ledger-2026-11-12-video.jsonl) |
| USD per decision | Not measured: no NEAR AI price is set ([`pricing.ts`](apps/web/src/lib/usage/pricing.ts)) |
| Bridge fee per Base payout | 0.0024 USDC, the POA bridge's fee read on 2026-10-20 ([runbook](docs/runbooks/mainnet-v0.md#10-first-base-payout-2-usdc)); not paid yet, since no Base payout has run |
| Hosting and RPC | Not measured |

## Not yet, as of 2026-11-13

- **No Intents payout on mainnet.** On testnet `intents-stub.probarion.testnet` stands in for `intents.near`, and a burn
  does not leave NEAR. Spike S1, a contract account withdrawing Base POA USDC to a Base address on mainnet, is unproven.
- **No outside users yet.** [/usage](https://probarion.xyz/usage) on testnet showed 0 external owners, 0 Canary
  participants and 0 pilots, beside 2 team vaults; the Canary's board showed 0 visitor attempts and 6 by the team.
- **The TEE measurement is not pinned**, so no check shows which model image ran ([why](docs/measurement-pin-2026-11.md)).
- **No audit.** No third party has audited the contracts or the packages.
- **No end-to-end encryption.** The request to NEAR AI Cloud is plain JSON over HTTPS, the hosted console reads each
  invoice, and the signed ledger keeps the model's answer, which can restate it ([Privacy](README.md#privacy--private-ai)).
- **Mainnet is one small vault.** `v0.probarion.near` is standalone, with no mainnet factory. It received 3 USDC and paid
  1 USDC to the owner's own wallet, pre-ledger: no SDK, model or ledger has run on mainnet, and neither has Payables.
