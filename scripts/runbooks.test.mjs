import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

/** 1-based line numbers of fenced blocks that send a mainnet tx with no OWNER SIGNS marker just above. */
function unsignedMainnetSends(markdown) {
  const lines = markdown.split("\n");
  const problems = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith("```")) continue;
    if (start < 0) {
      start = i;
      continue;
    }
    const block = lines.slice(start + 1, i).join("\n");
    const sends = block.includes("network-config mainnet") && /\bsend\b/.test(block);
    const marked = lines
      .slice(Math.max(0, start - 3), start)
      .some((l) => l.includes("**OWNER SIGNS**"));
    if (sends && !marked) problems.push(start + 1);
    start = -1;
  }
  return problems;
}

const FENCE = "```";

test("an unmarked mainnet send is flagged", () => {
  const md = [
    "Step:",
    `${FENCE}bash`,
    "near tokens x send-near y '1 NEAR' network-config mainnet sign-with-keychain send",
    FENCE,
  ].join("\n");
  assert.deepEqual(unsignedMainnetSends(md), [2]);
});

test("a marked send, a testnet send and a mainnet view are all fine", () => {
  const md = [
    "**OWNER SIGNS**",
    `${FENCE}bash`,
    "near contract call-function as-transaction a m json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as o network-config mainnet sign-with-keychain send",
    FENCE,
    `${FENCE}bash`,
    "near contract call-function as-transaction a m json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as o network-config testnet sign-with-keychain send",
    FENCE,
    `${FENCE}bash`,
    "near contract call-function as-read-only a get_config json-args '{}' network-config mainnet now",
    FENCE,
  ].join("\n");
  assert.deepEqual(unsignedMainnetSends(md), []);
});

test("every runbook marks its mainnet sends with OWNER SIGNS", () => {
  const dir = new URL("../docs/runbooks/", import.meta.url);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
    const problems = unsignedMainnetSends(readFileSync(new URL(name, dir), "utf8"));
    assert.deepEqual(
      problems,
      [],
      `${name}: unmarked mainnet sends at lines ${problems.join(", ")}`,
    );
  }
});

// The one-yocto rule (interfaces v2 §4.2): these methods panic RequiresOneYocto without exactly 1 yoctoNEAR.
const ONE_YOCTO_METHODS = [
  "add_agent",
  "remove_agent",
  "set_ledger_key",
  "revoke_mandate",
  "approve",
  "reject",
  "unfreeze",
  "withdraw",
  "withdraw_intents",
  "add_version",
  "store_code",
  "publish_global",
];

/** Commands (joined across trailing-backslash lines) that call a one-yocto method without 1 yoctoNEAR. */
function missingOneYocto(text) {
  return text
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((command) => {
      const m = /(?:as-transaction\s+\S+|owner_call)\s+(\w+)\s/.exec(command);
      return m && ONE_YOCTO_METHODS.includes(m[1]) && !command.includes("'1 yoctoNEAR'");
    });
}

test("a one-yocto method called with '0 NEAR' is flagged", () => {
  const bad =
    "near contract call-function as-transaction v0.probarion.near withdraw json-args '{}' \\\n  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as o network-config testnet sign-with-keychain send";
  assert.equal(missingOneYocto(bad).length, 1);
  assert.equal(missingOneYocto(bad.replace("'0 NEAR'", "'1 yoctoNEAR'")).length, 0);
});

test("runbooks and testnet scripts attach 1 yoctoNEAR to every one-yocto method", () => {
  const files = [];
  for (const [dir, ext] of [
    ["../docs/runbooks/", ".md"],
    ["./testnet/", ".sh"],
  ]) {
    const url = new URL(dir, import.meta.url);
    if (!existsSync(url)) continue;
    for (const name of readdirSync(url).filter((n) => n.endsWith(ext))) {
      files.push(new URL(name, url));
    }
  }
  for (const file of files) {
    assert.deepEqual(
      missingOneYocto(readFileSync(file, "utf8")),
      [],
      `${file.pathname}: missing '1 yoctoNEAR'`,
    );
  }
});
