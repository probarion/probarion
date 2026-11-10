// What the tools print: amounts in USDC, times in ISO 8601, payees spelled out.
import type { MandateView, Payee, SpendView, VerifyReport } from "@probarion/core";
import { formatUsdc } from "./units.js";

export function describePayee(p: Payee): string {
  return p.type === "near"
    ? `NEAR account ${p.account_id}`
    : `${p.chain} address ${p.address}, paid through NEAR Intents (asset ${p.asset})`;
}

export function nsToIso(ns: string | null | undefined): string | null {
  if (!ns) return null;
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
}

export function mandateSummary(m: MandateView) {
  const remaining = BigInt(m.max_total) - BigInt(m.spent) - BigInt(m.reserved);
  return {
    id: m.id,
    label: m.label,
    status: m.status,
    payee: describePayee(m.payee),
    payee_detail: m.payee,
    purpose_hash: m.purpose_hash,
    max_per_payment_usdc: formatUsdc(m.max_per_payment),
    max_total_usdc: formatUsdc(m.max_total),
    spent_usdc: formatUsdc(m.spent),
    reserved_usdc: formatUsdc(m.reserved),
    remaining_usdc: formatUsdc((remaining < 0n ? 0n : remaining).toString()),
    uses: m.uses,
    max_uses: m.max_uses,
    uses_left: Math.max(0, m.max_uses - m.uses),
    approval_above_usdc: formatUsdc(m.approval_above),
    expires_at: nsToIso(m.expires_at_ns),
    agent_key: m.agent_pk,
  };
}

export function spendSummary(s: SpendView) {
  return {
    spend_id: s.id,
    status: s.status,
    mandate_id: s.mandate_id,
    amount_usdc: formatUsdc(s.amount),
    destination: describePayee(s.destination),
    invoice_hash: s.invoice_hash,
    ref: s.ref,
    created_at: nsToIso(s.created_at_ns),
    held_until: nsToIso(s.held_until_ns),
    memo: s.memo,
  };
}

export function verifySummary(r: VerifyReport) {
  return {
    ok: r.ok,
    vault: r.vault,
    network: r.network,
    entries: r.entries,
    anchors: r.anchors,
    checks: r.checks.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      detail: c.detail,
      ...(c.firstBrokenSeq === undefined ? {} : { first_broken_seq: c.firstBrokenSeq }),
    })),
    unproven: r.unproven,
    generated_at: r.generated_at,
  };
}
