import type { MandateView } from "@probarion/core";
import { NETWORKS } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { actionKey } from "@/lib/near/lock";
import { createMandateTx } from "@/lib/near/tx";
import {
  approvalSummary,
  asMandateForm,
  backstopWarning,
  buildMandateInput,
  CHANGED_SINCE_REVIEW,
  checkPrepared,
  describeErrors,
  expiryText,
  floatFor,
  floatWarning,
  LABEL_MAX_BYTES,
  MAX_EXPIRY_AHEAD_MS,
  MAX_USES_BETA,
  type MandateContext,
  type MandateForm,
  mandateState,
  payeeView,
  purposeShort,
  remainingUnits,
  safeChainText,
  tryUsdcUnits,
  usdcText,
} from "./mandates";

// Every contract boundary below is read from contracts/vault/src/validate.rs and mandates.rs
// (`validate_mandate`): purpose_hash is 64 lowercase hex, 0 < max_per_payment <= max_total, max_uses > 0,
// expires_at_ns > block_timestamp, label <= 64 bytes, an Intents payee needs an allow-listed asset whose
// prefix names its chain and `0x` + 40 hex, and a NEAR payee must not be the vault itself. Where this
// builder is stricter than the contract, the test says so.

const BASE_ASSET = NETWORKS.mainnet.allowedAssets.base;
const SOL_ASSET = NETWORKS.mainnet.allowedAssets.solana;
const AGENT = `ed25519:${"3".repeat(44)}`;
const OTHER_AGENT = `ed25519:${"4".repeat(44)}`;
const U128_MAX = 2n ** 128n - 1n;
const NOW = new Date("2026-11-08T00:00:00Z");
const ctx: MandateContext = {
  now: NOW,
  vault: "acme.vaults.probarion.near",
  baseAsset: BASE_ASSET,
  allowedAssets: [BASE_ASSET],
  agentKeys: [AGENT],
};
const form: MandateForm = {
  payeeKind: "near",
  payee: "designer.near",
  purposeHash: "AB".repeat(32),
  maxPerPaymentUsdc: "100",
  maxTotalUsdc: "1000",
  maxUses: "10",
  expiresOn: "2026-12-31",
  approvalAboveUsdc: "100",
  agentPk: AGENT,
  label: "Acme Design retainer",
};
const check = (f: Partial<MandateForm>, c: Partial<MandateContext> = {}) =>
  buildMandateInput({ ...form, ...f }, { ...ctx, ...c });
const errorsOf = (f: Partial<MandateForm>, c: Partial<MandateContext> = {}) => {
  const r = check(f, c);
  return r.ok ? {} : r.errors;
};
const inputOf = (f: Partial<MandateForm>, c: Partial<MandateContext> = {}) => {
  const r = check(f, c);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);
  return r.input;
};
/** The human USDC text for a base-unit count (6 decimals), built here so the test does not use the code under test. */
const human = (units: bigint) =>
  `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0")}`;
const endOfDayNs = (y: number, m: number, d: number) =>
  String(BigInt(Date.UTC(y, m - 1, d, 23, 59, 59)) * 1_000_000n);

describe("buildMandateInput: what it builds", () => {
  it("builds a NEAR-payee mandate in smallest units", () => {
    expect(check({})).toEqual({
      ok: true,
      input: {
        payee: { type: "near", account_id: "designer.near" },
        purpose_hash: "ab".repeat(32),
        max_per_payment: "100000000",
        max_total: "1000000000",
        max_uses: 10,
        expires_at_ns: endOfDayNs(2026, 12, 31),
        approval_above: "100000000",
        agent_pk: AGENT,
        label: "Acme Design retainer",
      },
    });
  });

  it("builds a Base payee through Intents: the allow-listed POA asset, the EIP-55 address", () => {
    const input = inputOf({
      payeeKind: "base",
      payee: "0x52908400098527886e0f7030069857d2e4169ee7",
    });
    expect(input.payee).toEqual({
      type: "intents",
      chain: "base",
      address: "0x52908400098527886E0F7030069857D2E4169EE7",
      asset: BASE_ASSET,
    });
    // exactly the four keys of the contract's Payee::Intents, nothing from the form
    expect(Object.keys(input.payee).sort()).toEqual(["address", "asset", "chain", "type"]);
  });

  it("sends exactly the contract's nine MandateInput fields", () => {
    expect(Object.keys(inputOf({})).sort()).toEqual(
      [
        "agent_pk",
        "approval_above",
        "expires_at_ns",
        "label",
        "max_per_payment",
        "max_total",
        "max_uses",
        "payee",
        "purpose_hash",
      ].sort(),
    );
  });

  it("trims every text field before it is sent, so what the owner sees is what the contract stores", () => {
    const input = inputOf({
      payee: "  designer.near\n",
      purposeHash: ` ${"cd".repeat(32)} `,
      label: "  Acme  ",
      maxUses: " 7 ",
      maxPerPaymentUsdc: " 12.5 ",
    });
    expect(input.payee).toEqual({ type: "near", account_id: "designer.near" });
    expect(input.purpose_hash).toBe("cd".repeat(32));
    expect(input.label).toBe("Acme");
    expect(input.max_uses).toBe(7);
    expect(input.max_per_payment).toBe("12500000");
  });

  it("does not change its inputs", () => {
    const f = { ...form };
    const c = { ...ctx, allowedAssets: [...ctx.allowedAssets], agentKeys: [...ctx.agentKeys] };
    buildMandateInput(f, c);
    expect(f).toEqual(form);
    expect(c.allowedAssets).toEqual([BASE_ASSET]);
  });
});

// The brief's rejection table (Review Focus #4).
describe("buildMandateInput: rejections", () => {
  it.each<[Partial<MandateForm>, keyof MandateForm]>([
    [{ payeeKind: "base", payee: "0x52908400098527886e0F7030069857D2E4169EE7" }, "payee"], // bad checksum
    [{ payeeKind: "base", payee: "acme.eth" }, "payee"],
    [{ payee: "Designer.near" }, "payee"],
    [{ payee: "acme.vaults.probarion.near" }, "payee"], // the vault itself
    [{ maxPerPaymentUsdc: "1e3" }, "maxPerPaymentUsdc"],
    [{ maxPerPaymentUsdc: "0.0000001" }, "maxPerPaymentUsdc"],
    [{ maxPerPaymentUsdc: "2000" }, "maxPerPaymentUsdc"],
    [{ maxTotalUsdc: "0" }, "maxTotalUsdc"],
    [{ maxUses: "0" }, "maxUses"],
    [{ maxUses: "2.5" }, "maxUses"],
    [{ expiresOn: "2026-11-01" }, "expiresOn"],
    [{ expiresOn: "2028-01-01" }, "expiresOn"],
    [{ approvalAboveUsdc: "-1" }, "approvalAboveUsdc"],
    [{ agentPk: "ed25519:notmine" }, "agentPk"],
    [{ label: "é".repeat(33) }, "label"],
    [{ label: "  " }, "label"],
    [{ purposeHash: "xyz" }, "purposeHash"],
  ])("rejects %j on %s", (f, field) => {
    expect(errorsOf(f)[field]).toBeTruthy();
  });

  it("rejects a Base payee when the vault does not allow the Base POA asset", () => {
    expect(
      errorsOf(
        { payeeKind: "base", payee: "0x52908400098527886E0F7030069857D2E4169EE7" },
        { allowedAssets: [] },
      ).payee,
    ).toMatch(/allow/);
  });

  it("names a field only when it is wrong: a valid form has no errors, a bad one lists every bad field", () => {
    expect(check({}).ok).toBe(true);
    const r = check({ payee: "X", maxUses: "0", label: "", purposeHash: "" });
    expect(r.ok).toBe(false);
    expect(Object.keys(r.ok ? {} : r.errors).sort()).toEqual([
      "label",
      "maxUses",
      "payee",
      "purposeHash",
    ]);
  });

  it("refuses a payee kind it does not know, whatever the payee text is", () => {
    for (const kind of ["", "solana", "evm", "NEAR"]) {
      const e = errorsOf({ payeeKind: kind as MandateForm["payeeKind"], payee: "designer.near" });
      expect(e.payeeKind, kind).toBeTruthy();
    }
  });
});

describe("payee: NEAR account", () => {
  it.each([
    "ab", // the shortest the grammar allows
    "alice.near",
    "a1_b-c.near",
    `${"x".repeat(61)}.ab`, // 64 characters
    "0".repeat(64), // a 64-hex implicit account
    `0x${"ab".repeat(20)}`, // an EVM implicit account
    "pay.acme.vaults.probarion.near", // a sub-account of the vault is not the vault
  ])("accepts %s", (payee) => {
    expect(inputOf({ payee }).payee).toEqual({ type: "near", account_id: payee });
  });

  it.each([
    ["one character", "a"],
    ["65 characters", `${"x".repeat(62)}.ab`],
    ["an upper-case letter", "Alice.near"],
    ["two dots in a row", "alice..near"],
    ["a leading dash", "-alice.near"],
    ["a trailing dot", "alice.near."],
    ["a doubled separator", "a-_b.near"],
    ["a space inside", "al ice.near"],
    ["an at sign", "alice@near"],
    ["a non-ASCII letter", "ålice.near"],
    ["an empty text", ""],
    ["an EVM address with a checksum", "0x52908400098527886E0F7030069857D2E4169EE7"],
  ])("rejects %s", (_why, payee) => {
    expect(errorsOf({ payee }).payee).toBeTruthy();
  });

  it("refuses the vault itself, also when typed with spaces (the contract refuses it too)", () => {
    expect(errorsOf({ payee: ctx.vault }).payee).toMatch(/itself/);
    expect(errorsOf({ payee: `  ${ctx.vault} ` }).payee).toMatch(/itself/);
  });

  it("does not need the Base asset to be allowed", () => {
    expect(check({}, { allowedAssets: [] }).ok).toBe(true);
  });
});

describe("payee: Base address through NEAR Intents", () => {
  const CHECKSUMMED = "0x52908400098527886E0F7030069857D2E4169EE7";
  const base = (payee: string, c: Partial<MandateContext> = {}) =>
    check({ payeeKind: "base", payee }, c);

  it("sends the EIP-55 form whatever case was typed (the contract stores any case as written)", () => {
    for (const typed of [
      CHECKSUMMED,
      CHECKSUMMED.toLowerCase(),
      `0x${CHECKSUMMED.slice(2).toUpperCase()}`,
    ]) {
      const r = base(typed);
      expect(r.ok && r.input.payee).toMatchObject({ address: CHECKSUMMED });
    }
  });

  it("accepts an all-capitals address written without a checksum, and sends its EIP-55 form", () => {
    const allCaps = `0x${"AB".repeat(20)}`;
    const r = base(allCaps);
    expect(r.ok && r.input.payee).toMatchObject({ type: "intents" });
    const sent = r.ok && r.input.payee.type === "intents" ? r.input.payee.address : "";
    expect(sent).not.toBe(allCaps);
    expect(sent.toLowerCase()).toBe(allCaps.toLowerCase());
  });

  it.each([
    ["a bad checksum", "0x52908400098527886e0F7030069857D2E4169EE7"],
    ["the zero address", `0x${"0".repeat(40)}`],
    ["39 digits", `0x${"1".repeat(39)}`],
    ["41 digits", `0x${"1".repeat(41)}`],
    ["an upper-case 0X", `0X${"1".repeat(40)}`],
    ["a non-hex digit", `0x${"1".repeat(39)}g`],
    ["a NEAR account", "designer.near"],
    ["an ENS name", "acme.eth"],
    ["a Solana address", "7".repeat(32)],
  ])("rejects %s", (_why, payee) => {
    const r = base(payee);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.errors.payee).toBeTruthy();
  });

  it("needs the vault to allow the Base asset", () => {
    expect(
      (base(CHECKSUMMED, { allowedAssets: [] }) as { errors: { payee: string } }).errors.payee,
    ).toMatch(/allow/);
    expect(base(CHECKSUMMED, { allowedAssets: [SOL_ASSET] }).ok).toBe(false);
    expect(base(CHECKSUMMED, { allowedAssets: [BASE_ASSET, SOL_ASSET] }).ok).toBe(true);
  });

  it("needs an asset whose prefix names Base, even when the vault allows it (asset_matches_chain)", () => {
    const r = base(CHECKSUMMED, { baseAsset: SOL_ASSET, allowedAssets: [SOL_ASSET] });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.errors.payee).toMatch(/Base/);
  });

  it("is not the vault's own concern which NEAR account the address looks like", () => {
    // 40 hex digits behind 0x is a valid NEAR implicit account too, but a Base payee is never read as one
    const r = base(`0x${"ab".repeat(20)}`);
    expect(r.ok && r.input.payee.type).toBe("intents");
  });
});

describe("amounts", () => {
  it("accepts one base unit, the smallest the contract allows (max_per_payment > 0)", () => {
    const i = inputOf({
      maxPerPaymentUsdc: "0.000001",
      maxTotalUsdc: "0.000001",
      approvalAboveUsdc: "0",
    });
    expect([i.max_per_payment, i.max_total, i.approval_above]).toEqual(["1", "1", "0"]);
  });

  it("refuses a seventh decimal: no rounding, no truncation", () => {
    for (const f of ["maxPerPaymentUsdc", "maxTotalUsdc", "approvalAboveUsdc"] as const) {
      expect(errorsOf({ [f]: "1.0000001" })[f], f).toMatch(/6 decimal/);
    }
  });

  it("holds max_per_payment <= max_total exactly", () => {
    expect(check({ maxPerPaymentUsdc: "1000", maxTotalUsdc: "1000" }).ok).toBe(true);
    const e = errorsOf({ maxPerPaymentUsdc: "1000.000001", maxTotalUsdc: "1000" });
    expect(e.maxPerPaymentUsdc).toMatch(/exceed/);
    expect(e.maxTotalUsdc).toBeUndefined();
  });

  it("does not report a per-payment/total clash when one of the two is not an amount", () => {
    expect(errorsOf({ maxTotalUsdc: "abc" })).toEqual({ maxTotalUsdc: expect.any(String) });
    expect(errorsOf({ maxPerPaymentUsdc: "abc", maxTotalUsdc: "5" })).toEqual({
      maxPerPaymentUsdc: expect.any(String),
    });
  });

  it("holds the U128 boundary on both caps and on the approval threshold", () => {
    const max = human(U128_MAX);
    const i = inputOf({ maxPerPaymentUsdc: max, maxTotalUsdc: max, approvalAboveUsdc: max });
    expect(i.max_per_payment).toBe(U128_MAX.toString());
    expect(i.max_total).toBe(U128_MAX.toString());
    expect(i.approval_above).toBe(U128_MAX.toString());
    const over = human(U128_MAX + 1n);
    expect(errorsOf({ maxTotalUsdc: over }).maxTotalUsdc).toMatch(/large/i);
    expect(errorsOf({ maxPerPaymentUsdc: over }).maxPerPaymentUsdc).toMatch(/large/i);
    expect(errorsOf({ approvalAboveUsdc: over }).approvalAboveUsdc).toMatch(/large/i);
  });

  it("allows an approval threshold of 0 (every payment held) and one above the per-payment cap (none held)", () => {
    expect(inputOf({ approvalAboveUsdc: "0" }).approval_above).toBe("0");
    expect(inputOf({ approvalAboveUsdc: "100.000001" }).approval_above).toBe("100000001");
  });

  it.each([
    "",
    " ",
    "1e3",
    "-1",
    "+1",
    ".5",
    "5.",
    "1,000",
    "0x10",
    "01",
    "١",
    "1 000",
    "NaN",
    "Infinity",
  ])("refuses %j as an amount in every amount field", (text) => {
    const e = errorsOf({ maxPerPaymentUsdc: text, maxTotalUsdc: text, approvalAboveUsdc: text });
    expect(e.maxPerPaymentUsdc).toBeTruthy();
    expect(e.maxTotalUsdc).toBeTruthy();
    expect(e.approvalAboveUsdc).toBeTruthy();
  });

  it("refuses a zero cap with its own message", () => {
    expect(errorsOf({ maxPerPaymentUsdc: "0" }).maxPerPaymentUsdc).toMatch(/above 0/);
    expect(errorsOf({ maxTotalUsdc: "0.000000" }).maxTotalUsdc).toMatch(/above 0/);
  });
});

describe("max_uses", () => {
  it("accepts 1 up to the beta limit, and the limit is far below the contract's u32", () => {
    expect(inputOf({ maxUses: "1" }).max_uses).toBe(1);
    expect(inputOf({ maxUses: String(MAX_USES_BETA) }).max_uses).toBe(MAX_USES_BETA);
    expect(MAX_USES_BETA).toBeLessThan(2 ** 32 - 1); // nothing the form allows can overflow the contract's u32
  });

  it.each([
    "0",
    String(MAX_USES_BETA + 1),
    "4294967295",
    "4294967296",
    "99999999999999999999",
    "-1",
    "2.5",
    "1e2",
    "",
    "ten",
    "05",
    "+5",
    "٣",
  ])("refuses %j", (maxUses) => {
    expect(errorsOf({ maxUses }).maxUses).toBeTruthy();
  });

  it("sends a JSON number, not text", () => {
    expect(typeof inputOf({}).max_uses).toBe("number");
  });
});

describe("expires_at_ns", () => {
  const at = (iso: string) => ({ now: new Date(iso) });

  it("is the last second of the chosen UTC day, in nanoseconds", () => {
    expect(inputOf({ expiresOn: "2026-11-09" }).expires_at_ns).toBe(endOfDayNs(2026, 11, 9));
  });

  it("must be strictly after now (the contract: expires_at_ns > block_timestamp)", () => {
    // today's date: ends at 23:59:59 UTC
    expect(check({ expiresOn: "2026-11-08" }, at("2026-11-08T23:59:58.999Z")).ok).toBe(true);
    expect(errorsOf({ expiresOn: "2026-11-08" }, at("2026-11-08T23:59:59.000Z")).expiresOn).toMatch(
      /future/,
    );
    expect(errorsOf({ expiresOn: "2026-11-08" }, at("2026-11-08T23:59:59.001Z")).expiresOn).toMatch(
      /future/,
    );
    expect(errorsOf({ expiresOn: "2026-11-07" }).expiresOn).toMatch(/future/);
    expect(errorsOf({ expiresOn: "1970-01-01" }).expiresOn).toBeTruthy();
  });

  it("is at most 366 days ahead during the beta (a product limit, not the contract's)", () => {
    expect(MAX_EXPIRY_AHEAD_MS).toBe(366 * 24 * 3600_000);
    // now is 2026-11-08T00:00Z: 2027-11-08 23:59:59 is 365 days and 23:59:59 ahead, 2027-11-09 23:59:59 is past 366 days
    expect(check({ expiresOn: "2027-11-08" }).ok).toBe(true);
    expect(errorsOf({ expiresOn: "2027-11-09" }).expiresOn).toMatch(/year/);
    expect(errorsOf({ expiresOn: "9999-12-31" }).expiresOn).toMatch(/year/);
  });

  it.each([
    "",
    "soon",
    "2026-13-01",
    "2026-02-30",
    "2026-00-10",
    "26-12-31",
    "2026-12-31T00:00:00Z",
    "2026/12/31",
    "0099-12-31",
  ])("refuses %j", (expiresOn) => {
    expect(errorsOf({ expiresOn }).expiresOn).toBeTruthy();
  });

  it("holds the contract's U64 boundary on expires_at_ns (2^64 ns is the year 2554)", () => {
    // far in the future the beta limit is still met, so only the U64 rule can refuse it
    const e = errorsOf({ expiresOn: "2600-06-01" }, at("2600-01-01T00:00:00Z"));
    expect(e.expiresOn).toMatch(/far/);
    const ok = inputOf({ expiresOn: "2554-01-01" }, at("2553-06-01T00:00:00Z"));
    expect(BigInt(ok.expires_at_ns)).toBeLessThanOrEqual(2n ** 64n - 1n);
  });

  it("accepts a leap day only in a leap year", () => {
    expect(check({ expiresOn: "2028-02-29" }, at("2028-01-01T00:00:00Z")).ok).toBe(true);
    expect(errorsOf({ expiresOn: "2027-02-29" }, at("2027-01-01T00:00:00Z")).expiresOn).toMatch(
      /real date/,
    );
  });
});

describe("label", () => {
  it("holds the 64-byte limit exactly (the contract counts bytes of what it receives)", () => {
    expect(LABEL_MAX_BYTES).toBe(64);
    expect(check({ label: "x".repeat(64) }).ok).toBe(true);
    expect(errorsOf({ label: "x".repeat(65) }).label).toBeTruthy();
    expect(check({ label: "é".repeat(32) }).ok).toBe(true); // 2 bytes each: 64
    expect(errorsOf({ label: "é".repeat(33) }).label).toBeTruthy(); // 66
    expect(check({ label: "😀".repeat(16) }).ok).toBe(true); // 4 bytes each: 64
    expect(errorsOf({ label: "😀".repeat(17) }).label).toBeTruthy(); // 68
    expect(check({ label: `${"a".repeat(63)}é` }).ok).toBe(false); // 65 bytes
  });

  it("counts the trimmed text, which is what is sent", () => {
    expect(check({ label: ` ${"x".repeat(64)} ` }).ok).toBe(true);
  });

  it("needs a name (stricter than the contract, which stores an empty label)", () => {
    expect(errorsOf({ label: "" }).label).toMatch(/name/);
    expect(errorsOf({ label: " \t " }).label).toMatch(/name/);
  });

  it.each([
    ["a new line", "Acme\nDesign"],
    ["a null character", "Acme\u0000Design"],
    ["a right-to-left override", "Acme ‮gnisid"],
    ["a zero-width space", "Acme​Design"],
    ["a lone surrogate, which no JSON string can carry", "Acme\uD800"],
  ])("refuses %s (the label is shown back to people and to the model)", (_why, label) => {
    expect(errorsOf({ label }).label).toMatch(/plain/);
  });

  it("allows ordinary text in any script", () => {
    for (const label of [
      "Acme Design retainer #2",
      "Công ty Acme",
      "設計 / retainer",
      "R&D <2026>",
    ]) {
      expect(check({ label }).ok, label).toBe(true);
    }
  });
});

describe("purpose_hash", () => {
  it("is sent as 64 lowercase hex, whatever case the owner pasted", () => {
    expect(inputOf({ purposeHash: "AbCdEf01".repeat(8) }).purpose_hash).toBe("abcdef01".repeat(8));
  });

  it.each([
    ["63 characters", "a".repeat(63)],
    ["65 characters", "a".repeat(65)],
    ["a non-hex digit", `${"a".repeat(63)}g`],
    ["a 0x prefix (a sha256 is bare hex)", `0x${"a".repeat(64)}`],
    ["a space inside", `${"a".repeat(32)} ${"a".repeat(31)}`],
    ["empty", ""],
    ["a full-width digit", `${"a".repeat(63)}１`],
  ])("refuses %s", (_why, purposeHash) => {
    expect(errorsOf({ purposeHash }).purposeHash).toBeTruthy();
  });
});

describe("agent_pk", () => {
  it("must be one of the vault's active agent keys, exactly", () => {
    expect(check({ agentPk: AGENT }).ok).toBe(true);
    expect(check({ agentPk: OTHER_AGENT }, { agentKeys: [AGENT, OTHER_AGENT] }).ok).toBe(true);
    expect(errorsOf({ agentPk: OTHER_AGENT }).agentPk).toBeTruthy();
    expect(errorsOf({ agentPk: ` ${AGENT}` }).agentPk).toBeTruthy();
    expect(errorsOf({ agentPk: AGENT.toUpperCase() }).agentPk).toBeTruthy();
    expect(errorsOf({ agentPk: "" }).agentPk).toBeTruthy();
    expect(errorsOf({ agentPk: AGENT }, { agentKeys: [] }).agentPk).toBeTruthy();
  });
});

describe("asMandateForm (what the server takes from the browser)", () => {
  it("keeps exactly the ten fields, as text, and drops everything else", () => {
    const out = asMandateForm({
      ...form,
      vault: "mallory.vaults.probarion.near",
      tenant_id: "t",
      deposit: "1",
      owner: "mallory.near",
    });
    expect(out).toEqual(form);
    expect(Object.keys(out).sort()).toEqual(Object.keys(form).sort());
  });

  it("turns a field of another type into empty text, so the builder refuses it", () => {
    const out = asMandateForm({ ...form, payee: 5, maxUses: 10, label: { a: 1 }, agentPk: null });
    expect(out.payee).toBe("");
    expect(out.maxUses).toBe("");
    expect(out.label).toBe("");
    const r = buildMandateInput(out, ctx);
    expect(r.ok).toBe(false);
  });

  it("cuts a field at 1,000 characters", () => {
    expect(asMandateForm({ ...form, label: "x".repeat(5000) }).label).toHaveLength(1000);
  });

  it("keeps an unknown payee kind unknown rather than turning it into NEAR", () => {
    const out = asMandateForm({
      ...form,
      payeeKind: "evm",
      payee: "0x52908400098527886E0F7030069857D2E4169EE7",
    });
    const r = buildMandateInput(out, ctx);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.errors.payeeKind).toBeTruthy();
  });

  it("is safe on a value that is not an object at all", () => {
    for (const bad of [null, undefined, 5, "x", []]) {
      expect(buildMandateInput(asMandateForm(bad), ctx).ok).toBe(false);
    }
  });
});

describe("describeErrors", () => {
  it("names each field in words, not by its code", () => {
    const text = describeErrors({ maxUses: "Whole number", agentPk: "Pick one" });
    expect(text).toContain("Max number of payments: Whole number");
    expect(text).toContain("Agent key: Pick one");
    expect(text).not.toContain("maxUses");
  });
});

describe("approvalSummary", () => {
  const sum = (approval: string, per = "100") =>
    approvalSummary(
      inputOf({ approvalAboveUsdc: approval, maxPerPaymentUsdc: per, maxTotalUsdc: "1000" }),
    );
  it("says what the threshold does, as the contract applies it (a payment is held when amount > approval_above)", () => {
    expect(sum("0")).toMatch(/every payment/i);
    expect(sum("40")).toMatch(/above 40 USDC/);
    expect(sum("100")).toMatch(/no payment/i); // equal to the cap: nothing is above it
    expect(sum("250")).toMatch(/no payment/i);
  });
});

describe("R3: the float warning", () => {
  const units = (usdc: string) => String(BigInt(usdc) * 1_000_000n);
  const ok = (usdc: string) => ({ ok: true as const, units: units(usdc) });

  it("warns, without blocking, when the cap is above what the vault holds, naming both figures", () => {
    const w = floatWarning({
      payeeKind: "near",
      maxPerPaymentUnits: units("100"),
      float: ok("25"),
    });
    expect(w).toContain("100 USDC");
    expect(w).toContain("25 USDC");
    expect(w).toMatch(/USDC on NEAR/);
  });

  it("says Base USDC in Intents for a Base payee", () => {
    expect(
      floatWarning({ payeeKind: "base", maxPerPaymentUnits: units("100"), float: ok("25") }),
    ).toMatch(/Intents/);
  });

  it("is quiet at the boundary and below it", () => {
    expect(
      floatWarning({ payeeKind: "near", maxPerPaymentUnits: units("25"), float: ok("25") }),
    ).toBeNull();
    expect(
      floatWarning({ payeeKind: "near", maxPerPaymentUnits: "1", float: ok("25") }),
    ).toBeNull();
    expect(
      floatWarning({
        payeeKind: "near",
        maxPerPaymentUnits: String(BigInt(units("25")) + 1n),
        float: ok("25"),
      }),
    ).not.toBeNull();
  });

  it("an empty vault is an empty vault: a cap above 0 warns, and the text says 0 because the balance was read", () => {
    const w = floatWarning({ payeeKind: "near", maxPerPaymentUnits: units("1"), float: ok("0") });
    expect(w).toContain("0 USDC");
  });

  it("says 'balance unavailable' and never a zero when the balance could not be read", () => {
    for (const kind of ["near", "base"] as const) {
      const w = floatWarning({
        payeeKind: kind,
        maxPerPaymentUnits: units("100"),
        float: { ok: false },
      });
      expect(w).toMatch(/balance unavailable/i);
      expect(w).not.toMatch(/\b0 USDC/);
    }
    // even when there is no amount to compare yet
    expect(
      floatWarning({ payeeKind: "near", maxPerPaymentUnits: null, float: { ok: false } }),
    ).toMatch(/balance unavailable/i);
  });

  it("treats a balance that is not a decimal as unavailable, not as zero", () => {
    for (const bad of ["", "abc", "-5", "1.5", "1e3"]) {
      const w = floatWarning({
        payeeKind: "near",
        maxPerPaymentUnits: units("1"),
        float: { ok: true, units: bad },
      });
      expect(w, bad).toMatch(/balance unavailable/i);
    }
  });

  it("has nothing to say when the cap is not an amount yet and the balance was read", () => {
    expect(
      floatWarning({ payeeKind: "near", maxPerPaymentUnits: null, float: ok("25") }),
    ).toBeNull();
  });
});

describe("tryUsdcUnits", () => {
  it("is the amount in base units while the text is a valid amount, else null", () => {
    expect(tryUsdcUnits("12.5")).toBe("12500000");
    expect(tryUsdcUnits("")).toBeNull();
    expect(tryUsdcUnits("1e3")).toBeNull();
    expect(tryUsdcUnits("-1")).toBeNull();
  });
});

describe("backstopWarning", () => {
  it("warns when the per-payment cap is above the vault's daily backstop (the contract refuses it: OverDailyBackstop)", () => {
    const w = backstopWarning("600000000", "500000000");
    expect(w).toContain("500 USDC");
    expect(w).toContain("600 USDC");
    expect(backstopWarning("500000000", "500000000")).toBeNull();
    expect(backstopWarning(null, "500000000")).toBeNull();
    expect(backstopWarning("1", "not a number")).toBeNull();
  });
});

describe("honest mandate status", () => {
  const NOW_MS = Date.parse("2026-11-08T12:00:00Z");
  const ns = (iso: string) => String(BigInt(Date.parse(iso)) * 1_000_000n);
  const st = (status: string, expires: string) =>
    mandateState({ status: status as MandateView["status"], expires_at_ns: expires }, NOW_MS);

  it("an active mandate in date can be revoked", () => {
    expect(st("active", ns("2026-12-31T23:59:59Z"))).toMatchObject({
      key: "active",
      label: "active",
      canRevoke: true,
    });
  });

  it("an expired mandate says expired and has no Revoke, even though the chain still says active", () => {
    const s = st("active", ns("2026-11-01T23:59:59Z"));
    expect(s).toMatchObject({ key: "expired", canRevoke: false });
    expect(s.label).toMatch(/expired/);
  });

  it("expires exactly when the contract stops spending: now >= expires_at_ns", () => {
    expect(st("active", String(BigInt(NOW_MS) * 1_000_000n + 1n)).key).toBe("active");
    expect(st("active", String(BigInt(NOW_MS) * 1_000_000n)).key).toBe("expired");
    expect(st("active", String(BigInt(NOW_MS) * 1_000_000n - 1n)).key).toBe("expired");
  });

  it("a revoked mandate says revoked and has no Revoke, also when it is past its date", () => {
    expect(st("revoked", ns("2026-12-31T23:59:59Z"))).toMatchObject({
      key: "revoked",
      canRevoke: false,
    });
    expect(st("revoked", ns("2026-01-01T00:00:00Z"))).toMatchObject({
      key: "revoked",
      canRevoke: false,
    });
  });

  it("an exhausted mandate in date can still be revoked (a released spend gives its use back)", () => {
    expect(st("exhausted", ns("2026-12-31T23:59:59Z"))).toMatchObject({
      key: "exhausted",
      canRevoke: true,
    });
    expect(st("exhausted", ns("2026-01-01T00:00:00Z"))).toMatchObject({
      key: "expired",
      canRevoke: false,
    });
  });

  it("offers no Revoke for a status or a time it cannot read", () => {
    expect(st("frozen", ns("2026-12-31T23:59:59Z"))).toMatchObject({
      key: "unknown",
      canRevoke: false,
    });
    expect(st("active", "tomorrow")).toMatchObject({ key: "unknown", canRevoke: false });
    expect(st("active", "-1")).toMatchObject({ key: "unknown", canRevoke: false });
    expect(st("active", "")).toMatchObject({ key: "unknown", canRevoke: false });
    expect(st("<b>x</b>".repeat(20), ns("2026-12-31T23:59:59Z")).label.length).toBeLessThanOrEqual(
      40,
    );
  });
});

describe("remaining", () => {
  it("is max_total - spent - reserved, from the chain's own figures", () => {
    expect(remainingUnits({ max_total: "1000", spent: "300", reserved: "200" })).toBe("500");
    expect(remainingUnits({ max_total: "1000", spent: "1000", reserved: "0" })).toBe("0");
  });
  it("never goes below zero and is null when a figure is not a decimal", () => {
    expect(remainingUnits({ max_total: "10", spent: "8", reserved: "8" })).toBe("0");
    expect(remainingUnits({ max_total: "10", spent: "x", reserved: "0" })).toBeNull();
    expect(remainingUnits({ max_total: "", spent: "0", reserved: "0" })).toBeNull();
  });
});

describe("text from the chain", () => {
  it("usdcText formats base units and says unreadable instead of throwing", () => {
    expect(usdcText("1500000")).toBe("1.5");
    expect(usdcText("0")).toBe("0");
    expect(usdcText("abc")).toBe("unreadable");
    expect(usdcText("-5")).toBe("unreadable");
    expect(usdcText("")).toBe("unreadable");
  });

  it("safeChainText strips controls and direction marks, and cuts the length", () => {
    expect(safeChainText("Acme‮ gnisid\nline")).not.toMatch(/[‮\n]/);
    expect(safeChainText("a\u0000b")).toBe("a�b");
    expect(safeChainText("x".repeat(500), 64)).toHaveLength(65); // 64 characters and an ellipsis
    expect(safeChainText("<script>alert(1)</script>")).toBe("<script>alert(1)</script>"); // React escapes; nothing is rewritten here
    expect(safeChainText(undefined)).toBe("unreadable");
    expect(safeChainText(42)).toBe("unreadable");
    expect(safeChainText("\uD800")).toBe("�");
  });
});

describe("payeeView (a payee read from the chain, before it is shown or linked)", () => {
  const ADDR = "0x52908400098527886E0F7030069857D2E4169EE7";
  it("a NEAR payee with a valid account id can be linked", () => {
    expect(payeeView({ type: "near", account_id: "designer.near" })).toEqual({
      kind: "near",
      account: "designer.near",
    });
  });

  it("a NEAR payee that is not an account id is shown as text and never linked", () => {
    for (const bad of [
      "../../etc",
      "a b",
      "Designer.near",
      "x/y?z=1",
      "javascript:alert(1)",
      "a".repeat(80),
    ]) {
      const v = payeeView({ type: "near", account_id: bad });
      expect(v.kind, bad).toBe("unreadable");
    }
  });

  it("a Base payee needs 0x and 40 hex; a Solana payee needs 32 to 44 base58 characters", () => {
    expect(payeeView({ type: "intents", chain: "base", address: ADDR, asset: BASE_ASSET })).toEqual(
      {
        kind: "intents",
        chain: "base",
        address: ADDR,
      },
    );
    expect(
      payeeView({ type: "intents", chain: "solana", address: "7".repeat(40), asset: SOL_ASSET }),
    ).toEqual({
      kind: "intents",
      chain: "solana",
      address: "7".repeat(40),
    });
    expect(
      payeeView({ type: "intents", chain: "base", address: "0x12", asset: BASE_ASSET }).kind,
    ).toBe("unreadable");
    expect(
      payeeView({ type: "intents", chain: "solana", address: ADDR, asset: SOL_ASSET }).kind,
    ).toBe("unreadable");
    expect(
      payeeView({ type: "intents", chain: "ethereum", address: ADDR, asset: BASE_ASSET }).kind,
    ).toBe("unreadable");
  });

  it("anything else is unreadable and its text is made safe", () => {
    for (const bad of [
      null,
      undefined,
      5,
      "x",
      [],
      {},
      { type: "wire" },
      { type: "near" },
      { type: "near", account_id: 5 },
    ]) {
      expect(payeeView(bad).kind).toBe("unreadable");
    }
    const v = payeeView({ type: "near", account_id: "evil‮.near" });
    expect(v.kind === "unreadable" && v.text).not.toMatch(/‮/);
  });
});

describe("expiryText", () => {
  it("shows the UTC date and minute of an expiry in nanoseconds", () => {
    expect(expiryText(endOfDayNs(2026, 12, 31))).toBe("2026-12-31 23:59 UTC");
  });
  it("says unreadable for anything that is not a time, instead of throwing", () => {
    for (const bad of ["", "abc", "-1", "1.5", "99999999999999999999999999999999"]) {
      expect(expiryText(bad), bad).toBe("unreadable");
    }
  });
});

describe("purposeShort", () => {
  it("shortens a sha256, and says unreadable for anything else", () => {
    expect(purposeShort(`${"ab".repeat(4)}${"c".repeat(50)}${"de".repeat(3)}`)).toBe(
      `${"ab".repeat(4)}…${"de".repeat(3)}`,
    );
    for (const bad of ["", "xyz", "AB".repeat(32), "a".repeat(63)])
      expect(purposeShort(bad)).toBe("unreadable");
  });
});

describe("floatFor: which balance a payee kind is paid from", () => {
  it("a NEAR payee is paid from the USDC on NEAR, a Base payee from the Base USDC in Intents", () => {
    const floats = {
      near: { ok: true as const, units: "1" },
      base: { ok: true as const, units: "2" },
    };
    expect(floatFor("near", floats)).toBe(floats.near);
    expect(floatFor("base", floats)).toBe(floats.base);
  });
});

describe("checkPrepared: what the owner signs is what they reviewed", () => {
  const reviewed = createMandateTx(ctx.vault, inputOf({}));
  const key = actionKey(reviewed);

  it("passes the transaction the server built when it is the one reviewed", () => {
    expect(checkPrepared(createMandateTx(ctx.vault, inputOf({})), key)).toEqual(reviewed);
  });

  it("refuses a transaction that differs in any field the owner reviewed", () => {
    const changed = [
      createMandateTx(ctx.vault, inputOf({ payee: "someone.near" })),
      createMandateTx(ctx.vault, inputOf({ maxTotalUsdc: "1001" })),
      createMandateTx(ctx.vault, inputOf({ label: "Other" })),
      createMandateTx("other.vaults.probarion.near", inputOf({})), // another vault
    ];
    for (const tx of changed) {
      expect(checkPrepared(tx, key)).toEqual({ error: CHANGED_SINCE_REVIEW });
    }
  });

  it("passes the server's own refusal through, whatever the key", () => {
    expect(checkPrepared({ error: "no", status: 403 }, key)).toEqual({ error: "no", status: 403 });
    expect(checkPrepared({ error: "no" }, null)).toEqual({ error: "no" });
  });

  it("signs nothing when there is no reviewed transaction to compare with", () => {
    expect(checkPrepared(reviewed, null)).toEqual({ error: CHANGED_SINCE_REVIEW });
  });
});
