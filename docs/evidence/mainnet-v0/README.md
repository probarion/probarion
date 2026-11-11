# The mainnet v0 vault, 2026-11-11

`v0.probarion.near` is the first Probarion vault on NEAR mainnet, with real USDC. On 2026-11-11, between 12:52 and
13:00 UTC, the owner ran the 2026-11 demo path of [`docs/runbooks/mainnet-v0.md`](../../runbooks/mainnet-v0.md) in
their own terminal. The owner signed every transaction: the owner calls with near-cli-rs, the two spends with the
agent key file, and the two transfers from their own wallet in Meteor. Claude signed nothing on mainnet. The amounts
are small on purpose, because the contract is unaudited.

It is a standalone vault. The owner created, deployed and locked it directly. No mainnet factory is deployed:
`vaults.probarion.near` does not exist, and no global contract is published.

## Accounts

| Role | Account |
| --- | --- |
| Vault | `v0.probarion.near`, code hash `3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1`: the reproducible CI build of commit `64ac3c0` (CI run 41602304226), recorded in [`contracts/code-hashes.json`](../../../contracts/code-hashes.json). No full-access key |
| Owner | `probarion.near`, a near-cli-rs account whose key is in the owner's keychain |
| Approver and payee | `probarion-duong.near`, the owner's own Meteor wallet. It funded the run, it is the vault's one approver, and it is the payee of mandate 1, so the 1 USDC paid went back to the owner |
| Funder | `ca9fd7a2b71d5d72948e6f8b1975c6c4b6df87960fecae978df835e1074cb197`, an implicit account near-cli-rs made so that it could create `probarion.near`, since Meteor cannot sign near-cli-rs transactions |
| Agent key | `ed25519:GADeVCXtgcxS3E5JrcVpEWTuZiNMJ4gu17iyuEgyCycd`, label `v0 agent`, can call `spend` on the vault and nothing else |
| Token | Native USDC on NEAR, `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, 6 decimals |

The vault's config on chain: owner `probarion.near`, approvers `["probarion-duong.near"]`, USDC as above,
`intents.near`, the Base and Solana POA USDC as allowed assets, a daily backstop of 500 USDC, holds that expire after
72 hours, not frozen, no factory, version `0.1.0`, no ledger key.

## Transactions

In the order they ran. The step numbers are the runbook's.

| What | Transaction |
| --- | --- |
| The owner's Meteor wallet funds the funder account (section 0.4) | [`35aaBnsx…`](https://nearblocks.io/txns/35aaBnsxD4zs7pLhX838crHTxYUMbPbc3aogXjTqpDD4) |
| The funder registers `probarion.near` through the `near` registrar (section 0.4) | [`CxFfpm13…`](https://nearblocks.io/txns/CxFfpm13QpCqxXvfVP4i1AeQwW52pTujMeit9BVGxeji) |
| `probarion.near` creates `v0.probarion.near` with a full-access key for the deploy (step 1) | [`Bi8aVRsr…`](https://nearblocks.io/txns/Bi8aVRsrRhcXhoSY6ifMGPHG6rQ9QsMJnxZYu2xnG28r) |
| The vault deploys the CI wasm and calls `new` with the mainnet constants (step 2) | [`HMQj8Ttw…`](https://nearblocks.io/txns/HMQj8TtwqCn3dYfPDzQbFScwBi4xQadaEqPhAV7p789F) |
| The vault deletes its only full-access key, so only the contract code controls it (step 3) | [`Ap8e7bAi…`](https://nearblocks.io/txns/Ap8e7bAiDkA6WvCWbzcezKVmweuJ1Zyei6GQK8rCrZs6) |
| The owner registers the vault on USDC with `storage_deposit` (step 4) | [`AoXATi6L…`](https://nearblocks.io/txns/AoXATi6L84yAtjMYbcxk9nSEq7vpo3SMtrTuCDhXBR73) |
| The Meteor wallet sends 3 USDC to the vault with `ft_transfer` (step 5) | [`HQQe3aTr…`](https://nearblocks.io/txns/HQQe3aTrhq4gAZZ9RcCiNNfnfUcBnK7Sbm6hHHsnWMBC) |
| The owner adds the agent key with `add_agent` (step 7) | [`C1auyjtE…`](https://nearblocks.io/txns/C1auyjtE9SbDroPenWARewRvDYMdfKmcF19FBssdzEJn) |
| The owner signs mandate 1 with `create_mandate`, which returned `1` (step 8) | [`8TnxDYrD…`](https://nearblocks.io/txns/8TnxDYrDDsRboPAFj1Pc2SyniZvya8iigpNJLPm9FzX2) |
| The agent key calls `spend` on mandate 1 for 1 USDC, ref `INV-M001`: spend 1 `paid`, 1 USDC to `probarion-duong.near` (step 9) | [`22oqhgru…`](https://nearblocks.io/txns/22oqhgruo7JqdpPg5Cb2ts25mLK2fto8y1YAxNA56ieE) |
| The agent key calls `spend` on mandate 999, which does not exist: refused on chain with `PROBARION:NoMandate`, and no USDC moved (step 11) | [`2Dabq4uM…`](https://nearblocks.io/txns/2Dabq4uMh9VvttH3uj85samfYoX2wbQheADHS96AtwYh) |

The paid spend logged `spend_submitted`, then the USDC contract's `ft_transfer` from the vault to
`probarion-duong.near`, then `spend_paid`, and returned `{"spend_id":1,"status":"paid"}`.

## Mandate 1 and the files behind the hashes

Mandate 1 pays `probarion-duong.near` at most 1 USDC a payment and 2 USDC in all, at most 2 payments, until
2027-01-31 00:00 UTC. Its `approval_above` is 1 USDC, so no spend under it can be held. Its agent key is the one above.

| Hash on chain | Value | The sha256 of |
| --- | --- | --- |
| Mandate 1 `purpose_hash` | `3bc57742e1153e0cf14254077ee4fe96569836fa0f49dbdc8bb74ba7cea7c4db` | [`po-PO-M001.txt`](po-PO-M001.txt) |
| Spend 1 `invoice_hash` | `292f7c324bca6da815e237596e678efd82cb9ddf9b40024b42e39a402762d459` | [`invoice-INV-M001.txt`](invoice-INV-M001.txt) |
| Spend 1 `decision_hash` | `d00e8ccc7a99a23a7f56d22d68aa69c7050330ac61e5c88c74bf013d188fb4f1` | [`v0-decision-m001.json`](../v0-decision-m001.json) |
| Refused spend `invoice_hash` | `03f5854ef2555ff209ad01330f73d15dc82f49431eddbc62e9564b5a3c716053` | [`v0-invoice-refusal.txt`](../v0-invoice-refusal.txt) |
| Refused spend `decision_hash` | `aa8a907f0666ab97fe78e8d9e6b77ed4572db5ed7132a6a6776325d4c0bc6dd0` | [`v0-decision-refusal.json`](../v0-decision-refusal.json) |

The decisions are pre-ledger. This vault has no ledger key and no signed ledger. Spend 1's `decision_hash` is the
sha256 of a decision document in this repository, not an entry of the attested ledger, and no TEE attestation covers
it. The verifier's check d exempts it only because `v0.probarion.near` is the one vault the code lists as pre-ledger,
and only because the hash is the sha256 of a `v0-decision-*.json` file in `docs/evidence`.

## After the run

A read-only read of the chain after the run found: the code hash above, no full-access key and one function-call key
(the agent key, method `spend` only); a USDC balance of 2000000 (2 USDC); mandate 1 active, 1000000 of 2000000 spent,
1 use of 2; and one spend, spend 1, `INV-M001`, `paid`.

## What did not run

- Step 6 (the top-up of Base POA USDC inside NEAR Intents), mandate 2 (a Base payee) and step 10 (the first Base
  payout) were not in this run. Spike S1, a contract account withdrawing Base POA USDC to a Base address on mainnet,
  is unproven. So this run moved nothing through NEAR Intents, and no Base payout has run on mainnet.
- No mainnet factory and no global contract. The web console at probarion.xyz serves testnet only, and it has no
  page for this vault.
- No signed ledger, no ledger key, no anchors and no attested model decision.

## Check it

Each transaction above opens on nearblocks, and so does
[the vault](https://nearblocks.io/address/v0.probarion.near). The vault's own views are free and need no key, for
example with near-cli-rs:

```bash
near contract call-function as-read-only v0.probarion.near list_spends json-args '{"from_index":0,"limit":10}' network-config mainnet now
near contract call-function as-read-only v0.probarion.near get_mandate json-args '{"mandate_id":1}' network-config mainnet now
```

[`verify-2026-11-11.txt`](verify-2026-11-11.txt) is the output of a live, read-only run of the repository's CLI at
2026-11-11T13:19Z, built from this repository. It read the chain itself and printed
`8 passed, 0 failed, 0 unproven, 1 skipped` and `RESULT: PASS`: checks a to h pass, and check i skips, because this
vault has no factory. The ledger is empty, so checks a to c pass on nothing, and check d passes because spend 1's
decision hash is one of the documented pre-ledger hashes. From a clone, after `pnpm install` and `pnpm build`:

```bash
node packages/cli/dist/bin.js verify --network mainnet --vault v0.probarion.near --evidence docs/evidence --proof docs/mainnet-proof.json
```

That run wrote [`snapshot-2026-11-11.json`](snapshot-2026-11-11.json), the chain data it read. Offline, with no
network, the verifier checks that file against itself:

```bash
node packages/cli/dist/bin.js verify --offline docs/evidence/mainnet-v0/snapshot-2026-11-11.json
```

The transactions are also recorded in [`docs/mainnet-proof.json`](../../mainnet-proof.json) and
[`contracts/deployments/mainnet.json`](../../../contracts/deployments/mainnet.json).
