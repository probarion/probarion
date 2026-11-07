import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const docs = join(root, "docs");
const text = readFileSync(join(docs, "RUNBOOK.md"), "utf8").replace(/\r\n/g, "\n");
const headings = (level: "##" | "###"): string[] =>
  [...text.matchAll(new RegExp(`^${level} (.+)$`, "gm"))].map((m) => (m[1] ?? "").trim());
/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to dashes. */
const slug = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");

// Copied from apps/web/test/site-facts.test.ts:666, unchanged (its bracket keeps the name out of
// the repository).
const OTHER_PROJECT: RegExp = /vest[i]arion/i;

describe("docs/RUNBOOK.md", () => {
  it("has every section the spec (§13), the README and later tasks link to", () => {
    const h2 = headings("##");
    for (const h of [
      "Severity levels",
      "First 15 minutes",
      "If something looks wrong",
      "Freeze procedure",
      "Key rotation",
      "RPC failover",
      "Burned, awaiting bridge",
      "Status page posts",
      "Postmortem template",
    ]) {
      expect(h2, h).toContain(h);
    }
    const h3 = headings("###");
    for (const h of [
      "App down",
      "Alerts not delivered",
      "Canary levels",
      "Agent key's allowance nearly used up",
    ]) {
      expect(h3, h).toContain(h);
    }
  });

  it("makes no promise about what a finder keeps", () => {
    expect(text).not.toMatch(/keeps? what/i);
  });

  it("says what rotating the master key does to the duplicate check, here and in the rotation runbook", () => {
    expect(text).toMatch(/invoice-number key/i);
    expect(readFileSync(join(docs, "ops", "key-rotation.md"), "utf8")).toMatch(
      /invoice-number key/i,
    );
  });

  it("says a new master does not end the browser extension's connections, here and in the rotation runbook", () => {
    expect(text).toContain("A new `KEY_ENCRYPTION_SECRET` does not end them.");
    expect(readFileSync(join(docs, "ops", "key-rotation.md"), "utf8")).toMatch(
      /extension\s+connections\s+are\s+not\s+ended/i,
    );
  });

  it("ends every extension token with the pairing codes first, in one transaction, after a stolen session", () => {
    // An exchange in flight holds its code's row: the delete waits for it, and the update's fresh snapshot then sees
    // the token it minted. Revoking first lets that token, or one a live stolen session mints, survive.
    expect(text).toContain(
      "`begin; delete from public.extension_pair_codes; update public.extension_tokens set revoked_at = now() where revoked_at is null; commit;`",
    );
    expect(text).not.toMatch(/update public\.extension_tokens[^`]*`[^`]*then `delete from/);
    const session =
      text.split("\n").find((l) => l.startsWith("| An owner's console session stolen")) ?? "";
    const tokens = text.split("\n").find((l) => l.startsWith("| Extension tokens (")) ?? "";
    // A pairing code the stolen session showed turns into a token without any session for 10 minutes
    // (ext_code_exchange, migration 0013), and Revoke on /extension ends tokens only. So, once the sessions end, the
    // owner either runs the SQL, which deletes the codes first, or waits out every code before revoking one by one.
    for (const [name, row] of [
      ["session row", session],
      ["Extension tokens row", tokens],
    ] as const) {
      const ended = row.search(/end the sessions first/i);
      const wait = row.search(/wait at least 10 minutes from the moment the sessions ended/i);
      const revoke = row.search(
        /then revoke its tokens on `\/extension` and check Connected browsers again/i,
      );
      expect(ended, name).toBeGreaterThan(-1);
      expect(wait, `${name}: waits out the codes after the sessions end`).toBeGreaterThan(ended);
      expect(revoke, `${name}: revokes one by one only after the wait`).toBeGreaterThan(wait);
      expect(row, name).toMatch(
        /end every token with the SQL[^|]*deletes the pairing codes first/i,
      );
    }
  });

  it("has one Key rotation section (plan 05 Task 18 replaces it) and leaves Backups and restore to Task 19", () => {
    expect(headings("##").filter((h) => h === "Key rotation")).toHaveLength(1);
    expect(text).not.toMatch(/^## Backups and restore$/m);
  });

  it("tells only the owner to sign a freeze or a withdrawal", () => {
    expect(text).toMatch(/OWNER SIGNS/);
    expect(text).not.toMatch(/Claude (signs|runs the freeze)/i);
  });

  it("forbids re-paying a burned spend", () => {
    expect(text).toMatch(/Never re-pay/);
  });

  it("names the per-network RPC settings, and runs the CLI from source", () => {
    expect(text).toContain("NEAR_RPC_URLS_MAINNET");
    expect(text).toContain("NEAR_RPC_URLS_TESTNET");
    expect(text).toContain("node packages/cli/dist/bin.js");
    expect(text).not.toMatch(/npx (-y )?probarion/);
  });

  it("offers no contact or host that does not exist yet, and no alert latency it cannot keep", () => {
    expect(text).not.toMatch(/security@|support@|status\.probarion\.xyz/i);
    expect(text).not.toMatch(/within (about )?(1|one|a) minute/i);
  });

  it("names the rate-limit purge", () => {
    expect(text).toContain("rate_limits_prune");
  });

  it("links only files and headings that exist", () => {
    const broken: string[] = [];
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1] ?? "";
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [file = "", anchor] = target.split("#");
      const path = file === "" ? join(docs, "RUNBOOK.md") : resolve(docs, file);
      if (!existsSync(path)) {
        broken.push(target);
        continue;
      }
      if (anchor !== undefined && path.endsWith(".md")) {
        const anchors = [...readFileSync(path, "utf8").matchAll(/^#+ (.+)$/gm)].map((h) =>
          slug(h[1] ?? ""),
        );
        if (!anchors.includes(anchor)) broken.push(target);
      }
    }
    expect(broken).toEqual([]);
  });

  it("names none of the owner's other projects", () => {
    expect(text).not.toMatch(OTHER_PROJECT);
  });
});
