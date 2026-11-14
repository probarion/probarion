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
/** Bridge record 0's data, for tampering. */
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

type Expect = Parameters<typeof verifyPoaSettlement>[0]["expect"];

/** The verdict with spend 2's expectations, and the bridge's recorded fee as the bound, unless `expect` says else. */
function verify(r: Records, expect: Partial<Expect> = {}) {
  return verifyPoaSettlement({
    ...r,
    near: r.near as TxTreeLike,
    expect: {
      asset: ASSET,
      address: PAYEE,
      erc20: USDC_ON_BASE,
      maxFee: 2_400n,
      ...expect,
    } as Expect,
  });
}

/** The ids of the failed checks, and the earliest failure's detail. */
function failed(s: PoaSettlement): { ids: PoaCheckId[]; reason: string } {
  const bad = s.checks.filter((c) => !c.ok);
  return { ids: bad.map((c) => c.id), reason: bad[0]?.detail ?? "" };
}

/** The detail of one check. */
const detailOf = (s: PoaSettlement, id: PoaCheckId) => s.checks.find((c) => c.id === id)?.detail;

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
        expect: { asset: ASSET, address: PAYEE, erc20: USDC_ON_BASE, maxFee: 2_400n },
      });
      expect(settlement.ok).toBe(false);
      expect(settlement.checks[0]?.detail).toMatch(/unknown_status/);
    }
  });

  it("reads the testnet intents-stub, which logs both events itself, when it is named as an ft_burn emitter", () => {
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
    // By default the asset alone may log the ft_burn: the stub's own ft_burn does not count, so nothing pairs.
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

  it("does not count the token's ft_burn of another owner, or one without the WITHDRAW_TO: memo", () => {
    for (const [from, to] of [
      ['"owner_id":"intents.near"', '"owner_id":"alice.near"'],
      ['"memo":"WITHDRAW_TO:', '"memo":"'],
      ['"memo":"WITHDRAW_TO:', '"memo":"withdraw_to:'],
    ] as const) {
      const tx = nearTx(2);
      const logs = outcome(tx, SPENDS[2].ftBurn).outcome.logs;
      logs[0] = (logs[0] as string).replace(from, to);
      expect(logs[0], to).toContain(to);
      expect(findPoaBurns(tx, { asset: ASSET }), to).toEqual({
        burns: [],
        problems: [
          `1 mt_burn of nep141:${ASSET} by intents.near and 0 WITHDRAW_TO ft_burn by ${ASSET}: they do not pair`,
        ],
      });
    }
  });

  it("pairs by receipt: an ft_burn outside the mt_burn's receipt tree does not pair, whatever the list order", () => {
    // Spend 2's intents receipt burns for a second owner too, and an ft_burn to another address is put in front of
    // the token's own. In list order the vault's mt_burn would meet that address.
    const OTHER = `0x${"a".repeat(40)}`;
    const stray = "11111111111111111111111111111111";
    const build = (strayIsChild: boolean) => {
      const tx = nearTx(2);
      const mt = outcome(tx, SPENDS[2].mtBurn) as MutableOutcome & {
        outcome: { receipt_ids: string[] };
      };
      mt.outcome.logs[0] = (mt.outcome.logs[0] as string).replace(
        '"memo":"withdraw"}]',
        `"memo":"withdraw"},{"owner_id":"alice.near","token_ids":["nep141:${ASSET}"],"amounts":["1000000"],"memo":"withdraw"}]`,
      );
      const token = outcome(tx, SPENDS[2].ftBurn);
      const copy = structuredClone(token) as MutableOutcome & {
        outcome: { receipt_ids: string[] };
      };
      copy.id = stray;
      copy.outcome.logs = [(copy.outcome.logs[0] as string).replace(PAYEE, OTHER)];
      copy.outcome.receipt_ids = [];
      tx.receipts_outcome.splice(tx.receipts_outcome.indexOf(token), 0, copy);
      if (strayIsChild) mt.outcome.receipt_ids.push(stray);
      return tx;
    };
    const outside = findPoaBurns(build(false), { asset: ASSET, owner: VAULT });
    expect(outside).toEqual({
      burns: [],
      problems: [
        `ft_burn (receipt ${stray}) does not descend from a receipt with an mt_burn of nep141:${ASSET}`,
        `receipt ${SPENDS[2].mtBurn} holds 2 mt_burn of nep141:${ASSET} and 1 WITHDRAW_TO ft_burn descend ` +
          "from it: they do not pair",
      ],
    });
    // A receipt listed as created by two outcomes is a problem in itself.
    const twice = build(true);
    const signed = twice.receipts_outcome[0] as MutableOutcome & {
      outcome: { receipt_ids: string[] };
    };
    signed.outcome.receipt_ids.push(stray);
    expect(findPoaBurns(twice, { asset: ASSET }).problems).toContain(
      `receipt ${stray} is listed as created by both ${signed.id} and ${SPENDS[2].mtBurn}`,
    );
    // Even when the pair itself is clean, a doubtful tree gives no burn.
    const clean = nearTx(2);
    const vaultCall = clean.receipts_outcome[0] as MutableOutcome & {
      outcome: { receipt_ids: string[] };
    };
    const grandchild = (
      outcome(clean, SPENDS[2].ftBurn) as MutableOutcome & { outcome: { receipt_ids: string[] } }
    ).outcome.receipt_ids[0] as string;
    vaultCall.outcome.receipt_ids.push(grandchild);
    expect(findPoaBurns(clean, { asset: ASSET })).toEqual({
      burns: [],
      problems: [
        `receipt ${grandchild} is listed as created by both ${vaultCall.id} and ${SPENDS[2].ftBurn}`,
      ],
    });
    // Two owners, and two ft_burn to the same address for the same amount but in different receipts: which owner's
    // burn is which receipt is not told, so they do not pair either.
    const sameAddress = build(true);
    const strayOutcome = sameAddress.receipts_outcome.find((o) => o.id === stray) as MutableOutcome;
    strayOutcome.outcome.logs = [...outcome(sameAddress, SPENDS[2].ftBurn).outcome.logs];
    expect(findPoaBurns(sameAddress, { asset: ASSET }).problems).toEqual([
      `receipt ${SPENDS[2].mtBurn} holds 2 mt_burn of nep141:${ASSET} that differ, and the receipts do not ` +
        "tell which ft_burn is whose",
    ]);
    // Both ft_burn under the intents receipt: two owners, two addresses, and nothing says which is whose.
    const under = findPoaBurns(build(true), { asset: ASSET, owner: VAULT });
    expect(under).toEqual({
      burns: [],
      problems: [
        `receipt ${SPENDS[2].mtBurn} holds 2 mt_burn of nep141:${ASSET} that differ, and the receipts do not ` +
          "tell which ft_burn is whose",
      ],
    });
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

  it("does not throw: invalid options and sources are problems", () => {
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
    expect(failed(s)).toEqual({ ids: [], reason: "" });
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
      reason: expect.stringMatching(/^no_matching_transfer/),
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
      }).reason,
    ).toMatch(/^reverted/);
    expect(
      tamper((r) => {
        log(r).removed = true;
      }).ids,
    ).toEqual(["destination_transfer"]);
    expect(
      tamper((r) => {
        (receipt(r).logs as unknown[]).push(structuredClone(log(r)));
      }).reason,
    ).toMatch(/^ambiguous/);
    expect(
      tamper((r) => {
        r.destinationReceipt = baseReceipt(3);
      }).reason,
    ).toMatch(/^wrong_tx/);
    expect(
      tamper((r) => {
        r.destinationReceipt = null;
      }).reason,
    ).toMatch(/^malformed/);

    // The bridge record.
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).status = "PENDING";
      }),
    ).toEqual({
      ids: ["bridge_record", "destination_transfer", "amounts"],
      reason: "the bridge's status is PENDING, not COMPLETED",
    });
    // Spend 3's bridge record offered for spend 2's transaction.
    expect(
      tamper((r) => {
        r.bridgeAnswer = bridgeAnswer(3);
      }).reason,
    ).toMatch(/the bridge has no record of BdN7oB76.*its records are of 5amtgb8M/);
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.withdraw_amount = "997000";
      }).reason,
    ).toMatch(/do not add up to the burned 1000000/);
    // An inexact JSON number is kept, and compared as a number.
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.amount = 2 ** 53 + 2;
      }).reason,
    ).toBe(
      "the bridge's record says 9007199254740994 burned (a JSON number above 2^53 - 1), the burn is of 1000000",
    );
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.amount = 999_999;
      }).reason,
    ).toBe("the bridge's record says 999999 burned, the burn is of 1000000");
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.near_token_id =
          "base-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
      }).reason,
    ).toBe(
      `the bridge's record is of base-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near, not ${ASSET}`,
    );
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.chain = "sol:mainnet";
      }),
    ).toEqual({
      ids: ["bridge_record", "destination_transfer", "amounts"],
      reason: "the bridge's record is for chain sol:mainnet, not eth:8453 (Base)",
    });
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.account_id = "probarion.near";
      }).reason,
    ).toMatch(/is for probarion.near, but v0.probarion.near burned/);
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.transfer_tx_hash = null;
      }).reason,
    ).toBe("the bridge's record names no release transaction");
    // A release that is not a Base transaction hash (a Solana signature, say) is refused before Base is read.
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.transfer_tx_hash =
          SPENDS[2].near;
      }).reason,
    ).toMatch(/is not a Base transaction hash/);
    expect(
      tamper((r) => {
        const answer = r.bridgeAnswer as { withdrawals: unknown[] };
        answer.withdrawals.push(structuredClone(answer.withdrawals[0]));
      }).reason,
    ).toMatch(/2 records of/);
    // A release transaction the bridge names that is not the receipt given.
    expect(
      tamper((r) => {
        bridgeData(r.bridgeAnswer as Record<string, unknown>).data.transfer_tx_hash =
          SPENDS[3].base;
      }).reason,
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
    ).toMatchObject({ ids: ALL, reason: expect.stringMatching(/0 WITHDRAW_TO ft_burn/) });
    expect(
      tamper((r) => {
        outcome(r.near, SPENDS[2].mtBurn).outcome.status = { Failure: {} };
      }).ids,
    ).toEqual(ALL);
    expect(
      tamper((r) => {
        const logs = outcome(r.near, SPENDS[2].mtBurn).outcome.logs;
        logs[0] = (logs[0] as string).replace('"amounts":["1000000"]', '"amounts":["1000001"]');
      }).reason,
    ).toMatch(/differ/);
    expect(
      tamper((r) => {
        const mt = outcome(r.near, SPENDS[2].mtBurn).outcome.logs;
        const ft = outcome(r.near, SPENDS[2].ftBurn).outcome.logs;
        mt.push(mt[0] as string);
        ft.push(ft[0] as string);
      }).reason,
    ).toMatch(/2 POA withdrawal burns/);
    expect(
      tamper((r) => {
        r.nearTxHash = SPENDS[3].near;
      }).reason,
    ).toMatch(/is transaction BdN7oB76.*not 5amtgb8M/);
    // Without transaction.hash, the transaction outcome's id still ties the record to its hash.
    expect(
      tamper((r) => {
        delete (r.near as Partial<MutableTx>).transaction;
        r.nearTxHash = SPENDS[3].near;
      }).reason,
    ).toMatch(/transaction outcome is BdN7oB76.*not 5amtgb8M/);
    // With neither, the receipts are tied to no transaction: even the right hash does not pass.
    for (const hash of [SPENDS[2].near, SPENDS[3].near]) {
      expect(
        tamper((r) => {
          const tree = r.near as Partial<MutableTx>;
          delete tree.transaction;
          delete tree.transaction_outcome;
          r.nearTxHash = hash;
        }).reason,
      ).toBe(
        `the NEAR record has no outcome of transaction ${hash}, so its receipts are not tied to it`,
      );
    }
    // The intents receipt cut off from the transaction's tree: the burn pair is intact but is not this
    // transaction's.
    expect(
      tamper((r) => {
        const signed = r.near.receipts_outcome[0] as MutableOutcome & {
          outcome: { receipt_ids: string[] };
        };
        signed.outcome.receipt_ids = signed.outcome.receipt_ids.filter(
          (id) => id !== SPENDS[2].mtBurn,
        );
      }).reason,
    ).toBe(
      `receipt ${SPENDS[2].mtBurn} of the burn does not descend from the outcome of transaction ${SPENDS[2].near}`,
    );
    expect(tamper(() => {}, { amount: 999_999n }).reason).toBe(
      "the burn is of 1000000, not 999999",
    );
    expect(tamper(() => {}, { owner: "probarion.near" }).reason).toMatch(/from v0.probarion.near/);

    // The memo address comes from the burn: a different payee fails even though the bridge record is unchanged.
    expect(tamper(() => {}, { address: `0x${"1".repeat(40)}` }).ids).toEqual([
      "memo_address",
      "destination_transfer",
    ]);
    expect(tamper(() => {}, { address: PAYEE.toLowerCase() }).reason).toMatch(
      /by letter case alone/,
    );

    // The amounts.
    expect(tamper(() => {}, { maxFee: 2_399n })).toEqual({
      ids: ["amounts"],
      reason: "the fee 2400 is above 2399",
    });
    // The whole burn kept as the fee: nothing released, even under a bound that allows it.
    const drained = records(2);
    const { data } = bridgeData(drained.bridgeAnswer as Record<string, unknown>);
    data.withdrawal_fee = "1000000";
    data.withdraw_amount = "0";
    const nothing = verify(drained, { maxFee: 1_000_000n });
    expect(failed(nothing).ids).toEqual(["destination_transfer", "amounts"]);
    expect(detailOf(nothing, "amounts")).toBe("the bridge released nothing of the burned 1000000");
  });

  it("says skipped for a check whose input check failed, and does not throw", () => {
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
    // A JSON number amount is a caller mistake, not a mismatch.
    expect(verify(records(2), { amount: 1_000_000 as never }).checks[0]?.detail).toBe(
      "expect.amount is not a bigint",
    );
  });
});

describe("verifyPoaSettlement: what binds the Base release to the burn", () => {
  /** The POA bridge's sender on Base in both recorded releases. */
  const BRIDGE_SENDER = "0x2cff890f0378a11913b6129b2e97417a2c302680";

  /**
   * Spend 2's real burn, a bridge record edited to name spend 3's real release (247600 to the same payee) with
   * the fee that makes fee + released equal the burn, and spend 3's real Base receipt.
   */
  function pointedAtSpend3(): Records & { near: MutableTx } {
    const r = records(2);
    const { data } = bridgeData(r.bridgeAnswer as Record<string, unknown>);
    data.transfer_tx_hash = SPENDS[3].base;
    data.withdrawal_fee = "752400";
    data.withdraw_amount = "247600";
    r.destinationReceipt = baseReceipt(3);
    return r;
  }

  it("refuses another payout's release under the fee bound, and refuses to run without one", () => {
    const strict = verify(pointedAtSpend3(), { amount: 1_000_000n, owner: VAULT });
    expect(failed(strict)).toEqual({ ids: ["amounts"], reason: "the fee 752400 is above 2400" });
    const unbound = verify(pointedAtSpend3(), { maxFee: undefined as never });
    expect(failed(unbound).ids).toEqual(["amounts"]);
    expect(failed(unbound).reason).toMatch(
      /^expect\.maxFee is not a non-negative bigint: it is required/,
    );
    // So is the recorded payout itself: there is no default bound.
    expect(failed(verify(records(2), { maxFee: undefined as never })).ids).toEqual(["amounts"]);
  });

  it("trusts the bridge's choice of release within a loose fee bound, unless the release was already counted", () => {
    // A caller who accepts any fee gets spend 3's release counted for spend 2: the bridge's word decides. This is
    // the trust the doc names, not a pass to rely on.
    expect(verify(pointedAtSpend3(), { maxFee: 1_000_000n }).ok).toBe(true);
    // A watcher that counted spend 3's release already refuses it, in any letter case.
    for (const counted of [SPENDS[3].base, SPENDS[3].base.toUpperCase().replace("0X", "0x")]) {
      expect(
        failed(verify(pointedAtSpend3(), { maxFee: 1_000_000n, countedReleases: [counted] })),
      ).toEqual({
        ids: ["bridge_record", "destination_transfer", "amounts"],
        reason: `the bridge's release ${SPENDS[3].base} is in expect.countedReleases: it was counted for another burn`,
      });
    }
    // Other counted releases do not stand in the way, and a list that is not one is a caller mistake.
    expect(verify(records(2), { countedReleases: [SPENDS[3].base] }).ok).toBe(true);
    expect(failed(verify(records(2), { countedReleases: SPENDS[3].base as never })).reason).toBe(
      "expect.countedReleases is not a list of transaction hashes",
    );
  });

  it("checks the release's sender against expect.releaseFrom, and says when it is not checked", () => {
    const pinned = verify(records(2), {
      releaseFrom: [BRIDGE_SENDER.toUpperCase().replace("0X", "0x")],
    });
    expect(pinned.ok).toBe(true);
    expect(detailOf(pinned, "destination_transfer")).toBe(
      `${USDC_ON_BASE} moved 997600 from ${BRIDGE_SENDER} to ${PAYEE.toLowerCase()} in ${SPENDS[2].base} ` +
        "(block 56821514), a sender in expect.releaseFrom; the order in time is not checked (the NEAR record " +
        "carries no block times)",
    );
    expect(detailOf(verify(records(2)), "destination_transfer")).toMatch(
      /; the sender is not checked \(no expect\.releaseFrom\);/,
    );
    expect(failed(verify(records(2), { releaseFrom: [`0x${"5".repeat(40)}`] }))).toEqual({
      ids: ["destination_transfer"],
      reason: `the Transfer is from ${BRIDGE_SENDER}, which is not in expect.releaseFrom`,
    });
    for (const bad of [[], ["0x2cff"], BRIDGE_SENDER]) {
      expect(failed(verify(records(2), { releaseFrom: bad as never })).reason, String(bad)).toBe(
        "expect.releaseFrom is not a non-empty list of EVM addresses",
      );
    }
  });

  it("settles an 18-decimal size burn whose bridge amount is an inexact JSON number, on fee + released", () => {
    // Spend 2's three records edited to 10000000000000001 base units (0.01 of an 18-decimal token, plus 1): the
    // bridge's JSON number 1e16 cannot hold the last digit. Synthetic: no such payout was made.
    const burned = "10000000000000001";
    const released = 10_000_000_000_000_001n - 2_400n;
    const edited = (bridgeAmount: number) => {
      const r = records(2);
      const mt = outcome(r.near, SPENDS[2].mtBurn).outcome.logs;
      mt[0] = (mt[0] as string).replace('"amounts":["1000000"]', `"amounts":["${burned}"]`);
      const ft = outcome(r.near, SPENDS[2].ftBurn).outcome.logs;
      ft[0] = (ft[0] as string).replace('"amount":"1000000"', `"amount":"${burned}"`);
      const { data } = bridgeData(r.bridgeAnswer as Record<string, unknown>);
      data.amount = bridgeAmount;
      data.withdraw_amount = released.toString();
      const log = (
        (r.destinationReceipt as Record<string, unknown>).logs as Record<string, unknown>[]
      )[0];
      (log as Record<string, unknown>).data = `0x${released.toString(16).padStart(64, "0")}`;
      return r;
    };
    const s = verify(edited(1e16), { amount: BigInt(burned) });
    expect(failed(s)).toEqual({ ids: [], reason: "" });
    expect(s.bridge).toMatchObject({ amount: 10n ** 16n, amountExact: false, received: released });
    expect(detailOf(s, "bridge_record")).toMatch(
      /; its amount is an inexact JSON number, so fee \+ released stand for it$/,
    );
    expect(failed(verify(edited(2e16))).reason).toBe(
      `the bridge's record says 20000000000000000 burned (a JSON number above 2^53 - 1), the burn is of ${burned}`,
    );
  });
});
