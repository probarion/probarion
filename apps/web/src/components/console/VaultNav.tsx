import { RouteLink } from "@/components/RouteLink";
import { VAULT_TABS } from "@/lib/routes";

// A tab whose page is not built yet (Payables, Top-up, Alerts: see PLANNED_ROUTES) is left out until it lands.
export function VaultNav({ vault }: { vault: string }) {
  const base = `/console/${encodeURIComponent(vault)}`;
  return (
    <nav className="mb-6 flex flex-wrap gap-4 border-b border-[#0B0B0C]/10 pb-2 text-sm">
      {VAULT_TABS.map(({ path, label }) => (
        <RouteLink
          key={path}
          route={`/console/[vault]${path}`}
          href={`${base}${path}`}
          whenPlanned="hide"
          className="text-[#0B0B0C]/70 hover:underline"
        >
          {label}
        </RouteLink>
      ))}
      <RouteLink
        route="/proof/[vault]"
        href={`/proof/${encodeURIComponent(vault)}`}
        whenPlanned="hide"
        className="text-[#0B0B0C]/70 hover:underline"
      >
        Proof ↗
      </RouteLink>
    </nav>
  );
}
