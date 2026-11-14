import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFixture } from "./helpers/fixtures.js";

// The recorder reads public state and signs nothing. These checks read its source, so a later edit that adds a
// signing import, another RPC method or a write outside test/fixtures/keys fails here.
const source = readFileSync(new URL("../scripts/record-keys.ts", import.meta.url), "utf8");

describe("scripts/record-keys.ts", () => {
  it("calls query and nothing else", () => {
    const methods = [...source.matchAll(/\.call(?:<[^>]*>)?\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(["query"]));
  });

  it("asks for view_account, view_access_key_list and view_access_key, and its guard allows those three", () => {
    const requests = [...source.matchAll(/request_type:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(requests)).toEqual(
      new Set(["view_account", "view_access_key_list", "view_access_key"]),
    );
    const allowed = /ALLOWED_REQUESTS: readonly string\[\] = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
    expect([...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([
      "view_account",
      "view_access_key_list",
      "view_access_key",
    ]);
    expect(source).toMatch(/method !== "query"/);
  });

  it("imports no signer, key pair or wallet library", () => {
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual([
      "node:fs/promises",
      "../src/access-keys.js",
      "../src/code-identity.js",
      "../src/rpc.js",
    ]);
    expect(source).not.toMatch(
      /near-api-js|KeyPair|signTransaction|signAndSend|privateKey|secret/i,
    );
    expect(source).not.toMatch(/\.near-credentials|\.keys\/|process\.env/);
  });

  it("writes under test/fixtures/keys and nowhere else", () => {
    const urls = [...source.matchAll(/new URL\(([^)]*)\)/g)].map((m) => m[1]);
    expect(urls).toEqual(['"../test/fixtures/keys/", import.meta.url', "target.file, OUT_DIR"]);
    expect(source.match(/writeFile\(/g)).toHaveLength(1);
    expect(source).toMatch(/await writeFile\(new URL\(target\.file, OUT_DIR\)/);
  });

  it("wrote fixtures that say where they came from and that nothing was signed", () => {
    for (const file of [
      "mainnet-v0.json",
      "testnet-factory-vault.json",
      "drill-view-access-key.json",
    ]) {
      const fixture = readFixture<{ _source: string }>(`keys/${file}`);
      expect(fixture._source, file).toMatch(/nothing was signed/);
      expect(fixture._source, file).toMatch(
        /https:\/\/(archival-)?rpc\.(mainnet|testnet)\.fastnear\.com/,
      );
    }
  });
});
