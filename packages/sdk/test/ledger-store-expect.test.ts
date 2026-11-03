// Compare-and-append (T13-R1 item 2): `append(body, sign, { expect })` writes only at the expected position.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEd25519Signer, sha256Hex, ZERO_LINK } from "@probarion/core";
import { afterAll, describe, expect, it } from "vitest";
import { LedgerError } from "../src/errors.js";
import {
  FileLedgerStore,
  InMemoryLedgerStore,
  type LedgerAppendBody,
  LedgerConflictError,
  type LedgerStore,
} from "../src/ledger-store.js";
import { TEST_KEYS } from "../src/testing/index.js";

const sign = createEd25519Signer(TEST_KEYS.ledger.secretKey);
const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "probarion-expect-"));
  dirs.push(dir);
  return join(dir, "ledger.jsonl");
}

function body(n: number): LedgerAppendBody {
  return {
    v: 1,
    vault: "acme.vaults.probarion.testnet",
    kind: "decision",
    at: "2026-11-05T12:00:00.000Z",
    request_id: `req-${n}`,
    mandate_id: 1,
    invoice_hash: sha256Hex(`invoice-${n}`),
    amount: "25000000",
    proposal: null,
    evidence: null,
    rules: [],
    verdict: "allow",
    decided_by: "rules-only",
    contract: null,
    settlement: null,
    refs: null,
  };
}

const stores: [string, () => Promise<LedgerStore>][] = [
  ["InMemoryLedgerStore", async () => new InMemoryLedgerStore()],
  ["FileLedgerStore", async () => new FileLedgerStore(await tempPath())],
];

describe.each(stores)("%s compare-and-append", (_name, make) => {
  it("appends when the head gives the expected position", async () => {
    const store = await make();
    const first = await store.append(body(0), sign, { expect: { seq: 0, prev_link: ZERO_LINK } });
    const second = await store.append(body(1), sign, {
      expect: { seq: 1, prev_link: first.link },
    });
    expect(second.body).toMatchObject({ seq: 1, prev_link: first.link });
    expect((await store.all()).map((e) => e.body.seq)).toEqual([0, 1]);
  });

  it("throws LedgerConflictError and writes nothing when the seq or prev_link differ", async () => {
    const store = await make();
    const first = await store.append(body(0), sign);
    for (const expectation of [
      { seq: 0, prev_link: ZERO_LINK }, // stale: written before `first`
      { seq: 1, prev_link: "ab".repeat(32) }, // right seq, another history
      { seq: 2, prev_link: first.link }, // a seq ahead
    ]) {
      const error = await store.append(body(9), sign, { expect: expectation }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(LedgerConflictError);
      expect(error).toBeInstanceOf(LedgerError);
      expect(error).toMatchObject({
        expected: expectation,
        actual: { seq: 1, prev_link: first.link },
      });
    }
    expect((await store.all()).map((e) => e.body.request_id)).toEqual(["req-0"]);
  });

  it("without opts appends after whatever the head is, as before", async () => {
    const store = await make();
    await store.append(body(0), sign);
    await store.append(body(1), sign, {});
    expect((await store.all()).map((e) => e.body.seq)).toEqual([0, 1]);
  });
});

describe("FileLedgerStore compare-and-append across store objects on one file", () => {
  it("refuses an append whose expectation another store object made stale, and leaves the file as it was", async () => {
    const path = await tempPath();
    const a = new FileLedgerStore(path);
    const b = new FileLedgerStore(path);
    const expectation = { seq: 0, prev_link: ZERO_LINK }; // what b read before a wrote
    await a.append(body(0), sign, { expect: expectation });
    const before = await readFile(path);
    await expect(b.append(body(1), sign, { expect: expectation })).rejects.toBeInstanceOf(
      LedgerConflictError,
    );
    expect(await readFile(path)).toEqual(before);
  });

  it("lets exactly one of two racing appends with the same expectation win", async () => {
    const path = await tempPath();
    const a = new FileLedgerStore(path);
    const b = new FileLedgerStore(path);
    const expectation = { seq: 0, prev_link: ZERO_LINK };
    const results = await Promise.allSettled([
      a.append(body(0), sign, { expect: expectation }),
      b.append(body(1), sign, { expect: expectation }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LedgerConflictError);
    expect((await new FileLedgerStore(path).all()).map((e) => e.body.seq)).toEqual([0]);
  });
});
