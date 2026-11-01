# intents-stub

A stand-in for `intents.near` (the NEAR Intents Verifier) for the near-workspaces sandbox and for testnet, where Intents does not exist. **It is never deployed on mainnet.** On mainnet the vault talks to the real `intents.near`.

## What it models (the parts the Probarion vault uses)

| Real `intents.near` | Stub |
|---|---|
| Deposits by `ft_transfer_call` to the verifier credit an Intents account | `ft_on_transfer` credits `msg` (a plain account id) or the sender when `msg` is empty |
| `ft_withdraw(token, receiver_id, amount, memo, msg)` authenticates the owner by `predecessor_account_id` and needs exactly 1 yoctoNEAR | Same signature, same predecessor auth, same 1 yoctoNEAR rule |
| On every withdrawal `intents.near` burns the owner's internal balance and logs NEP-245 `mt_burn` (`owner_id` = the vault, `token_ids` = `["nep141:<token>"]`, memo `"withdraw"`) | The stub logs the same `mt_burn` shape |
| A POA token burns itself when `ft_transfer` has `receiver_id == token` and a memo starting with `WITHDRAW_TO:`. It logs NEP-300 `ft_burn` with `owner_id` = `intents.near` and the memo, and the POA bridge then releases funds on the destination chain | The stub detects the same branch, logs `ft_burn` with `owner_id` = the stub (the `intents.near` stand-in) and the memo, records a `BurnRecord`, and resolves to `amount` immediately |
| `ft_withdraw` resolves to the amount withdrawn, or 0 after a refund | Same: other withdrawals call `ft_transfer` on the token and resolve to `amount`, or 0 with the balance refunded |
| `public_keys_of`, `add_public_key` | Same names; keys are stored as strings. `add_public_key` exists so tests can prove the vault never calls it (I8) |
| `is_auth_by_predecessor_id_enabled`, `disable_auth_by_predecessor_id` | Same names; enabled by default, no way to re-enable |
| `mt_balance_of(account_id, token_id)` with `token_id = "nep141:<token>"` | Same |

## Differences (what it does not do)

1. **No signed intents.** There is no `execute_intents`, no NEP-413/ERC-191 signatures, no solvers, no `token_diff`, and no fees.
2. **No bridge.** Nothing leaves NEAR. A "burn" keeps the tokens in the stub's own account on the token contract; the real POA token destroys them, and the POA operator pays out on Base or Solana.
3. **Who emits the burn logs, and when.** On mainnet `mt_burn` comes from `intents.near` and `ft_burn` from the POA token contract (`base-…omft.near`), in a later receipt of the same transaction. Here both come from the stub account, in one receipt. The verifier's check (h) matches the `ft_burn` memo and the `mt_burn` owner and amount within one transaction; on testnet it must accept the stub as the emitter of both.
4. **No storage accounting.** No `storage_deposit` and no storage costs per account.
5. **Only NEP-141 deposits.** No NEP-245 `mt_transfer`, `mt_batch_transfer` or NEP-171 tokens; `msg` on `ft_withdraw` (the `ft_transfer_call` variant) is refused; `ft_on_transfer` accepts no JSON `DepositMessage`.
6. **No DAO roles.** No `ft_force_withdraw`, `force_lock_account` or `force_enable_auth_by_predecessor_ids`.
7. **No key removal.** There is no `remove_public_key`.
8. **Different gas.** Gas use differs from the real contract. The vault's 100 Tgas budget for `ft_withdraw` is checked on mainnet in spike S1, not here.
