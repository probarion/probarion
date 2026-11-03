// TEST DOUBLE scenario: a factory vault with one NEAR mandate (#1) and one Base mandate (#2). Ids start at 1 (v2).
// The keys are derived from fixed public strings and must never hold funds.
import {
  generateKeyPair,
  type MandateView,
  NETWORKS,
  sha256Bytes,
  sha256Hex,
  utf8,
} from "@probarion/core";
import { baseEncode } from "near-api-js";
import { type BurnShape, type CodeMode, FakeChain } from "./fake-chain.js";

export const TEST_KEYS = {
  agent: generateKeyPair(sha256Bytes(utf8("probarion/test-double/agent-key"))),
  ledger: generateKeyPair(sha256Bytes(utf8("probarion/test-double/ledger-key"))),
  other: generateKeyPair(sha256Bytes(utf8("probarion/test-double/other-key"))),
  /**
   * TEST DOUBLE: FullAccess; the secret is public; never add this key to a real account.
   * It is the key of the scenario's approver account (`approver.testnet`), never a key of the vault.
   */
  approver: generateKeyPair(sha256Bytes(utf8("probarion/test-double/approver-key"))),
};

export const SCENARIO_VAULT = "acme.vaults.probarion.testnet";
export const SCENARIO_APPROVER = "approver.testnet";
export const SCENARIO_CODE_HASH = baseEncode(sha256Bytes(utf8("probarion/test-double/vault-wasm")));
export const SCENARIO_PURPOSE_NEAR = sha256Hex("TEST DOUBLE PO-1001");
export const SCENARIO_PURPOSE_BASE = sha256Hex("TEST DOUBLE PO-2002");
export const SCENARIO_NEAR_PAYEE = "vendor.testnet";
export const SCENARIO_BASE_ADDRESS = "0x2222222222222222222222222222222222222222";
/** 2026-11-05T12:00:00Z. Pass `new Date(Number(SCENARIO_NOW / 1_000_000n))` as the SDK clock. */
export const SCENARIO_NOW = 1_793_880_000_000_000_000n;

export interface ScenarioOptions {
  nowNs?: () => bigint;
  /** `false` makes a plain (non-factory) deploy: no factory account, `config.factory` null, a local code hash. */
  factory?: boolean;
  intentsBalance?: string;
  /** The shape of the Intents burn logs. Default `stub`, the shape the live testnet intents-stub produces. */
  burnShape?: BurnShape;
  /**
   * `global` (NEP-591): `view_account` reports the all-ones `code_hash` plus `global_contract_hash`.
   * `local`: the account runs its own code and the field is omitted. Default `global` for a factory vault
   * (the scenario's factory version is global) and `local` for a plain deploy.
   */
  codeMode?: CodeMode;
}

function mandate(
  overrides: Partial<MandateView> & Pick<MandateView, "id" | "payee" | "purpose_hash" | "label">,
): MandateView {
  return {
    max_per_payment: "100000000",
    max_total: "1000000000",
    spent: "0",
    reserved: "0",
    max_uses: 10,
    uses: 0,
    expires_at_ns: "1798761600000000000",
    approval_above: "50000000",
    agent_pk: TEST_KEYS.agent.publicKey,
    status: "active",
    created_at_ns: "1793750400000000000",
    ...overrides,
  };
}

export function createScenarioChain(opts: ScenarioOptions = {}): FakeChain {
  const testnet = NETWORKS.testnet;
  const factoryId = testnet.factory;
  const withFactory = opts.factory !== false;
  const codeMode: CodeMode = opts.codeMode ?? (withFactory ? "global" : "local");
  const chain = new FakeChain({
    vaultId: SCENARIO_VAULT,
    codeHash: SCENARIO_CODE_HASH,
    codeMode,
    burnShape: opts.burnShape ?? "stub",
    nowNs: opts.nowNs ?? (() => SCENARIO_NOW),
    config: {
      owner: "owner.testnet",
      approvers: [SCENARIO_APPROVER],
      usdc: testnet.usdc,
      intents: testnet.intents,
      allowed_assets: [testnet.allowedAssets.base, testnet.allowedAssets.solana],
      daily_backstop: "500000000",
      held_ttl_ns: "259200000000000",
      frozen: false,
      factory: withFactory ? factoryId : null,
      version: "0.1.0",
      ledger_key: TEST_KEYS.ledger.publicKey,
    },
    mandates: [
      mandate({
        id: 1,
        payee: { type: "near", account_id: SCENARIO_NEAR_PAYEE },
        purpose_hash: SCENARIO_PURPOSE_NEAR,
        label: "TEST DOUBLE design retainer",
      }),
      mandate({
        id: 2,
        payee: {
          type: "intents",
          chain: "base",
          address: SCENARIO_BASE_ADDRESS,
          asset: testnet.allowedAssets.base,
        },
        purpose_hash: SCENARIO_PURPOSE_BASE,
        label: "TEST DOUBLE Base contractor",
      }),
    ],
    agentKeys: [{ publicKey: TEST_KEYS.agent.publicKey, label: "TEST DOUBLE agent" }],
    factory: withFactory
      ? {
          id: factoryId,
          // R14: factory version ids are 1-based, as the contract computes `index: i + 1`.
          versions: [
            {
              index: 1,
              code_hash: SCENARIO_CODE_HASH,
              mode: codeMode === "global" ? "global" : "embedded",
              notes: "TEST DOUBLE",
              at_ns: "1793750400000000000",
            },
          ],
          vaultVersion: 1,
          config: {
            owner: "probarion.testnet",
            usdc: testnet.usdc,
            intents: testnet.intents,
            allowed_assets: [testnet.allowedAssets.base, testnet.allowedAssets.solana],
            min_deposit: "5000000000000000000000000",
            current_version: 1,
          },
        }
      : null,
    intents: {
      balances: { [`nep141:${testnet.allowedAssets.base}`]: opts.intentsBalance ?? "100000000" },
    },
  });
  chain.addAccessKey(SCENARIO_APPROVER, {
    public_key: TEST_KEYS.approver.publicKey,
    permission: "FullAccess",
  });
  return chain;
}
