# @probarion/near

Building blocks for NEAR apps, from [Probarion](https://github.com/probarion/probarion), a mandate layer
for AI agents on NEAR. Probarion's own checks are made of these parts, and they work for any NEAR app.

**Unaudited beta.** Versions 0.x may change the API in a minor release. MIT licensed. This package is in
the repository and is not on npm yet; it reaches npm with the next release. ESM, with no CommonJS build; Node 24 or newer.

The pure functions use no network, no filesystem and no Node built-in, so they run the same in Node and in a
browser. The online helpers take any JSON-RPC client (an object with `call(method, params)`: `httpJsonRpc(url)`
is a minimal one, and the `RpcClient` of `@probarion/sdk` fits as is) and sign nothing. Dependencies:
`@noble/hashes` and `bs58`.

Status words: **Built** is implemented and tested in this repository. **Experimental** works on what was
recorded but rests on behaviour that is not documented. **Planned** is not built yet.

## Outcome proof verifier

`outcome-proof.ts` and `proof-rpc.ts`. **Built.**

Anyone who shows "this receipt ran, with these logs and this status" asks you to take one RPC node's word for
it. `verifyOutcomeProof(proof, head, expect?)` checks a NEAR `light_client_proof` answer against one block you
already trust, by its `block_merkle_root`. It recomputes the outcome's Merkle leaf (the Borsh
`PartialExecutionOutcome` and the hash of each log), the chunk and block outcome roots, the block hash from
`block_header_lite`, and that block's path to the head's `block_merkle_root`. The logs, status, gas, executor
and receipt ids it returns then rest on the head, not on the node that served them. It does not throw: a
refusal is a code (`malformed`, `path_too_long`, `outcome_root_mismatch`, `block_hash_mismatch`,
`head_mismatch`, `id_mismatch`, `executor_mismatch`, `status_mismatch`) and a detail.

- `verifyTransactionOutcomes(proofs, head, { txHash, signerId })` proves a transaction and its receipts under
  one head. It refuses a receipt the transaction did not lead to (`not_linked`), a duplicate, an empty list and
  a list of more than 256 proofs.
- `proveTransaction(rpc, { txHash, senderId, head })` reads the `tx` answer for the receipt ids, fetches a
  proof for the transaction and each receipt, and verifies the tree. `fetchOutcomeProof` sends one
  `light_client_proof` with nearcore's params.
- `readCrossCheckedHead(primary, secondary)` reads the final block on one provider and matches its hash,
  height and `block_merkle_root` on another, or throws `HeadMismatchError`.
- `merkleRootFromPath`, `lightBlockHash` and `outcomeLeafHash` are the low-level pieces.

What it does not prove: the head you pass in. Reading it from two providers run by different operators lowers
the trust in it; it does not remove it. Checking the head by validator signatures is **Planned**. It proves
the outcomes in the list and that each one descends from the transaction; a receipt that the `tx` answer
leaves out is not detected.

Tested on recorded mainnet proofs of Probarion's payout spend 2 (transaction
`BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9`, all 11 outcomes of its tree) and of the spend refused in the
2026-11-14 drill (transaction `G6WJcTZA67NBSrLV8zhS7Ay5BQKt6qCSao7dndm1tF1c`, whose failed receipt is proven
as a failure), with a tamper case for each committed field, a seeded mutation loop of 500 runs, and trees of
1 to 33 leaves built by a port of nearcore's `merklize`.

## Receipt-bound events

`events.ts`. **Built.**

Any contract can log `EVENT_JSON:{"standard":"nep141",...}`, and a receipt that fails keeps the logs it wrote
before it failed. An event means something when its emitter is the contract it describes and its receipt
succeeded.

- `eventsOf(source, { emitters, standard?, event?, status? })` reads NEP-297 events from the contracts you
  name (the list is required) and, by default, from receipts that succeeded. Each event carries its receipt
  id, emitter, log index, status and `proven`.
- `nep141Events`, `nep245Events` and `nep171Events` type the data: amounts as exact `bigint` values from
  canonical U128 strings (a number, `"01"`, `"-1"` or 2^128 is refused), valid account ids, matching
  `token_ids` and `amounts`. Each refused event or item is reported as a problem with a stable code
  (`malformed_outcome`, `duplicate_outcome`, `malformed_event`, `unknown_status`, `unsupported_version`,
  `bad_data`, `bad_item`) instead of being skipped.
- `ftDeltas` and `mtDeltas` give each account's net change, with an `ft_transfer_call` refund netted out.
- `scanAllEvents` lists every event and every malformed `EVENT_JSON` line with no emitter filter, for
  diagnostics. `parseEventLog` and `receiptStatusKind` are the pieces.

The source is an RPC `tx` answer or the `ProvenOutcome` list the proof verifier returns; read from proven
outcomes, each event says `proven: true`. Tested on Probarion's recorded testnet spends, its two mainnet
payouts and the expected logs in the unit tests of `near-contract-standards` 5.29.1, with seeded property
tests. A typed schema for the NEAR Intents `dip4` events is **Planned**; `eventsOf` already returns them by
name.

## Account lock audit

`access-keys.ts`, `code-identity.ts` and `account-rpc.ts`. **Built**, and run by Probarion's CLI as
`probarion account audit`.

- `auditAccessKeys(accountId, viewAccessKeyList, policy?)` states what each access key can do if it leaks:
  full access, receiver and exact methods, gas allowance, and NEP-611 gas keys with their balance. A permission
  it cannot read counts as full access. With a policy of exact method sets, pinned public keys and allowance
  bounds, a key outside it is a blocking finding.
- `codeIdentityOf(viewAccount)` reads what code the account runs, NEP-591 global contracts included: `local`,
  `global_by_hash`, or `global_by_account`, which follows a publisher account and is flagged as changeable.
  `matchRecordedBuild` checks it against a code-hashes record (the shape of `contracts/code-hashes.json` in
  the repository), and `wasmCodeHash` gives NEAR's code hash of a wasm file.
- `readAccountLock(rpc, accountId, { policy?, builds? })` reads `view_account` at the final block and
  `view_access_key_list` at that block's hash, so both views are of one block, and returns the
  `accountLockReport`: `locked`, `ok` and lines to print.

Tested on `v0.probarion.near` on mainnet and a testnet factory vault, recorded from public RPC, on the drill's
recorded `view_access_key` answers, and on the 13 recorded verifier snapshots of the repository, where it
agrees with Probarion's check f. A NEP-330 source metadata check is **Planned**.

## NEAR Intents POA withdrawal check

`poa.ts` and `poa-rpc.ts`. **Built**; the bridge status reader is **Experimental**.

- `poaWithdrawCall({ asset, chain, address, amount })` builds the `ft_withdraw` call that pays a NEAR Intents
  balance out to Base or Solana through the POA bridge: token and receiver the asset, memo
  `WITHDRAW_TO:<address>` with the address's case kept, `msg` null, 1 yoctoNEAR, 100 Tgas. Its `argsJson` is,
  byte for byte, what Probarion's vault sent in its mainnet spends 2 and 3.
- `findPoaBurns(source, { asset })` pairs `intents.near`'s NEP-245 `mt_burn` of `nep141:<asset>` with the POA
  token's NEP-141 `ft_burn` and its `WITHDRAW_TO:` memo, each bound to the contract that logged it in a receipt
  that succeeded. The counts and each pair's amounts must be equal.
- `findErc20Transfer(receipt, { txHash, contract, to, value? })` finds exactly one ERC-20 `Transfer` of the
  contract to the address in an `eth_getTransactionReceipt` result.
- `verifyPoaSettlement` gives one verdict with five named checks (`near_burn`, `memo_address`,
  `bridge_record`, `destination_transfer`, `amounts`) across the NEAR transaction or its proven outcomes, the
  POA bridge's `withdrawal_status` record and the Base receipt. It settles both mainnet payouts, in the token's
  smallest unit: 1000000 burned, 997600 received, a fee of 2400; and 250000, 247600, 2400.
- `readPoaWithdrawalStatus(bridge, burnTxHash)` (**Experimental**) sends `withdrawal_status` to the bridge's
  JSON-RPC at `POA_BRIDGE_RPC_URL`. The method was confirmed by a read of public data on 2026-11-14; statuses
  other than `COMPLETED` are not documented in what was read.

Base destinations are checked; Solana settlement is **Planned**. The Base receipt is what the Base RPC
answered, bound by hash to the bridge record; it is not proven.

## Use it

```ts
import {
  httpJsonRpc,
  proveTransaction,
  readCrossCheckedHead,
  scanAllEvents,
} from "@probarion/near";

const head = await readCrossCheckedHead(
  httpJsonRpc("https://rpc.mainnet.fastnear.com"),
  httpJsonRpc("https://rpc.intea.rs"),
);
const result = await proveTransaction(httpJsonRpc("https://archival-rpc.mainnet.fastnear.com"), {
  txHash: "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9",
  senderId: "v0.probarion.near",
  head,
});
if (!result.ok) throw new Error(`not proven: ${result.code}: ${result.detail}`);
for (const event of scanAllEvents(result.outcomes).events) {
  console.log(event.emitter, event.standard, event.event, event.proven);
}
```

The `examples/` folder of the repository has one example for each primitive: `prove-receipt.ts`,
`read-events.ts`, `audit-account.ts` and `check-payout.ts`.

Probarion's CLI runs two of them on the chain. Both read views and proofs over JSON-RPC and sign nothing:

```text
probarion --network mainnet account audit v0.probarion.near --vault-policy
probarion --network mainnet tx prove BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9 --signer v0.probarion.near
```

## Build and test from a clone

```sh
git clone https://github.com/probarion/probarion.git
cd probarion
pnpm install --frozen-lockfile
pnpm --filter @probarion/near build
pnpm --filter @probarion/near test
```

The tests run offline on fixtures recorded from public RPC. `pnpm --filter @probarion/near run record:proofs`
(and `record:keys`, `record:poa`) records them again: these scripts read public data and sign nothing.
