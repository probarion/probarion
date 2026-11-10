import "server-only";
import type { MandateView, SpendView } from "@probarion/core";
import { log, scrubText } from "@/lib/log";
import { listAll, type VaultReader } from "@/lib/near/reader";
import type { SpendsNow } from "./view";

/** What the owner's Confirm needs from the chain. */
export type VaultFactsReader = Pick<VaultReader, "getConfig" | "listMandates">;

/** The vault's on-chain owner and every mandate of it, or null (logged) when the chain could not be read. */
export async function readVaultFacts(
  reader: VaultFactsReader,
  vault: string,
): Promise<{ owner: string; mandates: MandateView[] } | null> {
  try {
    const [config, mandates] = await Promise.all([
      reader.getConfig(vault),
      listAll((from, limit) => reader.listMandates(vault, from, limit), 100),
    ]);
    return { owner: config.owner, mandates };
  } catch (error) {
    log.warn("payables.chain_unavailable", { vault, error: errorText(error) });
    return null;
  }
}

/**
 * Every spend of the vault by id, read from the chain with the paged list_spends view the overview reads, or "unread"
 * (logged) when the chain could not be read. A view call only: nothing is signed, and no row or ledger entry changes.
 */
export async function readSpendsNow(
  reader: Pick<VaultReader, "listSpends">,
  vault: string,
): Promise<SpendsNow> {
  try {
    const all: SpendView[] = await listAll((from, limit) => reader.listSpends(vault, from, limit));
    return new Map(all.map((s) => [s.id, s]));
  } catch (error) {
    log.warn("payables.spends_unavailable", { vault, error: errorText(error) });
    return "unread";
  }
}

const errorText = (error: unknown): string =>
  scrubText(error instanceof Error ? error.message : String(error)).slice(0, 300);
