"use client";

import { type ChangeEvent, useMemo, useState } from "react";
import { prepareMandateAction } from "@/app/console/[vault]/mandates/actions";
import { Field, inputClass, Notice } from "@/components/ui";
import { TxButton } from "@/components/wallet/TxButton";
import type { Network } from "@/lib/config";
import { consoleOutOfNear } from "@/lib/console/display";
import {
  approvalSummary,
  backstopWarning,
  buildMandateInput,
  checkPrepared,
  FIELD_LABEL,
  type FloatRead,
  floatFor,
  floatWarning,
  type MandateForm,
  tryUsdcUnits,
} from "@/lib/console/mandates";
import { actionKey } from "@/lib/near/lock";
import type { TxResult } from "@/lib/near/outcome";
import { createMandateTx, MANDATE_STORAGE_DEPOSIT } from "@/lib/near/tx";
import { formatNear, formatUsdc } from "@/lib/near/units";
import { parseBaseAddress } from "@/lib/near/validate";
import { sha256HexOf } from "./sha256";

/** A purpose document is read into memory to hash it: a PO is a few pages, so this is generous. */
const MAX_PURPOSE_FILE_BYTES = 25 * 1024 * 1024;

const muted = "text-[#0B0B0C]/60";

export function MandateFormPanel(props: {
  vault: string;
  /** The vault's on-chain owner: the only account that may sign `create_mandate`. */
  owner: string;
  network: Network;
  baseAsset: string;
  allowedAssets: string[];
  agentKeys: { public_key: string; label: string }[];
  /** The vault's daily backstop, base units. */
  dailyBackstop: string;
  /** R3: what the vault holds to pay from, read on the server. A failed read is `{ ok: false }`, never 0. */
  floats: { near: FloatRead; base: FloatRead };
  /** The SDK's out-of-NEAR codes, from the server. */
  outOfNearCodes: string[];
}) {
  const [form, setForm] = useState<MandateForm>({
    payeeKind: "near",
    payee: "",
    purposeHash: "",
    maxPerPaymentUsdc: "100",
    maxTotalUsdc: "1000",
    maxUses: "10",
    expiresOn: "",
    approvalAboveUsdc: "100",
    agentPk: props.agentKeys[0]?.public_key ?? "",
    label: "",
  });
  const [fileNote, setFileNote] = useState<string | null>(null);
  const set = (k: keyof MandateForm) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.value;
    setForm((cur) => ({ ...cur, [k]: value }));
  };

  const check = useMemo(
    () =>
      buildMandateInput(form, {
        now: new Date(),
        vault: props.vault,
        baseAsset: props.baseAsset,
        allowedAssets: props.allowedAssets,
        agentKeys: props.agentKeys.map((k) => k.public_key),
      }),
    [form, props.vault, props.baseAsset, props.allowedAssets, props.agentKeys],
  );
  const err = (k: keyof MandateForm) => (!check.ok && form[k] !== "" ? check.errors[k] : undefined);
  const missing = check.ok
    ? []
    : (Object.keys(check.errors) as (keyof MandateForm)[]).filter((k) => form[k] === "");

  // What the owner reviewed is exactly what the wallet is asked to sign: the lock is named by that
  // transaction, and the server's answer must be the same transaction or nothing is signed.
  const expected = useMemo(() => {
    if (!check.ok) return null;
    try {
      return createMandateTx(props.vault, check.input);
    } catch {
      return null;
    }
  }, [check, props.vault]);
  const lockKey = expected ? actionKey(expected) : null;

  const perPaymentUnits = tryUsdcUnits(form.maxPerPaymentUsdc);
  const warnings = [
    floatWarning({
      payeeKind: form.payeeKind,
      maxPerPaymentUnits: perPaymentUnits,
      float: floatFor(form.payeeKind, props.floats),
    }),
    backstopWarning(perPaymentUnits, props.dailyBackstop),
  ].filter((w): w is string => w !== null);

  const checksummed = form.payeeKind === "base" ? parseBaseAddress(form.payee) : null;

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setFileNote(null);
    if (!file) return;
    if (file.size > MAX_PURPOSE_FILE_BYTES) {
      setFileNote("That file is over 25 MB. Paste its sha256 instead.");
      return;
    }
    try {
      const hash = await sha256HexOf(await file.arrayBuffer());
      setForm((cur) => ({ ...cur, purposeHash: hash }));
      setFileNote(`Hashed ${file.name.slice(0, 80)} in your browser. The file was not uploaded.`);
    } catch {
      setFileNote("The file could not be read. Paste its sha256 instead.");
    }
  }

  const prepare = async () => checkPrepared(await prepareMandateAction(props.vault, form), lockKey);

  return (
    <div>
      <p className={`mb-3 text-xs ${muted}`}>
        A mandate is your signed rule for one agent key: who it may pay, for what, how much per
        payment and in all, and until when. The payee never changes: to pay someone else, create a
        new mandate. You sign with your own wallet as <span className="mono">{props.owner}</span>.
      </p>
      <Field label="Payee type">
        <select className={inputClass} value={form.payeeKind} onChange={set("payeeKind")}>
          <option value="near">NEAR account (USDC on NEAR)</option>
          <option value="base">Base address (USDC on Base via NEAR Intents)</option>
        </select>
      </Field>
      <Field
        label="Payee"
        hint="Never changes. A wrong payee cannot be fixed: check every character."
        error={err("payee")}
      >
        <input
          className={`${inputClass} mono`}
          value={form.payee}
          onChange={set("payee")}
          placeholder={form.payeeKind === "near" ? "designer.near" : "0x…"}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      {checksummed !== null ? (
        <p className={`-mt-2 mb-3 text-xs ${muted}`}>
          Will be sent as <span className="mono break-all">{checksummed}</span> (checksummed).
        </p>
      ) : null}
      <Field
        label="Purpose document (PO or contract)"
        hint="Hashed in your browser: the file never leaves your device and only its sha256 goes on-chain. Keep this same document: you attach it to the invoices it covers later, and an invoice is only paid when its PO hashes to this value."
      >
        <input type="file" onChange={onFile} />
      </Field>
      {fileNote ? <p className={`-mt-2 mb-3 text-xs ${muted}`}>{fileNote}</p> : null}
      <Field label="Purpose hash (sha256, 64 hex)" error={err("purposeHash")}>
        <input
          className={`${inputClass} mono`}
          value={form.purposeHash}
          onChange={set("purposeHash")}
          placeholder="or paste the sha256 of the document"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Max per payment (USDC)" error={err("maxPerPaymentUsdc")}>
          <input
            className={inputClass}
            value={form.maxPerPaymentUsdc}
            onChange={set("maxPerPaymentUsdc")}
            inputMode="decimal"
          />
        </Field>
        <Field label="Max total (USDC)" error={err("maxTotalUsdc")}>
          <input
            className={inputClass}
            value={form.maxTotalUsdc}
            onChange={set("maxTotalUsdc")}
            inputMode="decimal"
          />
        </Field>
        <Field label="Max number of payments" error={err("maxUses")}>
          <input
            className={inputClass}
            value={form.maxUses}
            onChange={set("maxUses")}
            inputMode="numeric"
          />
        </Field>
        <Field label="Expires on (UTC)" error={err("expiresOn")}>
          <input
            type="date"
            className={inputClass}
            value={form.expiresOn}
            onChange={set("expiresOn")}
          />
        </Field>
        <Field
          label="Hold for approval above (USDC)"
          hint="A payment above this waits for an approver. 0 holds every payment."
          error={err("approvalAboveUsdc")}
        >
          <input
            className={inputClass}
            value={form.approvalAboveUsdc}
            onChange={set("approvalAboveUsdc")}
            inputMode="decimal"
          />
        </Field>
        <Field label="Agent key" error={err("agentPk")}>
          <select className={inputClass} value={form.agentPk} onChange={set("agentPk")}>
            {props.agentKeys.length === 0 ? (
              <option value="">Add an agent key first (Keys tab)</option>
            ) : null}
            {props.agentKeys.map((k) => (
              <option key={k.public_key} value={k.public_key}>
                {k.label || k.public_key.slice(0, 20)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Name" error={err("label")}>
        <input
          className={inputClass}
          value={form.label}
          onChange={set("label")}
          placeholder="Acme Design retainer"
        />
      </Field>

      {warnings.map((w) => (
        <Notice key={w} tone="warn">
          {w}
        </Notice>
      ))}

      {check.ok ? (
        <section
          aria-label="What you are about to sign"
          className="mb-3 rounded-2xl border border-[#0B0B0C]/10 bg-[#F7F6F3] p-4 text-sm"
        >
          <h3 className="mb-2 font-semibold">You are about to create</h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
            <dt>Name</dt>
            <dd>{check.input.label}</dd>
            <dt>Pays</dt>
            <dd className="mono break-all">
              {check.input.payee.type === "near"
                ? `${check.input.payee.account_id} (USDC on NEAR)`
                : `${check.input.payee.address} (USDC on Base)`}
            </dd>
            <dt>Per payment</dt>
            <dd>up to {formatUsdc(check.input.max_per_payment)} USDC</dd>
            <dt>In all</dt>
            <dd>
              up to {formatUsdc(check.input.max_total)} USDC, at most {check.input.max_uses}{" "}
              payments
            </dd>
            <dt>Until</dt>
            <dd>{form.expiresOn.trim()} 23:59:59 UTC</dd>
            <dt>Approval</dt>
            <dd>{approvalSummary(check.input)}</dd>
            <dt>Purpose hash</dt>
            <dd className="mono break-all">{check.input.purpose_hash}</dd>
            <dt>Agent key</dt>
            <dd className="mono break-all">{check.input.agent_pk}</dd>
          </dl>
          <p className={`mt-2 text-xs ${muted}`}>
            Your wallet attaches {formatNear(MANDATE_STORAGE_DEPOSIT)} NEAR to cover the
            mandate&apos;s storage
            {check.input.payee.type === "near" ? " and the payee's USDC registration" : ""}. The
            vault keeps what that costs and refunds the rest to you.
          </p>
        </section>
      ) : missing.length > 0 ? (
        <p className={`mb-2 text-xs ${muted}`}>
          Still to fill in: {missing.map((k) => FIELD_LABEL[k]).join(", ")}.
        </p>
      ) : (
        <p className={`mb-2 text-xs ${muted}`}>Fix the highlighted fields to continue.</p>
      )}

      {check.ok && lockKey !== null ? (
        <TxButton
          label="Sign mandate in my wallet"
          network={props.network}
          expectedSigner={props.owner}
          confirm={`Create mandate "${check.input.label}"?\n\nPays ${
            check.input.payee.type === "near"
              ? check.input.payee.account_id
              : check.input.payee.address
          } up to ${formatUsdc(check.input.max_per_payment)} USDC per payment and ${formatUsdc(check.input.max_total)} USDC in all, at most ${check.input.max_uses} payments, until ${form.expiresOn.trim()} UTC.\n\nThe payee can never be changed. Your wallet attaches ${formatNear(MANDATE_STORAGE_DEPOSIT)} NEAR; the vault refunds what the storage does not use.`}
          prepare={prepare}
          lockKey={lockKey}
          describe={(r: TxResult) => {
            // The owner's own account pays this call's gas and deposit: name it first.
            const v = consoleOutOfNear(r.code, props.outOfNearCodes, false);
            return v === null ? undefined : { detail: v.text };
          }}
        />
      ) : (
        <button
          type="button"
          className="my-2 rounded-full bg-[#0B0B0C] px-4 py-1.5 text-sm text-[#F7F6F3] opacity-50"
          disabled
        >
          Sign mandate in my wallet
        </button>
      )}
    </div>
  );
}
