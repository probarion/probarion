# Security policy

Probarion lets an AI agent move USDC out of a NEAR contract, so we want to hear about any weakness in
it. This page says how to report one, what is in scope, and what the code does and does not protect
today.

**Unaudited beta.** No third party has audited the contracts or the packages. Today the vault runs on
NEAR testnet with test tokens. Since 2026-11-11 one mainnet vault, `v0.probarion.near`, holds a small
amount of real USDC. Its owner signed every transaction that created, funded or configured it, and
it has made one NEAR payment and one refusal. No Base payout has run on mainnet: spike S1, a contract
withdrawing Base POA USDC to a Base address on mainnet, is unproven
([the run](README.md#near-mainnet-2026-11-11)).

## Supported versions

| Version | Supported |
| --- | --- |
| The `dev` branch, where work lands, and `main` | Yes. A fix lands on `dev` first |
| The npm packages `@probarion/core`, `@probarion/sdk`, `probarion` and `@probarion/mcp` | The latest release, 0.1.1 (published 2026-11-11). A fix ships as a new version |
| The testnet vault `v0.probarion.testnet` | A test deployment. A vault has no upgrade method, so a fix ships as a new vault |
| The mainnet vault `v0.probarion.near` (2026-11-11, standalone, locked) | Yes. A vault has no upgrade method, so a fix ships as a new vault. Its owner can freeze it and withdraw its USDC ([runbook](docs/runbooks/mainnet-v0.md#if-anything-looks-wrong)) |

## Reporting a vulnerability

**Please do not put the details of a vulnerability in a public issue, pull request or post.**

- **On X:** send a direct message to [@probarionhq](https://x.com/probarionhq) that says you have a
  security report, with no details. We answer with a private channel for them.
- **On GitHub:** use the repository's private form,
  [**Security → Report a vulnerability**](https://github.com/probarion/probarion/security/advisories/new),
  which opens a private
  [security advisory](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/about-repository-security-advisories)
  that only you and the maintainers can see.

Say what is affected (a contract, a package, the web console, a script or a workflow), how to
reproduce it, and what an attacker could do with it. We aim to acknowledge a report within 72 hours,
fix a confirmed issue on `dev`, and credit you in the advisory and the changelog if you wish. There is
no bug bounty.

Test only against vaults you deployed yourself, on testnet or in the near-workspaces sandbox. Do not
try to move funds that are not yours.

### Response targets

| We aim to | Within |
| --- | --- |
| Acknowledge your report | 72 hours |
| Assess it and give it a severity ([severity levels](docs/RUNBOOK.md#severity-levels)) | 7 days |
| For a SEV1 (funds at risk): freeze the vaults Probarion runs, signed by the project owner, and ask the owners of every other vault to freeze theirs | At once |
| For a SEV2: ship a fix or a mitigation | 14 days |
| Disclose the issue, on a date agreed with you | Once a fix ships, or 90 days after the report |

Probarion can freeze only the vaults it runs: `freeze` checks the vault's owner, so the owner of any
other vault freezes it from their own wallet.

## Scope

In scope:

- the vault and factory contracts, [`contracts/vault`](contracts/vault) and
  [`contracts/factory`](contracts/factory);
- the packages [`@probarion/core`](packages/core), [`@probarion/sdk`](packages/sdk) and the
  [`probarion` CLI](packages/cli);
- the public site and web console in [`apps/web`](apps/web), deployed at
  <https://probarion.xyz> and <https://probarion.vercel.app>, NEAR testnet today (one deployment
  serves both networks, and the address decides which; a testnet address of the same deployment,
  once it is set up, is in scope too), with its database migrations, its server-side key sealing,
  and the browser extension's token API (`/api/ext/*`) and its `/extension` page;
- the browser extension for Chrome in [`apps/extension`](apps/extension), published on the Chrome
  Web Store as item `hhadnmnjdlamihjjoejphkimnbcfidmn`
  ([its listing](https://chromewebstore.google.com/detail/probarion/hhadnmnjdlamihjjoejphkimnbcfidmn));
- the build, deploy and release scripts in [`scripts`](scripts) and the workflows in
  [`.github/workflows`](.github/workflows).

Out of scope:

- [`contracts/intents-stub`](contracts/intents-stub) and [`contracts/test-ft`](contracts/test-ft),
  which are test stand-ins for `intents.near` and USDC and are not deployed on mainnet;
- weaknesses in services Probarion uses (the NEAR protocol, `intents.near`, the POA bridge, NEAR
  Intents 1Click, NEAR AI Cloud, wallets, NEAR RPC providers, Supabase, Vercel, Telegram and
  Resend), which go to that service;
- findings that need a compromised device, social engineering or physical access, denial of service
  by volume, and scanner output without a demonstrated impact.

## Safe harbor

Good-faith security research under this policy is welcome, and we will not take legal action over
it. Good faith here means that you test against your own vaults, on testnet or in the sandbox, or
against the Canary under its rules; that, outside the Canary, you do not move or try to move funds
that are not yours; that you do not degrade the service for anyone else; and that you report what
you find to us privately before you tell anyone else.

## The Canary

The Canary is a public testnet vault that anyone may try to trick, under its rules at
<https://probarion.xyz/canary/rules>. It is the one exception to "test only against vaults you
deployed yourself" above. It holds test tokens with no value, and there is no reward. A way past
what the contract enforces, such as a payment to an account no mandate names, is a vulnerability:
report it as above.

## Practices

- Reproducible builds: CI rebuilds the contracts in Docker and compares the code hashes in
  [`contracts/code-hashes.json`](contracts/code-hashes.json).
- CI runs gitleaks over the full history and `cargo clippy` with warnings as errors on every push
  and pull request to `main` and `dev`.
- GitHub secret scanning with push protection, Dependabot security updates and private
  vulnerability reporting are on for this repository.
- No owner keys on servers. Agent keys are generated server-side, encrypted at rest with a master key held outside the database, and can call only `spend`.
- Every decision is signed into a hash-chained ledger, and anchors pin it on chain.
- Dependabot alerts are triaged; the latest review is in the
  [review log](docs/THREAT_MODEL.md#review-log).

## Threat model

The full model (eleven attacks, the blast radius if Probarion is breached, the failure modes, the
trust assumptions and the known gaps) is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). The table
below says who holds which key, and what each can and cannot do.

The vault holds the USDC. The agent holds one function-call key. A spend is checked by code off chain
and again by the contract on chain, and every decision goes into a signed, hash-chained ledger.

| Who or what | Can | Cannot, and what stops it |
| --- | --- | --- |
| **The agent key** (a function-call key the vault adds to itself, method `spend` only) | Call `spend` against a mandate that names this key | Choose the payee: `SpendRequest` has no address field and the destination comes from the mandate in storage. Go past the mandate's `max_per_payment`, `max_total` (spent plus reserved), `max_uses` or `expires_at_ns`, or the vault's UTC-day `daily_backstop`. Pay one `invoice_hash` twice or reuse a `ref`. Call any other method, or attach a deposit: the NEAR protocol limits a function-call key to its method list and to calls without deposit |
| **The ledger key** (function-call key, method `anchor` only) | Anchor the next ledger range, `seq` exactly one above the last | Spend, or change a mandate or a key |
| **Whoever holds the agent key**, for example a breached server | Spend inside open mandates, with invoice hashes of its choosing | Pay anyone a mandate does not name, or exceed a mandate's limits or the daily backstop. Hide a rewritten ledger range that was anchored: `verify` names the first entry that does not match |
| **The owner** (a full-access key on the owner's account) | Create and revoke mandates, add and remove keys, set the ledger key, freeze, unfreeze, withdraw USDC and the Intents balance to the owner's own account | Change a mandate's payee (a new payee needs a new mandate), change the owner or the approvers, or upgrade the vault: there is no method for any of these |
| **A function-call key on the owner's or the approver's account**, such as a dapp login key | On the owner's account, call `freeze` if the key may call this vault (its receiver is the vault, and its method list is empty or names `freeze`). `freeze` takes no deposit so that the owner can stop the vault fast; a key scoped to another contract cannot call the vault at all | Call `add_agent`, `remove_agent`, `set_ledger_key`, `revoke_mandate`, `approve`, `reject`, `unfreeze`, `withdraw` or `withdraw_intents`: each needs exactly 1 yoctoNEAR attached, which only a full-access key can attach |
| **An approver** | Approve or reject a held spend (1 yoctoNEAR) | Approve while the vault is frozen, after the hold expired, or for a revoked mandate |
| **The factory owner** | Publish a new vault version | Change, upgrade or take funds from a vault the factory created: such a vault starts with no access keys and has no upgrade method |
| **The model** (NEAR AI Cloud, private TEE) | Propose `pay`, `hold` or `refuse` for one invoice | Decide alone. Its proposal is advice: the code rules run on every decision and the contract checks every spend, so text injected into an invoice cannot widen a mandate |
| **An extension token** (`pbx_…`, held by a connected browser; the server keeps a sha256 of the token and its last four characters, with the account, network, browser name and times, not the token itself) | At its network's address, for 30 days unless revoked: read its account's waiting invoices, held spends and active mandates; and queue an invoice (`POST /api/ext/invoices`, at most 20 per account and network in 10 minutes) for a vault, not a Canary vault, where the account is an owner or an approver, under a usable mandate the member picks, which the server stores in `awaiting_owner` only when core's `payeeHintContradiction` and the contract's `check_spend` view let it through, and otherwise stores nothing | Pay, approve, confirm, or change a mandate or a key: a queued invoice runs no cycle and waits for the owner's wallet-signed Confirm. No code under `apps/web/src/lib/ext`, `apps/web/src/app/api/ext` or `apps/web/src/lib/payables/queue*.ts`, nor any app module it loads, imports a function that pays or signs, or, from outside `apps/web/src/lib/crypto`, one that opens a sealed key, anything from `near-api-js` or `@near-js`, or a signer from the SDK or `@probarion/core`; it names no RPC method that sends a transaction and no database function or column that returns a sealed agent key, builds no database client but `apps/web/src/lib/db/clients.ts`, which only calls functions, and names each function it calls as a literal; outside `apps/web/src/lib/crypto`, it asks `subkey` only for the session's, imports none of `parseMasterKey`, `deriveSubkey`, `tenantInvoiceKey` or `getSodium`, and only the queue's route imports `masterKey`, and it loads no libsodium, tweetnacl, `@noble` or `@stablelib` package (`apps/web/test/ext-structure.test.ts`). `apps/web/src/lib/crypto/secrets.ts` opens a sealed value only inside its own opening functions, which the extension's server code never imports, and the queue's route reads the master key only to seal the invoice with `sealInvoice` and to key its duplicate guard, as the console upload does. That test reads imports and names: it catches a plain import of any of these, not code written to get around it, so review of every change to that code is the other control. The inbox and the queue read the chain through the SDK's `VaultClient`, built with no signer, and Confirm needs the owner's wallet signature |

### What `verify` proves

`runChecks` in `@probarion/core`, and `verify()` in `@probarion/sdk`, run checks a to i over a
snapshot of the ledger and the chain:

| Check | Passes when |
| --- | --- |
| a, b | Every ledger entry is signed by the vault's ledger key, and the hash links recompute |
| c | Every on-chain anchor root equals the ledger link at its count |
| d | Every on-chain spend is bound to exactly one decision with the same invoice, mandate and amount, which allowed it (or held it, for a spend that went through an approver) |
| e | Every decision with model evidence passes the attestation checks A1 to A7 (and A8 when the invoice text is supplied) |
| f | The vault has no full-access key, its other keys are only `spend` and `anchor` keys, and its code hash is a known reproducible build or a version of the canonical factory |
| g | The vault names the network's own intents contract, holds no public key there, and predecessor authentication is on |
| h | Every cross-chain spend has a burn whose memo is `WITHDRAW_TO:` and the mandate's address. A burn it cannot prove is `unproven`, and the report is then not `ok` |
| i | A factory vault's version is in the factory's registry |

### What is not proven yet

- **Offline, a snapshot is checked against itself.** `verify --offline` takes the chain data from the
  same file as the ledger. An edit that was not re-signed fails. A forged snapshot, with re-signed
  entries and chain data edited to agree, passes. Only a live run with `--vault` reads the chain, so
  take the snapshot yourself or run live.
- **That `decide()` ran.** `verify` shows that the ledger key signed each decision and that each spend
  is bound to one that allowed it; it does not run the policy again. Whoever holds both the agent key and
  the ledger key can skip `decide()` and still pass, within the mandate's payee and caps. Keep the ledger
  key out of the agent's reach: run `@probarion/mcp` as another OS user or in a container
  ([threat model](docs/THREAT_MODEL.md#known-gaps)).
- **The TEE measurement is not pinned (O1b, deferred).** Offline, A1 to A7 show that the signature,
  the response and the recorded proposal agree, and that the attestation report is bound to the
  ledger position. The online check O1 verifies the TDX quote through Intel DCAP, and O2 checks the
  NVIDIA payload through NRAS. Neither pins the measurements of NEAR AI's published image yet, so
  `quote_verified` stays false and Probarion says "attested and signed", not "proven to run a
  given model image".
- **A8 needs the invoice text.** The ledger stores no invoice text, so only an auditor who holds the
  invoices can show that the model saw the standard request for that invoice. A8 does not show that
  an invoice is authentic.
- **Entries after the last anchor** are checked against the ledger key only; no anchor pins them yet.
- **Historical mandate state.** A mandate's `remaining` and `status` at decision time need archival
  chain state, so `verify` reports a difference there as a note.
- **Testnet has no real bridge.** On testnet `intents-stub` stands in for `intents.near`, and a
  cross-chain burn does not leave NEAR.
- **Real attested decisions do not show which image ran.** The NEAR AI Cloud adapter is tested
  against a fake NEAR AI Cloud. On testnet, the Canary's ledger of 2026-11-10, published on 2026-11-11
  ([evidence](docs/evidence/canary-vault/README.md#the-signed-ledger-published-2026-11-11)), holds 2
  real decisions by a NEAR AI Cloud model that are attested and signed and pass A1 to A7 offline.
  On 2026-11-11 they also passed the online checks O1 and O2
  ([output](docs/evidence/canary-vault/verify-online-2026-11-11.txt)): each TDX quote is a genuine
  Intel TDX quote (Intel DCAP, debug off, an accepted TCB status, which can be `OutOfDate`) whose
  report data holds the signing address and the entry's nonce, and NVIDIA NRAS verified each GPU
  payload. The demo vault's ledger holds 4 more, made by Payables, which pass A1 to A7 offline and,
  on 2026-11-12, O1 and O2 online
  ([evidence](docs/evidence/demo-vault/README.md#2026-11-12-payables-pays-on-its-own-with-an-attested-model),
  [output](docs/evidence/demo-vault/verify-online-2026-11-12.txt)); the code allowed the last of
  them, and the vault paid that invoice, 2.00 test USDC. The TEE measurement is not pinned, so this
  does not show which model image ran, and A8 was not run, since the ledger holds no invoice text.
  The Canary's model is a small model given a deliberately gullible prompt.

The full design is in [`docs/specs/2026-10-21-probarion-design.md`](docs/specs/2026-10-21-probarion-design.md)
(§7, §10, §11 and §12), and the exact checks are in
[`docs/specs/2026-10-21-probarion-interfaces.md`](docs/specs/2026-10-21-probarion-interfaces.md) (§7 and §10).

## Acknowledgments

None yet.
