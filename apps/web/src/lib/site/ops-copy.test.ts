import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANARY_VIA } from "@/lib/canary/via";
import { CLI_NOTE, CLI_ON_NPM, CLI_SETUP_LINES } from "@/lib/proof/cli";
import {
  BLAST_RADIUS,
  EXTENSION_PRIVACY,
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
  EXTENSION_PRIVACY,
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
  // npx probarion runs only once the package is on npm.
  ...(CLI_ON_NPM ? [] : [/npx probarion/]),
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

  it("says what the server keeps of an extension token the same way in every doc as /privacy does", () => {
    // The columns of extension_tokens (migration 0013): a hash and a four-character hint, not the token.
    const KEPT =
      "a sha256 of the token and its last four characters, with the account, network, browser name and times, not the token itself";
    expect(EXTENSION_PRIVACY.paragraphs.join(" ")).toContain("last four characters");
    for (const doc of [
      ["docs", "THREAT_MODEL.md"],
      ["SECURITY.md"],
      ["docs", "RUNBOOK.md"],
      ["docs", "specs", "2026-10-21-probarion-interfaces.md"],
    ]) {
      const md = read(...doc).replace(/\s+/g, " ");
      expect(md, doc.join("/")).toContain(KEPT);
      expect(md, doc.join("/")).not.toMatch(
        /keeps only (a|its|their|each token's) sha256|only the token's sha256/i,
      );
    }
  });

  it("says what the server keeps of an invoice sent from the extension, and for which vaults it can send one", () => {
    // lib/payables/queue.ts: the upload's retention; the mandate, the sender and the checks always; a check is a pass
    // or a hold. The queue route takes an owner or an approver of the vault.
    const text = EXTENSION_PRIVACY.paragraphs.join(" ");
    expect(text).toContain("under the same vault settings as an upload in the console");
    expect(text).toContain("the checks it was queued with");
    expect(text).toContain(
      "If your vault is set to keep no invoice files, its record keeps the invoice's hashes and amount, the mandate, the account that sent it and those checks, which name the mandate's payee: not the file, its text, its other facts or its name.",
    );
    expect(text).toContain("a vault where you are the owner or an approver");
    expect(text).toContain("paid only after the vault's owner confirms it in the console");
    expect(text).not.toMatch(/checks it passed|you own or approve|same settings,/);
    // ops-pages.test.ts counts the paragraphs that name the setting.
    expect(text).not.toMatch(/zero-retention/i);
  });

  it("says in the threat model and the runbook who ends a leaked extension token, and what its queued invoices block", () => {
    // ext_token_revoke matches the session's own account (migration 0013, lib/ext/store.ts); the vault's approvers are
    // fixed when it is created (contracts/vault/src/lib.rs); invoice_reject keeps the ref (0007), and a queued row
    // holds both duplicate keys (0006's invoice_insert).
    for (const doc of [
      ["docs", "THREAT_MODEL.md"],
      ["docs", "RUNBOOK.md"],
    ]) {
      const md = read(...doc).replace(/\s+/g, " ");
      const name = doc.join("/");
      expect(md, name).toContain("the vault's owner cannot revoke an approver's token");
      expect(md, name).toContain("can block a later upload of the same invoice");
      expect(md, name).toContain("after a Reject the same text cannot be queued or uploaded again");
      expect(md, name).not.toMatch(/The owner revokes (it|a token) on `?\/extension/);
    }
    const row = read("docs", "RUNBOOK.md")
      .split("\n")
      .find((l) => l.startsWith("| An extension token leaked |"));
    expect(row).toContain(
      "The vault's owner rejects every waiting invoice sent from the browser extension by that account since the suspected leak that they do not recognise.",
    );
  });

  it("claims no analytics and no paid plan", () => {
    expect(ALL.join("\n")).not.toMatch(/paid plan|pricing/i);
    expect(PRIVACY_PAGE.sections.map((s) => s.id)).not.toContain("browser-extension");
    // The extension's section is EXTENSION_PRIVACY, rendered once by components/site/ExtensionPrivacy.tsx.
    expect(EXTENSION_PRIVACY.id).toBe("browser-extension");
  });

  it("says a Canary attempt also stores the one word its link names, from the app's own set", () => {
    const canary = PRIVACY_PAGE.sections.find((s) => s.id === "canary")?.paragraphs.join(" ");
    expect(canary).toContain("/canary?via=x");
    expect(CANARY_VIA).toContain("x");
    expect(canary).toContain("one word");
    expect(canary).toContain("is not stored");
  });

  it("puts the downloaded ledger where the relative --ledger path finds it", () => {
    expect(SECURITY_PAGE.verify.hosted).toContain(
      CLI_ON_NPM ? "Then run this in the folder that holds it" : "into the repository folder",
    );
    expect(SECURITY_PAGE.verify.hosted).toContain("`--network mainnet`");
  });

  it("shows the repository set-up only while the CLI is not on npm", () => {
    expect(SECURITY_PAGE.verify.note).toBe(CLI_NOTE);
    expect(SECURITY_PAGE.verify.setupLines).toEqual(CLI_ON_NPM ? [] : CLI_SETUP_LINES);
    if (CLI_ON_NPM) expect(SECURITY_PAGE.verify.hosted).not.toContain("repository folder");
  });

  it("does not limit the zero-retention amount to the wait for a Confirm", () => {
    // A rejected row keeps suggested_amount, and a confirmed one keeps its signed confirmation message.
    const invoices = PRIVACY_PAGE.sections.find((s) => s.id === "invoices");
    expect(invoices?.paragraphs.join(" ")).not.toContain("while it waits");
  });
});
