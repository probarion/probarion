"use client";

import { useRouter } from "next/navigation";
import { type ChangeEvent, useState } from "react";
import { prepareCreateVaultAction, registerVaultAction } from "@/app/console/actions";
import { buttonClass, Field, inputClass, Notice, type Tone } from "@/components/ui";
import { TxButton } from "@/components/wallet/TxButton";
import type { Network } from "@/lib/config";
import { VAULT_DEFAULTS } from "@/lib/config";
import { createWarnings, parseApprovers } from "@/lib/console/create-rules";
import { rewordOutOfNear } from "@/lib/console/display";
import { lockKeyFor } from "@/lib/near/lock";
import type { TxResult } from "@/lib/near/outcome";
import { createDepositPlan, type FactoryMode, MAX_CREATE_DEPOSIT_YOCTO } from "@/lib/near/runway";
import { formatNear, formatNearUp, parseNear } from "@/lib/near/units";

/** After an "ok" create, the vault can take a few seconds to read as final: registration is a read, so it may retry. */
const REGISTER_TRIES = 4;
const REGISTER_WAIT_MS = 2_500;

type Note = { tone: Tone; text: string } | null;

function depositView(minDeposit: string, mode: FactoryMode, depositNear: string) {
  let yocto: bigint;
  try {
    yocto = BigInt(parseNear(depositNear));
  } catch {
    return { ok: false as const, text: "Enter the deposit as a plain number of NEAR, such as 3.5" };
  }
  const plan = createDepositPlan(minDeposit, mode, yocto);
  // A minimum is rounded up: the figure shown, typed back in, always meets it.
  const required = formatNearUp(plan.requiredYocto.toString(), 6);
  if (yocto < plan.requiredYocto) {
    return {
      ok: false as const,
      text:
        mode === "embedded"
          ? `The factory requires at least ${required} NEAR in embedded mode (min_deposit plus the storage of the vault's own copy of its code).`
          : `The factory requires at least ${required} NEAR.`,
    };
  }
  if (!plan.covers)
    return { ok: false as const, text: "Too low to pay for the vault's own storage." };
  if (yocto > MAX_CREATE_DEPOSIT_YOCTO) {
    return {
      ok: false as const,
      text: `At most ${formatNear(MAX_CREATE_DEPOSIT_YOCTO.toString())} NEAR: if the name is taken, the factory refunds the deposit from a float sized for that.`,
    };
  }
  return {
    ok: true as const,
    low: plan.low,
    text: `Required ${required} NEAR. Expected runway: about ${plan.spends} paid spends (${formatNear(plan.freeYocto.toString())} NEAR free after storage).`,
  };
}

export function CreateVaultPanel({
  factory,
  network,
  mode,
  version,
  minDeposit,
  defaultDeposit,
  owner,
  outOfNearCodes,
}: {
  factory: string;
  network: Network;
  mode: FactoryMode;
  version: number;
  /** yoctoNEAR */
  minDeposit: string;
  /** yoctoNEAR: min_deposit, plus the code storage in embedded mode (R14). */
  defaultDeposit: string;
  /**
   * The signed-in account. The factory makes whoever signs `create_vault` the vault's permanent
   * owner (contracts/factory create_vault: owner = predecessor), so only this account may sign.
   */
  owner: string;
  /** The SDK's out-of-NEAR codes, from the server. */
  outOfNearCodes: string[];
}) {
  const [form, setForm] = useState({
    name: "",
    approvers: "",
    dailyBackstopUsdc: VAULT_DEFAULTS.dailyBackstopUsdc,
    heldTtlHours: String(VAULT_DEFAULTS.heldTtlHours),
    depositNear: formatNearUp(defaultDeposit, 6),
  });
  const router = useRouter();
  const [note, setNote] = useState<Note>(null);
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });
  const vaultId = `${form.name.trim()}.${factory}`;
  const deposit = depositView(minDeposit, mode, form.depositNear);
  const warnings = createWarnings(parseApprovers(form.approvers), owner);

  async function register(id: string, tries: number): Promise<void> {
    for (let i = 0; i < tries; i++) {
      const reg = await registerVaultAction(id);
      if (reg.ok) {
        // The new vault's own page, where its first-payment checklist starts (site audit P1-8).
        setNote({ tone: "good", text: `Registered ${id}. Opening it…` });
        router.push(`/console/${encodeURIComponent(id)}`);
        return;
      }
      if (reg.code !== "not_found" || i === tries - 1) {
        setNote({
          tone: "bad",
          text: `${id}: ${reg.error} You can register it below once it reads.`,
        });
        return;
      }
      await new Promise((r) => setTimeout(r, REGISTER_WAIT_MS));
    }
  }

  async function onResult(r: TxResult) {
    // The id is fixed at the moment the owner signed, whatever they type next.
    const id = vaultId;
    if (r.status === "ok") {
      setNote({ tone: "info", text: `Created. Registering ${id}…` });
      await register(id, REGISTER_TRIES);
    } else if (r.status === "failed") {
      // Out of NEAR here is the signer's own account: the vault does not exist yet.
      rewordOutOfNear(r, outOfNearCodes, false);
    } else if (r.status === "unknown") {
      // Never sign again: the vault may exist. Registration is a read, so one try is safe.
      setNote({
        tone: "warn",
        text: `The outcome is not confirmed. Check the explorer before anything else; if ${id} exists, register it below.`,
      });
      await register(id, 1).catch(() => undefined);
    }
  }

  return (
    <div>
      <p className="mb-3 text-xs text-mute">
        Factory version {version} ({mode === "global" ? "global code" : "embedded code"}). You sign
        with your own wallet as <span className="mono">{owner}</span>, and that account becomes the
        vault&apos;s owner for good.
      </p>
      <Field
        label="Vault name"
        hint={`Your vault will be ${form.name.trim() || "<name>"}.${factory}`}
      >
        <input className={inputClass} value={form.name} onChange={set("name")} placeholder="acme" />
      </Field>
      <Field
        label="Approvers"
        hint="NEAR accounts that approve held payments, comma separated. Ideally a second person."
      >
        <input
          className={inputClass}
          value={form.approvers}
          onChange={set("approvers")}
          placeholder="cfo.near"
        />
      </Field>
      <Field
        label="Daily backstop (USDC)"
        hint="Hard cap on the total spent per day, enforced by the contract."
      >
        <input
          className={inputClass}
          value={form.dailyBackstopUsdc}
          onChange={set("dailyBackstopUsdc")}
        />
      </Field>
      <Field label="Held payments expire after (hours)" hint="1 to 720.">
        <input className={inputClass} value={form.heldTtlHours} onChange={set("heldTtlHours")} />
      </Field>
      <Field
        label="Deposit (NEAR)"
        hint="It stays in the vault as its NEAR runway for storage and gas, and can never be withdrawn."
        error={deposit.ok ? undefined : deposit.text}
      >
        <input className={inputClass} value={form.depositNear} onChange={set("depositNear")} />
      </Field>
      {deposit.ok ? <Notice tone={deposit.low ? "warn" : "neutral"}>{deposit.text}</Notice> : null}
      {warnings.map((w) => (
        <Notice key={w} tone="warn">
          {w}
        </Notice>
      ))}
      {deposit.ok ? (
        <TxButton
          label="Create vault in my wallet"
          network={network}
          expectedSigner={owner}
          confirm={`Create ${vaultId} with ${owner} as its owner and a ${form.depositNear.trim()} NEAR deposit? The deposit becomes the vault's runway and cannot be withdrawn. If the name is taken, the factory refunds it.`}
          prepare={() => prepareCreateVaultAction(form)}
          lockKey={lockKeyFor(`create-vault:${vaultId}`)}
          onResult={onResult}
        />
      ) : (
        <button type="button" className={`my-2 ${buttonClass}`} disabled>
          Create vault in my wallet
        </button>
      )}
      {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
    </div>
  );
}
