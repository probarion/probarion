import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../proof.js";

const NOW = new Date("2026-11-04T10:00:00.000Z");

describe("pnpm proof", () => {
  it("init, add-tx, set and show work on a fresh file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "proof-")), "mainnet-proof.json");
    expect(main(["init"], NOW, path)).toBe(0);
    expect(main(["init"], NOW, path)).toBe(1);
    expect(
      main(
        [
          "add-tx",
          "--id",
          "first_near_payment",
          "--hash",
          "8qkFz1q7mJpQd9wZ3yX4hT6uV2bN5cR1sE7gK3aL9mP",
          "--signer",
          "v0.probarion.near",
          "--receiver",
          "v0.probarion.near",
          "--kind",
          "near_payment",
          "--signed-by",
          "agent_key",
          "--what",
          "First NEAR payment",
          "--spend-id",
          "1",
          "--amount",
          "2.00",
        ],
        NOW,
        path,
      ),
    ).toBe(0);
    expect(
      main(
        [
          "set",
          "metrics.external_owners",
          "2",
          "--type",
          "number",
          "--source",
          "pnpm count:external",
        ],
        NOW,
        path,
      ),
    ).toBe(0);
    expect(main(["show"], NOW, path)).toBe(0);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.txs.first_near_payment.spend_id).toBe(1);
    expect(saved.metrics.external_owners).toBe(2);
  });
  it("exits 2 with usage when required flags are missing", () => {
    const path = join(mkdtempSync(join(tmpdir(), "proof-")), "mainnet-proof.json");
    main(["init"], NOW, path);
    expect(main(["add-tx", "--id", "x_tx"], NOW, path)).toBe(2);
    expect(main(["set", "metrics.n", "1"], NOW, path)).toBe(2);
    expect(main(["bogus"], NOW, path)).toBe(2);
  });
});
