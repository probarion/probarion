import "server-only";
import type { MandateView } from "@probarion/core";
import { log, scrubText } from "@/lib/log";
import { listAll, type VaultReader } from "@/lib/near/reader";

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
    log.warn("payables.chain_unavailable", {
      vault,
      error: scrubText(error instanceof Error ? error.message : String(error)).slice(0, 300),
    });
    return null;
  }
}
