import { describe, expect, it } from "vitest";
import * as accessKeys from "../src/access-keys.js";
import * as accountRpc from "../src/account-rpc.js";
import * as codeIdentity from "../src/code-identity.js";
import * as errors from "../src/errors.js";
import * as events from "../src/events.js";
import type {
  AccessKeyAudit,
  AccessKeyKind,
  AccessKeyView,
  AccountLockReport,
  BoundEvent,
  BuildMatch,
  CodeIdentity,
  Erc20Match,
  Erc20Transfer,
  EventLogParse,
  EventProblem,
  EventQuery,
  ExpectedStatus,
  FindingSeverity,
  FindPoaBurnOptions,
  FtEvent,
  KeyFinding,
  KeyFindingCode,
  KeyPolicy,
  KeyRule,
  MerkleDirection,
  MerklePathItem,
  MtEvent,
  NearRpc,
  Nep297Event,
  NftEvent,
  OutcomeExpectation,
  OutcomeLike,
  OutcomeProofCode,
  OutcomeProofResult,
  OutcomeSource,
  OutcomeTreeCode,
  OutcomeTreeResult,
  PoaBridgeWithdrawal,
  PoaBurn,
  PoaChain,
  PoaCheckId,
  PoaSettlement,
  PoaWithdrawArgs,
  PoaWithdrawCall,
  PoaWithdrawRequest,
  ProofTarget,
  ProvenOutcome,
  ProvenStatus,
  ReceiptStatusKind,
  RecordedBuild,
  TrustedHead,
  TxTreeLike,
  TypedEvents,
  TypedItem,
} from "../src/index.js";
import * as near from "../src/index.js";
import * as outcomeProof from "../src/outcome-proof.js";
import * as poa from "../src/poa.js";
import * as poaRpc from "../src/poa-rpc.js";
import * as proofRpc from "../src/proof-rpc.js";
import * as rpc from "../src/rpc.js";
import * as types from "../src/types.js";

// The public API, module by module (spec 2.8). The barrel re-exports every module with `export *`, so a name
// added to a module is public at once: this list is where that becomes a decision. encoding.ts is internal.
const VALUES = {
  errors: { module: errors, names: ["NearFormatError"] },
  types: { module: types, names: [] },
  rpc: { module: rpc, names: ["NearRpcError", "httpJsonRpc"] },
  "outcome-proof": {
    module: outcomeProof,
    names: [
      "MAX_PROOF_PATH",
      "lightBlockHash",
      "merkleRootFromPath",
      "outcomeLeafHash",
      "verifyOutcomeProof",
      "verifyTransactionOutcomes",
    ],
  },
  "proof-rpc": {
    module: proofRpc,
    names: ["HeadMismatchError", "fetchOutcomeProof", "proveTransaction", "readCrossCheckedHead"],
  },
  events: {
    module: events,
    names: [
      "EVENT_JSON_PREFIX",
      "eventsOf",
      "ftDeltas",
      "mtDeltas",
      "nep141Events",
      "nep171Events",
      "nep245Events",
      "parseEventLog",
      "receiptStatusKind",
      "scanAllEvents",
    ],
  },
  "access-keys": {
    module: accessKeys,
    names: ["auditAccessKeys", "parseAccessKey", "parseAccessKeyList"],
  },
  "code-identity": {
    module: codeIdentity,
    names: [
      "accountLockReport",
      "codeIdentityOf",
      "matchRecordedBuild",
      "normalizeCodeHash",
      "wasmCodeHash",
    ],
  },
  "account-rpc": { module: accountRpc, names: ["readAccountLock"] },
  poa: {
    module: poa,
    names: [
      "ERC20_TRANSFER_TOPIC",
      "FT_WITHDRAW_GAS",
      "WITHDRAW_TO_PREFIX",
      "findErc20Transfer",
      "findPoaBurns",
      "parsePoaWithdrawalStatus",
      "poaWithdrawCall",
      "verifyPoaSettlement",
    ],
  },
  "poa-rpc": { module: poaRpc, names: ["POA_BRIDGE_RPC_URL", "readPoaWithdrawalStatus"] },
} as const;

const CONSTANTS = new Set([
  "MAX_PROOF_PATH",
  "EVENT_JSON_PREFIX",
  "WITHDRAW_TO_PREFIX",
  "FT_WITHDRAW_GAS",
  "ERC20_TRANSFER_TOPIC",
  "POA_BRIDGE_RPC_URL",
]);

const sorted = (names: Iterable<string>): string[] => [...names].sort();

describe("@probarion/near root exports (spec 2.8)", () => {
  it.each(Object.entries(VALUES))(
    "%s exports exactly its listed values",
    (_name, { module, names }) => {
      expect(sorted(Object.keys(module))).toEqual(sorted(names));
    },
  );

  it("re-exports every module's values from the barrel, and nothing else", () => {
    const all = Object.values(VALUES).flatMap((entry) => [...entry.names]);
    expect(new Set(all).size).toBe(all.length); // `export *` drops a name two modules both export
    expect(sorted(Object.keys(near))).toEqual(sorted(all));
    expect(all.length).toBe(42);
    const exported: Record<string, unknown> = { ...near };
    for (const name of all) {
      if (CONSTANTS.has(name)) continue;
      expect(typeof exported[name], name).toBe("function");
    }
  });

  it("keeps the internal encoding helpers out of the API", () => {
    for (const name of ["sha256", "decodeBase58Hash", "parseU128", "BorshWriter", "isAccountId"]) {
      expect(Object.keys(near), name).not.toContain(name);
    }
  });

  it("exports the constants with their recorded values", () => {
    expect(near.MAX_PROOF_PATH).toBe(64);
    expect(near.EVENT_JSON_PREFIX).toBe("EVENT_JSON:");
    expect(near.WITHDRAW_TO_PREFIX).toBe("WITHDRAW_TO:");
    expect(near.FT_WITHDRAW_GAS).toBe(100_000_000_000_000n);
    expect(near.ERC20_TRANSFER_TOPIC).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
    expect(near.POA_BRIDGE_RPC_URL).toBe("https://bridge.chaindefuser.com/rpc");
  });

  it("exports the error classes as Error subclasses with their names", () => {
    expect(new near.NearFormatError("response", "m")).toBeInstanceOf(Error);
    expect(new near.NearFormatError("response", "m").name).toBe("NearFormatError");
    expect(new near.NearRpcError("block", null, "m").name).toBe("NearRpcError");
    expect(near.HeadMismatchError.prototype).toBeInstanceOf(Error);
  });

  it("exports every public type (tsc fails this file if one is missing)", () => {
    type Exported = [
      // types
      OutcomeLike,
      TxTreeLike,
      ReceiptStatusKind,
      MerkleDirection,
      MerklePathItem,
      TrustedHead,
      ProvenStatus,
      ProvenOutcome,
      OutcomeSource,
      // rpc
      NearRpc,
      // outcome-proof, proof-rpc
      OutcomeProofCode,
      ExpectedStatus,
      OutcomeExpectation,
      OutcomeProofResult,
      OutcomeTreeCode,
      OutcomeTreeResult,
      ProofTarget,
      // events
      Nep297Event,
      EventLogParse,
      EventQuery,
      BoundEvent,
      EventProblem,
      TypedItem<FtEvent>,
      TypedEvents<MtEvent>,
      FtEvent,
      MtEvent,
      NftEvent,
      // access-keys, code-identity
      AccessKeyKind,
      AccessKeyView,
      FindingSeverity,
      KeyFindingCode,
      KeyFinding,
      KeyRule,
      KeyPolicy,
      AccessKeyAudit,
      CodeIdentity,
      RecordedBuild,
      BuildMatch,
      AccountLockReport,
      // poa
      PoaChain,
      PoaWithdrawRequest,
      PoaWithdrawArgs,
      PoaWithdrawCall,
      PoaBurn,
      FindPoaBurnOptions,
      PoaBridgeWithdrawal,
      Erc20Transfer,
      Erc20Match,
      PoaCheckId,
      PoaSettlement,
    ];
    const count: Exported["length"] = 50;
    expect(count).toBe(50);
  });
});
