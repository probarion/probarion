import { NETWORKS } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { actionKey } from "@/lib/near/lock";
import type { TxResult } from "@/lib/near/outcome";
import { createMandateTx, MANDATE_STORAGE_DEPOSIT } from "@/lib/near/tx";
import { formatNear } from "@/lib/near/units";
import { SIGNER_OUT_OF_NEAR } from "./display";
import {
  CHANGED_SINCE_REVIEW,
  checkPrepared,
  confirmText,
  createButtonProps,
  createLockKey,
  FIX_FIELDS_FIRST,
  payeeLine,
  type ServerAnswer,
} from "./mandate-create";
import { buildMandateInput, type MandateContext, type MandateForm } from "./mandates";

const BASE_ASSET = NETWORKS.mainnet.allowedAssets.base;
const AGENT = `ed25519:${"3".repeat(44)}`;
const NOW = new Date("2026-11-08T00:00:00Z");
const ctx: MandateContext = {
  now: NOW,
  vault: "acme.vaults.probarion.near",
  baseAsset: BASE_ASSET,
  allowedAssets: [BASE_ASSET],
  agentKeys: [AGENT],
  protocolAccounts: [],
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
const inputOf = (f: Partial<MandateForm>) => {
  const r = buildMandateInput({ ...form, ...f }, ctx);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);
  return r.input;
};

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

const EIP55 = "0x52908400098527886E0F7030069857D2E4169EE7";
const OWNER = "acme.near";
const CODES = ["LackBalanceForState", "NotEnoughBalance"];
const result = (over: Partial<TxResult>): TxResult => ({
  status: "failed",
  txHash: null,
  code: null,
  error: null,
  ...over,
});

/** A server that answers with the transaction its own build gives, and counts its calls. */
function server(answer?: (vault: string, f: MandateForm) => ServerAnswer) {
  const calls: { vault: string; form: MandateForm }[] = [];
  const fn = async (vault: string, f: MandateForm): Promise<ServerAnswer> => {
    calls.push({ vault, form: f });
    if (answer) return answer(vault, f);
    const r = buildMandateInput(f, ctx);
    return r.ok ? createMandateTx(vault, r.input) : { error: "refused" };
  };
  return { fn, calls };
}

function buttonFor(
  over: Partial<MandateForm> = {},
  extra: Partial<Parameters<typeof createButtonProps>[0]> = {},
) {
  const f = { ...form, ...over };
  const s = server();
  const created = { n: 0 };
  const props = createButtonProps({
    vault: ctx.vault,
    owner: OWNER,
    network: "mainnet",
    form: f,
    check: buildMandateInput(f, ctx),
    prepareOnServer: s.fn,
    outOfNearCodes: CODES,
    onCreated: () => {
      created.n += 1;
    },
    ...extra,
  });
  return { props, server: s, created };
}

describe("createLockKey: the lock names the action, never the draft", () => {
  it("names the vault, and differs between vaults", () => {
    expect(createLockKey("acme.vaults.probarion.near")).toContain(
      "create-mandate:acme.vaults.probarion.near",
    );
    expect(createLockKey("acme.vaults.probarion.near")).not.toBe(
      createLockKey("other.vaults.probarion.near"),
    );
  });
});

describe("createButtonProps: the wiring of the create button", () => {
  it("is signed by the vault's owner, with the label and network it was given", () => {
    const { props } = buttonFor();
    expect(props.expectedSigner).toBe(OWNER);
    expect(props.network).toBe("mainnet");
    expect(props.label).toBe("Sign mandate in my wallet");
  });

  it("keeps ONE lock whatever the form holds: an edit, an incomplete form or a different mandate", () => {
    const keys = new Set([
      buttonFor().props.lockKey,
      buttonFor({ maxTotalUsdc: "1001" }).props.lockKey, // edited after an unknown outcome
      buttonFor({ label: "Another" }).props.lockKey,
      buttonFor({ payee: "someone.near", expiresOn: "2027-01-31" }).props.lockKey,
      buttonFor({ payee: "", purposeHash: "" }).props.lockKey, // incomplete
      buttonFor({ payeeKind: "base", payee: EIP55 }, {}).props.lockKey,
    ]);
    expect([...keys]).toEqual([createLockKey(ctx.vault)]);
  });

  it("has a different lock on another vault", () => {
    const other = createButtonProps({
      vault: "other.vaults.probarion.near",
      owner: OWNER,
      network: "mainnet",
      form,
      check: buildMandateInput(form, { ...ctx, vault: "other.vaults.probarion.near" }),
      prepareOnServer: server().fn,
      outOfNearCodes: CODES,
      onCreated: () => {},
    });
    expect(other.lockKey).not.toBe(buttonFor().props.lockKey);
  });

  it("confirms with what will be signed: the EIP-55 address, the amounts, the exact expiry, the deposit", () => {
    const { props } = buttonFor({
      payeeKind: "base",
      payee: EIP55.toLowerCase(),
      maxPerPaymentUsdc: "12.5",
      maxTotalUsdc: "1000",
      maxUses: "7",
      label: "Acme Design retainer",
    });
    const c = props.confirm ?? "";
    expect(c).toContain(EIP55); // the checksummed form, though the owner typed lower case
    expect(c).not.toContain(EIP55.toLowerCase());
    expect(c).toContain("12.5 USDC per payment");
    expect(c).toContain("1000 USDC in all");
    expect(c).toContain("at most 7 payments");
    expect(c).toContain("until 2026-12-31 23:59:59 UTC");
    expect(c).toContain('"Acme Design retainer"');
    expect(c).toContain(`${formatNear(MANDATE_STORAGE_DEPOSIT)} NEAR`);
    expect(c).toContain("can never be changed");
  });

  it("has nothing to confirm for a form that cannot be signed", () => {
    expect(buttonFor({ payee: "Not An Account" }).props.confirm).toBeUndefined();
  });

  it("asks the server for the transaction and returns it when it is the one reviewed", async () => {
    const { props, server: s } = buttonFor();
    const answer = await props.prepare();
    expect("error" in answer).toBe(false);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.vault).toBe(ctx.vault);
    expect(s.calls[0]?.form).toEqual(form);
    const reviewed = createMandateTx(ctx.vault, inputOf({}));
    expect(answer).toEqual(reviewed);
  });

  it("refuses to sign, with CHANGED_SINCE_REVIEW, when the server's transaction is not the reviewed one", async () => {
    const changed = (over: Partial<MandateForm>) =>
      server((vault) => createMandateTx(vault, inputOf(over)));
    for (const over of [{ payee: "someone.near" }, { maxTotalUsdc: "1001" }, { label: "Other" }]) {
      const s = changed(over);
      const { props } = buttonFor({}, { prepareOnServer: s.fn });
      expect(await props.prepare(), JSON.stringify(over)).toEqual({ error: CHANGED_SINCE_REVIEW });
    }
    // the same fields on another vault are another transaction too
    const s = server(() => createMandateTx("other.vaults.probarion.near", inputOf({})));
    expect(await buttonFor({}, { prepareOnServer: s.fn }).props.prepare()).toEqual({
      error: CHANGED_SINCE_REVIEW,
    });
  });

  it("passes the server's own refusal through, status included", async () => {
    const s = server(() => ({ error: "Only the vault's owner can create mandates.", status: 403 }));
    expect(await buttonFor({}, { prepareOnServer: s.fn }).props.prepare()).toEqual({
      error: "Only the vault's owner can create mandates.",
      status: 403,
    });
  });

  it("asks the server nothing for an incomplete form", async () => {
    const { props, server: s } = buttonFor({ payee: "", purposeHash: "" });
    expect(await props.prepare()).toEqual({ error: FIX_FIELDS_FIRST });
    expect(s.calls).toHaveLength(0);
  });

  it("sets the detail line only, and only for an out-of-NEAR refusal, naming the signer first", () => {
    const { props } = buttonFor();
    const words = props.describe(result({ code: "LackBalanceForState" }));
    expect(words).toEqual({ detail: SIGNER_OUT_OF_NEAR });
    expect(Object.keys(words ?? {})).toEqual(["detail"]); // never a headline or a tone
    expect(props.describe(result({ code: "NotEnoughBalance" }))).toEqual({
      detail: SIGNER_OUT_OF_NEAR,
    });
    expect(props.describe(result({ code: "PROBARION:NotOwner" }))).toBeUndefined();
    expect(props.describe(result({ code: null }))).toBeUndefined();
    expect(props.describe(result({ status: "unknown", code: "LackBalanceForState" }))).toEqual({
      detail: SIGNER_OUT_OF_NEAR,
    });
  });

  it("starts a new form after a confirmed create, and only then", () => {
    const { props, created } = buttonFor();
    props.onResult(result({ status: "failed" }));
    props.onResult(result({ status: "unknown" }));
    expect(created.n).toBe(0);
    props.onResult(result({ status: "ok", txHash: null }));
    expect(created.n).toBe(1);
  });
});

describe("confirmText and payeeLine", () => {
  it("shows a NEAR payee by account and a Base payee by its address", () => {
    expect(payeeLine({ type: "near", account_id: "designer.near" })).toBe(
      "designer.near (USDC on NEAR)",
    );
    expect(payeeLine({ type: "intents", chain: "base", address: EIP55, asset: BASE_ASSET })).toBe(
      `${EIP55} (USDC on Base)`,
    );
  });

  it("is built from the validated input, not the typed text", () => {
    const text = confirmText(inputOf({ payee: "  designer.near ", label: "  Spaced  " }));
    expect(text).toContain("designer.near (USDC on NEAR)");
    expect(text).toContain('"Spaced"');
  });
});
