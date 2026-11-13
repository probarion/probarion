# Probarion by track

Each table below takes one track's brief, from its prompt in
[nearai/near-hackathon-prompt-examples](https://github.com/nearai/near-hackathon-prompt-examples/tree/main/tracks)
(read on 2026-11-13), and says what Probarion does for each ask and where the evidence is. A row says
**Not built** where Probarion does not do what the brief asks. Times are UTC.

Three caveats apply to every table. The code is unaudited. Every mainnet payment so far is a test to the owner's own
addresses. The TEE measurement is not pinned, so no check shows which model image ran.

## 06 AI Security & Defense

The brief asks for spending limits and policy engines that give AI money "without handing it the keys to
everything", and its prompt asks for an allow, warn or block answer before an agent pays.

| Brief asks | Probarion | Evidence |
| --- | --- | --- |
| Before an agent pays, an answer of allow, warn or block, with the reasons | The vault contract's free `check_spend` dry run answers for the exact spend. `ok: true` is allow. `would_hold: true` is warn: the amount is above the mandate's `approval_above`, so the vault would hold the spend for a human approver. `ok: false` with a code such as `OverPerPayment`, `NoMandate` or `UsesExhausted` is block, and `spend` would fail with `PROBARION:<Code>` | [`checks.rs`](../contracts/vault/src/checks.rs); [step 4 of the evaluation](../README.md#how-to-evaluate-probarion-in-5-minutes) prints `ok` for 2 USDC and `OverPerPayment` for 6; [probarion.xyz/#try](https://probarion.xyz/#try) asks the testnet vault from your browser |
| An agent-side wrapper that refuses to sign on block and asks a human on warn | `Probarion.process()` in the SDK runs `check_spend` before it signs. On a refusal it writes the refusal into the signed ledger and sends nothing. On a hold it sends the spend, and the contract keeps it until an approver signs `approve` or `reject`, or the hold expires | [`probarion.ts`](../packages/sdk/src/probarion.ts), [`held.rs`](../contracts/vault/src/held.rs); on testnet on 2026-11-11 two held spends paid only after the owner approved them ([the run](evidence/trial-vault/README.md#the-run)) |
| Score the receiver: account age and activity, whether it is a contract and its code changed, prior interactions, a shared blocklist | **Not built.** The owner fixes the payee when signing a mandate, and nothing scores it then or later. The console's mandate form checks only whether a NEAR payee account exists | [`mandates.ts`](../apps/web/src/lib/console/mandates.ts) |
| The agent signs with a function-call key scoped to one contract, never a full-access key, and the README explains its limits | The agent key is a function-call key on the vault, for the vault, for `spend` only. The ledger key is for `anchor` only. The limits are below | [`keys.rs`](../contracts/vault/src/keys.rs); on mainnet, [the keys as read on 2026-11-13](evidence/mainnet-v0/worst-case-2026-11-13.json) |
| An attack demo: a prompt-injected agent tries to pay a known-bad address and is stopped, with the log | `spend` has no address field, so an agent cannot name a known-bad address. In the Canary rehearsal on testnet, 2026-11-10, a fake invoice asked for 50 USDC under a mandate of 1 USDC a payment: the model proposed paying it, the code rules refused it, and the same spend sent raw was refused on chain with `OverPerPayment`. In `npx -y @probarion/mcp@0.1.1 demo`, a `request_spend` with an injected `to` field is refused by the input schema | [The rehearsal](evidence/canary-vault/README.md#the-rehearsal) and its [transaction](https://testnet.nearblocks.io/txns/6XuxN42dDWaboaqaiCuRGKCoA1UrypcDfvat48v6z8DH); [`demo.ts`](../packages/mcp/src/demo.ts) |

**The limits of the agent's key, and of a vault that holds only function-call keys.** These are read from
[`keys.rs`](../contracts/vault/src/keys.rs), [`admin.rs`](../contracts/vault/src/admin.rs),
[`mandates.rs`](../contracts/vault/src/mandates.rs) and [`spend.rs`](../contracts/vault/src/spend.rs):

- The vault has no full-access key. Its keys are function-call keys that the contract adds to itself on the owner's
  instruction: agent keys that may call `spend` and one ledger key that may call `anchor`, each on the vault only.
  The contract refuses an unlimited gas allowance for either.
- NEAR lets a function-call key call only its listed methods on its one receiver, with no deposit. The gas of a
  transaction it signs comes from the vault's NEAR, up to that key's allowance.
- NEAR leaves the vault in four ways, all fixed in the code: as gas, within each key's allowance; as 1 yoctoNEAR
  attached to each USDC transfer or Intents withdrawal the vault makes; as a NEAR payee's USDC storage
  registration, paid from the owner's mandate deposit
  ([`mandates.rs`](../contracts/vault/src/mandates.rs#L42-L55)); and as the refund of an owner's excess deposit,
  to the owner ([`mandates.rs`](../contracts/vault/src/mandates.rs#L56-L60)).
- The owner can `freeze` and `unfreeze` the vault, `withdraw` its USDC and `withdraw_intents` its balance inside NEAR
  Intents, each to the owner's own account. No method withdraws the vault's own NEAR.
- When a key's allowance or the vault's free NEAR runs out, that key stops signing, and the agent cannot pay. The
  owner's methods are called from the owner's own account, so the owner can still send the vault NEAR and add a
  fresh key with `add_agent` or `set_ledger_key`.

## 07 Agent Economy

The brief's prompt asks for an agent that hires other agents or pays for data, negotiates and keeps a receipt for
every task, inside a budget.

| Brief asks | Probarion | Evidence |
| --- | --- | --- |
| Find out how jobs get posted and paid on the NEAR AI Agent Market | Read on 2026-11-13. (1) market.near.ai serves a REST API for jobs, bids, assignments and competitions ([its OpenAPI file](https://market.near.ai/openapi.json), version 2.0.0); a competition locks its prize pool in escrow, and the wallet reads USDC balances from OutLayer. (2) The older guide ([skill.md](https://market-legacy.near.ai/skill.md), version 0.3.0) says that awarding a bid moves the funds into escrow, which is released to the worker when the requester accepts, in NEAR, USDC or USD. (3) **Not built:** no Probarion agent has posted, bid on or paid a job there | The two links |
| When a quote is above plan, counter once, then accept or walk away | The 402 example's agent counters once at the mandate's cap per payment, then pays the seller's new quote or walks away with no payment. On testnet, 2026-11-11, it countered a 0.012 quote at 0.01, and spend 21 paid 0.01 | [The negotiation demo](evidence/402-vault/README.md#the-negotiation-demo-2026-11-11), [`examples/402`](../examples/402) |
| A receipt for every task: what was bought, from whom, at what price, and whether the work passed the check | One JSON line per paid call: the resource, the seller, the list price, the price paid, the spend and its transaction, and the data check | [`receipts-2026-11-11.jsonl`](evidence/402-vault/receipts-2026-11-11.jsonl) |
| Payments in USDC or NEAR, directly or through NEAR Intents | USDC only: `ft_transfer` to a NEAR account, or `ft_withdraw` on `intents.near` with the memo `WITHDRAW_TO:<address>` for a Base or Solana address. On mainnet two Base payouts ran on 2026-11-13, tests to the owner's own address | [S2 on mainnet](../README.md#near-mainnet-2026-11-13-s2-an-attested-base-payout) |
| Explain how the agent holds its keys and what it cannot do without the owner | The MCP server's `init` makes the agent key and the ledger key on the user's machine and prints only their public keys. The agent cannot add a payee, raise a cap, approve its own held spend, unfreeze or withdraw: those need the owner's or an approver's account | [`packages/mcp`](../packages/mcp), [`keys.rs`](../contracts/vault/src/keys.rs) |
| Hire other agents, check their work and pay out | **Not built.** The 402 example buys data from one seller. The example's 402 is its own format, not x402 | [`examples/402`](../examples/402) |

## 08 Real-World Money

The brief's prompt asks for invoicing where the freelancer "receives USDC on NEAR and never buys NEAR for gas".
Probarion is the payer's side of that: an agent that pays invoices.

| Brief asks | Probarion | Evidence |
| --- | --- | --- |
| The payee receives USDC and never buys NEAR for gas | The payee signs nothing and needs no NEAR. The vault pays with `ft_transfer`, and for a NEAR payee the contract registers the payee's USDC storage when the mandate is created, from the owner's deposit | [`mandates.rs`](../contracts/vault/src/mandates.rs#L42-L55); on mainnet, 2026-11-11, spend 1 paid 1 USDC to `probarion-duong.near`, the owner's own wallet ([transaction](https://nearblocks.io/txns/22oqhgruo7JqdpPg5Cb2ts25mLK2fto8y1YAxNA56ieE)) |
| Pay across chains through the 1Click API | The vault pays a Base or Solana address through NEAR Intents. On mainnet, 2026-11-13, a 1Click swap topped up the vault's Base USDC, and S1 and S2 paid 1.00 and 0.25 USDC to the owner's own Base address | [S1](../README.md#near-mainnet-2026-11-13-s1-a-base-payout), [S2](../README.md#near-mainnet-2026-11-13-s2-an-attested-base-payout) |
| An invoice page with a pay button for a client paying from any chain | **Not built.** Probarion pays invoices; it does not issue them | None |
| Gasless for the freelancer, through a meta transaction relayer | **Not built.** There is no relayer. The payee signs nothing; the owner and each approver pay the gas of what they sign | None |
| Status updates the freelancer can trust, with links to the transactions | Each spend has a status on chain: `held`, `pending`, `paid`, `burned`, `failed`, `rejected` or `expired`. The landing page's mainnet section links each payout's transactions and reads them again in your browser | [`types.rs`](../contracts/vault/src/types.rs), [probarion.xyz/#mainnet](https://probarion.xyz/#mainnet) |
| A CSV export an accountant could open | `/proof/<vault>/payments.csv`: one row per decision, with its payee, amount, reason and the spend's status on chain | [The demo vault's CSV](evidence/demo-vault/payments-2026-11-09.csv) |

## 04 Autonomous Business

The brief says "Humans only set the constraints". Its prompt asks for rules in one place, a kill switch and a
public ledger page.

| Brief asks | Probarion | Evidence |
| --- | --- | --- |
| Humans only set the constraints | The owner signs each mandate from their own wallet: the payee, the caps per payment and in total, the uses, the expiry and the amount above which an approver must approve. The agent works inside them | [Mandates](../README.md#what-probarion-does) |
| A kill switch the owner can flip at any time | `freeze` stops every new spend and every approve, with no deposit, from any key on the owner's account. The owner froze and unfroze the testnet demo vault from the console on 2026-11-11 and 2026-11-12. Not run on mainnet yet | [`admin.rs`](../contracts/vault/src/admin.rs), [the demo vault's record](evidence/demo-vault/README.md#2026-11-11-freeze-unfreeze-and-attested-decisions) |
| No full-access key in plain text: OutLayer agent custody or a scoped function-call key | A scoped function-call key, for `spend` only, on a vault with no full-access key | [`keys.rs`](../contracts/vault/src/keys.rs) |
| Log every sale, cost and payout to a public ledger page | `/proof/<vault>` shows every decision, refusals included, with checks a to i, once the owner makes it public. The testnet demo vault's page is public. The mainnet vault has no proof page; its ledger is committed in this repository | [The demo vault's proof page](https://probarion.xyz/proof/demo.vaults.probarion.testnet), [the mainnet ledger](evidence/mainnet-v0/s2-2026-11-13) |
| Run the business on its own | Payables, the console's reference agent, paid two invoices on its own on testnet on 2026-11-12: an attested model proposed each payment and every code rule passed | [The record](evidence/demo-vault/README.md#2026-11-12-filmed-a-second-invoice-paid-on-its-own-freeze-and-unfreeze) |
| Rules for inference spend per day, a minimum price and a revenue split | **Not built.** A mandate bounds payments, not inference spend, prices or splits | None |

## 03 Privacy & Private AI

The brief's prompt asks for a model on NEAR AI Cloud whose analysis is proven to run inside a TEE, with nothing
kept server-side after a response.

| Brief asks | Probarion | Evidence |
| --- | --- | --- |
| Call NEAR AI Cloud through its OpenAI-compatible API and pick a TEE-hosted model from the models endpoint | `POST /chat/completions` on `https://cloud-api.near.ai/v1`. The SDK reads `GET /v1/model/list` and keeps only models marked attestation-supported and verifiable | [`nearai.ts`](../packages/sdk/src/nearai.ts) |
| Fetch the attestation with a fresh random nonce, verify it as the docs describe, and show a Verified panel | Each recorded decision uses a nonce derived from its ledger position, not a random one; A1 to A8 check it offline and O1 and O2 online. The proof page's **Check the TEE now** card draws a random nonce in your browser and shows nonce bound, signer bound, O1 and O2 | [On mainnet, O1 and O2 passed on 2026-11-13](evidence/mainnet-v0/s2-2026-11-13/verify-online-2026-11-13.txt); [the live card](https://probarion.xyz/proof/demo.vaults.probarion.testnet#tee-check) |
| Keep nothing server-side after a response | With the SDK on your own machine, nothing is kept on a Probarion server. The hosted console does keep data, as the table below says | [Privacy & Private AI](../README.md#privacy--private-ai) |
| Fictional sample documents | The demo and trial vaults ran on made-up invoices marked "test USDC, no value", and the eval's 20 invoices are synthetic | [`eval`](../eval/README.md) |

**What is kept where.**

| Data | Where it is kept |
| --- | --- |
| The invoice text | On your machine with the SDK. It is sent to NEAR AI Cloud for the model, as plain JSON over HTTPS, not end to end encrypted. The hosted console keeps the file sealed with a key derived per vault, or only its hashes when zero-retention is on. The MCP server takes only the invoice's hash |
| The invoice's sha256 | On chain with each spend, and in the ledger. It has no salt, so a guessable invoice can be confirmed against it |
| The model's answer, its reasoning included | In the signed ledger, so also in the console's database, and on a public proof page once the owner publishes it |
| The signed ledger | `.probarion/ledger.jsonl` on your machine, or the console's database. Its root is anchored on chain |
| The agent and ledger keys | On the machine that runs the agent, such as `~/.probarion/<vault>/keys.json` for the MCP server. The console seals the keys it stores |

**What an observer learns from the chain.**

| An observer learns | An observer does not learn |
| --- | --- |
| Each mandate: its payee (a NEAR account, or a Base or Solana address), caps, uses, expiry, approval threshold, agent key, label and the sha256 of its purpose document | The purpose document's text |
| Each spend: its amount, mandate, payee, invoice sha256, ref, decision hash, status and time | The invoice text, unless it can be guessed and hashed |
| Each anchor: the ledger's root and entry count | The ledger's entries, unless the owner publishes them |
| Each Base payout: the `WITHDRAW_TO:` memo with the Base address, and the USDC transfer on Base | |

**Next step, not built.** Payouts through NEAR's Confidential Intents, which the
[Agent API docs](https://docs.agentsonintents.com/integration/agent-api/overview) (read 2026-11-13) describe as the
private balance its agents' swaps, transfers and withdrawals use. We have not checked whether a contract such as the
vault can pay through it.
