import Link from "next/link";

// Mandates, Keys, Payables, Top-up and Alerts are Tasks 9, 10, 11, 13 and 21: their pages land with them.
const TABS = [
  ["", "Overview"],
  ["/mandates", "Mandates"],
  ["/keys", "Keys"],
  ["/payables", "Payables"],
  ["/topup", "Top-up"],
  ["/alerts", "Alerts"],
] as const;

export function VaultNav({ vault }: { vault: string }) {
  const base = `/console/${encodeURIComponent(vault)}`;
  return (
    <nav className="mb-6 flex flex-wrap gap-4 border-b border-[#0B0B0C]/10 pb-2 text-sm">
      {TABS.map(([path, label]) => (
        <Link key={path} href={`${base}${path}`} className="text-[#0B0B0C]/70 hover:underline">
          {label}
        </Link>
      ))}
      <Link
        href={`/proof/${encodeURIComponent(vault)}`}
        className="text-[#0B0B0C]/70 hover:underline"
      >
        Proof ↗
      </Link>
    </nav>
  );
}
