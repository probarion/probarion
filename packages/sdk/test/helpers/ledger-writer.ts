// Child process for the multi-process ledger test: appends `count` notes to the ledger at `path`.
// Usage: node --import tsx test/helpers/ledger-writer.ts <path> <tag> <count>
import { createEd25519Signer, generateKeyPair, sha256Hex } from "@probarion/core";
import { FileLedgerStore } from "../../src/ledger-store.js";

const [path, tag, countText] = process.argv.slice(2);
if (path === undefined || tag === undefined || countText === undefined) {
  throw new Error("usage: ledger-writer <path> <tag> <count>");
}

const sign = createEd25519Signer(generateKeyPair(new Uint8Array(32).fill(9)).secretKey);
const store = new FileLedgerStore(path, { lockTimeoutMs: 30_000 });

for (let i = 0; i < Number(countText); i++) {
  await store.append(
    {
      v: 1,
      vault: "acme.vaults.probarion.testnet",
      kind: "note",
      at: "2026-11-05T12:00:00.000Z",
      request_id: `${tag}-${i}`,
      mandate_id: null,
      invoice_hash: sha256Hex(`${tag}-${i}`),
      amount: null,
      proposal: null,
      evidence: null,
      rules: [],
      verdict: null,
      decided_by: null,
      contract: null,
      settlement: null,
      refs: null,
    },
    sign,
  );
}
