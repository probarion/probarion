# How Probarion compares (November 2026)

Sources read on 2026-11-11. These products and specs change. Check the sources below before you rely on a cell.

This page compares Probarion with three things an agent builder on NEAR may also look at: NEAR's Agent API, the x402 "exact" scheme on NEAR, and AP2, the Agent Payments Protocol. It also covers plain caps: a function-call key allowance or a spending-limit contract.

## What is different

- **The request cannot name a payee.** The agent's key can call only `spend`, and `spend` takes a mandate id, an amount, an invoice hash, a ref and a decision hash. It has no recipient field. The vault pays the payee the owner wrote into the mandate.
- **A spend without a decision shows up.** Each spend stores the hash of its decision on chain. `probarion verify` check d fails when a spend has no matching signed decision in the ledger.
- **The model only proposes.** A model on NEAR AI Cloud, in a TEE, may propose pay, hold or refuse. Code rules decide. The vault contract checks the limits again before any USDC moves.
- **Every decision is signed and anchored, refusals included.** Ledger entries are signed and hash-linked. A separate key, which can only call `anchor`, writes the ledger root on chain.

## The table

| | Probarion | NEAR Agent API | x402 exact on NEAR | AP2 | Plain caps [5] |
| --- | --- | --- | --- | --- | --- |
| Per-payment cap | yes, on chain | yes, API, and wallet on chain per the docs [1] | not in scope [3] | yes (amount range), verifiers | cap contract only |
| Per-period budget | vault-wide daily only, on chain | yes: per asset (API, and wallet on chain per the docs [1]), USD (API only) | not in scope [3] | no amount per period: a total budget plus a recurrence frequency and count, verifiers | if coded |
| Payee fixed by the owner | yes, on chain | only with a one-entry list, API | no: the server sets `payTo` | only with a one-entry list, verifiers | if coded |
| Destination allowlist | one payee per mandate, on chain | yes, API only | not in scope | yes (allowed payees), verifiers | if coded |
| Human approval above a threshold | yes, on chain | all or none, wallet on chain per the docs [2] | not in scope | per purchase when human present; no threshold | if coded |
| Freeze | yes, owner signs, on chain | yes, API, and wallet on chain per the docs | not in scope | not in the spec | if coded |
| Where limits are enforced | vault contract, on chain; code rules first | API service, and agent wallet on chain per the docs [1] | no limits; the facilitator checks the transfer matches the request [7] | verifiers: merchant, credential provider, network | on chain |
| Audit trail of decisions, refusals included | yes, signed, anchored on chain | executions, FAILED ones included; signed log [4] | settlement tx hash only | receipts, rejections included | chain txs only |
| Model attestation | yes: two recorded decisions pass A1 to A7, O1 and O2; image not pinned [6] | not in scope (the API runs in a TEE) | not in scope | not in scope | no |

Notes:

1. The Agent API docs say the API itself enforces destinations, the USD budget, the timelock and the schedule, so those hold in the API only. They say "The wallet provider enforces the rest", which covers actions, assets, per-asset limits, owner approval and freeze. Changes to those fields are written to the agent wallet's rules on chain, and the docs say this lets the wallet enforce them on chain. They do not name the wallet contract or show its code. The API also counts the per-asset limits before the wallet sees an action.
2. `owner_approval` is one switch. When on, every money action except deposits waits for the owner's vote. The docs describe no amount threshold.
3. The x402 v2 spec lists "Client-side budget management" as out of scope. Each request names one exact amount.
4. Each Agent API execution has a proof in an append-only log whose checkpoints a notary inside the TEE signs. The docs say a budget or limit refusal on an execution that runs now "leaves no operation and charges nothing". An admitted action that is refused, such as a timelocked one released over budget or a limit, is recorded as FAILED, and its execution has a proof. The docs do not describe anchoring the log on a chain.
5. Plain caps means a function-call key allowance or a spending-limit contract. NEAR's docs say the allowance is "The amount of NEAR allowed to be spent on gas", not tokens. A function-call key cannot attach a deposit, so it cannot call `ft_transfer`, which needs 1 yoctoNEAR. A cap contract enforces what its code checks and nothing else.
6. The Canary's ledger of 2026-11-10, published in the repository, holds two decisions by NEAR AI Cloud's `z-ai/glm-5.3-flash` that are attested and signed ([evidence](evidence/canary-vault/README.md#the-signed-ledger-published-2026-11-11)). Offline, `probarion verify` passes A1 to A7 on both: the signature, the response and the recorded proposal agree, and the attestation report is bound to that ledger position. The offline checks alone do not show that the signing key is held in a genuine TEE. A live `verify --online` on 2026-11-11 also passed O1 and O2 on both ([output](evidence/canary-vault/verify-online-2026-11-11.txt)): each TDX quote is a genuine Intel TDX quote (Intel DCAP, debug off, an accepted TCB status, which can be `OutOfDate`) whose report data holds the signing address and the entry's nonce, and NVIDIA NRAS verified each GPU payload with that nonce. The TEE measurement is not pinned, so this does not show which model image ran, or that the key stays inside it, and A8 was not run.
7. In x402 exact on NEAR, the payer signs a NEP-366 delegate action for one exact `ft_transfer`, and a relayer submits it. The spec says standard NEAR FunctionCall access keys "MUST be rejected" for this flow. So the paying key is a full-access key.

AP2 terms: AP2 v0.2 (2026-04-28) has a Checkout Mandate and a Payment Mandate, each open or closed. The user, or a trusted agent provider, signs the open mandates. The agent signs the closed ones in the human-not-present mode. AP2 v0.1 called them Cart, Intent and Payment Mandates. The AP2 spec says nothing about blockchains. Its first version supports card payments, and its repo has an x402 sample.

## What Probarion does not have

- No per-mandate budget per hour, day or month. A mandate has a per-payment cap, a total, a number of uses and an expiry. The only period limit is the vault-wide daily backstop per UTC day.
- No USD budget across assets. It pays USDC only: NEP-141 USDC on NEAR, or USDC on Base or Solana through NEAR Intents.
- No timelock and no time windows. A spend above `approval_above` is held for an approver, but other spends have no delay.
- No list of payees in one mandate. One mandate has one payee. More payees need more mandates.
- No outgoing webhooks. Owner alerts by Telegram and email are built but in preview. To follow a vault, index the NEP-297 events its contract logs.
- No relayer for gas. The owner and each approver pay the gas of what they sign. The agent key and the ledger key spend the vault's own NEAR on gas.
- No x402 or AP2 support. The pay-per-call example in the repo uses its own 402 format, not x402.
- No pinned TEE measurement, so no proof of which model image ran (note 6).
- Testnet only. The mainnet vault and the mainnet factory are not deployed.
- No third-party audit. The code is an unaudited beta.

## They can work together

These are ideas, not features. Nothing below is built.

- **An x402 seller as a mandate payee.** An x402 seller names its `payTo` and price per request. An owner could write that seller into a mandate ahead of time, with a small per-payment cap and a number of uses. The agent would then pay through `spend`. This is not x402 exact as written: that scheme wants the payer to sign one `ft_transfer` with a full-access key, and Probarion's agent key can call only `spend`. The seller would have to accept the vault's own transfer as proof of payment.
- **AP2 open mandates as Probarion mandates.** AP2's open Payment Mandate constraints map closely to a mandate: allowed payees to the payee, amount range to the per-payment cap, budget to the total, execution date to the expiry, and the recurrence count to the number of uses. Probarion has no recurrence frequency. An owner could sign the matching mandate on chain, so the contract enforces what the AP2 verifiers check.

## Sources

Probarion:

- Repository: https://github.com/probarion/probarion
- What works today: https://probarion.xyz/docs/start/what-works-today
- Mandates: https://probarion.xyz/docs/concepts/mandates

NEAR Agent API:

- Track 06 prompt, "Start here" links: https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/06-security.md
- Overview: https://docs.agentsonintents.com/integration/agent-api/overview
- How it works: https://docs.agentsonintents.com/integration/agent-api/concepts
- Policies and limits: https://docs.agentsonintents.com/integration/agent-api/policies-and-limits
- Executions: https://docs.agentsonintents.com/integration/agent-api/executions
- Transparency proofs: https://docs.agentsonintents.com/integration/agent-api/transparency
- TEE and attestation: https://docs.agentsonintents.com/integration/agent-api/tee

x402:

- Exact scheme on NEAR: https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_near.md
- x402 v2 specification: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md

AP2:

- Specification: https://ap2-protocol.org/ap2/specification/
- Payment Mandate: https://github.com/google-agentic-commerce/AP2/blob/main/docs/ap2/payment_mandate.md
- Overview: https://github.com/google-agentic-commerce/AP2/blob/main/docs/index.md
- Changelog (v0.2.0, 2026-04-28): https://github.com/google-agentic-commerce/AP2/blob/main/CHANGELOG.md
- v0.1 specification (Cart, Intent, Payment Mandates): https://github.com/google-agentic-commerce/AP2/blob/e66fc0b8f3f3c69fbabae721a4c57a18cf28c4b7/docs/specification.md

NEAR:

- Access keys: https://docs.near.org/protocol/accounts-contracts/access-keys
