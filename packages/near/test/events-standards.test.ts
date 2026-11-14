import { describe, expect, it } from "vitest";
import {
  EVENT_JSON_PREFIX,
  type EventProblem,
  ftDeltas,
  mtDeltas,
  nep141Events,
  nep171Events,
  nep245Events,
} from "../src/events.js";
import type { OutcomeLike, OutcomeSource, TxTreeLike } from "../src/types.js";
import { readFixture } from "./helpers/fixtures.js";

// Real testnet `tx` answers with receipt statuses (a byte copy of apps/web/test/fixtures/testnet-spend-trees.json).
const TREES = readFixture<Record<"paid" | "burned" | "noMandate", TxTreeLike>>(
  "events/testnet-spend-trees.json",
);
// The two mainnet payouts, statuses trimmed when they were recorded (see the fixture's _source).
const MAINNET = readFixture<Record<"spend2" | "spend3", TxTreeLike>>(
  "events/mainnet-payout-outcomes.json",
);
// Logs of near-contract-standards 5.29.1's own unit tests (reference logs, not chain data; see _source).
const REFERENCE = readFixture<{ nep141: Record<string, string>; nep171: Record<string, string> }>(
  "events/nep-reference-logs.json",
);

const VAULT = "v0.probarion.testnet";
const PAYEE = "probarion-payee.testnet";
const USDC = "usdc.probarion.testnet";
const STUB = "intents-stub.probarion.testnet";
const POA_ASSET = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

const event = (body: Record<string, unknown>) => `${EVENT_JSON_PREFIX}${JSON.stringify(body)}`;
const nep141 = (name: string, data: unknown, version = "1.0.0") =>
  event({ standard: "nep141", version, event: name, data });
const nep245 = (name: string, data: unknown, version = "1.0.0") =>
  event({ standard: "nep245", version, event: name, data });

let synthetic = 0;
/** A synthetic receipt outcome (labelled in each test): a fresh id, the executor, its logs, SuccessValue "". */
function outcome(
  executor: string,
  logs: string[],
  status: unknown = { SuccessValue: "" },
): OutcomeLike {
  synthetic++;
  return { id: `synthetic-receipt-${synthetic}`, outcome: { executor_id: executor, logs, status } };
}

function tree(...receipts: OutcomeLike[]): TxTreeLike {
  return { receipts_outcome: receipts };
}

const codes = (problems: readonly EventProblem[]) => problems.map((p) => p.problem.split(":")[0]);

describe("nep141Events on the recorded testnet trees", () => {
  it("reads the token's ft_transfer of the paid spend", () => {
    const { items, problems } = nep141Events(TREES.paid, USDC);
    expect(problems).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]?.item).toEqual({
      event: "ft_transfer",
      oldOwnerId: VAULT,
      newOwnerId: PAYEE,
      amount: 1_000_000n,
      memo: "probarion:1",
    });
    expect(items[0]?.itemIndex).toBe(0);
    expect(items[0]?.event.emitter).toBe(USDC);
    expect(items[0]?.event.status).toBe("success");
  });

  it("does not count a nep141 line logged by any other account", () => {
    // The intents-stub logs a nep141 ft_burn itself in the burned spend: it counts for the stub, not for the asset.
    expect(nep141Events(TREES.burned, "base-usdc.probarion.testnet")).toEqual({
      items: [],
      problems: [],
    });
    expect(nep141Events(TREES.burned, STUB).items.map((i) => i.item)).toEqual([
      {
        event: "ft_burn",
        ownerId: STUB,
        amount: 1_000_000n,
        memo: "WITHDRAW_TO:0x1111111111111111111111111111111111111111",
      },
    ]);
    // The vault's own events are of its own standard: nep141Events(vault) reads none of them.
    expect(nep141Events(TREES.paid, VAULT)).toEqual({ items: [], problems: [] });
  });

  it("ftDeltas on paid: the payer down and the payee up by 1000000", () => {
    const { deltas, problems } = ftDeltas(TREES.paid, USDC);
    expect(problems).toEqual([]);
    expect([...deltas]).toEqual([
      [VAULT, -1_000_000n],
      [PAYEE, 1_000_000n],
    ]);
  });

  it("ftDeltas ignores a forged nep141 transfer that the vault logged", () => {
    // Derived from the real `paid` tree, labelled: a vault receipt also logs a nep141 ft_transfer of 5000000.
    const forged = structuredClone(TREES.paid);
    const vaultReceipt = forged.receipts_outcome[0] as OutcomeLike;
    (vaultReceipt.outcome.logs as string[]).push(
      nep141("ft_transfer", [{ old_owner_id: VAULT, new_owner_id: PAYEE, amount: "5000000" }]),
    );
    expect([...ftDeltas(forged, USDC).deltas]).toEqual([
      [VAULT, -1_000_000n],
      [PAYEE, 1_000_000n],
    ]);
  });

  it("drops a failed token receipt with no problem (its logs never count)", () => {
    // Derived from the real `paid` tree, labelled: the token's receipt marked failed.
    const failed = structuredClone(TREES.paid);
    const token = failed.receipts_outcome.find(
      (r) => r.outcome.executor_id === USDC,
    ) as OutcomeLike;
    (token.outcome as { status?: unknown }).status = { Failure: { ActionError: { index: 0 } } };
    expect(nep141Events(failed, USDC)).toEqual({ items: [], problems: [] });
    expect(ftDeltas(failed, USDC).deltas.size).toBe(0);
    const any = nep141Events(failed, USDC, { status: "any" });
    expect(any.items.map((i) => [i.item.event, i.event.status])).toEqual([
      ["ft_transfer", "failure"],
    ]);
  });
});

describe("nep245Events and mtDeltas", () => {
  it("mtDeltas on burned: the stub's mt_burn takes 1000000 off the vault", () => {
    const { deltas, problems } = mtDeltas(TREES.burned, STUB);
    expect(problems).toEqual([]);
    expect([...deltas].map(([account, perToken]) => [account, [...perToken]])).toEqual([
      [VAULT, [["nep141:base-usdc.probarion.testnet", -1_000_000n]]],
    ]);
    expect(nep245Events(TREES.burned, STUB).items[0]?.item).toEqual({
      event: "mt_burn",
      ownerId: VAULT,
      authorizedId: null,
      tokenIds: ["nep141:base-usdc.probarion.testnet"],
      amounts: [1_000_000n],
      memo: "withdraw",
    });
  });

  it("on the status-less mainnet payouts: nothing by default, the mt_burn with status any", () => {
    for (const [spend, amount] of [
      [MAINNET.spend2, 1_000_000n],
      [MAINNET.spend3, 250_000n],
    ] as const) {
      const strict = nep245Events(spend, "intents.near");
      expect(strict.items).toEqual([]);
      expect(codes(strict.problems)).toEqual(["unknown_status"]);
      expect(mtDeltas(spend, "intents.near").deltas.size).toBe(0);

      const any = nep245Events(spend, "intents.near", { status: "any" });
      expect(any.problems).toEqual([]);
      expect(any.items.map((i) => [i.item, i.event.status])).toEqual([
        [
          {
            event: "mt_burn",
            ownerId: "v0.probarion.near",
            authorizedId: null,
            tokenIds: [`nep141:${POA_ASSET}`],
            amounts: [amount],
            memo: "withdraw",
          },
          "unknown",
        ],
      ]);
      const burns = nep141Events(spend, POA_ASSET, { status: "any" }).items.map((i) => i.item);
      expect(burns).toEqual([
        {
          event: "ft_burn",
          ownerId: "intents.near",
          amount,
          memo: "WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27",
        },
      ]);
    }
  });

  it("mtDeltas nets transfers per account and token id (synthetic, labelled)", () => {
    const MT = "mt.test.near";
    const source = tree(
      outcome(MT, [
        nep245("mt_mint", [
          { owner_id: "alice.near", token_ids: ["a", "b"], amounts: ["10", "5"] },
        ]),
        nep245("mt_transfer", [
          {
            old_owner_id: "alice.near",
            new_owner_id: "bob.near",
            token_ids: ["a"],
            amounts: ["4"],
            authorized_id: "app.near",
          },
        ]),
      ]),
      outcome(MT, [
        nep245("mt_burn", [{ owner_id: "bob.near", token_ids: ["a"], amounts: ["1"], memo: null }]),
      ]),
    );
    const { deltas, problems } = mtDeltas(source, MT);
    expect(problems).toEqual([]);
    expect([...deltas].map(([account, perToken]) => [account, [...perToken]])).toEqual([
      [
        "alice.near",
        [
          ["a", 6n],
          ["b", 5n],
        ],
      ],
      ["bob.near", [["a", 3n]]],
    ]);
    expect(nep245Events(source, MT).items[1]?.item).toMatchObject({
      authorizedId: "app.near",
      memo: null,
    });
  });
});

describe("schema problems are reported, not counted", () => {
  const TOKEN = "ft.test.near";
  const transfer = (amount: unknown) => [
    { old_owner_id: "a.near", new_owner_id: "b.near", amount },
  ];

  it("refuses amounts that are not canonical U128 strings", () => {
    const amounts: unknown[] = [
      1000000,
      "01",
      "-1",
      "1e6",
      " 1",
      "",
      "340282366920938463463374607431768211456",
      null,
    ];
    for (const amount of amounts) {
      const { items, problems } = nep141Events(
        tree(outcome(TOKEN, [nep141("ft_transfer", transfer(amount))])),
        TOKEN,
      );
      expect(items).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]?.problem).toMatch(
        /^bad_item: ft_transfer item 0: amount .* is not a canonical U128/,
      );
    }
    // 2^128 - 1 is the largest U128.
    const max = nep141Events(
      tree(
        outcome(TOKEN, [
          nep141("ft_transfer", transfer("340282366920938463463374607431768211455")),
        ]),
      ),
      TOKEN,
    );
    expect(max.items[0]?.item).toMatchObject({ amount: (1n << 128n) - 1n });
  });

  it("refuses invalid account ids and memos, and keeps the valid items of the same event", () => {
    const data = [
      { owner_id: "Alice.near", amount: "1" },
      { owner_id: "a", amount: "1" },
      { owner_id: "ok.near", amount: "1", memo: 7 },
      { amount: "1" },
      "not an item",
      { owner_id: "ok.near", amount: "2", memo: "fine", extra: { ignored: true } },
    ];
    const { items, problems } = nep141Events(
      tree(outcome(TOKEN, [nep141("ft_mint", data)])),
      TOKEN,
    );
    expect(items.map((i) => [i.itemIndex, i.item])).toEqual([
      [5, { event: "ft_mint", ownerId: "ok.near", amount: 2n, memo: "fine" }],
    ]);
    expect(problems.map((p) => p.problem)).toEqual([
      'bad_item: ft_mint item 0: owner_id "Alice.near" is not a NEAR account id',
      'bad_item: ft_mint item 1: owner_id "a" is not a NEAR account id',
      "bad_item: ft_mint item 2: memo 7 is not a string or null",
      "bad_item: ft_mint item 3: owner_id undefined is not a NEAR account id",
      "bad_item: ft_mint item 4 is not an object",
    ]);
    expect(problems[0]).toMatchObject({ emitter: TOKEN, logIndex: 0 });
  });

  it("refuses data that is not a list, and an unsupported major version", () => {
    const source = tree(
      outcome(TOKEN, [
        nep141("ft_burn", { owner_id: "a.near", amount: "1" }),
        nep141("ft_burn", [{ owner_id: "a.near", amount: "1" }], "2.0.0"),
        nep141("ft_burn", [{ owner_id: "a.near", amount: "1" }], "1.0"),
        nep141("ft_burn", [{ owner_id: "a.near", amount: "3" }], "1.2.0"),
        event({ standard: "nep141", version: "1.0.0", event: "ft_burn" }),
      ]),
    );
    const { items, problems } = nep141Events(source, TOKEN);
    expect(items.map((i) => i.item)).toEqual([
      { event: "ft_burn", ownerId: "a.near", amount: 3n, memo: null },
    ]);
    expect(problems.map((p) => [p.logIndex, p.problem])).toEqual([
      [0, "bad_data: the data of ft_burn is not a list"],
      [1, 'unsupported_version: nep141 version "2.0.0", this reader reads 1.x.y'],
      [2, 'unsupported_version: nep141 version "1.0", this reader reads 1.x.y'],
      [4, "bad_data: the data of ft_burn is not a list"],
    ]);
  });

  it("skips other events of the standard and reports the token's malformed EVENT_JSON: lines", () => {
    const source = tree(
      outcome(TOKEN, [
        nep141("ft_something_new", [{ any: "shape" }]),
        "EVENT_JSON:{not json",
        "EVENT_JSON:[]",
        "a plain log",
      ]),
      outcome("other.near", ["EVENT_JSON:{not json"]),
    );
    const { items, problems } = nep141Events(source, TOKEN);
    expect(items).toEqual([]);
    expect(problems.map((p) => [p.emitter, p.logIndex, p.problem])).toEqual([
      [TOKEN, 1, "malformed_event: the text after EVENT_JSON: is not JSON"],
      [TOKEN, 2, "malformed_event: the JSON after EVENT_JSON: is not an object"],
    ]);
  });

  it("NEP-245: token_ids and amounts of one length, at least one", () => {
    const MT = "mt.test.near";
    const cases: [unknown, RegExp][] = [
      [
        { owner_id: "a.near", token_ids: ["x", "y"], amounts: ["1"] },
        /token_ids has 2 entries and amounts has 1/,
      ],
      [
        { owner_id: "a.near", token_ids: [], amounts: [] },
        /token_ids is not a list of at least one id/,
      ],
      [
        { owner_id: "a.near", token_ids: ["x"], amounts: [1] },
        /amounts\[0\] 1 is not a canonical U128/,
      ],
      [{ owner_id: "a.near", token_ids: ["x"] }, /amounts is not a list/],
      [{ owner_id: "a.near", token_ids: [7], amounts: ["1"] }, /token id 7 is not a string/],
      [
        { owner_id: "a.near", token_ids: ["x"], amounts: ["1"], authorized_id: "Bad" },
        /authorized_id "Bad"/,
      ],
    ];
    for (const [item, pattern] of cases) {
      const { items, problems } = nep245Events(tree(outcome(MT, [nep245("mt_burn", [item])])), MT);
      expect(items).toEqual([]);
      expect(problems[0]?.problem).toMatch(pattern);
    }
  });

  it("reports a malformed or repeated outcome in the problems, without throwing", () => {
    const source = {
      receipts_outcome: [{ id: "r", outcome: { executor_id: TOKEN } }],
    } as unknown as OutcomeSource;
    expect(codes(nep141Events(source, TOKEN).problems)).toEqual(["malformed_outcome"]);
    const once = outcome(TOKEN, [nep141("ft_mint", [{ owner_id: "a.near", amount: "5" }])]);
    const { deltas, problems } = ftDeltas(tree(once, once), TOKEN);
    expect([...deltas]).toEqual([["a.near", 5n]]); // counted once
    expect(codes(problems)).toEqual(["duplicate_outcome"]);
  });

  it("throws TypeError for an invalid contract or option", () => {
    expect(() => nep141Events(TREES.paid, "")).toThrow(TypeError);
    expect(() => nep245Events(TREES.paid, "Not Valid")).toThrow(TypeError);
    expect(() => nep171Events(TREES.paid, USDC, { status: "all" as "any" })).toThrow(TypeError);
    expect(() => ftDeltas(TREES.paid, 42 as unknown as string)).toThrow(TypeError);
  });
});

describe("ft_transfer_call refund (synthetic, labelled)", () => {
  // The shape near-contract-standards 5.29.1 writes (src/fungible_token/core_impl.rs): ft_transfer_call logs a
  // transfer, the receiver's ft_on_transfer returns the unused amount, and ft_resolve_transfer logs a second
  // ft_transfer back from the receiver with memo "refund". Account names and amounts are made up.
  const TOKEN = "ft.test.near";
  const SENDER = "alice.test.near";
  const RECEIVER = "dex.test.near";

  it("nets the refund: the sender pays 60 of 100, the receiver keeps 60", () => {
    const source = tree(
      outcome(SENDER, []),
      outcome(TOKEN, [
        nep141("ft_transfer", [{ old_owner_id: SENDER, new_owner_id: RECEIVER, amount: "100" }]),
      ]),
      outcome(
        RECEIVER,
        [
          "ft_on_transfer: keeping 60",
          // The receiver may log a nep141 line of its own: not the token's, so it does not count.
          nep141("ft_transfer", [{ old_owner_id: RECEIVER, new_owner_id: SENDER, amount: "100" }]),
        ],
        { SuccessValue: "IjQwIg==" },
      ),
      outcome(TOKEN, [
        nep141("ft_transfer", [
          { old_owner_id: RECEIVER, new_owner_id: SENDER, amount: "40", memo: "refund" },
        ]),
      ]),
    );
    const { deltas, problems } = ftDeltas(source, TOKEN);
    expect(problems).toEqual([]);
    expect([...deltas]).toEqual([
      [SENDER, -60n],
      [RECEIVER, 60n],
    ]);
  });

  it("keeps an account that nets to zero, as 0n", () => {
    const source = tree(
      outcome(TOKEN, [
        nep141("ft_transfer", [{ old_owner_id: SENDER, new_owner_id: RECEIVER, amount: "100" }]),
      ]),
      outcome(TOKEN, [
        nep141("ft_transfer", [
          { old_owner_id: RECEIVER, new_owner_id: SENDER, amount: "100", memo: "refund" },
        ]),
      ]),
    );
    expect([...ftDeltas(source, TOKEN).deltas]).toEqual([
      [SENDER, 0n],
      [RECEIVER, 0n],
    ]);
  });
});

describe("nep171Events on the reference logs of near-contract-standards 5.29.1", () => {
  // The logs are the crate's own expected strings; the receipts around them are synthetic, labelled.
  const NFT = "nft.test.near";
  const source = tree(outcome(NFT, Object.values(REFERENCE.nep171)));

  it("reads every mint, transfer and burn item, authorized_id and memo included", () => {
    const { items, problems } = nep171Events(source, NFT);
    expect(problems).toEqual([]);
    expect(items.map((i) => [i.event.logIndex, i.itemIndex, i.item])).toEqual([
      [0, 0, { event: "nft_mint", ownerId: "bob", tokenIds: ["0", "1"], memo: null }],
      [1, 0, { event: "nft_mint", ownerId: "bob", tokenIds: ["0", "1"], memo: null }],
      [1, 1, { event: "nft_mint", ownerId: "alice", tokenIds: ["2", "3"], memo: "has memo" }],
      [
        2,
        0,
        { event: "nft_burn", ownerId: "bob", authorizedId: null, tokenIds: ["0", "1"], memo: null },
      ],
      [
        3,
        0,
        {
          event: "nft_burn",
          ownerId: "alice",
          authorizedId: "bob",
          tokenIds: ["2", "3"],
          memo: "has memo",
        },
      ],
      [
        3,
        1,
        { event: "nft_burn", ownerId: "bob", authorizedId: null, tokenIds: ["0", "1"], memo: null },
      ],
      [
        4,
        0,
        {
          event: "nft_transfer",
          oldOwnerId: "bob",
          newOwnerId: "alice",
          authorizedId: null,
          tokenIds: ["0", "1"],
          memo: null,
        },
      ],
      [
        5,
        0,
        {
          event: "nft_transfer",
          oldOwnerId: "alice",
          newOwnerId: "bob",
          authorizedId: "bob",
          tokenIds: ["2", "3"],
          memo: "has memo",
        },
      ],
      [
        5,
        1,
        {
          event: "nft_transfer",
          oldOwnerId: "bob",
          newOwnerId: "alice",
          authorizedId: null,
          tokenIds: ["0", "1"],
          memo: null,
        },
      ],
    ]);
  });

  it("skips the metadata update events of 1.1.0 and 1.2.0, and refuses an empty token_ids", () => {
    const more = tree(
      outcome(NFT, [
        event({
          standard: "nep171",
          version: "1.1.0",
          event: "contract_metadata_update",
          data: [],
        }),
        event({
          standard: "nep171",
          version: "1.2.0",
          event: "nft_metadata_update",
          data: [{ token_ids: ["0"] }],
        }),
        event({
          standard: "nep171",
          version: "1.0.0",
          event: "nft_mint",
          data: [{ owner_id: "bob", token_ids: [] }],
        }),
      ]),
    );
    const { items, problems } = nep171Events(more, NFT);
    expect(items).toEqual([]);
    expect(problems.map((p) => p.problem)).toEqual([
      "bad_item: nft_mint item 0: token_ids is not a list of at least one id",
    ]);
  });

  it("does not read the same logs from another contract", () => {
    expect(nep171Events(source, "other.test.near")).toEqual({ items: [], problems: [] });
  });
});

describe("ftDeltas on the reference logs of near-contract-standards 5.29.1", () => {
  it("adds mints, subtracts burns and moves transfers", () => {
    const TOKEN = "ft.test.near";
    const { deltas, problems } = ftDeltas(
      tree(outcome(TOKEN, Object.values(REFERENCE.nep141))),
      TOKEN,
    );
    expect(problems).toEqual([]);
    // mints: bob +100, bob +100, alice +200; burns: bob -100, alice -200, bob -100;
    // transfers: bob -> alice 100, alice -> bob 200, bob -> alice 100.
    expect(Object.fromEntries(deltas)).toEqual({ bob: 0n, alice: 0n });
  });
});
