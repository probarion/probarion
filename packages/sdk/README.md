# @probarion/sdk

Let an AI agent pay people and services on NEAR only inside mandates that a human signed, and keep a
record that this human can publish for anyone to check afterwards.

**Unaudited beta.** Versions 0.x may change the API in a minor release. MIT licensed.

## How it fits together

- A **Probarion vault** is a NEAR smart contract that holds USDC. It pays only what an owner-signed
  **mandate** allows: one payee, a limit per payment, a total, a number of uses, an expiry, and an
  amount above which an approver has to confirm. The contract's `spend` method has no recipient
  argument, so the destination always comes from the mandate.
- The **agent key** is a function-call key that can call `spend` and nothing else. The **ledger key**
  is another function-call key that can call `anchor` and nothing else. The SDK holds only these two.
  Owner actions (create a vault or a mandate, add a key, freeze, approve) are signed by people in their
  own wallet; the [`probarion` CLI](https://github.com/probarion/probarion/tree/main/packages/cli) prints them for that.
- This SDK runs one payment cycle: the code decides, an optional model gives an attested proposal, the
  contract checks and pays, and every step is written to a signed, hash-chained **ledger** that is
  anchored on chain.

## Install

```sh
npm install @probarion/sdk @probarion/core
```

The examples below import from both packages, so install both. ESM only, Node 24 or newer. Import it
with `import`; there is no CommonJS build. To import `@probarion/sdk/testing` from TypeScript, set
`"moduleResolution"` to `"NodeNext"` or `"Bundler"`.

To build them from source instead, from a clone of the repository:

```sh
git clone https://github.com/probarion/probarion.git
cd probarion
pnpm install --frozen-lockfile
pnpm build
```

A script in the repository folder then imports the builds as `./packages/sdk/dist/index.js` and
`./packages/core/dist/index.js`, and a package of the clone's pnpm workspace that depends on them
imports them by name, as the examples below do.

## Quick start

```ts
import { sha256Hex } from "@probarion/core";
import { Probarion, hashInvoice } from "@probarion/sdk";

const probarion = new Probarion({
  network: "testnet",
  vault: "acme.vaults.probarion.testnet",
  agentKey: process.env.PROBARION_AGENT_KEY, // function-call key: can only call `spend`
  ledgerKey: process.env.PROBARION_LEDGER_KEY, // function-call key: can only call `anchor`
  // The NEAR AI Cloud model step needs a key: an empty `apiKey` throws a ConfigError here.
  // With no key, `model: null` decides with code only.
  model: process.env.NEARAI_API_KEY
    ? { provider: "near-ai-cloud", apiKey: process.env.NEARAI_API_KEY }
    : null,
});

const outcome = await probarion.process({
  text: invoiceText, // untrusted: it is shown to the model as data and nothing else
  ref: "INV-2026-001", // your reference; the vault accepts each ref once
  facts: {
    invoice_hash: hashInvoice(invoiceText),
    amount: "25000000", // USDC has 6 decimals, so this is 25 USDC
    po_ref: "PO-1001",
    purpose_hash: sha256Hex(poBytes), // the hash the mandate was created with
    payee_hint: null, // what the invoice claims; it is not used as the destination
  },
});

console.log(outcome.status, outcome.code, outcome.spendId, outcome.txHash);
```

`outcome.status` is one of:

- `refused_by_code`: a rule said no, and nothing was sent.
- `refused_by_contract`: the vault said no.
- `held`: with `spendId` set, the contract holds the spend until an approver approves or rejects it.
  With `spendId` null, a code rule held it (`code` names the rule) and nothing was sent; there is no
  approval to give for a code hold.
- `paid`: paid on NEAR.
- `burned`: paid out through NEAR Intents for Base or Solana. The release on the other chain is
  observed later, so `process` does not return `settled`.
- `failed`: definitely not paid.
- `unconfirmed`: a `spend` was sent and may have paid. Find out on the chain whether it did before
  anything else, and do not send it again under a new `ref`. The contract has no lookup by `ref`:
  list the vault's spends and match `ref`, as below. `probarion.spends.get(id)` reads one spend by
  its id.

```ts
import { RpcClient, resolveRpcUrls, VaultClient } from "@probarion/sdk";

// A read-only client: no sender, so it cannot sign anything. listAllSpends pages the contract's list_spends.
const vault = new VaultClient(
  "acme.vaults.probarion.testnet",
  new RpcClient({ urls: resolveRpcUrls("testnet") }),
);
const spend = (await vault.listAllSpends()).find((s) => s.ref === "INV-2026-001") ?? null;
```

## The `Probarion` class

| Member | What it does |
| --- | --- |
| `process({ text, facts, ref })` | The whole cycle for one invoice: decide, optional model proposal, `check_spend`, `spend`, ledger entries, anchor. |
| `requestSpend({ mandateId, amount, invoiceHash, ref, ... })` | The same path when you made the decision yourself. It has no recipient parameter. |
| `checkSpend({ mandateId, amount, invoiceHash, ref })` | The contract's free dry run of `spend`: no transaction, no ledger entry. |
| `mandates.list()`, `mandates.get(id)` | The vault's mandates, read from the chain. |
| `spends.get(id)`, `anchors.latest()` | One spend, and the latest ledger anchor. |
| `rules.add(rule)` | Adds a `CustomRule` (its id starts with `custom.`) to every decision. |
| `snapshot()` | The chain facts that `verify` needs, gathered together with your ledger. |
| `verify({ online?, snapshot?, invoiceTexts? })` | Runs the verifier checks a to i and returns a `VerifyReport`. |

With no keys and `model: null` an instance is read-only: the reads, `checkSpend`, `snapshot` and
`verify` work, and `process` and `requestSpend` throw a `ConfigError` before they read or write
anything. The package also exports the RPC client with failover (`RpcClient`), the vault, intents and
factory clients, the transaction sender and the typed errors.

## The ledger

Every decision and every payment becomes a ledger entry: signed with the ledger key, chained to the
entry before it, and anchored on chain. An entry that carries a model proposal also carries the
attestation evidence for it.

- `FileLedgerStore` keeps the ledger as a JSONL file: `.probarion/ledger.jsonl` by default, or
  `PROBARION_LEDGER_PATH`. Appends are locked and synced to disk. The lock is published with a hard
  link, so the ledger directory must be on a local disk whose file system supports hard links (NTFS,
  ext4, APFS). FAT, exFAT and some network shares do not, and there the store reports an error and does
  not fall back to anything weaker.
- `InMemoryLedgerStore` is for tests.
- Run one writer per vault. Two writers with two ledger files give the vault two histories, and the
  anchor check of `verify` fails for the ranges that came from the other file.

## The NEAR AI Cloud adapter

With `model: { provider: "near-ai-cloud", apiKey }` the SDK asks a private, TEE-hosted model on NEAR
AI Cloud for one structured proposal per invoice and records its attestation. The attestation report
is bound to the ledger position by a nonce, and the proposal is attested and signed: the signature
comes from the provider's TEE key, and the recorded proposal has to be the one that the signed
response contains. The model gives advice. The code rules still apply, and the contract has the last
word. If the model is unavailable or its attestation fails, the code decides alone.

The offline checks show that the evidence is consistent. Showing that a quote came from genuine TEE
hardware is the online check, `verify({ online: true })`, which uses the optional peer dependency
`@nearai/inference-sdk`.

## Testing your integration

`@probarion/sdk/testing` has a fake chain, a fake NEAR JSON-RPC server (`startFakeRpcServer`), a fake
NEAR AI Cloud (`createFakeNearAi`) and a ready scenario (`createScenarioChain`). They are test
doubles, not the contract: a passing test against them does not show that a real vault behaves the
same.

## Requirements

- Node >= 24 (`engines`).
- The optional peer dependency `@nearai/inference-sdk` (range `>=0.1.0 <1`) is only needed for the
  online attestation check. The NEAR AI SDK itself needs Node >= 24.22.1, so install it on that Node
  version or newer. Without it, the rest of the SDK runs on any Node >= 24.
- Keep `agentKey` and `ledgerKey` on the server and out of the repository.
