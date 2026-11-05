import { KeyPair } from "near-api-js";
import { describe, expect, it, vi } from "vitest";
import { signNep413 } from "../../../test/fixtures/nep413";
import {
  type AccessKeyProvider,
  fullAccessKeyVerifier,
  rpcLoginProvider,
  VerifierUnavailableError,
} from "./verify";

// The key check of an owner's confirmation (ruling W-T14-R1 item 4, W-T14-R2 m7): the exact FullAccess permission at
// a final block, whose height and hash are returned for the record. A block that cannot be read means the check cannot
// be recorded, so it counts as unavailable.

const MESSAGE = "Probarion confirm v1 | pay …";
const RECIPIENT = "probarion.xyz/payables/confirm";
const NONCE = new Uint8Array(32).fill(1);
const HASH = "4reLvkAWfqk5fsqio1KLudk46cqRz9erQdaHkWZKMJDZ";
const keyPair = KeyPair.fromRandom("ed25519");
const signed = signNep413({ message: MESSAGE, nonce: NONCE, recipient: RECIPIENT, keyPair });

const answers = (answer: unknown): AccessKeyProvider => ({
  viewAccessKey: vi.fn(async () => answer as { permission: unknown }),
});
const check = (provider: AccessKeyProvider, over: { message?: string } = {}) =>
  fullAccessKeyVerifier(provider)({
    accountId: "owner.testnet",
    publicKey: signed.publicKey,
    signature: Buffer.from(signed.signature, "base64"),
    message: over.message ?? MESSAGE,
    recipient: RECIPIENT,
    nonce: NONCE,
  });

describe("fullAccessKeyVerifier", () => {
  it("accepts the exact FullAccess permission and returns the block of the read", async () => {
    await expect(
      check(answers({ permission: "FullAccess", block_height: 190000000, block_hash: HASH })),
    ).resolves.toEqual({ blockHeight: 190000000, blockHash: HASH });
  });

  it.each([
    ["no height", { block_hash: HASH }],
    ["a height as text", { block_height: "1", block_hash: HASH }],
    ["a negative height", { block_height: -1, block_hash: HASH }],
    ["a fractional height", { block_height: 1.5, block_hash: HASH }],
    ["no hash", { block_height: 1 }],
    ["a malformed hash", { block_height: 1, block_hash: "not a hash" }],
  ])("counts %s as unavailable: the check could not be recorded", async (_why, block) => {
    await expect(check(answers({ permission: "FullAccess", ...block }))).rejects.toBeInstanceOf(
      VerifierUnavailableError,
    );
  });

  it.each([
    ["GasKeyFullAccess as text", "GasKeyFullAccess"],
    ["a gas key as an object", { GasKeyFullAccess: { balance: "1" } }],
    ["FullAccess inside an object", { FullAccess: {} }],
    [
      "a function-call key",
      { FunctionCall: { allowance: null, receiver_id: "x.near", method_names: [] } },
    ],
  ])("refuses %s, and not as unavailable", async (_why, permission) => {
    const refused = check(answers({ permission, block_height: 1, block_hash: HASH }));
    await expect(refused).rejects.toThrow();
    await expect(refused).rejects.not.toBeInstanceOf(VerifierUnavailableError);
  });

  it("refuses a bad signature before any RPC call", async () => {
    const provider = answers({ permission: "FullAccess", block_height: 1, block_hash: HASH });
    await expect(check(provider, { message: "another message" })).rejects.toThrow(/signature/);
    expect(provider.viewAccessKey).not.toHaveBeenCalled();
  });

  it("reads the key at finality final through the login provider, and passes its block on", async () => {
    const call = vi.fn(async () => ({
      permission: "FullAccess",
      block_height: 7,
      block_hash: HASH,
    }));
    await expect(check(rpcLoginProvider({ call } as never))).resolves.toEqual({
      blockHeight: 7,
      blockHash: HASH,
    });
    expect(call).toHaveBeenCalledWith("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: "owner.testnet",
      public_key: signed.publicKey,
    });
  });

  it("passes on a node that cannot answer, and refuses a key the chain says is not there", async () => {
    await expect(
      check({
        viewAccessKey: async () => {
          throw new VerifierUnavailableError();
        },
      }),
    ).rejects.toBeInstanceOf(VerifierUnavailableError);
    const missing = check({
      viewAccessKey: async () => {
        throw new Error("access key not found");
      },
    });
    await expect(missing).rejects.toThrow();
    await expect(missing).rejects.not.toBeInstanceOf(VerifierUnavailableError);
  });
});
