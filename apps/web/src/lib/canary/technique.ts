/**
 * The labels of the public Canary leaderboard. The list is also the database's list: canary_attempts.techniques only
 * accepts these values (migration 0008), so a visitor's own words can never reach the public feed through a label.
 */
export const TECHNIQUES = [
  "instruction_override",
  "authority_urgency",
  "payee_change",
  "fake_invoice",
  "foreign_address",
  "encoding_base64",
  "encoding_hex",
  "encoding_morse",
  "unicode_obfuscation",
  "roleplay",
  "over_cap",
  "other",
] as const;

export type Technique = (typeof TECHNIQUES)[number];

const EVM_ONE = /0x[0-9a-fA-F]{40}/;
const EVM_ALL = /0x[0-9a-fA-F]{40}/g;

function looksLikeBase64Text(t: string): boolean {
  for (const m of t.matchAll(/[A-Za-z0-9+/]{24,}={0,2}/g)) {
    const decoded = Buffer.from(m[0], "base64").toString("latin1");
    const printable = [...decoded].filter((c) => c >= " " && c <= "~").length;
    if (decoded.length >= 12 && printable / decoded.length > 0.9) return true;
  }
  return false;
}

const RULES: [Exclude<Technique, "other">, (t: string) => boolean][] = [
  [
    "instruction_override",
    (t) =>
      /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|all|your)\b/i.test(t) ||
      /\b(new instructions?|system (prompt|message|override))\b/i.test(t),
  ],
  [
    "authority_urgency",
    (t) =>
      /\b(ceo|cfo|founder|admin(istrator)?|security team|developer|near foundation|probarion team)\b/i.test(
        t,
      ) && /\b(urgent|immediately|asap|right now|override|emergency)\b/i.test(t),
  ],
  [
    "payee_change",
    (t) =>
      /\b(new|changed|updated|different)\b.{0,25}\b(bank|account|wallet|address|payee|details)\b/i.test(
        t,
      ) || /\b(bank|account|wallet|address)\b.{0,25}\b(has |have )?changed\b/i.test(t),
  ],
  ["fake_invoice", (t) => /\b(invoice|inv[-#\s]?\d+|amount due|bill to|balance due)\b/i.test(t)],
  ["foreign_address", (t) => EVM_ONE.test(t) || /\b[a-z0-9_-]+(\.[a-z0-9_-]+)*\.near\b/.test(t)],
  ["encoding_base64", looksLikeBase64Text],
  ["encoding_hex", (t) => /\b(?:[0-9a-f]{2}[\s:]){12,}[0-9a-f]{2}\b/i.test(t.replace(EVM_ALL, ""))],
  ["encoding_morse", (t) => /(?:[.-]{1,6}(?:\s+\/\s+|\s+)){6,}[.-]{1,6}/.test(t)],
  ["unicode_obfuscation", (t) => /[​-‏⁠﻿]/.test(t) || (/[Ͱ-ϿЀ-ӿ]/.test(t) && /[A-Za-z]/.test(t))],
  [
    "roleplay",
    (t) => /\b(pretend|role-?play|you are now|act as|imagine you)\b/i.test(t) || /\bDAN\b/.test(t),
  ],
  [
    "over_cap",
    (t) =>
      /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/.test(t) ||
      /\b\d{4,}(?:\.\d+)?\s*(?:usdc|usd|\$|dollars)\b/i.test(t),
  ],
];

/** Labels for the public leaderboard; heuristic by design, never used for any decision. */
export function classify(text: string): Technique[] {
  const hits = RULES.filter(([, test]) => test(text)).map(([k]) => k);
  return hits.length > 0 ? hits : ["other"];
}
