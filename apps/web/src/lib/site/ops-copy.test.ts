import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BLAST_RADIUS,
  LEGAL_STATUS,
  PRIVACY_PAGE,
  SECURITY_PAGE,
  STATUS_PAGE,
  TERMS_PAGE,
} from "./ops-copy";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** Every string of the copy; a function is called for both networks. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function")
    return [...strings(value("testnet")), ...strings(value("mainnet"))];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}
const ALL = strings({
  BLAST_RADIUS,
  LEGAL_STATUS,
  PRIVACY_PAGE,
  SECURITY_PAGE,
  STATUS_PAGE,
  TERMS_PAGE,
});

const BANNED: readonly RegExp[] = [
  /guarantee/i,
  /100%/,
  /unhackable/i,
  /keep what/i,
  /\bprize/i,
  /\breward/i,
  /\bplease\b/i,
  /\bnever\b/i,
  /!/,
  /\/open\b/,
  /mailto:/i,
  /status\.probarion\.xyz/i,
  /support@/i,
  /security@/i,
  /—/,
  /npx probarion/,
];

describe("the operations copy", () => {
  it("has no banned word, contact or host", () => {
    for (const text of ALL)
      for (const re of BANNED) expect(text, `${re} in: ${text}`).not.toMatch(re);
  });

  it("says what SECURITY.md says about reports", () => {
    const md = read("SECURITY.md");
    expect(ALL.join("\n")).toContain("72 hours");
    expect(md).toContain("72 hours");
    expect(md).toContain("There is\nno bug bounty");
  });

  it("shows the threat model's blast-radius rows word for word", () => {
    const md = read("docs", "THREAT_MODEL.md");
    expect(BLAST_RADIUS).toHaveLength(5);
    for (const row of BLAST_RADIUS) expect(md).toContain(`| ${row.can} | ${row.cannot} |`);
  });

  it("claims no analytics and no paid plan", () => {
    expect(ALL.join("\n")).not.toMatch(/paid plan|pricing/i);
    expect(PRIVACY_PAGE.sections.map((s) => s.id)).not.toContain("browser-extension");
  });

  it("puts the downloaded ledger where the relative --ledger path finds it", () => {
    expect(SECURITY_PAGE.verify.hosted).toContain("into the repository folder");
    expect(SECURITY_PAGE.verify.hosted).toContain("`--network mainnet`");
  });

  it("does not limit the zero-retention amount to the wait for a Confirm", () => {
    // A rejected row keeps suggested_amount, and a confirmed one keeps its signed confirmation message.
    const invoices = PRIVACY_PAGE.sections.find((s) => s.id === "invoices");
    expect(invoices?.paragraphs.join(" ")).not.toContain("while it waits");
  });
});
