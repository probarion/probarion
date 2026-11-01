import { NETWORKS, type NetworkId, type Payee } from "@probarion/core";
import { CliError } from "./errors.js";

/** NEAR account id rules: 2 to 64 characters, lowercase alphanumerics joined by `-`, `_` and `.`. */
export const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parsePayeeArg(arg: string, network: NetworkId): Payee {
  const colon = arg.indexOf(":");
  if (colon === -1) {
    throw new CliError("--payee must be near:<account>, base:<0x address> or solana:<address>");
  }
  const kind = arg.slice(0, colon);
  const value = arg.slice(colon + 1).trim();
  const assets = NETWORKS[network].allowedAssets;
  if (kind === "near") {
    if (!NEAR_ACCOUNT_RE.test(value)) {
      throw new CliError(`--payee near:${value} is not a valid NEAR account id`);
    }
    return { type: "near", account_id: value };
  }
  if (kind === "base") {
    if (!EVM_RE.test(value)) {
      throw new CliError(`--payee base:${value} is not a 0x-prefixed 20-byte address`);
    }
    return { type: "intents", chain: "base", address: value, asset: assets.base };
  }
  if (kind === "solana") {
    if (!SOLANA_RE.test(value)) {
      throw new CliError(`--payee solana:${value} is not a base58 Solana address`);
    }
    return { type: "intents", chain: "solana", address: value, asset: assets.solana };
  }
  throw new CliError(`--payee kind ${JSON.stringify(kind)} is not near, base or solana`);
}
