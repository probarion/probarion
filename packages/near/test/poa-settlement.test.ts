import { describe, expect, it } from "vitest";
import {
  findPoaBurns,
  type PoaCheckId,
  type PoaSettlement,
  verifyPoaSettlement,
} from "../src/poa.js";
import type { OutcomeLike, ProvenOutcome, TxTreeLike } from "../src/types.js";
import { readFixture } from "./helpers/fixtures.js";

// Probarion's two mainnet payouts to Base (2026-11-13): the NEAR txs recorded by scripts/record-poa.ts with their
// receipt statuses, the POA bridge's withdrawal_status answers and the Base receipts copied from the repository.
const ASSET = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const USDC_ON_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAYEE = "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27";
const VAULT = "v0.probarion.near";
const SPENDS = {
  2: {
    tx: "mainnet-spend-2-tx.json",
    status: "poa-status-s1.json",
    receipt: "spend-2",
    near: "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9",
    base: "0xc2df8f8799467834cdaed0e8f23638af49334483387560fd34ef360939e1ea71",
    mtBurn: "F2BErA5fo6HBPhgwjyER9iiCrs9XHmDHX6dsey1dZmVi",
    ftBurn: "D7Ux36fgy29tu5jjEoEstVwbLz3FXDP8Q2gDu65ZkK3b",
    burned: 1_000_000n,
    received: 997_600n,
  },
  3: {
    tx: "mainnet-spend-3-tx.json",
    status: "poa-status-s2.json",
    receipt: "spend-3",
    near: "5amtgb8MujUkiydS5Ht9Ut6AX6pN9SGegHUCHGsX9NGH",
    base: "0xc6c4507e098b558bdff1b5836600f5e3365fee5a63037d399db58e1db4547ab7",
    mtBurn: "2HMqxtTBKuKsmvmFeePXm3eELefEtaVGaDWJVMyGaUHq",
    ftBurn: "FNAzBqBEWNeA1eJtnPP2h4VxzNuf3Dn68USwnbTHALSQ",
    burned: 250_000n,
    received: 247_600n,
  },
} as const;
type SpendId = keyof typeof SPENDS;

interface MutableOutcome {
  id: string;
  outcome: { executor_id: string; logs: string[]; status?: unknown };
}
interface MutableTx {
  transaction: { hash: string };
  transaction_outcome: MutableOutcome;
  receipts_outcome: MutableOutcome[];
}

const nearTx = (spend: SpendId) =>
  structuredClone(readFixture<{ result: MutableTx }>(`poa/${SPENDS[spend].tx}`).result);
const bridgeAnswer = (spend: SpendId) =>
  structuredClone(
    readFixture<{ answer: Record<string, unknown> }>(`poa/${SPENDS[spend].status}`).answer,
  );
const baseReceipt = (spend: SpendId) =>
  structuredClone(
    readFixture<{ receipts: Record<string, Record<string, unknown>> }>("poa/base-receipts.json")
      .receipts[SPENDS[spend].receipt],
  );
const outcome = (tx: MutableTx, id: string): MutableOutcome => {
  const found = tx.receipts_outcome.find((o) => o.id === id);
  if (found === undefined) throw new Error(`no outcome ${id}`);
  return found;
};
/** The first bridge record's data, for tampering. */
const bridgeData = (answer: Record<string, unknown>) =>
  (answer.withdrawals as { status: string; data: Record<string, unknown> }[])[0] as {
    status: string;
    data: Record<string, unknown>;
  };

interface Records {
  near: MutableTx | readonly ProvenOutcome[] | TxTreeLike;
  nearTxHash: string;
  bridgeAnswer: unknown;
  destinationReceipt: unknown;
}

function records(spend: SpendId): Records & { near: MutableTx } {
  return {
    near: nearTx(spend),
    nearTxHash: SPENDS[spend].near,
    bridgeAnswer: bridgeAnswer(spend),
    destinationReceipt: baseReceipt(spend),
  };
}

function verify(
  r: Records,
  expect: Partial<Parameters<typeof verifyPoaSettlement>[0]["expect"]> = {},
) {
  return verifyPoaSettlement({
    ...r,
    near: r.near as TxTreeLike,
    expect: { asset: ASSET, address: PAYEE, erc20: USDC_ON_BASE, ...expect },
  });
}

/** The ids of the failed checks, and the first failure's detail. */
function failed(s: PoaSettlement): { ids: PoaCheckId[]; first: string } {
  const bad = s.checks.filter((c) => !c.ok);
  return { ids: bad.map((c) => c.id), first: bad[0]?.detail ?? "" };
}

const ALL: PoaCheckId[] = [
  "near_burn",
  "memo_address",
  "bridge_record",
  "destination_transfer",
  "amounts",
];

describe("findPoaBurns", () => {
  it("pairs the intents mt_burn with the POA token's ft_burn in both mainnet payouts", () => {
    for (const spend of [2, 3] as const) {
      const s = SPENDS[spend];
      expect(findPoaBurns(nearTx(spend), { asset: ASSET })).toEqual({
        burns: [
          {
            asset: ASSET,
            owner: VAULT,
            amount: s.burned,
            memo: `WITHDRAW_TO:${PAYEE}`,
            address: PAYEE,
            mtBurnReceiptId: s.mtBurn,
            ftBurnReceiptId: s.ftBurn,
            proven: false,
          },
        ],
        problems: [],
      });
    }
    expect(findPoaBurns(nearTx(2), { asset: ASSET, owner: VAULT }).burns).toHaveLength(1);
    expect(findPoaBurns(nearTx(2), { asset: ASSET, owner: "probarion.near" })).toEqual({
      burns: [],
      problems: [],
    });
    // Another asset has no burn here, and that is not a problem.
    expect(findPoaBurns(nearTx(2), { asset: "base-other.omft.near" })).toEqual({
      burns: [],
      problems: [],
    });
  });

  it("refuses the trimmed mainnet outcomes: their receipt statuses were not recorded", () => {
    // N2's copy of the landing page's recorded reads (apps/web mainnet-payout-recorded.json), statuses removed there.
    const trimmed = readFixture<Record<"spend2" | "spend3", TxTreeLike>>(
      "events/mainnet-payout-outcomes.json",
    );
    for (const tree of [trimmed.spend2, trimmed.spend3]) {
      const found = findPoaBurns(tree, { asset: ASSET });
      expect(found.burns).toEqual([]);
      expect(found.problems.filter((p) => p.includes("unknown_status"))).toHaveLength(2);
      const settlement = verifyPoaSettlement({
        near: tree,
        nearTxHash: tree.transaction?.hash ?? "",
        bridgeAnswer: bridgeAnswer(tree === trimmed.spend2 ? 2 : 3),
        destinationReceipt: baseReceipt(tree === trimmed.spend2 ? 2 : 3),
        expect: { asset: ASSET, address: PAYEE, erc20: USDC_ON_BASE },
      });
      expect(settlement.ok).toBe(false);
      expect(settlement.checks[0]?.detail).toMatch(/unknown_status/);
    }
  });

  it("reads the testnet intents-stub, which logs both events itself, only when it is a named ft_burn emitter", () => {
    const trees = readFixture<Record<string, TxTreeLike>>("events/testnet-spend-trees.json");
    const burned = trees.burned as TxTreeLike;
    const stub = "intents-stub.probarion.testnet";
    const asset = "base-usdc.probarion.testnet";
    const found = findPoaBurns(burned, { asset, intents: stub, ftBurnEmitters: [asset, stub] });
    expect(found.problems).toEqual([]);
    expect(found.burns).toMatchObject([
      {
        owner: "v0.probarion.testnet",
        amount: 1_000_000n,
        address: "0x1111111111111111111111111111111111111111",
        mtBurnReceiptId: "Fvs9ZsdrJuSZ9TFJVMN5pqAC9BUVxq42v9jUuhjdPhhA",
        ftBurnReceiptId: "Fvs9ZsdrJuSZ9TFJVMN5pqAC9BUVxq42v9jUuhjdPhhA",
      },
    ]);
    // By default only the asset may log the ft_burn: the stub's own ft_burn does not count, so nothing pairs.
    const strict = findPoaBurns(burned, { asset, intents: stub });
    expect(strict.burns).toEqual([]);
    expect(strict.problems).toEqual([
      `1 mt_burn of nep141:${asset} by ${stub} and 0 WITHDRAW_TO ft_burn by ${asset}: they do not pair`,
    ]);
  });

  it("does not count an ft_burn logged by the vault, or by any account but the token", () => {
    const tx = nearTx(2);
    const token = outcome(tx, SPENDS[2].ftBurn);
    // Move the token's ft_burn log into the vault's receipt: the same text, the wrong emitter.
    const vault = outcome(tx, "ChNYpWkBdspsT81quDPBLKZ5AWn37x6DkN1nNdzComfY");
    vault.outcome.logs.push(...token.outcome.logs);
    token.outcome.logs = [];
    const found = findPoaBurns(tx, { asset: ASSET });
    expect(found.burns).toEqual([]);
    expect(found.problems[0]).toMatch(/1 mt_burn .* and 0 WITHDRAW_TO ft_burn/);
  });

  it("refuses a failed mt_burn receipt, unequal amounts, two burns and broken events", () => {
    const problemsOf = (edit: (tx: MutableTx) => void) => {
      const tx = nearTx(2);
      edit(tx);
      const found = findPoaBurns(tx, { asset: ASSET });
      if (found.problems.length > 0) expect(found.burns).toEqual([]);
      return found.problems;
    };
    // A Failure keeps the logs it wrote before failing: the mt_burn no longer counts.
    expect(
      problemsOf((tx) => {
        outcome(tx, SPENDS[2].mtBurn).outcome.status = { Failure: { ActionError: {} } };
      }),
    ).toEqual([
      `0 mt_burn of nep141:${ASSET} by intents.near and 1 WITHDRAW_TO ft_burn by ${ASSET}: they do not pair`,
    ]);
    expect(
      problemsOf((tx) => {
        const logs = outcome(tx, SPENDS[2].ftBurn).outcome.logs;
        logs[0] = (logs[0] as string).replace('"amount":"1000000"', '"amount":"999999"');
      })[0],
    ).toMatch(/pair 0: mt_burn of 1000000 .* and ft_burn of 999999 .* differ/);
    // Two burns in one record: two pairs, so a reader of one payout refuses (the verdict below), but they pair.
    const twice = nearTx(2);
    const mt = outcome(twice, SPENDS[2].mtBurn).outcome.logs;
    const ft = outcome(twice, SPENDS[2].ftBurn).outcome.logs;
    mt.push(mt[0] as string);
    ft.push(ft[0] as string);
    expect(findPoaBurns(twice, { asset: ASSET }).burns).toHaveLength(2);
    expect(
      problemsOf((tx) => {
        outcome(tx, SPENDS[2].mtBurn).outcome.logs.push(
          outcome(tx, SPENDS[2].mtBurn).outcome.logs[0] as string,
        );
      })[0],
    ).toMatch(/2 mt_burn .* and 1 WITHDRAW_TO ft_burn/);
    // An event of the token that breaks NEP-141: a JSON number amount.
    expect(
      problemsOf((tx) => {
        const logs = outcome(tx, SPENDS[2].ftBurn).outcome.logs;
        logs[0] = (logs[0] as string).replace('"amount":"1000000"', '"amount":1000000');
      }).join(" "),
    ).toMatch(/nep141 \(receipt D7Ux36fg.*bad_item/);
    expect(
      problemsOf((tx) => {
        const logs = outcome(tx, SPENDS[2].mtBurn).outcome.logs;
        logs[0] = (logs[0] as string).replace('"version":"1.0.0"', '"version":"2.0.0"');
      }).join(" "),
    ).toMatch(/unsupported_version/);
  });

  it("reads burns from proven outcomes and marks them proven", () => {
    const tx = nearTx(2);
    const proven: ProvenOutcome[] = [tx.transaction_outcome, ...tx.receipts_outcome].map((o) =>
      provenFrom(o),
    );
    const found = findPoaBurns(proven, { asset: ASSET });
    expect(found.problems).toEqual([]);
    expect(found.burns.map((b) => [b.amount, b.proven])).toEqual([[1_000_000n, true]]);
  });

  it("never throws: invalid options and sources are problems", () => {
    expect(findPoaBurns(nearTx(2), { asset: "Base" }).problems).toEqual([
      "options: asset is not a NEAR account id",
    ]);
    expect(findPoaBurns(nearTx(2), { asset: ASSET, intents: "" }).problems).toHaveLength(1);
    expect(findPoaBurns(nearTx(2), { asset: ASSET, owner: "A" }).problems).toHaveLength(1);
    expect(findPoaBurns(nearTx(2), { asset: ASSET, ftBurnEmitters: [] }).problems).toHaveLength(1);
    expect(findPoaBurns(nearTx(2), null as never).problems).toEqual(["options: not an object"]);
    const broken = findPoaBurns({ receipts_outcome: "x" } as never, { asset: ASSET });
    expect(broken.burns).toEqual([]);
    expect(broken.problems.join(" ")).toMatch(/malformed_outcome/);
  });
});

/**
 * A hand-built ProvenOutcome carrying an RPC outcome's fields (labelled: not recomputed from a proof here; the
 * outcome proof verifier's own tests do that). Statuses map to the proven kinds.
 */
function provenFrom(o: OutcomeLike): ProvenOutcome {
  const status = o.outcome.status as Record<string, unknown> | undefined;
  return {
    id: o.id,
    executorId: o.outcome.executor_id,
    logs: o.outcome.logs,
    receiptIds: o.outcome.receipt_ids ?? [],
    gasBurnt: 0n,
    tokensBurnt: 0n,
    status:
      status !== undefined && "SuccessValue" in status
        ? { kind: "success_value", value: new Uint8Array() }
        : status !== undefined && "SuccessReceiptId" in status
          ? { kind: "success_receipt_id", receiptId: String(status.SuccessReceiptId) }
          : { kind: "unknown" },
    block: { hash: "", height: 0, timestampNs: 0n, epochId: "" },
    head: { blockMerkleRoot: "" },
  };
}

describe("verifyPoaSettlement", () => {
  it("settles spend 2: 1000000 burned, 997600 received on Base, fee 2400", () => {
    const s = verify(records(2), { amount: 1_000_000n, owner: VAULT, maxFee: 2_400n });
    expect(failed(s)).toEqual({ ids: [], first: "" });
    expect(s.ok).toBe(true);
    expect(s.checks.map((c) => c.id)).toEqual(ALL);
    expect(s.burn).toMatchObject({ owner: VAULT, amount: 1_000_000n, address: PAYEE });
    expect(s.bridge).toMatchObject({ status: "COMPLETED", fee: 2_400n, received: 997_600n });
    expect(s.transfer).toMatchObject({
      txHash: SPENDS[2].base,
      contract: USDC_ON_BASE,
      to: PAYEE.toLowerCase(),
      value: 997_600n,
    });
    expect(s.checks.find((c) => c.id === "amounts")?.detail).toBe(
      "burned 1000000, released 997600, fee 2400 (at most 2400)",
    );
  });

  it("settles spend 3: 250000 burned, 247600 received on Base, fee 2400", () => {
    const s = verify(records(3), { amount: 250_000n, owner: VAULT });
    expect(failed(s).ids).toEqual([]);
    expect(s.ok).toBe(true);
    expect(s.bridge?.fee).toBe(2_400n);
    expect(s.transfer?.value).toBe(247_600n);
    expect(s.burn?.amount).toBe(250_000n);
  });

  it("settles from proven outcomes when they include the transaction's own outcome", () => {
    const r = records(2);
    const proven = [r.near.transaction_outcome, ...r.near.receipts_outcome].map((o) =>
      provenFrom(o),
    );
    expect(verify({ ...r, near: proven }).ok).toBe(true);
    expect(verify({ ...r, near: proven.slice(1) }).checks[0]?.detail).toMatch(
      /do not include the outcome of transaction/,
    );
  });

  it("fails each tamper with its named check", () => {
    const tamper = (
      edit: (r: Records & { near: MutableTx }) => void,
      expect: Partial<Parameters<typeof verifyPoaSettlement>[0]["expect"]> = {},
    ) => {
      const r = records(2);
      edit(r);
      return failed(verify(r, expect));
    };
    const receipt = (r: Records) => r.destinationReceipt as Record<string, unknown>;
    const log = (r: Records) =>
      (receipt(r).logs as Record<string, unknown>[])[0] as Record<string, unknown>;

    // The Base side.
    expect(
      tamper((r) => {
        (log(r).topics as string[])[2] = `0x${"0".repeat(24)}${"1".repeat(40)}`;
      }),
    ).toMatchObject({
      ids: ["destination_transfer"],
      first: expect.stringMatching(/^no_matching_transfer/),
    });
    expect(
      tamper((r) => {
        log(r).address = `0x${"2".repeat(40)}`;
      }).ids,
    ).toEqual(["destination_transfer"]);
    expect(tamper(() => {}, { erc20: `0x${"2".repeat(40)}` }).ids).toEqual([
      "bridge_record",
      "destination_transfer",
      "amounts",
    ]);
    expect(
      tamper((r) => {
        receipt(r).status = "0x0";
      }).first,
    ).toMatch(/^reverted/);
    expect(
      tamper((r) => {
        log(r).removed = true;
      }).ids,
    ).toEqual(["destination_transfer"]);
    expect(
      tamper((r) => {
        (receipt(r).logs as unknown[]).push(structuredClone(log(r)));
      }).first,
    ).toMatch(/^ambiguous/);
    expect(
      tamper((r) => {
        r.destinationReceipt = baseReceipt(3);
      }).first,
    ).toMatch(/^wrong_tx/);
    expect(
      tamper((r) => {
        r.destinationReceipt = null;
      }).first,
    ).toMatch(/^malformed/);

    // The bridge record.
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).status = "PENDING";
      }),
    ).toEqual({
      ids: ["bridge_record", "destination_transfer", "amounts"],
      first: "the bridge's status is PENDING, not COMPLETED",
    });
    // Spend 3's bridge record offered for spend 2's transaction.
    expect(
      tamper((r) => {
        r.bridgeAnswer = bridgeAnswer(3);
      }).first,
    ).toMatch(/the bridge has no record of BdN7oB76.*its records are of 5amtgb8M/);
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.withdraw_amount = "997000";
      }).first,
    ).toMatch(/do not add up to the burned 1000000/);
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.amount = 2 ** 53 + 2;
      }).first,
    ).toMatch(/not readable: .*withdrawals\[0\]\.data\.amount/);
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.account_id = "probarion.near";
      }).first,
    ).toMatch(/is for probarion.near, but v0.probarion.near burned/);
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.transfer_tx_hash = null;
      }).first,
    ).toBe("the bridge's record names no release transaction");
    // A release that is not a Base transaction hash (a Solana signature, say) is refused before Base is read.
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.transfer_tx_hash =
          SPENDS[2].near;
      }).first,
    ).toMatch(/is not a Base transaction hash/);
    expect(
      tamper((r) => {
        const answer = r.bridgeAnswer as { withdrawals: unknown[] };
        answer.withdrawals.push(structuredClone(answer.withdrawals[0]));
      }).first,
    ).toMatch(/2 records of/);
    // A release transaction the bridge names that is not the receipt given.
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.transfer_tx_hash =
          SPENDS[3].base;
      }).first,
    ).toMatch(/^wrong_tx/);

    // The NEAR side.
    expect(
      tamper((r) => {
        const token = outcome(r.near, SPENDS[2].ftBurn);
        outcome(r.near, "ChNYpWkBdspsT81quDPBLKZ5AWn37x6DkN1nNdzComfY").outcome.logs.push(
          ...token.outcome.logs,
        );
        token.outcome.logs = [];
      }),
    ).toMatchObject({ ids: ALL, first: expect.stringMatching(/0 WITHDRAW_TO ft_burn/) });
    expect(
      tamper((r) => {
        outcome(r.near, SPENDS[2].mtBurn).outcome.status = { Failure: {} };
      }).ids,
    ).toEqual(ALL);
    expect(
      tamper((r) => {
        const logs = outcome(r.near, SPENDS[2].mtBurn).outcome.logs;
        logs[0] = (logs[0] as string).replace('"amounts":["1000000"]', '"amounts":["1000001"]');
      }).first,
    ).toMatch(/differ/);
    expect(
      tamper((r) => {
        const mt = outcome(r.near, SPENDS[2].mtBurn).outcome.logs;
        const ft = outcome(r.near, SPENDS[2].ftBurn).outcome.logs;
        mt.push(mt[0] as string);
        ft.push(ft[0] as string);
      }).first,
    ).toMatch(/2 POA withdrawal burns/);
    expect(
      tamper((r) => {
        r.nearTxHash = SPENDS[3].near;
      }).first,
    ).toMatch(/is transaction BdN7oB76.*not 5amtgb8M/);
    expect(tamper(() => {}, { amount: 999_999n }).first).toBe("the burn is of 1000000, not 999999");
    expect(tamper(() => {}, { owner: "probarion.near" }).first).toMatch(/from v0.probarion.near/);

    // The memo address comes from the burn: a different payee fails even though the bridge record is unchanged.
    expect(tamper(() => {}, { address: `0x${"1".repeat(40)}` }).ids).toEqual([
      "memo_address",
      "destination_transfer",
    ]);
    expect(tamper(() => {}, { address: PAYEE.toLowerCase() }).first).toMatch(
      /by letter case alone/,
    );

    // The amounts.
    expect(tamper(() => {}, { maxFee: 2_399n })).toEqual({
      ids: ["amounts"],
      first: "the fee 2400 is above 2399",
    });
  });

  it("says skipped for a check whose input check failed, and never throws", () => {
    const s = verify(records(2), { asset: "base-other.omft.near" });
    expect(s.ok).toBe(false);
    expect(s.checks.map((c) => [c.id, c.ok, c.detail.startsWith("skipped: needs")])).toEqual([
      ["near_burn", false, false],
      ["memo_address", false, true],
      ["bridge_record", false, true],
      ["destination_transfer", false, true],
      ["amounts", false, true],
    ]);
    const empty = verifyPoaSettlement(null as never);
    expect(empty.ok).toBe(false);
    expect(empty.checks.map((c) => c.id)).toEqual(ALL);
    expect(verify({ ...records(2), nearTxHash: "0xc2df" }).checks[0]?.detail).toBe(
      "nearTxHash is not a NEAR transaction hash",
    );
    expect(verify({ ...records(2), near: "x" as never }).ok).toBe(false);
  });
});
