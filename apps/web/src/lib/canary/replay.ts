import type { Network } from "@/lib/config";
import data from "../../../content/attack-replay.json";

/**
 * One recorded attack from a run of the team's own: the page says the rows come "from our own tests", so a visitor's
 * attempt never goes in this file. A contract entry carries its transaction, which a deployment record names
 * (replay.test.ts). The OWNER curates the file.
 */
export interface ReplayEntry {
  at: string;
  technique: string;
  summary: string;
  layer: "code" | "contract";
  result: string; // a rule id (code) or a PROBARION error code (contract)
  tx_hash: string | null;
  network: Network;
}

export function parseReplay(json: unknown): ReplayEntry[] {
  if (!Array.isArray(json)) return [];
  return json.filter((e): e is ReplayEntry => {
    if (typeof e !== "object" || e === null) return false;
    const r = e as Record<string, unknown>;
    return (
      typeof r.at === "string" &&
      !Number.isNaN(Date.parse(r.at)) &&
      typeof r.technique === "string" &&
      typeof r.summary === "string" &&
      r.summary.length > 0 &&
      (r.layer === "code" || r.layer === "contract") &&
      typeof r.result === "string" &&
      r.result.length > 0 &&
      (r.tx_hash === null || typeof r.tx_hash === "string") &&
      (r.network === "mainnet" || r.network === "testnet")
    );
  });
}

export const REPLAY: ReplayEntry[] = parseReplay(data);
