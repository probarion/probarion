import { describe, expect, it } from "vitest";
import {
  eventsOf,
  ftDeltas,
  mtDeltas,
  nep141Events,
  nep245Events,
  scanAllEvents,
} from "../src/events.js";
import { verifyTransactionOutcomes } from "../src/outcome-proof.js";
import type { ProvenOutcome, TrustedHead, TxTreeLike } from "../src/types.js";
import { readFixture } from "./helpers/fixtures.js";

// N1's recorded mainnet spend 2: the tx answer with statuses and a light_client_proof of the transaction and of every
// receipt, under a head read from two providers (see the fixture's _source).
const SPEND_2 = readFixture<{ head: TrustedHead; tx: TxTreeLike; proofs: unknown[] }>(
  "proofs/mainnet-spend-2.json",
);
const TX_HASH = "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9";
const VAULT = "v0.probarion.near";
const INTENTS = "intents.near";
const POA_ASSET = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const MEMO = "WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27";

function proven(proofs: readonly unknown[]): readonly ProvenOutcome[] {
  const result = verifyTransactionOutcomes(proofs, SPEND_2.head, {
    txHash: TX_HASH,
    signerId: VAULT,
  });
  if (!result.ok) throw new Error(`spend 2 does not verify: ${result.code}: ${result.detail}`);
  return result.outcomes;
}

describe("events read from proven outcomes (mainnet spend 2)", () => {
  const outcomes = proven(SPEND_2.proofs);

  it("reads the POA token's ft_burn with its WITHDRAW_TO memo, proven and successful", () => {
    const { items, problems } = nep141Events(outcomes, POA_ASSET);
    expect(problems).toEqual([]);
    expect(items.map((i) => i.item)).toEqual([
      { event: "ft_burn", ownerId: INTENTS, amount: 1_000_000n, memo: MEMO },
    ]);
    expect(items[0]?.event).toMatchObject({
      emitter: POA_ASSET,
      receiptId: "D7Ux36fgy29tu5jjEoEstVwbLz3FXDP8Q2gDu65ZkK3b",
      status: "success",
      proven: true,
    });
  });

  it("reads intents.near's mt_burn of the vault's nep141 balance", () => {
    const { items, problems } = nep245Events(outcomes, INTENTS);
    expect(problems).toEqual([]);
    expect(items.map((i) => [i.item, i.event.proven, i.event.status])).toEqual([
      [
        {
          event: "mt_burn",
          ownerId: VAULT,
          authorizedId: null,
          tokenIds: [`nep141:${POA_ASSET}`],
          amounts: [1_000_000n],
          memo: "withdraw",
        },
        true,
        "success",
      ],
    ]);
    const deltas = mtDeltas(outcomes, INTENTS).deltas;
    expect([...deltas].map(([account, perToken]) => [account, [...perToken]])).toEqual([
      [VAULT, [[`nep141:${POA_ASSET}`, -1_000_000n]]],
    ]);
    expect([...ftDeltas(outcomes, POA_ASSET).deltas]).toEqual([[INTENTS, -1_000_000n]]);
  });

  it("gives the same items as the RPC tx answer, which is read as unproven", () => {
    const fromRpc = nep141Events(SPEND_2.tx, POA_ASSET);
    expect(fromRpc.items.map((i) => i.item)).toEqual(
      nep141Events(outcomes, POA_ASSET).items.map((i) => i.item),
    );
    expect(fromRpc.items[0]?.event.proven).toBe(false);
    const all = (source: TxTreeLike | readonly ProvenOutcome[]) =>
      scanAllEvents(source).events.map((e) => [
        e.receiptId,
        e.emitter,
        e.logIndex,
        e.standard,
        e.event,
        e.status,
      ]);
    expect(all(outcomes)).toEqual(all(SPEND_2.tx));
  });

  it("has nothing to read when one character of the burn's log is changed: the proof no longer verifies", () => {
    const tampered = structuredClone(SPEND_2.proofs) as {
      outcome_proof: { id: string; outcome: { logs: string[] } };
    }[];
    const burn = tampered.find((p) =>
      p.outcome_proof.outcome.logs.some((l) => l.includes('"ft_burn"')),
    );
    if (burn === undefined) throw new Error("no ft_burn proof in the fixture");
    burn.outcome_proof.outcome.logs = burn.outcome_proof.outcome.logs.map((l) =>
      l.replace('"1000000"', '"9000000"'),
    );
    const result = verifyTransactionOutcomes(tampered, SPEND_2.head, {
      txHash: TX_HASH,
      signerId: VAULT,
    });
    expect(result.ok ? "ok" : result.code).toBe("outcome_root_mismatch");
  });

  it("reports the POA burn as missing when its outcomes are left out of a list of proven ones", () => {
    // The POA token's burn receipt and the receipt it created, left out: what a list of receipts proven one by one
    // gives when the `tx` answer that named them hid those two. Each of the 9 left is still a proven outcome.
    const BURN = "D7Ux36fgy29tu5jjEoEstVwbLz3FXDP8Q2gDu65ZkK3b";
    const BURN_CHILD = "9aKWUzfU2vCZSxdZcPeKmTKFLLDqgT6PiWZFGJCUP5xV";
    const MT_BURN = "F2BErA5fo6HBPhgwjyER9iiCrs9XHmDHX6dsey1dZmVi"; // intents.near's receipt, which created BURN
    const partial = outcomes.filter((o) => o.id !== BURN && o.id !== BURN_CHILD);
    expect(partial).toHaveLength(9);
    const missing = {
      receiptId: MT_BURN,
      emitter: INTENTS,
      logIndex: -1,
      problem: `missing_outcome: ${MT_BURN} created receipt ${BURN}, which is not in the source`,
    };
    // The burn of 1000000 is not in the list: no delta, and a problem says why instead of an empty, clean answer.
    expect(ftDeltas(partial, POA_ASSET)).toEqual({ deltas: new Map(), problems: [missing] });
    expect(nep141Events(partial, POA_ASSET).problems).toEqual([missing]);
    expect(mtDeltas(partial, INTENTS).problems).toEqual([missing]);
    expect(() => eventsOf(partial, { emitters: [POA_ASSET] })).toThrow(missing.problem);
    expect(scanAllEvents(partial).malformed).toEqual([missing]);
    // The whole list of 11 names no receipt it lacks.
    expect(scanAllEvents(outcomes).malformed).toEqual([]);
  });
});
