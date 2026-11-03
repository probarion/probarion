import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTx,
  emptyProof,
  readProof,
  serializeProof,
  setValue,
  writeProof,
} from "../lib/proof.js";
import { main } from "../proof.js";

// renameSync is wrapped (it still renames) so a test can look at the disk at the moment of the
// rename, or make it fail. Everything else in node:fs is the real thing.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const NOW = new Date("2026-11-04T10:00:00.000Z");
const HASH = "8qkFz1q7mJpQd9wZ3yX4hT6uV2bN5cR1sE7gK3aL9mP";
const TARGET = "mainnet-proof.json";

const first = () =>
  addTx(
    emptyProof(NOW),
    "first_near_payment",
    {
      hash: HASH,
      network: "mainnet",
      signer_id: "v0.probarion.near",
      receiver_id: "v0.probarion.near",
      kind: "near_payment",
      what: "First NEAR payment under mandate 1",
      signed_by: "agent_key",
      expect: "success",
      error_code: null,
      spend_id: 1,
      amount_usdc: "2.00",
      base_tx: null,
    },
    NOW,
  );

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proof-write-"));
  path = join(dir, TARGET);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.mocked(renameSync).mockClear();
  vi.restoreAllMocks();
});

describe("writeProof is atomic", () => {
  it("writes a temp file next to the target, then renames it over the target", async () => {
    const real = await vi.importActual<typeof import("node:fs")>("node:fs");
    const before = emptyProof(NOW);
    writeProof(path, before);
    const after = first();

    const seen: { from?: string; to?: string; target?: string; temp?: string } = {};
    vi.mocked(renameSync).mockImplementationOnce((from, to) => {
      seen.from = String(from);
      seen.to = String(to);
      seen.target = readFileSync(path, "utf8"); // the target at the moment of the rename ...
      seen.temp = readFileSync(from, "utf8"); // ... and the temp file
      return real.renameSync(from, to);
    });
    writeProof(path, after);

    expect(seen.from).toBe(`${path}.${process.pid}.tmp`);
    expect(seen.to).toBe(path);
    expect(seen.target).toBe(serializeProof(before)); // still the old, complete file
    expect(seen.temp).toBe(serializeProof(after)); // the new content is already complete
    expect(readFileSync(path, "utf8")).toBe(serializeProof(after));
    expect(readdirSync(dir)).toEqual([TARGET]); // no temp file left
  });

  it("a rename that fails leaves the original intact, removes the temp file and rethrows", () => {
    const original = emptyProof(NOW);
    writeProof(path, original);
    const before = readFileSync(path, "utf8");

    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("EXDEV: simulated rename failure");
    });
    expect(() => writeProof(path, first())).toThrow(/EXDEV: simulated rename failure/);

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readProof(path)).toEqual(original);
    expect(readdirSync(dir)).toEqual([TARGET]);
  });

  it("a failed write of the temp file leaves the original intact and reports that error", () => {
    writeProof(path, emptyProof(NOW));
    const before = readFileSync(path, "utf8");
    vi.mocked(renameSync).mockClear(); // the setup write above renamed once
    // a directory where the temp file must go: writing it fails before any rename
    mkdirSync(`${path}.${process.pid}.tmp`);

    expect(() => writeProof(path, first())).toThrow(/EISDIR|EPERM|EACCES/);

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  });

  it("an invalid proof is refused before anything is written", () => {
    writeProof(path, emptyProof(NOW));
    const before = readFileSync(path, "utf8");
    const broken = { ...emptyProof(NOW), v: 2 } as never;
    expect(() => writeProof(path, broken)).toThrow(/refusing to write an invalid proof file/);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual([TARGET]);
  });

  it("a stale temp file from a crashed run is never read and never overwritten", () => {
    writeProof(path, emptyProof(NOW));
    const stale = `${path}.${process.pid + 1}.tmp`;
    writeFileSync(stale, '{ "v": 1, "updated_at": "truncated');

    expect(main(["show"], NOW, path)).toBe(0);
    expect(
      main(["set", "metrics.external_owners", "2", "--type", "number", "--source", "s"], NOW, path),
    ).toBe(0);

    expect(readFileSync(stale, "utf8")).toBe('{ "v": 1, "updated_at": "truncated');
    const next = setValue(emptyProof(NOW), "metrics.external_owners", 2, "s", NOW);
    expect(readProof(path)).toEqual(next);
  });
});
