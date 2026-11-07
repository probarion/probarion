import { type FeatureStatus, STATUS_LABELS } from "@/lib/docs/types";
import d from "./docs.module.css";

/** Takes only a registry status, so no other word can reach a status chip. */
export function StatusChip({ status }: { status: FeatureStatus }) {
  return (
    <span className={`${d.chip} ${d[status] ?? ""}`}>
      <span className={d.chipDot} aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function NetworkChip({ network }: { network: "Testnet" | "Mainnet" }) {
  return <span className={d.chip}>{network}</span>;
}
