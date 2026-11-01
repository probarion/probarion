import { describe, expect, it } from "vitest";
import {
  addTx,
  emptyProof,
  serializeProof,
  setValue,
  type TxEntry,
  validateProof,
} from "../lib/proof.js";

const NOW = new Date("2026-11-04T10:00:00.000Z");
const HASH = "8qkFz1q7mJpQd9wZ3yX4hT6uV2bN5cR1sE7gK3aL9mP";
const HASH2 = "5Rk2nWdQ8vYbT3gH7jL4mN9pS6uX1zA2cE5fG8hJ3kM";

const tx = (over: Partial<Omit<TxEntry, "recorded_at">> = {}): Omit<TxEntry, "recorded_at"> => ({
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
  ...over,
});

describe("mainnet-proof.json", () => {
  it("an empty proof file is valid", () => {
    expect(validateProof(emptyProof(NOW))).toEqual([]);
  });

  it("addTx records a valid entry and stamps recorded_at", () => {
    const p = addTx(emptyProof(NOW), "first_near_payment", tx(), NOW);
    expect(p.txs.first_near_payment?.recorded_at).toBe("2026-11-04T10:00:00.000Z");
    expect(validateProof(p)).toEqual([]);
  });

  it("addTx never overwrites and never records the same hash twice", () => {
    const p = addTx(emptyProof(NOW), "first_near_payment", tx(), NOW);
    expect(() => addTx(p, "first_near_payment", tx({ hash: HASH2 }), NOW)).toThrow(
      /already exists/,
    );
    expect(() => addTx(p, "again", tx(), NOW)).toThrow(
      /already recorded as txs.first_near_payment/,
    );
  });

  it("addTx rejects a bad hash, an unknown kind and a bad account", () => {
    const p = emptyProof(NOW);
    expect(() => addTx(p, "x_one", tx({ hash: "0xdeadbeef" }), NOW)).toThrow(/base58 NEAR tx hash/);
    expect(() => addTx(p, "x_two", tx({ kind: "teleport" as never }), NOW)).toThrow(
      /kind must be one of/,
    );
    expect(() => addTx(p, "x_three", tx({ signer_id: "Not An Account" }), NOW)).toThrow(
      /signer_id must be a NEAR account id/,
    );
  });

  it("an expected failure needs an error code, an expected success must not have one", () => {
    const p = emptyProof(NOW);
    expect(() => addTx(p, "refused", tx({ expect: "failure", error_code: null }), NOW)).toThrow(
      /error_code is required/,
    );
    expect(() => addTx(p, "paid", tx({ error_code: "NoMandate" }), NOW)).toThrow(
      /must be null for an expected success/,
    );
    const ok = addTx(
      p,
      "refused_no_mandate",
      tx({
        expect: "failure",
        error_code: "NoMandate",
        kind: "refused_on_chain",
        spend_id: null,
        amount_usdc: null,
      }),
      NOW,
    );
    expect(validateProof(ok)).toEqual([]);
  });

  it("setValue validates by section and records the source", () => {
    let p = setValue(
      emptyProof(NOW),
      "accounts.factory",
      "vaults.probarion.near",
      "plan 02 Day 7 deploy",
      NOW,
    );
    p = setValue(p, "metrics.external_owners", 0, "pnpm count:external", NOW);
    expect(p.accounts.factory).toBe("vaults.probarion.near");
    expect(p.metrics.external_owners).toBe(0);
    expect(p.sources["metrics.external_owners"]).toBe("pnpm count:external");
    expect(() => setValue(p, "accounts.demo_vault", "Demo Vault", "x", NOW)).toThrow(
      /NEAR account id/,
    );
    expect(() => setValue(p, "links.status_page", "http://insecure.example", "x", NOW)).toThrow(
      /https URL/,
    );
    expect(() => setValue(p, "metrics.nan", Number.NaN, "x", NOW)).toThrow(/finite number/);
  });

  it("setValue refuses an empty source, unknown sections and nested paths", () => {
    const p = emptyProof(NOW);
    expect(() => setValue(p, "metrics.n", 1, "  ", NOW)).toThrow(/source is required/);
    expect(() => setValue(p, "secrets.k", "v", "x", NOW)).toThrow(/section must be one of/);
    expect(() => setValue(p, "metrics.a.b", 1, "x", NOW)).toThrow(/<section>.<key>/);
  });

  it("serialization is stable: sorted keys and a trailing newline", () => {
    const a = serializeProof(addTx(emptyProof(NOW), "b_tx", tx(), NOW));
    expect(a.endsWith("}\n")).toBe(true);
    expect(a.indexOf('"accounts"')).toBeLessThan(a.indexOf('"txs"'));
    expect(serializeProof(JSON.parse(a))).toBe(a);
  });

  it("validateProof reports a hash used twice", () => {
    const p = addTx(emptyProof(NOW), "one_tx", tx(), NOW);
    const broken = { ...p, txs: { ...p.txs, two_tx: { ...p.txs.one_tx } } };
    expect(validateProof(broken).join("\n")).toMatch(/duplicates txs.one_tx.hash/);
  });
});
