/** The callout kinds. A footer is fixed text the component adds, so every signing callout says the same thing. */
export const CALLOUT_KINDS = {
  note: { label: "Note" },
  warning: { label: "Warning" },
  "owner-signs": {
    label: "Owner signs",
    footer: "The owner signs this transaction. Probarion never signs it.",
  },
  "approver-signs": {
    label: "Approver signs",
    footer: "An approver signs this transaction. Probarion never signs it.",
  },
  key: { label: "Key idea" },
} as const satisfies Record<string, { label: string; footer?: string }>;

export type CalloutKind = keyof typeof CALLOUT_KINDS;

export function isCalloutKind(value: string): value is CalloutKind {
  return Object.hasOwn(CALLOUT_KINDS, value);
}

export function calloutFooter(kind: CalloutKind): string | undefined {
  const entry: { label: string; footer?: string } = CALLOUT_KINDS[kind];
  return entry.footer;
}
