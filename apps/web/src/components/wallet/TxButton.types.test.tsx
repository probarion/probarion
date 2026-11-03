/**
 * Compile-time checks only (tsc runs this file; vitest does not, and nothing imports it): a TxButton
 * that uses `prepare()` must say which action it is with a `lockKey` (W-T6-R2).
 */
import type { ComponentProps } from "react";
import { freezeTx } from "@/lib/near/tx";
import { TxButton } from "./TxButton";

const tx = freezeTx("acme.vaults.probarion.near");
const prepare = async () => tx;

export const accepted = [
  <TxButton key="tx" label="Freeze" network="testnet" tx={tx} />,
  <TxButton key="tx-key" label="Freeze" network="testnet" tx={tx} lockKey="freeze:acme" />,
  <TxButton
    key="describe"
    label="Freeze"
    network="testnet"
    tx={tx}
    describe={(r) => (r.code === null ? undefined : { detail: r.error })}
  />,
  <TxButton
    key="prepare-key"
    label="Create"
    network="testnet"
    prepare={prepare}
    lockKey="create-vault:acme.vaults.probarion.near"
  />,
];

export const refused = [
  // @ts-expect-error prepare() without a lockKey: a reload would forget an unconfirmed send
  <TxButton key="prepare" label="Create" network="testnet" prepare={prepare} />,
  // @ts-expect-error describe returns words, not a number
  <TxButton key="bad-describe" label="Freeze" network="testnet" tx={tx} describe={() => 5} />,
  // @ts-expect-error a lockKey that is not a string
  <TxButton key="bad-key" label="Create" network="testnet" prepare={prepare} lockKey={5} />,
];

/** A wrapper that forwards the button's props keeps compiling (T8's VaultTxButton does). */
type Forwarded = Omit<ComponentProps<typeof TxButton>, "onResult">;
export function forward(props: Forwarded) {
  return <TxButton {...props} onResult={() => undefined} />;
}
