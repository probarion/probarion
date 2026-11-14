// Pins what scripts/record-proofs.ts may do, by reading its source (it is never run by the tests): the RPC methods it
// calls (block, tx, light_client_proof), what it imports (no signer, no key, no near-api-js), and where it writes
// (test/fixtures/proofs only). The online helpers it calls are pinned to the same methods.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFixture } from "./helpers/fixtures.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const script = read("../scripts/record-proofs.ts");
const proofRpc = read("../src/proof-rpc.ts");
const ALLOWED = ["block", "light_client_proof", "tx"];

/** The method names passed to `.call(...)` / `.call<T>(...)` in a source text. */
function calledMethods(source: string): string[] {
  const methods = new Set<string>();
  for (const match of source.matchAll(/\.call(?:<[^>]*>)?\(\s*"([^"]+)"/g)) {
    methods.add(match[1] as string);
  }
  return [...methods].sort();
}

/** Every `.call(` in the source, so a call with a computed method name cannot slip past calledMethods. */
const callSites = (source: string) => source.match(/\.call(?:<[^>]*>)?\(/g)?.length ?? 0;

describe("scripts/record-proofs.ts", () => {
  it("calls block, tx and light_client_proof and nothing else", () => {
    expect(calledMethods(script)).toEqual(["block", "tx"]);
    expect(calledMethods(proofRpc)).toEqual(ALLOWED);
    expect(script).toContain(
      'const ALLOWED_METHODS: readonly string[] = ["block", "tx", "light_client_proof"];',
    );
    // The only call with a computed method name is the guard's pass-through, after the allow-list check.
    const literal = script.match(/\.call(?:<[^>]*>)?\(\s*"/g)?.length ?? 0;
    expect(callSites(script) - literal).toBe(2);
    expect(script).toMatch(/if \(!ALLOWED_METHODS\.includes\(method\)\) \{\s*throw/);
    expect(proofRpc.match(/\.call(?:<[^>]*>)?\(\s*"/g)?.length).toBe(callSites(proofRpc));
  });

  it("imports nothing that can sign: no near-api-js, no key or signer module", () => {
    const imports = [...script.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual([
      "../src/outcome-proof.js",
      "../src/proof-rpc.js",
      "../src/rpc.js",
      "../src/types.js",
      "node:fs/promises",
    ]);
    for (const source of [script, proofRpc]) {
      expect(source).not.toMatch(
        /near-api-js|@near-js|near-kit|KeyPair|privateKey|secretKey|signTransaction/,
      );
      expect(source).not.toMatch(/broadcast_tx|send_tx|process\.env/);
    }
  });

  it("writes under test/fixtures/proofs and nowhere else", () => {
    expect(script).toContain(
      'const OUT_DIR = new URL("../test/fixtures/proofs/", import.meta.url);',
    );
    const writes = [
      ...script.matchAll(
        /\b(writeFile|mkdir|appendFile|rm|unlink|rename|copyFile)\(\s*(new URL\([^)]*\)|[^,)]+)/g,
      ),
    ];
    expect(writes.map((match) => match[1])).toEqual(["mkdir", "writeFile", "writeFile"]);
    for (const match of writes) {
      expect(match[2]).toMatch(/^(OUT_DIR|new URL\("[a-z0-9-]+\.json", OUT_DIR\))$/);
    }
    expect(script).not.toMatch(/writeFileSync|createWriteStream/);
  });

  it("wrote fixtures that say where they came from and carry no signature", () => {
    for (const name of ["mainnet-spend-2.json", "mainnet-drill-over-cap.json"]) {
      const fixture = readFixture<{
        _source: string;
        tx: { transaction: Record<string, unknown> };
      }>(`proofs/${name}`);
      expect(fixture._source).toContain("scripts/record-proofs.ts");
      expect(fixture._source).toContain("nothing signed");
      expect(fixture.tx.transaction).not.toHaveProperty("signature");
    }
  });
});
