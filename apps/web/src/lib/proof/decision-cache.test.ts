// The decision rows of /proof are built once per snapshot object: loadProof's cache hands every visitor of the next
// 60 s the same snapshot, so A1 to A7 for each decision run once per gather, not once per page view.
import type { Snapshot } from "@probarion/core";
import { describe, expect, it } from "vitest";
import fixture from "@/lib/site/valid-snapshot.json";
import { cachedDecisionRows } from "./decision-cache";
import type { DecisionRow } from "./decisions";

const snapshot = () => structuredClone(fixture) as unknown as Snapshot;

describe("cachedDecisionRows", () => {
  it("builds the rows of one snapshot object once, and again for another object or network", async () => {
    const s = snapshot();
    let built = 0;
    const build = async (_s: Snapshot): Promise<DecisionRow[]> => {
      built++;
      return [];
    };
    const first = cachedDecisionRows(s, "testnet", build);
    expect(cachedDecisionRows(s, "testnet", build)).toBe(first);
    await first;
    expect(built).toBe(1);
    // A new gather is a new snapshot object.
    await cachedDecisionRows(snapshot(), "testnet", build);
    expect(built).toBe(2);
    // The same object read for the other network is not the same rows (its explorer links differ).
    await cachedDecisionRows(s, "mainnet", build);
    expect(built).toBe(3);
  });

  it("forgets a build that failed, so the next view tries again", async () => {
    const s = snapshot();
    let calls = 0;
    const failing = async (): Promise<DecisionRow[]> => {
      calls++;
      throw new Error("rows broke");
    };
    await expect(cachedDecisionRows(s, "testnet", failing)).rejects.toThrow("rows broke");
    await expect(cachedDecisionRows(s, "testnet", failing)).rejects.toThrow("rows broke");
    expect(calls).toBe(2);
    expect(await cachedDecisionRows(s, "testnet", async () => [])).toEqual([]);
  });

  it("defaults to the real rows", async () => {
    const rows = await cachedDecisionRows(snapshot(), "testnet");
    expect(rows.map((r) => r.id)).toEqual(["seq-4", "seq-2", "seq-0"]);
  });
});
