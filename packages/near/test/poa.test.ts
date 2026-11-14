import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NearFormatError } from "../src/errors.js";
import {
  ERC20_TRANSFER_TOPIC,
  FT_WITHDRAW_GAS,
  findErc20Transfer,
  type PoaWithdrawRequest,
  parsePoaWithdrawalStatus,
  poaWithdrawCall,
  WITHDRAW_TO_PREFIX,
} from "../src/poa.js";
import { readFixture } from "./helpers/fixtures.js";

// The two mainnet payouts of v0.probarion.near to Base (2026-11-13), as recorded in test/fixtures/poa.
const ASSET = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const USDC_ON_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** The owner's Base address as the mandate holds it, EIP-55 checksummed. */
const PAYEE = "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27";
/** The POA bridge's sender on Base in both releases. */
const BRIDGE_SENDER = "0x2cff890f0378a11913b6129b2e97417a2c302680";
const SPEND_2 = {
  near: "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9",
  base: "0xc2df8f8799467834cdaed0e8f23638af49334483387560fd34ef360939e1ea71",
};
const SPEND_3 = {
  near: "5amtgb8MujUkiydS5Ht9Ut6AX6pN9SGegHUCHGsX9NGH",
  base: "0xc6c4507e098b558bdff1b5836600f5e3365fee5a63037d399db58e1db4547ab7",
};
/** contracts/vault/src/test_utils.rs SOL_ADDR (base58 of 32 bytes). */
const SOL_ADDR = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

interface VaultArgs {
  spends: {
    spendId: number;
    receiptId: string;
    predecessorId: string;
    receiverId: string;
    methodName: string;
    args: string;
  }[];
}
interface BaseReceipts {
  receipts: Record<"spend-2" | "spend-3", Record<string, unknown>>;
}
interface StatusFixture {
  answer: Record<string, unknown>;
}

const baseReceipt = (spend: "spend-2" | "spend-3") =>
  structuredClone(readFixture<BaseReceipts>("poa/base-receipts.json").receipts[spend]);
const statusAnswer = (file: "poa-status-s1.json" | "poa-status-s2.json") =>
  structuredClone(readFixture<StatusFixture>(`poa/${file}`).answer);
const repoJson = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"));

/** Log 0 of a receipt, for tampering. */
function firstLog(receipt: Record<string, unknown>): Record<string, unknown> {
  return (receipt.logs as Record<string, unknown>[])[0] as Record<string, unknown>;
}

describe("the copied fixtures", () => {
  it("equal the repository records they were copied from", () => {
    expect(readFixture<StatusFixture>("poa/poa-status-s1.json").answer).toEqual(
      repoJson("docs/evidence/mainnet-v0/s1-2026-11-13/poa-status.json"),
    );
    expect(readFixture<StatusFixture>("poa/poa-status-s2.json").answer).toEqual(
      repoJson("docs/evidence/mainnet-v0/s2-2026-11-13/poa-status.json"),
    );
    const recorded = repoJson("apps/web/src/lib/site/mainnet-payout-recorded.json") as {
      payouts: {
        payout: { spendId: number };
        reads: {
          base: unknown;
          spend: {
            receipts: { receipt: { Action: { actions: { FunctionCall: { args: string } }[] } } }[];
          };
        };
      }[];
    };
    const [two, three] = recorded.payouts;
    expect(two?.payout.spendId).toBe(2);
    expect(three?.payout.spendId).toBe(3);
    expect(readFixture<BaseReceipts>("poa/base-receipts.json").receipts).toEqual({
      "spend-2": two?.reads.base,
      "spend-3": three?.reads.base,
    });
    expect(
      readFixture<VaultArgs>("poa/vault-ft-withdraw-args.json").spends.map((s) => s.args),
    ).toEqual(
      recorded.payouts.map(
        (p) => p.reads.spend.receipts[0]?.receipt.Action.actions[0]?.FunctionCall.args,
      ),
    );
  });
});

describe("poaWithdrawCall", () => {
  const request = (overrides: Partial<PoaWithdrawRequest> = {}): PoaWithdrawRequest => ({
    asset: ASSET,
    chain: "base",
    address: PAYEE,
    amount: 1_000_000n,
    ...overrides,
  });

  it("builds the bytes the vault sent to intents.near in mainnet spends 2 and 3", () => {
    const { spends } = readFixture<VaultArgs>("poa/vault-ft-withdraw-args.json");
    expect(spends.map((s) => s.spendId)).toEqual([2, 3]);
    for (const [spend, amount] of [
      [spends[0], 1_000_000n],
      [spends[1], 250_000n],
    ] as const) {
      const call = poaWithdrawCall(request({ amount }));
      expect(call.receiverId).toBe(spend?.receiverId);
      expect(call.methodName).toBe(spend?.methodName);
      // Byte for byte: the receipt's base64 args decode to exactly argsJson.
      expect(
        new TextDecoder().decode(Uint8Array.from(atob(spend?.args ?? ""), (c) => c.charCodeAt(0))),
      ).toBe(call.argsJson);
    }
  });

  it("names the asset as token and receiver, keeps the checksummed address in the memo and sets no msg", () => {
    const call = poaWithdrawCall(request());
    expect(call).toEqual({
      receiverId: "intents.near",
      methodName: "ft_withdraw",
      args: {
        token: ASSET,
        receiver_id: ASSET,
        amount: "1000000",
        memo: `WITHDRAW_TO:${PAYEE}`,
        msg: null,
      },
      argsJson: `{"token":"${ASSET}","receiver_id":"${ASSET}","amount":"1000000","memo":"WITHDRAW_TO:${PAYEE}","msg":null}`,
      gas: 100_000_000_000_000n,
      deposit: 1n,
    });
    expect(FT_WITHDRAW_GAS).toBe(100n * 10n ** 12n);
    expect(WITHDRAW_TO_PREFIX).toBe("WITHDRAW_TO:");
    // contracts/vault/src/test_utils.rs EVM_MIXED reaches the memo byte for byte, as in the vault's own test.
    const mixed = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
    expect(poaWithdrawCall(request({ address: mixed })).args.memo).toBe(`WITHDRAW_TO:${mixed}`);
  });

  it("builds a Solana withdrawal and takes another intents contract", () => {
    const call = poaWithdrawCall({
      asset: "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
      chain: "solana",
      address: SOL_ADDR,
      amount: 5n,
      intents: "intents-stub.probarion.testnet",
    });
    expect(call.receiverId).toBe("intents-stub.probarion.testnet");
    expect(call.args.memo).toBe(`WITHDRAW_TO:${SOL_ADDR}`);
    expect(call.args.amount).toBe("5");
    expect(poaWithdrawCall(request({ amount: (1n << 128n) - 1n })).args.amount).toBe(
      "340282366920938463463374607431768211455",
    );
  });

  it("refuses what the vault refuses, and Solana addresses that are not 32 bytes", () => {
    const refused: [string, Partial<PoaWithdrawRequest>][] = [
      ["39 hex digits", { address: `0x${"1".repeat(39)}` }],
      ["41 hex digits", { address: `0x${"1".repeat(41)}` }],
      ["0X prefix", { address: `0X${"1".repeat(40)}` }],
      ["a non-hex digit", { address: `0x${"1".repeat(39)}g` }],
      ["a trailing space", { address: `${PAYEE} ` }],
      ["a Solana address on Base", { address: SOL_ADDR }],
      ["a base asset with the solana chain", { chain: "solana", address: SOL_ADDR }],
      ["a sol asset with the base chain", { asset: "sol-abc.omft.near" }],
      ["an asset that is not an account id", { asset: "base-USDC.omft.near" }],
      ["amount 0", { amount: 0n }],
      ["a negative amount", { amount: -1n }],
      ["an amount above u128", { amount: 1n << 128n }],
      ["a number amount", { amount: 1_000_000 as unknown as bigint }],
      ["intents not an account id", { intents: "Intents.near" }],
      ["an unknown chain", { chain: "ethereum" as "base" }],
    ];
    for (const [label, overrides] of refused) {
      expect(() => poaWithdrawCall(request(overrides)), label).toThrow(TypeError);
    }
    const sol = (address: string) => () =>
      poaWithdrawCall({ asset: "sol-abc.omft.near", chain: "solana", address, amount: 1n });
    expect(sol(SOL_ADDR)).not.toThrow();
    // validate.rs accepts 32 to 44 base58 characters; these are 33 and 23 bytes, so the builder refuses them.
    expect(sol("z".repeat(44))).toThrow(/32 bytes/);
    expect(sol("2".repeat(32))).toThrow(/32 bytes/);
    for (const bad of ["0", "O", "I", "l"]) {
      expect(sol(`${bad}${SOL_ADDR.slice(1)}`), bad).toThrow(TypeError);
    }
    expect(() => poaWithdrawCall(null as unknown as PoaWithdrawRequest)).toThrow(TypeError);
  });
});

describe("parsePoaWithdrawalStatus", () => {
  it("reads the bridge's records of spends 2 and 3", () => {
    expect(parsePoaWithdrawalStatus(statusAnswer("poa-status-s1.json"))).toEqual([
      {
        status: "COMPLETED",
        burnTxHash: SPEND_2.near,
        transferTxHash: SPEND_2.base,
        chain: "eth:8453",
        nearTokenId: ASSET,
        contractAddress: USDC_ON_BASE,
        accountId: "v0.probarion.near",
        amount: 1_000_000n,
        fee: 2_400n,
        received: 997_600n,
        createdAt: "2026-11-13T07:24:37.896Z",
      },
    ]);
    const [three] = parsePoaWithdrawalStatus(statusAnswer("poa-status-s2.json"));
    expect(three).toMatchObject({
      burnTxHash: SPEND_3.near,
      transferTxHash: SPEND_3.base,
      amount: 250_000n,
      fee: 2_400n,
      received: 247_600n,
    });
  });

  it("reads a lone { status, data } answer, an empty list, and absent optional fields as null", () => {
    const { status, data } = statusAnswer("poa-status-s1.json");
    expect(parsePoaWithdrawalStatus({ status, data })).toEqual(
      parsePoaWithdrawalStatus(statusAnswer("poa-status-s1.json")),
    );
    expect(parsePoaWithdrawalStatus({ withdrawals: [] })).toEqual([]);
    const {
      transfer_tx_hash: _hash,
      address: _address,
      created_at: _created,
      ...rest
    } = data as Record<string, unknown>;
    const [pending] = parsePoaWithdrawalStatus({ status: "PENDING", data: rest });
    expect(pending).toMatchObject({
      status: "PENDING",
      transferTxHash: null,
      contractAddress: null,
      createdAt: null,
    });
    // A canonical decimal string amount is read too.
    const [text] = parsePoaWithdrawalStatus({
      status,
      data: { ...(data as object), amount: "1000000" },
    });
    expect(text?.amount).toBe(1_000_000n);
  });

  it("refuses an unsafe JSON number amount and names every refused field", () => {
    const refusal = (edit: (data: Record<string, unknown>) => void): NearFormatError => {
      const answer = statusAnswer("poa-status-s1.json");
      const list = answer.withdrawals as { data: Record<string, unknown> }[];
      edit(list[0]?.data as Record<string, unknown>);
      try {
        parsePoaWithdrawalStatus(answer);
      } catch (error) {
        expect(error).toBeInstanceOf(NearFormatError);
        return error as NearFormatError;
      }
      throw new Error("expected a refusal");
    };
    expect(
      refusal((d) => {
        d.amount = 2 ** 53;
      }).what,
    ).toBe("withdrawals[0].data.amount");
    expect(
      refusal((d) => {
        d.amount = 1.5;
      }).what,
    ).toBe("withdrawals[0].data.amount");
    expect(
      refusal((d) => {
        d.amount = -1;
      }).what,
    ).toBe("withdrawals[0].data.amount");
    expect(
      refusal((d) => {
        d.withdrawal_fee = 2400;
        d.withdraw_amount = "0997600";
      }).what,
    ).toBe("withdrawals[0].data.withdraw_amount");
    expect(
      refusal((d) => {
        delete d.withdrawal_fee;
      }).what,
    ).toBe("withdrawals[0].data.withdrawal_fee");
    expect(
      refusal((d) => {
        d.tx_hash = "0xc2df";
      }).what,
    ).toBe("withdrawals[0].data.tx_hash");
    expect(
      refusal((d) => {
        d.near_token_id = "nep141:base";
      }).what,
    ).toBe("withdrawals[0].data.near_token_id");
    expect(
      refusal((d) => {
        d.account_id = "";
      }).what,
    ).toBe("withdrawals[0].data.account_id");
    expect(
      refusal((d) => {
        d.transfer_tx_hash = 7;
      }).what,
    ).toBe("withdrawals[0].data.transfer_tx_hash");
    for (const answer of [null, [], "COMPLETED", { withdrawals: {} }, { status: "COMPLETED" }]) {
      expect(() => parsePoaWithdrawalStatus(answer), JSON.stringify(answer)).toThrow(
        NearFormatError,
      );
    }
    expect(() => parsePoaWithdrawalStatus({ withdrawals: [{ status: "", data: {} }] })).toThrow(
      NearFormatError,
    );
    try {
      parsePoaWithdrawalStatus({ withdrawals: [7] });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toMatchObject({ name: "NearFormatError", what: "withdrawals[0]" });
    }
  });
});

describe("findErc20Transfer", () => {
  const want = (overrides: Partial<Parameters<typeof findErc20Transfer>[1]> = {}) => ({
    txHash: SPEND_2.base,
    contract: USDC_ON_BASE,
    to: PAYEE,
    value: 997_600n,
    ...overrides,
  });

  it("finds the USDC Transfer to the payee in both recorded Base releases", () => {
    expect(findErc20Transfer(baseReceipt("spend-2"), want())).toEqual({
      ok: true,
      transfer: {
        txHash: SPEND_2.base,
        blockNumber: 0x363070an,
        contract: USDC_ON_BASE,
        from: BRIDGE_SENDER,
        to: PAYEE.toLowerCase(),
        value: 997_600n,
        logIndex: null,
      },
    });
    const three = findErc20Transfer(
      baseReceipt("spend-3"),
      want({ txHash: SPEND_3.base, value: 247_600n }),
    );
    expect(three.ok && three.transfer.value).toBe(247_600n);
    // Without a value it reports what moved; hex in either case matches.
    const any = findErc20Transfer(
      baseReceipt("spend-2"),
      want({ value: undefined, txHash: SPEND_2.base.toUpperCase().replace("0X", "0x") }),
    );
    expect(any.ok && any.transfer.value).toBe(997_600n);
    expect(ERC20_TRANSFER_TOPIC).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
  });

  it("reads logIndex when the receipt carries it", () => {
    const receipt = baseReceipt("spend-2");
    firstLog(receipt).logIndex = "0x1f";
    firstLog(receipt).removed = false;
    firstLog(receipt).transactionHash = SPEND_2.base;
    const match = findErc20Transfer(receipt, want());
    expect(match.ok && match.transfer.logIndex).toBe(31);
  });

  it("fails each tamper with its code", () => {
    const code = (edit: (r: Record<string, unknown>) => void, overrides = {}) => {
      const receipt = baseReceipt("spend-2");
      edit(receipt);
      const match = findErc20Transfer(receipt, want(overrides));
      return match.ok ? "ok" : match.code;
    };
    const topics = (r: Record<string, unknown>) => firstLog(r).topics as string[];
    expect(code(() => {})).toBe("ok");
    // The recipient topic changed: the Transfer went somewhere else.
    expect(
      code((r) => {
        topics(r)[2] = `0x${"0".repeat(24)}${"1".repeat(40)}`;
      }),
    ).toBe("no_matching_transfer");
    // A different token contract.
    expect(code(() => {}, { contract: `0x${"2".repeat(40)}` })).toBe("no_matching_transfer");
    expect(
      code((r) => {
        firstLog(r).address = `0x${"2".repeat(40)}`;
      }),
    ).toBe("no_matching_transfer");
    expect(
      code((r) => {
        r.status = "0x0";
      }),
    ).toBe("reverted");
    expect(code(() => {}, { txHash: SPEND_3.base })).toBe("wrong_tx");
    expect(code(() => {}, { value: 1_000_000n })).toBe("no_matching_transfer");
    expect(
      code((r) => {
        firstLog(r).removed = true;
      }),
    ).toBe("no_matching_transfer");
    expect(
      code((r) => {
        (r.logs as unknown[]).push(structuredClone(firstLog(r)));
      }),
    ).toBe("ambiguous");
    // Dirty high bytes in the recipient topic: the low 20 bytes are the payee, but it is not an address.
    expect(
      code((r) => {
        topics(r)[2] = `0x${"0".repeat(23)}1${PAYEE.slice(2).toLowerCase()}`;
      }),
    ).toBe("malformed");
    expect(
      code((r) => {
        topics(r).push(`0x${"0".repeat(64)}`);
      }),
    ).toBe("malformed");
    expect(
      code((r) => {
        firstLog(r).data = "0x0f38e0";
      }),
    ).toBe("malformed");
    expect(
      code((r) => {
        firstLog(r).removed = "no";
      }),
    ).toBe("malformed");
    expect(
      code((r) => {
        firstLog(r).transactionHash = SPEND_3.base;
      }),
    ).toBe("malformed");
    expect(
      code((r) => {
        firstLog(r).logIndex = "0x01";
      }),
    ).toBe("malformed");
    expect(
      code((r) => {
        r.status = undefined;
      }),
    ).toBe("malformed");
    expect(
      code((r) => {
        r.blockNumber = 56_825_610;
      }),
    ).toBe("malformed");
    expect(
      code((r) => {
        r.logs = {};
      }),
    ).toBe("malformed");
    expect(code(() => {}, { to: "0xB22E" })).toBe("malformed");
    expect(code(() => {}, { value: -1n })).toBe("malformed");
    expect(findErc20Transfer(null, want())).toMatchObject({ ok: false, code: "malformed" });
  });

  it("skips other contracts' logs and other events of the contract", () => {
    const receipt = baseReceipt("spend-2");
    const log = firstLog(receipt);
    (receipt.logs as unknown[]).unshift(
      { ...structuredClone(log), address: `0x${"3".repeat(40)}` },
      { ...structuredClone(log), topics: [`0x${"a".repeat(64)}`] },
    );
    const match = findErc20Transfer(receipt, want());
    expect(match.ok).toBe(true);
    // A second Transfer of the contract to another address is not ambiguous.
    const two = baseReceipt("spend-2");
    const other = structuredClone(firstLog(two));
    (other.topics as string[])[2] = `0x${"0".repeat(24)}${"4".repeat(40)}`;
    (two.logs as unknown[]).push(other);
    expect(findErc20Transfer(two, want()).ok).toBe(true);
  });
});
