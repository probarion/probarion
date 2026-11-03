import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CanonicalJsonError,
  computeBodyHash,
  createEd25519Signer,
  type LedgerEntry,
  sha256Hex,
  verifyEntrySignature,
  ZERO_LINK,
} from "@probarion/core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { LedgerError } from "../src/errors.js";
import {
  composeBody,
  FileLedgerStore,
  InMemoryLedgerStore,
  type LedgerAppendBody,
  type LedgerStore,
  ledgerPathFromEnv,
} from "../src/ledger-store.js";
import { assertCanChainOnto, assertChains } from "../src/ledger-store-chain.js";
import { withFileLock } from "../src/ledger-store-lock.js";
import { Mutex } from "../src/mutex.js";
import { TEST_KEYS } from "../src/testing/index.js";

const sign = createEd25519Signer(TEST_KEYS.ledger.secretKey);

function body(n: number, overrides: Partial<LedgerAppendBody> = {}): LedgerAppendBody {
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
    rules: [{ id: "mandate.none", outcome: "pass", detail: "mandate 1 selected by purpose_hash" }],
    verdict: "allow",
    decided_by: "rules-only",
    contract: null,
    settlement: null,
    refs: null,
    ...overrides,
  };
}

// Every temp directory is removed after the file's tests, on Windows too (retry on a transient EBUSY).
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "probarion-ledger-"));
  tempDirs.push(dir);
  return dir;
}

async function tempPath(): Promise<string> {
  return join(await tempDir(), "nested", "ledger.jsonl");
}

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

async function exerciseChain(store: LedgerStore): Promise<void> {
  const first = await store.append(body(0), sign);
  const second = await store.append(body(1), sign);
  expect(first.body).toMatchObject({ seq: 0, prev_link: ZERO_LINK });
  expect(second.body).toMatchObject({ seq: 1, prev_link: first.link });
  expect(second.signer).toBe(TEST_KEYS.ledger.publicKey);
  expect((await store.head())?.link).toBe(second.link);
  expect(await store.all()).toHaveLength(2);
}

describe("Mutex", () => {
  it("runs tasks one at a time, in call order", async () => {
    const mutex = new Mutex();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([
      mutex.run(task("a", 30)),
      mutex.run(task("b", 1)),
      mutex.run(task("c", 1)),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("does not let a failed task block the next one", async () => {
    const mutex = new Mutex();
    const failing = mutex.run(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    await expect(mutex.run(async () => 7)).resolves.toBe(7);
  });
});

describe("composeBody", () => {
  it("keeps exactly the 18 interface keys in a fixed order and drops anything else", () => {
    const composed = composeBody(
      { ...body(0), extra: "dropped" } as LedgerAppendBody,
      3,
      "a".repeat(64),
    );
    expect(Object.keys(composed)).toEqual([
      "v",
      "vault",
      "seq",
      "prev_link",
      "kind",
      "at",
      "request_id",
      "mandate_id",
      "invoice_hash",
      "amount",
      "proposal",
      "evidence",
      "rules",
      "verdict",
      "decided_by",
      "contract",
      "settlement",
      "refs",
    ]);
    expect(composed.seq).toBe(3);
    expect(composed.prev_link).toBe("a".repeat(64));
  });
});

describe("InMemoryLedgerStore", () => {
  it("assigns seq and prev_link and chains entries", async () => {
    await exerciseChain(new InMemoryLedgerStore());
  });

  it("returns copies that callers cannot use to rewrite history", async () => {
    const store = new InMemoryLedgerStore();
    await store.append(body(0), sign);
    const copy = await store.all();
    const first = copy[0];
    if (first === undefined) throw new Error("missing entry");
    first.body.amount = "1";
    expect((await store.all())[0]?.body.amount).toBe("25000000");
  });

  it("stores only the interface keys of the body", async () => {
    const store = new InMemoryLedgerStore();
    const withExtra = { ...body(0), extra: "dropped" } as LedgerAppendBody;
    const entry = await store.append(withExtra, sign);
    expect(Object.keys(entry.body)).not.toContain("extra");
    expect(Object.keys(entry.body)).toHaveLength(18);
  });

  it("does not keep a reference to the caller's body", async () => {
    const store = new InMemoryLedgerStore();
    const input = body(0);
    const entry = await store.append(input, sign);
    const hashBefore = entry.body_hash;
    const rule = input.rules[0];
    if (rule === undefined) throw new Error("body has no rule");
    rule.detail = "rewritten after the append";
    input.rules.push({ id: "vault.frozen", outcome: "refuse", detail: "late" });
    const stored = (await store.all())[0];
    expect(stored?.body.rules).toHaveLength(1);
    expect(stored?.body.rules[0]?.detail).toBe("mandate 1 selected by purpose_hash");
    expect(computeBodyHash(stored?.body as LedgerEntry["body"])).toBe(hashBefore);
  });

  it("continues the chain of the entries it was seeded with, and copies them", async () => {
    const seed = new InMemoryLedgerStore();
    const e0 = await seed.append(body(0), sign);
    const e1 = await seed.append(body(1), sign);
    const store = new InMemoryLedgerStore([e0, e1]);
    e1.body.amount = "1";
    const e2 = await store.append(body(2), sign);
    expect(e2.body).toMatchObject({ seq: 2 });
    expect(e2.body.prev_link).toBe((await seed.head())?.link);
    expect(await store.all()).toHaveLength(3);
  });

  it("refuses an entry for another vault and leaves the ledger as it was", async () => {
    const store = new InMemoryLedgerStore();
    const first = await store.append(body(0), sign);
    await expect(
      store.append(body(1, { vault: "other.vaults.probarion.testnet" }), sign),
    ).rejects.toThrow(LedgerError);
    await expect(
      store.append(body(1, { vault: "other.vaults.probarion.testnet" }), sign),
    ).rejects.toThrow(/belongs to vault acme\.vaults\.probarion\.testnet/);
    expect(await store.all()).toEqual([first]);
    expect((await store.append(body(1), sign)).body.seq).toBe(1);
  });

  it("refuses an empty vault", async () => {
    await expect(new InMemoryLedgerStore().append(body(0, { vault: "" }), sign)).rejects.toThrow(
      LedgerError,
    );
  });

  it("refuses a body with an undefined value and stays usable", async () => {
    const store = new InMemoryLedgerStore();
    await store.append(body(0), sign);
    await expect(
      store.append(body(1, { refs: { decision_body_hash: undefined } }), sign),
    ).rejects.toThrow(CanonicalJsonError);
    expect(await store.all()).toHaveLength(1);
    expect((await store.append(body(1), sign)).body.seq).toBe(1);
  });

  it("refuses a body with a missing field", async () => {
    const incomplete = { ...body(0) } as Partial<LedgerAppendBody>;
    delete incomplete.contract;
    await expect(
      new InMemoryLedgerStore().append(incomplete as LedgerAppendBody, sign),
    ).rejects.toThrow(CanonicalJsonError);
  });

  it("a failing signer adds nothing and does not block the next append", async () => {
    const store = new InMemoryLedgerStore();
    await expect(
      store.append(body(0), async () => {
        throw new Error("kms unreachable");
      }),
    ).rejects.toThrow("kms unreachable");
    expect(await store.all()).toEqual([]);
    expect((await store.append(body(0), sign)).body.seq).toBe(0);
  });

  it("refuses to extend a head that does not match its own link", async () => {
    const seed = new InMemoryLedgerStore();
    const e0 = await seed.append(body(0), sign);
    const forged: LedgerEntry = { ...e0, link: "f".repeat(64) };
    await expect(new InMemoryLedgerStore([forged]).append(body(1), sign)).rejects.toThrow(
      /not internally consistent|not sound/,
    );
    const changed: LedgerEntry = { ...e0, body: { ...e0.body, amount: "1" } };
    await expect(new InMemoryLedgerStore([changed]).append(body(1), sign)).rejects.toThrow(
      LedgerError,
    );
  });
});

describe("assertChains / assertCanChainOnto (checks before an entry is written)", () => {
  async function twoEntries(): Promise<[LedgerEntry, LedgerEntry]> {
    const store = new InMemoryLedgerStore();
    return [await store.append(body(0), sign), await store.append(body(1), sign)];
  }

  it("accepts a real successor and the first entry", async () => {
    const [e0, e1] = await twoEntries();
    expect(() => assertChains(null, e0, "ledger")).not.toThrow();
    expect(() => assertChains(e0, e1, "ledger")).not.toThrow();
    expect(() => assertCanChainOnto(e1, e1.body.vault, "ledger")).not.toThrow();
    expect(() => assertCanChainOnto(null, "v.testnet", "ledger")).not.toThrow();
  });

  it("refuses an entry with the wrong seq, prev_link or vault", async () => {
    const [e0, e1] = await twoEntries();
    expect(() => assertChains(e0, e0, "ledger")).toThrow(/seq is 0, expected 1/);
    expect(() => assertChains(null, e1, "ledger")).toThrow(/seq is 1, expected 0/);
    expect(() => assertChains(e1, { ...e1, body: { ...e1.body, seq: 2 } }, "ledger")).toThrow(
      LedgerError,
    );
    const otherVault = await new InMemoryLedgerStore().append(
      body(0, { vault: "other.vaults.probarion.testnet" }),
      sign,
    );
    expect(() =>
      assertChains(e0, { ...otherVault, body: { ...otherVault.body, seq: 1 } }, "ledger"),
    ).toThrow(/prev_link is not the link|vault is other/);
  });

  it("refuses an entry whose hash, signature or link was not produced for its body", async () => {
    const [e0, e1] = await twoEntries();
    expect(() => assertChains(e0, { ...e1, body: { ...e1.body, amount: "1" } }, "ledger")).toThrow(
      /body_hash does not match/,
    );
    expect(() => assertChains(e0, { ...e1, link: "d".repeat(64) }, "ledger")).toThrow(
      /link does not match/,
    );
    expect(() => assertChains(e0, { ...e1, sig: e0.sig }, "ledger")).toThrow(LedgerError);
    expect(() => assertChains(e0, { ...e1, sig: "not a signature" }, "ledger")).toThrow(
      /cannot be recomputed/,
    );
  });

  it("refuses a different vault, an empty vault and an unsound head", async () => {
    const [, e1] = await twoEntries();
    expect(() => assertCanChainOnto(e1, "other.testnet", "ledger")).toThrow(/belongs to vault/);
    expect(() => assertCanChainOnto(e1, "", "ledger")).toThrow(LedgerError);
    expect(() =>
      assertCanChainOnto({ ...e1, link: "0".repeat(63) }, e1.body.vault, "ledger"),
    ).toThrow(/64 lowercase hex/);
    expect(() =>
      assertCanChainOnto({ ...e1, body: { ...e1.body, seq: -1 } }, e1.body.vault, "ledger"),
    ).toThrow(/seq/);
    expect(() =>
      assertCanChainOnto({ ...e1, body: null } as never, e1.body.vault, "ledger"),
    ).toThrow(/no body/);
  });
});

describe("FileLedgerStore", () => {
  it("assigns seq and prev_link and chains entries", async () => {
    await exerciseChain(new FileLedgerStore(await tempPath()));
  });

  it("re-hashes identically after a disk round trip", async () => {
    const path = await tempPath();
    const store = new FileLedgerStore(path);
    for (let i = 0; i < 3; i++) await store.append(body(i), sign);
    const reloaded = await new FileLedgerStore(path).all();
    expect(reloaded).toHaveLength(3);
    for (const entry of reloaded) {
      expect(computeBodyHash(entry.body)).toBe(entry.body_hash);
      expect(verifyEntrySignature(entry)).toBe(true);
    }
  });

  it("refuses a body with an undefined value and leaves the file untouched", async () => {
    const path = await tempPath();
    const store = new FileLedgerStore(path);
    await store.append(body(0), sign);
    const before = await readFile(path, "utf8");
    await expect(
      store.append(body(1, { refs: { decision_body_hash: undefined } }), sign),
    ).rejects.toThrow(CanonicalJsonError);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("treats a missing file as an empty ledger", async () => {
    const store = new FileLedgerStore(await tempPath());
    expect(await store.all()).toEqual([]);
    expect(await store.head()).toBeNull();
  });

  it("names the corrupt line", async () => {
    const path = await tempPath();
    const store = new FileLedgerStore(path);
    await store.append(body(0), sign);
    await writeFile(path, `${await readFile(path, "utf8")}{"truncated":\n`);
    await expect(store.all()).rejects.toThrow(LedgerError);
    await expect(store.all()).rejects.toThrow(/line 2/);
  });

  it("serializes concurrent appends into a contiguous chain", async () => {
    const store = new FileLedgerStore(await tempPath());
    await Promise.all([0, 1, 2, 3, 4].map((i) => store.append(body(i), sign)));
    const entries = await store.all();
    expect(entries.map((e) => e.body.seq)).toEqual([0, 1, 2, 3, 4]);
    for (let i = 1; i < entries.length; i++)
      expect(entries[i]?.body.prev_link).toBe(entries[i - 1]?.link);
  });
});

describe("FileLedgerStore: path", () => {
  it("defaults to .probarion/ledger.jsonl", () => {
    expect(new FileLedgerStore().path).toBe(".probarion/ledger.jsonl");
  });

  it("treats an empty or blank path as unset (R12)", () => {
    expect(new FileLedgerStore("").path).toBe(".probarion/ledger.jsonl");
    expect(new FileLedgerStore("   ").path).toBe(".probarion/ledger.jsonl");
    expect(new FileLedgerStore("custom/ledger.jsonl").path).toBe("custom/ledger.jsonl");
  });

  it("ledgerPathFromEnv uses envValue: unset, empty and blank all fall back", () => {
    expect(ledgerPathFromEnv({})).toBe(".probarion/ledger.jsonl");
    expect(ledgerPathFromEnv({ PROBARION_LEDGER_PATH: "" })).toBe(".probarion/ledger.jsonl");
    expect(ledgerPathFromEnv({ PROBARION_LEDGER_PATH: "  " })).toBe(".probarion/ledger.jsonl");
    expect(ledgerPathFromEnv({ PROBARION_LEDGER_PATH: " out/l.jsonl " })).toBe("out/l.jsonl");
    expect(ledgerPathFromEnv({ PROBARION_LEDGER_PATH: "" }, "home/l.jsonl")).toBe("home/l.jsonl");
  });
});

describe("FileLedgerStore: file format and appends", () => {
  it("writes one JSON object per line, LF only, and only ever adds to the end", async () => {
    const path = await tempPath();
    const store = new FileLedgerStore(path);
    let previous = "";
    for (let i = 0; i < 4; i++) {
      await store.append(body(i), sign);
      const text = await readFile(path, "utf8");
      expect(text.startsWith(previous)).toBe(true);
      expect(text.length).toBeGreaterThan(previous.length);
      previous = text;
    }
    expect(previous.endsWith("\n")).toBe(true);
    expect(previous).not.toContain("\r");
    const lines = previous.slice(0, -1).split("\n");
    expect(lines).toHaveLength(4);
    for (const [i, line] of lines.entries()) {
      expect((JSON.parse(line) as LedgerEntry).body.seq).toBe(i);
    }
  });

  it("leaves no lock or temporary file behind", async () => {
    const path = await tempPath();
    const store = new FileLedgerStore(path);
    await store.append(body(0), sign);
    await store.append(body(1), sign);
    await expect(store.append(body(2, { vault: "" }), sign)).rejects.toThrow(LedgerError);
    expect(await readdir(join(path, ".."))).toEqual(["ledger.jsonl"]);
  });

  it("flushes the line to disk before it reports success", async () => {
    const path = await tempPath();
    const store = new FileLedgerStore(path);
    await store.append(body(0), sign);
    const handle = await open(path, "r");
    const proto = Object.getPrototypeOf(handle) as { sync: () => Promise<void> };
    await handle.close();
    const spy = vi.spyOn(proto, "sync");
    try {
      await store.append(body(1), sign);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("serializes appends from two store objects on the same file", async () => {
    const path = await tempPath();
    const a = new FileLedgerStore(path);
    const b = new FileLedgerStore(path);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? a : b).append(body(i), sign)),
    );
    const entries = await a.all();
    expect(entries.map((e) => e.body.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]?.body.prev_link).toBe(entries[i - 1]?.link);
    }
    expect(new Set(entries.map((e) => e.body.request_id)).size).toBe(12);
  });

  it("does not keep a reference to the caller's body", async () => {
    const path = await tempPath();
    const store = new FileLedgerStore(path);
    const input = body(0);
    const entry = await store.append(input, sign);
    const rule = input.rules[0];
    if (rule === undefined) throw new Error("body has no rule");
    rule.detail = "rewritten after the append";
    expect(entry.body.rules[0]?.detail).toBe("mandate 1 selected by purpose_hash");
    const reloaded = (await store.all())[0];
    expect(computeBodyHash(reloaded?.body as LedgerEntry["body"])).toBe(entry.body_hash);
  });

  it("refuses an entry for another vault and leaves the file untouched", async () => {
    const path = await tempPath();
    const store = new FileLedgerStore(path);
    await store.append(body(0), sign);
    const before = await readFile(path, "utf8");
    await expect(
      store.append(body(1, { vault: "other.vaults.probarion.testnet" }), sign),
    ).rejects.toThrow(/belongs to vault acme\.vaults\.probarion\.testnet/);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("a failing signer adds nothing, releases the lock and does not block the next append", async () => {
    const path = await tempPath();
    const store = new FileLedgerStore(path);
    await store.append(body(0), sign);
    const before = await readFile(path, "utf8");
    await expect(
      store.append(body(1), async () => {
        throw new Error("kms unreachable");
      }),
    ).rejects.toThrow("kms unreachable");
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await store.append(body(1), sign)).body.seq).toBe(1);
  });

  it("refuses to extend a head whose link was changed, and still lets the file be read", async () => {
    const path = await tempPath();
    const store = new FileLedgerStore(path);
    const first = await store.append(body(0), sign);
    const text = (await readFile(path, "utf8")).replace(first.link, "e".repeat(64));
    await writeFile(path, text);
    await expect(store.append(body(1), sign)).rejects.toThrow(/line 1/);
    await expect(store.append(body(1), sign)).rejects.toThrow(LedgerError);
    expect(await readFile(path, "utf8")).toBe(text);
    // Reading is the verifier's business: it reports the broken link, it does not need an error here.
    expect(await store.all()).toHaveLength(1);
  });

  it("extends a ledger written by core's fixtures and keeps their links", async () => {
    const source = new URL("../../core/test/fixtures/valid-ledger.jsonl", import.meta.url);
    const path = await tempPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await readFile(source, "utf8"));
    const store = new FileLedgerStore(path);
    const before = await store.all();
    expect(before).toHaveLength(5);
    const next = await store.append(body(9, { vault: before[0]?.body.vault as string }), sign);
    expect(next.body).toMatchObject({ seq: 5, prev_link: before[4]?.link });
    expect(await store.all()).toHaveLength(6);
  });
});

describe("FileLedgerStore: reading", () => {
  async function ledgerWith(count: number): Promise<{ path: string; store: FileLedgerStore }> {
    const path = await tempPath();
    const store = new FileLedgerStore(path);
    for (let i = 0; i < count; i++) await store.append(body(i), sign);
    return { path, store };
  }

  it("accepts CRLF line endings and blank lines, and counts them in line numbers", async () => {
    const { path, store } = await ledgerWith(2);
    const lines = (await readFile(path, "utf8")).slice(0, -1).split("\n");
    await writeFile(path, `\n${lines[0]}\r\n\r\n${lines[1]}\r\n`);
    expect((await store.all()).map((e) => e.body.seq)).toEqual([0, 1]);
    await writeFile(path, `\n${lines[0]}\r\n\r\n{oops\r\n`);
    await expect(store.all()).rejects.toThrow(/line 4 is not valid JSON/);
  });

  it("refuses a line that is JSON but not an object", async () => {
    const { path, store } = await ledgerWith(1);
    for (const junk of ["null", "42", "[]", '"text"']) {
      await writeFile(path, `${await readFile(path, "utf8")}${junk}\n`);
      await expect(store.all()).rejects.toThrow(/line 2 is not a JSON object/);
      await expect(store.head()).rejects.toThrow(LedgerError);
      await writeFile(path, `${(await readFile(path, "utf8")).split("\n")[0]}\n`);
    }
  });

  it("refuses bytes that are not UTF-8 and names the line", async () => {
    const { path, store } = await ledgerWith(1);
    const good = await readFile(path);
    await writeFile(path, Buffer.concat([good, Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a])]));
    await expect(store.all()).rejects.toThrow(/line 2 is not valid UTF-8/);
  });

  it("detects a torn last line, names it, and drops or repairs nothing", async () => {
    const { path, store } = await ledgerWith(2);
    const intact = await readFile(path, "utf8");
    const third = JSON.stringify(
      await new InMemoryLedgerStore(await store.all()).append(body(2), sign),
    );
    const torn = `${intact}${third.slice(0, third.length - 17)}`;
    await writeFile(path, torn);

    for (const read of [() => store.all(), () => store.head()]) {
      const error = await read().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as Error).message).toMatch(/line 3/);
      expect((error as Error).message).toMatch(/torn/);
      expect((error as Error).message).toMatch(/no trailing newline/);
    }
    // It refuses to append after a torn line, and the file is exactly as the crash left it.
    await expect(store.append(body(2), sign)).rejects.toThrow(/line 3.*torn/);
    expect(await readFile(path, "utf8")).toBe(torn);
  });

  it("detects a torn last line that stops inside a multi-byte character", async () => {
    const { path, store } = await ledgerWith(1);
    const intact = await readFile(path);
    const cut = Buffer.concat([intact, Buffer.from('{"a":"é', "utf8").subarray(0, -1)]);
    await writeFile(path, cut);
    await expect(store.all()).rejects.toThrow(/line 2.*torn/);
    expect(await readFile(path)).toEqual(cut);
  });

  it("detects a torn last line that is only an opening brace", async () => {
    const { path, store } = await ledgerWith(1);
    await appendFile(path, "{");
    await expect(store.all()).rejects.toThrow(/line 2.*torn/);
  });

  it("reads a last line that only lacks its newline, and the next append supplies the newline", async () => {
    const { path, store } = await ledgerWith(2);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.slice(0, -1));
    expect((await store.all()).map((e) => e.body.seq)).toEqual([0, 1]);
    const third = await store.append(body(2), sign);
    expect(third.body.seq).toBe(2);
    const after = await readFile(path, "utf8");
    expect(after.startsWith(text.slice(0, -1))).toBe(true);
    expect(after.endsWith("\n")).toBe(true);
    expect(after.slice(0, -1).split("\n")).toHaveLength(3);
    expect((await store.all()).map((e) => e.body.seq)).toEqual([0, 1, 2]);
  });

  it("prints forward slashes in every message (R11)", async () => {
    const { path, store } = await ledgerWith(1);
    await appendFile(path, "{oops\n");
    const shown = path.replaceAll("\\", "/");
    const error = await store.all().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toContain(shown);
    expect(error?.message).not.toContain("\\");
    await writeFile(path, (await readFile(path, "utf8")).replace("{oops\n", '{"body":'));
    const torn = await store.all().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(torn?.message).toMatch(/torn/);
    expect(torn?.message).toContain(shown);
    expect(torn?.message).not.toContain("\\");
    const refused = await store.append(body(1), sign).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(refused?.message).toContain(shown);
    expect(refused?.message).not.toContain("\\");
  });

  it("waits for an append that is still being written instead of reporting its half line", async () => {
    const { path, store } = await ledgerWith(1);
    const second = await new InMemoryLedgerStore(await store.all()).append(body(1), sign);
    const text = `${JSON.stringify(second)}\n`;
    let pending: Promise<LedgerEntry[]> | undefined;
    await withFileLock(`${path}.lock`, async () => {
      await appendFile(path, text.slice(0, 40));
      pending = store.all();
      await sleep(150);
      await appendFile(path, text.slice(40));
    });
    expect((await pending)?.map((e) => e.body.seq)).toEqual([0, 1]);
  });

  it("reports a half line when the writer holding the lock does not finish", async () => {
    const { path } = await ledgerWith(1);
    const store = new FileLedgerStore(path, { lockTimeoutMs: 100 });
    await appendFile(path, '{"body":');
    await withFileLock(`${path}.lock`, async () => {
      await expect(store.all()).rejects.toThrow(/line 2.*torn/);
    });
  });

  it("reports what the second look finds when it is not a torn tail any more", async () => {
    const { path, store } = await ledgerWith(1);
    let pending: Promise<LedgerEntry[]> | undefined;
    await withFileLock(`${path}.lock`, async () => {
      await appendFile(path, '{"body":');
      pending = store.all();
      pending.catch(() => undefined);
      await sleep(150);
      await appendFile(path, "oops\n"); // the line is now complete, and it is not JSON
    });
    await expect(pending).rejects.toThrow(/line 2 is not valid JSON/);
  });
});

describe("FileLedgerStore: a failed write", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  async function handleProto(path: string): Promise<Record<string, (...a: never[]) => unknown>> {
    const handle = await open(path, "r");
    const proto = Object.getPrototypeOf(handle) as Record<string, (...a: never[]) => unknown>;
    await handle.close();
    return proto;
  }

  it("takes a half-written line back out (disk full) and keeps working", async () => {
    const path = await tempPath();
    const store = new FileLedgerStore(path);
    await store.append(body(0), sign);
    const before = await readFile(path, "utf8");

    const proto = await handleProto(path);
    const original = proto.writeFile as (this: unknown, data: Buffer | string) => Promise<void>;
    let failed = false;
    // The lock file is written with a string; only the first write of the ledger line (a Buffer) fails.
    const spy = vi
      .spyOn(proto as { writeFile: typeof original }, "writeFile")
      .mockImplementation(async function (this: unknown, data: Buffer | string) {
        if (typeof data === "string" || failed) return original.call(this, data);
        failed = true;
        await original.call(this, data.subarray(0, Math.floor(data.length / 2)));
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      });
    spies.push(spy);

    await expect(store.append(body(1), sign)).rejects.toThrow(/ENOSPC/);
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await store.all()).map((e) => e.body.seq)).toEqual([0]);
    expect((await readdir(join(path, ".."))).sort()).toEqual(["ledger.jsonl"]);
    expect((await store.append(body(1), sign)).body.seq).toBe(1);
  });

  it("takes the line back out when the flush fails", async () => {
    const path = await tempPath();
    const store = new FileLedgerStore(path);
    await store.append(body(0), sign);
    const before = await readFile(path, "utf8");
    const proto = await handleProto(path);
    const spy = vi
      .spyOn(proto as { sync: () => Promise<void> }, "sync")
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      });
    spies.push(spy);
    await expect(store.append(body(1), sign)).rejects.toThrow(/EIO/);
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
