/**
 * The alert kinds in plain words, in the order a message lists them. Each phrase follows "when" ("you get a message when
 * a spend waits for approval, ..."). The kinds are the `vault_events` ones; a subscription's own kinds come from the
 * table's default (migration 0001), so this is the only place that says them in words.
 */
const WORDS: readonly (readonly [string, string])[] = [
  ["spend_held", "a spend waits for approval"],
  ["refused_by_contract", "the contract refuses a spend"],
  ["spend_paid", "a spend is paid"],
  ["spend_burned", "a payout goes out to Base"],
  ["spend_failed", "a payout fails"],
  ["allowance_low", "an agent or ledger key's gas allowance runs low"],
  ["near_low", "the vault's free NEAR runs low"],
  ["mandate_created", "a mandate is created"],
  ["spend_pending", "a payout is on its way"],
  ["spend_rejected", "an approver rejects a spend"],
  ["spend_expired", "a held spend expires"],
  ["anchor", "the ledger is anchored"],
];

/** "a spend waits for approval, a spend is paid and the vault's free NEAR runs low". A kind without words stays as its id. */
export function kindsInWords(kinds: readonly string[]): string {
  const wanted = new Set(kinds);
  const known = new Set(WORDS.map(([kind]) => kind));
  const phrases = [
    ...WORDS.filter(([kind]) => wanted.has(kind)).map(([, words]) => words),
    ...[...wanted].filter((kind) => !known.has(kind)),
  ];
  if (phrases.length < 2) return phrases[0] ?? "";
  return `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
}
