import { FactoryClient } from "@probarion/sdk";
import type { Metadata } from "next";
import Link from "next/link";
import { CliFallback } from "@/components/console/CliFallback";
import { CreateVaultPanel } from "@/components/console/CreateVaultPanel";
import { RegisterVaultForm } from "@/components/console/RegisterVaultForm";
import { Badge, Card } from "@/components/ui";
import { requireSession } from "@/lib/auth/guard";
import type { Network } from "@/lib/config";
import { OUT_OF_NEAR } from "@/lib/console/out-of-near";
import { loadFactoryForCreate } from "@/lib/console/vaults";
import { serviceDb } from "@/lib/db/clients";
import { memberTenants } from "@/lib/db/tenants";
import { getEnv } from "@/lib/env";
import { createDepositPlan } from "@/lib/near/runway";
import { getRpc } from "@/lib/near/server";
import { originFor, requestNetwork } from "@/lib/network";

export const metadata: Metadata = { title: "Your vaults" };
/** The create button's confirmTx server action waits for the transaction to be FINAL. */
export const maxDuration = 60;

/**
 * The warn badge of a vault on the other network. With that network's address it is a link to the vault there ("mainnet ↗"),
 * where the person signs in with a wallet of that network; without one it stays the plain badge.
 */
function OtherNetworkBadge({ vault, network }: { vault: string; network: Network }) {
  const origin = originFor(network);
  if (origin === null) return <Badge tone="warn">{network}</Badge>;
  return (
    <a href={`${origin}/console/${encodeURIComponent(vault)}`}>
      <Badge tone="warn">
        {network} <span aria-hidden="true">↗</span>
      </Badge>
    </a>
  );
}

/**
 * The console home. It comes before any vault, so it is guarded by the session (requireSession);
 * every vault page under it is guarded by requireMember. It lists every vault of the account; a vault on the other
 * network keeps its badge, which links to that network's address when this site serves it. Create and Register use the
 * network of the address the page was opened at.
 */
export default async function ConsolePage() {
  const session = await requireSession();
  const network = await requestNetwork();
  const settings = getEnv().networks[network];
  const [vaults, factory] = await Promise.all([
    memberTenants(serviceDb(), session.accountId),
    loadFactoryForCreate(new FactoryClient(settings.factoryId, getRpc(network))),
  ]);
  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Your vaults</h1>
      <Card title="Vaults you own, approve or view">
        {vaults.length === 0 ? (
          <p className="text-sm text-mute">No vaults yet. Create one, or register one you own.</p>
        ) : (
          <ul className="text-sm">
            {vaults.map((v) => (
              <li key={v.tenant_id} className="border-b border-line py-2 last:border-0">
                <Link
                  className="mono underline"
                  href={`/console/${encodeURIComponent(v.vault_id)}`}
                >
                  {v.vault_id}
                </Link>{" "}
                <Badge>{v.role}</Badge>{" "}
                {v.kind !== "external" ? <Badge tone="info">{v.kind}</Badge> : null}{" "}
                {v.network !== network ? (
                  <OtherNetworkBadge vault={v.vault_id} network={v.network} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Create a vault">
        {factory.ok ? (
          <CreateVaultPanel
            factory={settings.factoryId}
            network={network}
            mode={factory.mode}
            version={factory.version}
            minDeposit={factory.minDeposit}
            defaultDeposit={createDepositPlan(
              factory.minDeposit,
              factory.mode,
              0n,
            ).requiredYocto.toString()}
            owner={session.accountId}
            outOfNearCodes={OUT_OF_NEAR.codes}
          />
        ) : (
          <CliFallback factory={settings.factoryId} network={network} reason={factory.reason} />
        )}
      </Card>
      <Card title="Register a vault you already own">
        <p className="mb-3 text-sm text-mute">
          Sign in as its on-chain owner. The console checks that the account runs a Probarion vault
          build, and reads the approvers from the chain.
        </p>
        <RegisterVaultForm placeholder={`acme.${settings.factoryId}`} />
      </Card>
    </div>
  );
}
