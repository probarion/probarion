/**
 * The create button's behaviour, as pure functions so it can be tested without a browser: which
 * account may sign, the lock that keeps a possibly-sent create from being signed twice, the text the
 * owner confirms, and the check that what the wallet is asked to sign is what was reviewed. The panel
 * only spreads `createButtonProps` into the wallet button.
 */
import type { Network } from "@/lib/config";
import { consoleOutOfNear } from "@/lib/console/display";
import type { MandateCheck, MandateForm } from "@/lib/console/mandates";
import { expiryText } from "@/lib/console/mandates-view";
import { actionKey, lockKeyFor } from "@/lib/near/lock";
import type { DescribeResult, TxResult } from "@/lib/near/outcome";
import {
  createMandateTx,
  MANDATE_STORAGE_DEPOSIT,
  type MandateInputJson,
  type WalletTx,
} from "@/lib/near/tx";
import { formatNear, formatUsdc } from "@/lib/near/units";

/** What the server action answers: the transaction to sign, or why there is none. */
export type ServerAnswer = WalletTx | { error: string; status?: number };
export type PrepareOnServer = (vault: string, form: MandateForm) => Promise<ServerAnswer>;

export const CHANGED_SINCE_REVIEW =
  "The vault changed since you reviewed this form, so nothing was signed. Check the fields and try again.";
export const FIX_FIELDS_FIRST = "Fix the highlighted fields first. Nothing was signed.";

/**
 * W-T9-R1. The lock is named for the ACTION (creating a mandate on this vault), never for the draft. A
 * create whose outcome is unknown may have landed, and the owner who reloads, edits one field or starts
 * over must still be stopped until they have checked the explorer; a lock named for the form's contents
 * would be forgotten the moment a field changed.
 */
export function createLockKey(vault: string): string {
  return lockKeyFor(`create-mandate:${vault}`);
}

/**
 * The server prepares the transaction again from the chain as it is now. What the wallet is asked to
 * sign must be exactly the transaction the owner reviewed (`expectedKey` is `actionKey` of that
 * transaction: its receiver, methods, arguments, gas and deposit). The server's own refusal passes
 * through; with nothing reviewed to compare against, nothing is signed.
 */
export function checkPrepared(answer: ServerAnswer, expectedKey: string | null): ServerAnswer {
  if ("error" in answer) return answer;
  // (a null key equals no transaction's key, so "nothing reviewed" refuses too)
  if (actionKey(answer) !== expectedKey) return { error: CHANGED_SINCE_REVIEW };
  return answer;
}

/** The payee as the owner reads it, exactly as it is sent (a Base address in its EIP-55 form). */
export function payeeLine(payee: MandateInputJson["payee"]): string {
  return payee.type === "near"
    ? `${payee.account_id} (USDC on NEAR)`
    : `${payee.address} (USDC on Base)`;
}

/** The confirmation the owner reads in the wallet's dialog, built from the validated input and nothing else. */
export function confirmText(input: MandateInputJson): string {
  return [
    `Create mandate "${input.label}"?`,
    "",
    `Pays ${payeeLine(input.payee)} up to ${formatUsdc(input.max_per_payment)} USDC per payment and ${formatUsdc(input.max_total)} USDC in all, at most ${input.max_uses} payments, until ${expiryText(input.expires_at_ns, true)}.`,
    "",
    `The payee can never be changed. Your wallet attaches ${formatNear(MANDATE_STORAGE_DEPOSIT)} NEAR; the vault refunds what the storage does not use.`,
  ].join("\n");
}

export interface CreateButtonProps {
  label: string;
  network: Network;
  expectedSigner: string;
  lockKey: string;
  confirm: string | undefined;
  prepare: () => Promise<ServerAnswer>;
  describe: DescribeResult;
  onResult: (r: TxResult) => void;
}

/**
 * Everything the create button is given.
 *  - `expectedSigner` is the vault's owner: only that account can sign `create_mandate`.
 *  - `lockKey` does not depend on the form (see `createLockKey`), so the button stays locked after a
 *    reload or an edit, and a form that is still incomplete shows the lock too.
 *  - `prepare` asks the server for the transaction and refuses to sign anything but the one reviewed.
 *    With an incomplete form it asks the server nothing.
 *  - `describe` changes the detail line only, and only for an out-of-NEAR refusal, naming the owner's own
 *    account first: it pays this call's gas and deposit.
 *  - `onResult` starts a new form after a confirmed create (and only then).
 */
export function createButtonProps(a: {
  vault: string;
  owner: string;
  network: Network;
  form: MandateForm;
  check: MandateCheck;
  prepareOnServer: PrepareOnServer;
  outOfNearCodes: readonly string[];
  onCreated: () => void;
}): CreateButtonProps {
  const { check } = a;
  return {
    label: "Sign mandate in my wallet",
    network: a.network,
    expectedSigner: a.owner,
    lockKey: createLockKey(a.vault),
    confirm: check.ok ? confirmText(check.input) : undefined,
    prepare: async () => {
      if (!check.ok) return { error: FIX_FIELDS_FIRST };
      let expected: WalletTx;
      try {
        expected = createMandateTx(a.vault, check.input);
      } catch (e) {
        return { error: `The transaction could not be built: ${(e as Error).message}` };
      }
      return checkPrepared(await a.prepareOnServer(a.vault, a.form), actionKey(expected));
    },
    describe: (r) => {
      const v = consoleOutOfNear(r.code, a.outOfNearCodes, false);
      return v === null ? undefined : { detail: v.text };
    },
    onResult: (r) => {
      if (r.status === "ok") a.onCreated();
    },
  };
}
