/**
 * The create-vault form rules that both the server (prepareCreateVault) and the browser (the live
 * panel) apply. No SDK, no I/O: safe in a client component.
 */

export interface CreateVaultForm {
  name: string;
  approvers: string; // comma/space separated
  dailyBackstopUsdc: string;
  heldTtlHours: string;
  depositNear: string;
}

const FORM_KEYS = [
  "name",
  "approvers",
  "dailyBackstopUsdc",
  "heldTtlHours",
  "depositNear",
] as const;

/**
 * What a server action takes from the browser: exactly the five form fields, each a string of at
 * most 1,000 characters. Anything else the browser sends (an owner, a factory, a deposit floor) is
 * dropped, and a field of another type is empty.
 */
export function asForm(raw: unknown): CreateVaultForm {
  const src = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out = {} as CreateVaultForm;
  for (const k of FORM_KEYS) {
    const v = src[k];
    out[k] = typeof v === "string" ? v.slice(0, 1_000) : "";
  }
  return out;
}

export function parseApprovers(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((a) => a.trim())
        .filter(Boolean),
    ),
  ];
}

export const ONLY_APPROVER_WARNING =
  "You are the only approver, so a held payment needs nobody else's signature. A second person is safer.";

/** Warnings that do not block the create (the contract allows them), shown before the owner signs. */
export function createWarnings(approvers: readonly string[], owner: string): string[] {
  return approvers.length === 1 && approvers[0] === owner ? [ONLY_APPROVER_WARNING] : [];
}
