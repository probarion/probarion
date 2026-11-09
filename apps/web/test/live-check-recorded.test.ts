// The answers the landing page shows with no JavaScript or no RPC, held to the deployment record and to what the
// contract really answers for each scenario. If the vault's answers change, re-run `record-live-check`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LIVE_VAULT,
  MANDATE_IDS,
  OTHER_PK,
  parseMandate,
  parseVerdict,
  type RecordedFile,
  SCENARIO_INPUTS,
} from "@/lib/site/live-check";
import recordedJson from "@/lib/site/live-check-recorded.json";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..", "..");
const recorded = recordedJson as unknown as RecordedFile;
const deployment = JSON.parse(
  readFileSync(join(ROOT, "contracts", "deployments", "testnet.json"), "utf8"),
) as { accounts: { vault_v0: string } };

describe("the recorded live-check answers", () => {
  it("are from the vault the deployment record names", () => {
    expect(LIVE_VAULT).toBe(deployment.accounts.vault_v0);
    expect(recorded.vault).toBe(LIVE_VAULT);
  });

  it("give each scenario the answer the spec expects", () => {
    const want = {
      normal: { ok: true, code: null },
      hijack: { ok: false, code: "OverPerPayment" },
      nomandate: { ok: false, code: "NoMandate" },
      otherkey: { ok: false, code: "NotAgent" },
    } as const;
    for (const s of SCENARIO_INPUTS) {
      expect(parseVerdict(recorded.answers[s.id].value), s.id).toMatchObject(want[s.id]);
    }
  });

  it("hold a readable view of every mandate the select offers, and none for 999", () => {
    for (const id of MANDATE_IDS)
      expect(() => parseMandate(recorded.mandates[String(id)])).not.toThrow();
    expect(recorded.mandates["999"]).toBeNull();
  });

  it("take the agent key from mandate 1, and the vault lets that key call spend and nothing else", () => {
    const m = parseMandate(recorded.mandates["1"]);
    expect(m).not.toBeNull();
    const key = recorded.accessKeys.find((k) => k.public_key === m?.agentPk);
    expect(key?.access_key.permission).toEqual({
      FunctionCall: expect.objectContaining({ method_names: ["spend"], receiver_id: LIVE_VAULT }),
    });
    expect(recorded.accessKeys.every((k) => k.access_key.permission !== "FullAccess")).toBe(true);
  });

  it("use an other key that is no key of the vault", () => {
    expect(recorded.accessKeys.map((k) => k.public_key)).not.toContain(OTHER_PK);
  });

  it("are dated, at a block height", () => {
    expect(Number.isNaN(Date.parse(recorded.recordedAt))).toBe(false);
    expect(recorded.blockHeight).toBeGreaterThan(0);
  });
});
