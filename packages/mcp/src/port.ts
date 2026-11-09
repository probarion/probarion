import type {
  CheckSpendVerdict,
  Hex32,
  MandateView,
  ModelProposal,
  SpendView,
  VerifyReport,
} from "@probarion/core";
import type { SpendOutcome } from "@probarion/sdk";

export interface SpendInput {
  mandateId: number;
  /** Smallest units (6 decimals). */
  amount: string;
  invoiceHash: Hex32;
  ref: string;
}

/**
 * Everything the MCP server can ask of Probarion. No member names a recipient, and none creates, changes or
 * removes a mandate, a key or the vault's settings: those are the owner's, signed in the owner's wallet.
 */
export interface ProbarionPort {
  listMandates(): Promise<MandateView[]>;
  checkSpend(input: SpendInput): Promise<CheckSpendVerdict>;
  requestSpend(input: SpendInput & { proposal: ModelProposal }): Promise<SpendOutcome>;
  getSpend(spendId: number): Promise<SpendView | null>;
  verify(): Promise<VerifyReport>;
}

export interface ServerInfo {
  vault: string;
  network: "mainnet" | "testnet";
  version: string;
  readOnly: boolean;
}
