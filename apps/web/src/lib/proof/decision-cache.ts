import type { Snapshot } from "@probarion/core";
import type { Network } from "@/lib/config";
import { type DecisionRow, decisionRows } from "./decisions";

// The decision rows of /proof, built once per snapshot object. loadProof caches its result for 60 s and hands each
// visitor of that window the very same snapshot object, so keying on it builds the rows (A1 to A7 for each decision:
// a signature recovery, a sha256 of the response and a TDX parse) once per gather, as the report is, instead of once
// per page view. A WeakMap lets a snapshot that left the proof cache go with its rows.

const built = new WeakMap<object, Partial<Record<Network, Promise<DecisionRow[]>>>>();

/**
 * `decisionRows(snapshot, network)`, shared by every caller with the same snapshot object and network. A build that
 * fails is forgotten, so the next view tries again. `build` is for tests.
 */
export function cachedDecisionRows(
  snapshot: Snapshot,
  network: Network,
  build: (snapshot: Snapshot, network: Network) => Promise<DecisionRow[]> = decisionRows,
): Promise<DecisionRow[]> {
  const held = built.get(snapshot) ?? {};
  const hit = held[network];
  if (hit !== undefined) return hit;
  let rows: Promise<DecisionRow[]>;
  try {
    rows = build(snapshot, network);
  } catch (error) {
    return Promise.reject(error);
  }
  held[network] = rows;
  built.set(snapshot, held);
  rows.catch(() => {
    if (held[network] === rows) delete held[network];
  });
  return rows;
}
