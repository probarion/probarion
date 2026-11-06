import { Card, linePillClass } from "@/components/ui";
import type { Network } from "@/lib/config";

/** What the page shows in place of a vault that is registered on the other network (W-NET-R4). */
export interface VaultOnOtherNetworkProps {
  vaultId: string;
  /** The network the vault is registered on. */
  vaultNetwork: Network;
  /** The network of the address this page was opened at. */
  requestNetwork: Network;
  /** `<origin of the vault's network>/console/<vault>`, or null when this site does not serve that network. */
  href: string | null;
}

/**
 * The page of a vault on the other network. It replaces the page: nothing of the vault is read, and no wallet is
 * connected, because this address's wallet and chain are the other network's. The way out is the vault's own address,
 * where the person signs in with a wallet of that network.
 */
export function VaultOnOtherNetwork({
  vaultId,
  vaultNetwork,
  requestNetwork,
  href,
}: VaultOnOtherNetworkProps) {
  return (
    <div>
      <h1 className="mono mb-4 text-2xl font-semibold break-all">{vaultId}</h1>
      <Card title={`This vault is on NEAR ${vaultNetwork}`}>
        <p className="mb-4 text-sm text-ink/70">
          {href === null
            ? `You are on the ${requestNetwork} console. NEAR ${vaultNetwork} is not served by this site yet.`
            : `You are on the ${requestNetwork} console. Open it at the ${vaultNetwork} address and sign in there with your ${vaultNetwork} wallet.`}
        </p>
        {href === null ? null : (
          <a className={linePillClass} href={href}>
            Open on {vaultNetwork} <span aria-hidden="true">↗</span>
          </a>
        )}
      </Card>
    </div>
  );
}
