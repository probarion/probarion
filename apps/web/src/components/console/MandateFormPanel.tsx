"use client";

import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import { checkPayeeAction, prepareMandateAction } from "@/app/console/[vault]/mandates/actions";
import { type SampleNote, SampleOffer, sampleLinkClass } from "@/components/console/SampleOffer";
import { Field, inputClass, Notice } from "@/components/ui";
import { TxButton } from "@/components/wallet/TxButton";
import type { Network } from "@/lib/config";
import { createButtonProps, payeeLine } from "@/lib/console/mandate-create";
import {
  approvalSummary,
  backstopWarning,
  blankForm,
  buildMandateInput,
  FIELD_LABEL,
  type FloatRead,
  floatFor,
  floatWarning,
  type MandateForm,
  nearPayeeWarnings,
  type PayeeExists,
  payeeToCheck,
  purposeFileTooLarge,
  tryUsdcUnits,
} from "@/lib/console/mandates";
import { expiryText } from "@/lib/console/mandates-view";
import { loadSampleMandate, SAMPLE_PO, SAMPLE_PO_PATH } from "@/lib/console/samples";
import { MANDATE_STORAGE_DEPOSIT } from "@/lib/near/tx";
import { formatNear, formatUsdc } from "@/lib/near/units";
import { parseBaseAddress } from "@/lib/near/validate";
import { sha256HexOf } from "./sha256";

/** How long the owner stops typing before the console asks whether the payee account exists. */
const PAYEE_CHECK_DELAY_MS = 500;

const muted = "text-mute";

export function MandateFormPanel(props: {
  vault: string;
  /** The vault's on-chain owner: the only account that may sign `create_mandate`. */
  owner: string;
  network: Network;
  baseAsset: string;
  allowedAssets: string[];
  /** The vault's USDC, Intents contract and allowed POA assets: not payees. */
  protocolAccounts: string[];
  /** `label` is already safe to show (safeChainText); `public_key` is the exact chain string. */
  agentKeys: { public_key: string; label: string }[];
  /** The vault's daily backstop, base units. */
  dailyBackstop: string;
  /** R3: what the vault holds to pay from, read on the server. A failed read is `{ ok: false }`, never 0. */
  floats: { near: FloatRead; base: FloatRead };
  /** The SDK's out-of-NEAR codes, from the server. */
  outOfNearCodes: string[];
  /** Fields to start with (a link, a test). A new form after a confirmed create starts blank. */
  initialForm?: Partial<MandateForm>;
}) {
  const firstAgent = props.agentKeys[0]?.public_key ?? "";
  const [form, setForm] = useState<MandateForm>({
    ...blankForm(firstAgent),
    ...props.initialForm,
  });
  const [fileNote, setFileNote] = useState<string | null>(null);
  // The file input is uncontrolled, so a new form needs a new input: changing its key makes React mount a
  // fresh one, and the old file name does not stay on screen beside a blank hash.
  const [fileKey, setFileKey] = useState(0);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleNote, setSampleNote] = useState<SampleNote | null>(null);
  const [payeeCheck, setPayeeCheck] = useState<{
    account: string;
    exists: boolean | null;
  } | null>(null);
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
        protocolAccounts: props.protocolAccounts,
      }),
    [
      form,
      props.vault,
      props.baseAsset,
      props.allowedAssets,
      props.agentKeys,
      props.protocolAccounts,
    ],
  );
  const err = (k: keyof MandateForm) => (!check.ok && form[k] !== "" ? check.errors[k] : undefined);
  const missing = check.ok
    ? []
    : (Object.keys(check.errors) as (keyof MandateForm)[]).filter((k) => form[k] === "");

  // Does the NEAR account typed as the payee exist? Asked on the server once the owner stops typing.
  // Only a note: the vault accepts any valid account id.
  const payeeAccount = payeeToCheck(form.payeeKind, form.payee);
  useEffect(() => {
    if (payeeAccount === null) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      let exists: boolean | null = null;
      try {
        const r = await checkPayeeAction(props.vault, payeeAccount);
        if ("exists" in r) exists = r.exists;
      } catch {
        exists = null;
      }
      if (!cancelled) setPayeeCheck({ account: payeeAccount, exists });
    }, PAYEE_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [payeeAccount, props.vault]);
  const seen = payeeCheck !== null && payeeCheck.account === payeeAccount ? payeeCheck : null;
  const exists: PayeeExists =
    seen === null ? null : seen.exists === null ? "unreadable" : seen.exists;
  const payeeNotes = nearPayeeWarnings({ payeeKind: form.payeeKind, payee: form.payee, exists });

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
    // A file of the owner's own replaces the sample's hash, so the note about the sample no longer holds.
    setSampleNote(null);
    if (!file) return;
    const tooLarge = purposeFileTooLarge(file.size);
    if (tooLarge !== null) {
      setFileNote(tooLarge);
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

  // Testnet (site audit P1-8): the form filled from the sample PO, hashed here as it is served, as a picked file is,
  // and only once the hash is the pinned one.
  async function fillSample() {
    setSampleLoading(true);
    setSampleNote(null);
    try {
      const now = new Date();
      const agentPk = form.agentPk || firstAgent;
      const filled = await loadSampleMandate((path) => fetch(path), {
        now,
        owner: props.owner,
        agentPk,
      });
      setForm(filled);
      setFileNote(null);
      setFileKey((k) => k + 1);
      setSampleNote({
        text: `Filled from the sample purchase order ${SAMPLE_PO.ref}, hashed in your browser. Check the form, then sign it. On Payables, the sample invoice attaches the same file.`,
      });
    } catch {
      setSampleNote({
        text: "The sample could not be loaded. Reload the page and try again.",
        failed: true,
      });
    } finally {
      setSampleLoading(false);
    }
  }

  const button = createButtonProps({
    vault: props.vault,
    owner: props.owner,
    network: props.network,
    form,
    check,
    prepareOnServer: prepareMandateAction,
    outOfNearCodes: props.outOfNearCodes,
    onCreated: () => {
      setForm(blankForm(firstAgent));
      setFileNote(null);
      setFileKey((k) => k + 1);
      setPayeeCheck(null);
      setSampleNote(null);
    },
  });

  return (
    <div>
      <p className={`mb-3 text-xs ${muted}`}>
        A mandate is your signed rule for one agent key: who it may pay, for what, how much per
        payment and in all, and until when. The payee never changes: to pay someone else, create a
        new mandate. You sign with your own wallet as{" "}
        <span className="mono wrap-anywhere">{props.owner}</span>.
      </p>
      {props.network === "testnet" ? (
        <SampleOffer
          text={`Fill the form from the sample purchase order ${SAMPLE_PO.ref}: ${SAMPLE_PO.perPaymentUsdc} test USDC a payment, ${SAMPLE_PO.totalUsdc} in all, ${SAMPLE_PO.uses} payments, for ${SAMPLE_PO.days} days, paid to you.`}
          label="Use the sample PO"
          onUse={fillSample}
          busy={sampleLoading}
          note={sampleNote}
        >
          <a href={SAMPLE_PO_PATH} download className={sampleLinkClass}>
            Download the sample PO
          </a>
        </SampleOffer>
      ) : null}
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
      {payeeNotes.map((n) => (
        <Notice key={n} tone="warn">
          {n}
        </Notice>
      ))}
      <Field
        label="Purpose document (PO or contract)"
        hint="Hashed in your browser: the file never leaves your device and only its sha256 goes on-chain. Keep this same document: you attach it to the invoices it covers later (the invoice and this document together: 4 MiB at most), and an invoice is only paid when its PO hashes to this value."
      >
        <input key={fileKey} type="file" onChange={onFile} />
      </Field>
      {fileNote ? <p className={`-mt-2 mb-3 text-xs ${muted}`}>{fileNote}</p> : null}
      <Field label="Purpose hash (sha256, 64 hex)" error={err("purposeHash")}>
        <input
          className={`${inputClass} mono`}
          value={form.purposeHash}
          onChange={(e) => {
            setSampleNote(null);
            set("purposeHash")(e);
          }}
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
                {k.label}
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
          className="mb-3 rounded-2xl border border-line bg-paper p-4 text-sm"
        >
          <h3 className="mb-2 font-semibold">You are about to create</h3>
          <dl className="grid grid-cols-1 gap-y-1 sm:grid-cols-[max-content_1fr] sm:gap-x-6 [&>dd]:wrap-anywhere max-sm:[&>dd]:mb-1 max-sm:[&>dt]:text-mute">
            <dt>Name</dt>
            <dd>{check.input.label}</dd>
            <dt>Pays</dt>
            <dd className="mono break-all">{payeeLine(check.input.payee)}</dd>
            <dt>Per payment</dt>
            <dd>up to {formatUsdc(check.input.max_per_payment)} USDC</dd>
            <dt>In all</dt>
            <dd>
              up to {formatUsdc(check.input.max_total)} USDC, at most {check.input.max_uses}{" "}
              payments
            </dd>
            <dt>Until</dt>
            <dd>{expiryText(check.input.expires_at_ns, true)}</dd>
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

      {/* Always rendered, so a create that may have gone through stays locked (and says so) after a
          reload or an edit, whether or not the form is complete. */}
      <TxButton {...button} />
    </div>
  );
}
