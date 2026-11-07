import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Network } from "@/lib/config";
import { describeRaw, RAW_SKIP_TEXT } from "./copy";
import { CANARY_LIMITS } from "./limits";
import { parseReplay, REPLAY } from "./replay";

describe("attack replay data", () => {
  it("keeps well-formed entries and drops the rest", () => {
    const out = parseReplay([
      {
        at: "2026-11-04T12:00:00Z",
        technique: "payee_change",
        summary: "Invoice asks for a new Base address",
        layer: "contract",
        result: "NoMandate",
        tx_hash: "AbC123",
        network: "mainnet",
      },
      {
        at: "2026-11-04T12:05:00Z",
        technique: "instruction_override",
        summary: "Ignore previous instructions",
        layer: "code",
        result: "mandate.payee_mismatch",
        tx_hash: null,
        network: "mainnet",
      },
      {
        at: "nope",
        technique: "x",
        summary: "",
        layer: "moon",
        result: "",
        tx_hash: 5,
        network: "devnet",
      },
      "garbage",
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ layer: "contract", result: "NoMandate", tx_hash: "AbC123" });
  });

  it("returns [] for anything that is not an array", () => {
    expect(parseReplay({})).toEqual([]);
  });

  it("holds only the team's own recorded runs: every transaction in it is one a deployment record names", () => {
    const record = (network: Network) =>
      readFileSync(
        fileURLToPath(
          new URL(`../../../../../contracts/deployments/${network}.json`, import.meta.url),
        ),
        "utf8",
      );
    expect(REPLAY.length).toBeGreaterThan(0);
    for (const e of REPLAY) {
      // The contract answered on chain, so its entry has a transaction; a code refusal sent nothing and has none.
      if (e.layer === "contract") expect(e.tx_hash, e.summary).not.toBeNull();
      else expect(e.tx_hash, e.summary).toBeNull();
      if (e.tx_hash !== null) expect(record(e.network), e.tx_hash).toContain(`"${e.tx_hash}"`);
    }
  });

  it("starts with the smoke run's refusal: the agent key cited a mandate that does not exist, and the contract said no", () => {
    const testnet = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../../../../contracts/deployments/testnet.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as { smoke: { no_mandate_tx: string } };
    expect(REPLAY[0]).toEqual({
      at: "2026-11-01T07:10:31Z",
      technique: "other",
      summary:
        "Our smoke test: the agent key went straight to the contract and cited mandate 999, which does not exist.",
      layer: "contract",
      result: "NoMandate",
      tx_hash: testnet.smoke.no_mandate_tx,
      network: "testnet",
    });
  });

  it("ships as a list the owner fills in, and every entry in it is well formed", () => {
    const raw = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../content/attack-replay.json", import.meta.url)),
        "utf8",
      ),
    ) as unknown;
    expect(Array.isArray(raw)).toBe(true);
    // The loader drops a malformed entry silently, so a typo in the file would hide a recorded attack: none may be dropped.
    expect(REPLAY).toHaveLength((raw as unknown[]).length);
  });
});

describe("raw-mode copy", () => {
  it("explains every skip reason and shows contract refusals as good news", () => {
    for (const k of Object.keys(RAW_SKIP_TEXT)) {
      expect(RAW_SKIP_TEXT[k as keyof typeof RAW_SKIP_TEXT].length).toBeGreaterThan(10);
    }
    expect(
      describeRaw({ sent: true, status: "refused_by_contract", code: "NoMandate", txHash: "T" }),
    ).toMatchObject({ tone: "good" });
    expect(describeRaw({ sent: true, status: "held", code: null, txHash: "T" }).text).toMatch(
      /mandated payee/,
    );
    expect(describeRaw({ sent: false, skipped: "visitor_limit" }).text).toBe(
      RAW_SKIP_TEXT.visitor_limit,
    );
  });

  it("has a text for each of the 13 RawSkip reasons in limits.ts, and for nothing else", () => {
    const source = readFileSync(fileURLToPath(new URL("./limits.ts", import.meta.url)), "utf8");
    const union = /export type RawSkip =([\s\S]*?);/.exec(source)?.[1] ?? "";
    const reasons = [...union.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(reasons).toHaveLength(13);
    expect(Object.keys(RAW_SKIP_TEXT).sort()).toEqual(reasons);
  });

  it("builds the limits it quotes from CANARY_LIMITS, not from literals", () => {
    expect(RAW_SKIP_TEXT.visitor_limit).toContain(
      `${CANARY_LIMITS.rawVisitorWindowS / 60} minutes`,
    );
    expect(RAW_SKIP_TEXT.global_limit).toContain(String(CANARY_LIMITS.rawGlobalPerHour));
  });
});
