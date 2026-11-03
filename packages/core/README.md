# @probarion/core

The pure TypeScript core of [Probarion](https://github.com/probarion/probarion), a mandate layer for AI
agents on NEAR: spend by mandate, prove every payment.

**Unaudited beta.** Versions 0.x may change the API in a minor release. MIT licensed.

Decisions, hashes and checks are deterministic functions of their inputs. There is no network, no
filesystem and no Node built-in, so the same code decides, hashes and verifies in the SDK, the CLI, a
server and a browser. The network and files live in [`@probarion/sdk`](https://www.npmjs.com/package/@probarion/sdk).

## What is in it

- **Types.** TypeScript mirrors of the Probarion vault and factory contract views, with the
  contracts' snake_case JSON keys, and the network constants (`NETWORKS`).
- **Hashing and keys.** `canonicalJson` (RFC 8785), `sha256Hex`, and ed25519 helpers in the NEAR key
  format (`generateKeyPair`, `createEd25519Signer`, `verifyEd25519`).
- **Ledger.** The ledger is a signed, hash-chained list of entries. `buildEntry` signs the body hash,
  `computeLink` chains it, `verifyEntrySignature` checks it, and `computeNonce` derives the attestation
  nonce from the ledger position and the vault account, so a model's attestation report is bound to one
  place in one vault's history.
- **Policy.** `decide(input)` is the code's decision for one invoice: the built-in rules plus any
  `CustomRule` you add. The destination of a payment always comes from the mandate; a `payee_hint` that
  contradicts it is refused. A model proposal is advice, used only when its attestation passes; the
  code rules (and the contract) still apply to the mandate it names.
- **Attestation.** `checkAttestation` runs the offline checks A1 to A7 on NEAR AI Cloud evidence
  (the signature, the signing address, the nonce binding, and that the signed response is the proposal
  that was recorded). `checkRequestBinding` is the auditor check A8, which recomputes the request from
  the invoice text. These checks do not show that a TDX quote came from genuine TEE hardware; that
  needs the online check in the SDK.
- **Verifier.** `runChecks(snapshot)` runs checks a to i (ledger signatures, hash links, on-chain
  anchors, a decision for every spend, attestations, vault locked, intents keys, burn memos, factory
  version) and returns a `VerifyReport`; `firstBrokenSeq(report)` names the first entry that fails.

## Install

```sh
npm install @probarion/core
```

ESM only, Node 24 or newer. Import it with `import`; there is no CommonJS build.

## Example

```ts
import { canonicalJson, firstBrokenSeq, runChecks, sha256Hex, type Snapshot } from "@probarion/core";

// RFC 8785: key order and number formatting are fixed, so the hash is stable everywhere.
sha256Hex(canonicalJson({ b: 1, a: 2 })); // the sha256 of {"a":2,"b":1}

// A snapshot comes from `@probarion/sdk` (`probarion.snapshot()`), or from a file someone gave you.
async function audit(snapshot: Snapshot) {
  const report = await runChecks(snapshot); // pure and offline; a malformed snapshot gives a failing report
  for (const check of report.checks) console.log(check.id, check.status, check.detail);
  return report.ok ? null : firstBrokenSeq(report);
}
```

A passing report says the ledger, the chain and the recorded decisions agree with each other. It does
not say the vault's code is audited, and the offline run does not verify TEE quotes.
