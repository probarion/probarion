import "server-only";
import { randomBytes } from "node:crypto";
import { type CustomRule, isNearTxHash } from "@probarion/core";
import type { SpendOutcome } from "@probarion/sdk";
import {
  type KeyCheck,
  type Nep413KeyVerifier,
  parseSignedMessage,
  VerifierUnavailableError,
} from "@/lib/auth/verify";
import type { Network } from "@/lib/config";
import { decodeCanonical } from "@/lib/crypto/sodium";
import { type Db, DbError } from "@/lib/db/port";
import { type MemberTenant, withLease } from "@/lib/db/tenants";
import { openKey } from "@/lib/keys/open";
import { loadActiveSecret, loadActiveSecretFor } from "@/lib/keys/service";
import { log, newRequestId, scrubText } from "@/lib/log";
import { readVaultFacts, type VaultFactsReader } from "./chain";
import {
  CONFIRM_NONCE_BYTES,
  CONFIRM_RECIPIENT,
  ConfirmMessageError,
  confirmMessage,
  payeeText,
} from "./confirm-message";
import { AMOUNT, HEX32, UUID } from "./forms";
import { type OwnerConfirmation, ownerConfirmedRule } from "./owner-confirmed";
import { payeeId } from "./payee";
import { invoiceStatusOf, PROCESS_LEASE_SECONDS } from "./pipeline";
import {
  abortConfirmation,
  beginConfirmation,
  burnConfirmNonce,
  getInvoice,
  type InvoiceRow,
  type InvoiceStatus,
  issueConfirmNonce,
  type RowSnapshot,
  readConfirmNonce,
  setInvoiceOutcome,
  setInvoiceRejected,
} from "./store";
import { invoiceStatusLabel, outcomeLabel, usdcFixed } from "./view";

// The owner's Confirm and Reject for an invoice in awaiting_owner (plan 04 Task 14, rulings W-T14-R0 and R1).
//
// Confirm moves real money on the strength of a signed record, so a session alone is not enough:
//   1. prepare: the server issues a single-use nonce for this row's snapshot (id, suggested_amount, mandate_id,
//      invoice_hash; migration 0007) and builds the message from database and chain values (confirm-message.ts);
//   2. the owner's wallet signs it (NEP-413, recipient CONFIRM_RECIPIENT, not sign-in's);
//   3. confirm: the server rebuilds the message from the nonce's record and the chain, checks the signature over its
//      own copy and that the key is a FullAccess key of the vault's on-chain owner at finality "final" (recording
//      that block), then, in one database transaction, burns the nonce, re-runs the duplicate guard and
//      compare-and-sets the row from that snapshot to processing; then it pays exactly the suggested amount with
//      the SDK's requestSpend on a Probarion made without custom.owner_confirms_without_model and with
//      custom.owner_confirmed, whose detail puts the whole confirmation in the signed ledger.
// The contract still decides: above the mandate's approval_above the vault holds the spend for its approvers.
// Every refusal before the compare-and-set leaves the row as it was.
//
// Why requestSpend and not process(): a zero-retention row keeps no text to run process() on, and the owner signed
// for one mandate, one amount and one invoice hash, which requestSpend takes as they are (the text checks ran when
// the invoice was uploaded, and the row waits only when nothing but the owner rule held it).

/** What the confirm service needs from the SDK's Probarion (and what tests fake). */
export interface ConfirmProbarion {
  requestSpend(input: {
    mandateId: number;
    amount: string;
    invoiceHash: string;
    ref: string;
  }): Promise<SpendOutcome>;
  rules: { add(rule: CustomRule): void };
}

export interface ConfirmDeps {
  db: Db;
  master: Uint8Array;
  reader: VaultFactsReader;
  /** fullAccessKeyVerifier(rpcLoginProvider(rpc)): the signature, then the key at finality "final". */
  keyVerifier: Nep413KeyVerifier;
  network: Network;
  /** A Probarion for this tenant WITHOUT the owner-confirms rule (makeTenantProbarion adds none). */
  makeProbarion(o: {
    tenant: MemberTenant;
    agentKey: string;
    ledgerKey: string;
    requestId: string;
  }): ConfirmProbarion;
  rand?: (n: number) => Uint8Array;
  requestId?: () => string;
}

export type Refusal =
  | "not_found"
  | "not_awaiting"
  | "no_mandate"
  | "not_owner"
  | "chain_unavailable"
  | "mandate_missing"
  | "unconfirmable"
  | "invalid_input"
  | "nonce_unknown"
  | "nonce_used"
  | "nonce_mismatch"
  | "expired"
  | "bad_signature"
  | "verifier_unavailable"
  | "row_changed"
  | "duplicate"
  | "busy"
  | "no_keys"
  | "key_unavailable"
  | "failed"
  | "failed_unknown";

// Each refusal speaks only for this attempt: an earlier attempt's outcome may be unknown, so none of them says that
// nothing was ever sent.
const UNCHANGED = "This attempt sent nothing and changed nothing.";
const CHECK_FIRST = "Reload to see what happened to the invoice before you do anything else.";

/** Each refusal in words the owner can act on. */
export const REFUSAL_TEXT: Readonly<Record<Refusal, string>> = {
  not_found: "This invoice is not one of this vault's.",
  not_awaiting: `This invoice no longer waits for you, and this attempt sent nothing. ${CHECK_FIRST}`,
  no_mandate:
    "This invoice was recorded without its mandate, so it cannot be confirmed. You can reject it, but the same text cannot be uploaded again: upload a corrected invoice, or pay it by hand.",
  not_owner: `Only the vault's on-chain owner can confirm, signing with a full-access key. ${UNCHANGED}`,
  chain_unavailable: `The vault's config or mandates could not be read from NEAR. ${UNCHANGED} Try again.`,
  mandate_missing: `The invoice's mandate is not on the vault any more. ${UNCHANGED}`,
  unconfirmable: `The confirmation message could not be built from what the chain shows (the payee or the owner is not in a form it accepts). ${UNCHANGED}`,
  invalid_input: `The wallet's answer was not in the expected form. ${UNCHANGED}`,
  nonce_unknown: `This confirmation has expired, start again. ${UNCHANGED}`,
  nonce_used: `This confirmation was already used, and this attempt sent nothing. ${CHECK_FIRST}`,
  nonce_mismatch: `This confirmation was issued for another invoice or account. ${UNCHANGED}`,
  expired: `This confirmation has expired (it lasts 5 minutes), start again. ${UNCHANGED}`,
  bad_signature: `Your wallet's signature was not accepted: sign as the vault's owner with a full-access key. ${UNCHANGED}`,
  verifier_unavailable: `No NEAR node could check your key. ${UNCHANGED} Try again.`,
  row_changed: `The invoice changed after you opened it. ${UNCHANGED} Reload the page and check it again.`,
  duplicate: `Another invoice with the same text or number was paid or is being paid. ${UNCHANGED}`,
  busy: `Another invoice for this vault is being processed. ${UNCHANGED} Try again in a few seconds.`,
  no_keys: `The vault's agent or ledger key is not active in this console. ${UNCHANGED}`,
  key_unavailable: `The mandate's agent key or the ledger key cannot be used on the server. ${UNCHANGED}`,
  failed:
    "The payment cycle stopped before anything was sent. The invoice still waits for you: confirm again.",
  failed_unknown:
    "The payment cycle stopped and the invoice could not be set back, so its outcome is unknown: it may stay in processing until the chain has been checked against it. Do not confirm again or pay by hand.",
};

export type Refused = { ok: false; reason: Refusal; text: string; duplicateId?: string };

const refuse = (reason: Refusal, extra: { duplicateId?: string } = {}): Refused => ({
  ok: false,
  reason,
  text: REFUSAL_TEXT[reason],
  ...extra,
});

export type PrepareResult =
  | {
      ok: true;
      message: string;
      recipient: string;
      /** The 32-byte NEP-413 nonce, standard padded base64 (the wallet signs it, the browser sends it back). */
      nonce: string;
      expiresAt: string;
    }
  | Refused;

export type ConfirmResult =
  | {
      ok: true;
      invoiceStatus: InvoiceStatus;
      outcome: SpendOutcome;
      /** False when the outcome could not be written to the row (the watcher reconciles it). */
      recorded: boolean;
      text: string;
    }
  | Refused;

/** The row, or null for an id that is not a uuid or not this tenant's. */
async function row(db: Db, tenantId: string, id: string): Promise<InvoiceRow | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  return getInvoice(db, tenantId, id);
}

/**
 * Step 1: a nonce for this row's snapshot, and the message to sign. Owner only (the action checks the role; here the
 * session account must also be the vault's on-chain owner).
 */
export async function prepareConfirmation(
  deps: ConfirmDeps,
  a: { member: MemberTenant; account: string; invoiceId: string },
): Promise<PrepareResult> {
  const r = await row(deps.db, a.member.tenant_id, a.invoiceId);
  if (r === null) return refuse("not_found");
  if (r.status !== "awaiting_owner" || r.suggested_amount === null) return refuse("not_awaiting");
  if (r.mandate_id === null) return refuse("no_mandate");
  const chain = await readVaultFacts(deps.reader, a.member.vault_id);
  if (chain === null) return refuse("chain_unavailable");
  if (chain.owner !== a.account) return refuse("not_owner");
  const mandate = chain.mandates.find((m) => m.id === r.mandate_id);
  if (mandate === undefined) return refuse("mandate_missing");
  try {
    payeeText(mandate.payee);
  } catch {
    return refuse("unconfirmable");
  }
  const nonce = (deps.rand ?? ((k) => new Uint8Array(randomBytes(k))))(CONFIRM_NONCE_BYTES);
  if (nonce.length !== CONFIRM_NONCE_BYTES) throw new Error("the nonce must be 32 bytes");
  const nonceHex = Buffer.from(nonce).toString("hex");
  const issued = await issueConfirmNonce(deps.db, a.member.tenant_id, r.id, nonceHex, a.account);
  if (!issued.ok) return refuse(issued.reason);
  let message: string;
  try {
    message = confirmMessage({
      amount: issued.suggested_amount,
      payee: mandate.payee,
      vault: a.member.vault_id,
      network: deps.network,
      owner: chain.owner,
      mandateId: issued.mandate_id,
      invoiceId: issued.invoice_id,
      invoiceHash: issued.invoice_hash,
      nonceHex,
      expiresAt: issued.expires_at,
    });
  } catch (error) {
    if (!(error instanceof ConfirmMessageError)) throw error;
    await burnConfirmNonce(deps.db, nonceHex);
    return refuse("unconfirmable");
  }
  log.info("payables.confirm_issued", {
    tenant: a.member.tenant_id,
    invoice: r.id,
    by: a.account,
    expires_at: issued.expires_at,
  });
  return {
    ok: true,
    message,
    recipient: CONFIRM_RECIPIENT,
    nonce: Buffer.from(nonce).toString("base64"),
    expiresAt: issued.expires_at,
  };
}

/** Nothing was sent and only the code held it: the invoice waits for the owner again (another rule must clear). */
const heldAgain = (o: SpendOutcome): boolean =>
  o.status === "held" && o.spendId === null && o.txHash === null;

/**
 * Step 3: check the owner's signature over the server's own copy of the message, then pay exactly the suggested
 * amount. `nonce` (base64) and `signed` come from the browser: they are looked up and checked, never trusted.
 */
export async function confirmInvoice(
  deps: ConfirmDeps,
  a: { member: MemberTenant; account: string; invoiceId: string; nonce: string; signed: unknown },
): Promise<ConfirmResult> {
  const { member } = a;
  const nonce = decodeCanonical(a.nonce, "base64");
  if (nonce === null || nonce.length !== CONFIRM_NONCE_BYTES) return refuse("invalid_input");
  const nonceHex = Buffer.from(nonce).toString("hex");
  const rec = await readConfirmNonce(deps.db, nonceHex);
  if (rec === null || rec.purpose !== "confirm") return refuse("nonce_unknown");
  if (rec.used) return refuse("nonce_used");
  if (rec.expired) return refuse("expired");
  if (
    rec.tenant_id !== member.tenant_id ||
    rec.invoice_id !== a.invoiceId ||
    rec.issued_to !== a.account
  ) {
    return refuse("nonce_mismatch");
  }
  if (!AMOUNT.test(rec.suggested_amount) || !HEX32.test(rec.invoice_hash))
    return refuse("unconfirmable");
  const r = await row(deps.db, member.tenant_id, rec.invoice_id);
  if (r === null) return refuse("not_found");
  if (r.status !== "awaiting_owner") return refuse("not_awaiting");
  if (
    r.suggested_amount !== rec.suggested_amount ||
    r.invoice_hash !== rec.invoice_hash ||
    r.mandate_id !== rec.mandate_id
  ) {
    return refuse("row_changed");
  }
  const signed = parseSignedMessage(a.signed);
  if (signed === null) return refuse("invalid_input");
  if (signed.accountId !== a.account) return refuse("not_owner");
  const chain = await readVaultFacts(deps.reader, member.vault_id);
  if (chain === null) return refuse("chain_unavailable");
  if (chain.owner !== a.account) return refuse("not_owner");
  const mandate = chain.mandates.find((m) => m.id === rec.mandate_id);
  if (mandate === undefined) return refuse("mandate_missing");

  // The server's own copy of the message, from the nonce's record and the chain.
  let message: string;
  try {
    message = confirmMessage({
      amount: rec.suggested_amount,
      payee: mandate.payee,
      vault: member.vault_id,
      network: deps.network,
      owner: chain.owner,
      mandateId: rec.mandate_id,
      invoiceId: rec.invoice_id,
      invoiceHash: rec.invoice_hash,
      nonceHex,
      expiresAt: rec.expires_at,
    });
  } catch (error) {
    if (!(error instanceof ConfirmMessageError)) throw error;
    return refuse("unconfirmable");
  }

  let keyCheck: KeyCheck;
  try {
    keyCheck = await deps.keyVerifier({
      accountId: signed.accountId,
      publicKey: signed.publicKey,
      signature: signed.sigBytes,
      message,
      recipient: CONFIRM_RECIPIENT,
      nonce,
    });
  } catch (error) {
    if (error instanceof VerifierUnavailableError) return refuse("verifier_unavailable");
    // One attempt per nonce: a signature that does not verify spends it.
    await burnConfirmNonce(deps.db, nonceHex);
    log.warn("payables.confirm_refused", {
      tenant: member.tenant_id,
      invoice: r.id,
      reason: "bad_signature",
    });
    return refuse("bad_signature");
  }

  const ledger = await openKey(() =>
    loadActiveSecret(deps.db, deps.master, member.tenant_id, "ledger"),
  );
  if ("problem" in ledger)
    return refuse(ledger.problem === "inactive" ? "no_keys" : "key_unavailable");
  const agent = await openKey(() =>
    loadActiveSecretFor(deps.db, deps.master, member.tenant_id, mandate.agent_pk),
  );
  if ("problem" in agent)
    return refuse(agent.problem === "inactive" ? "no_keys" : "key_unavailable");

  const requestId = (deps.requestId ?? newRequestId)();
  const at = {
    request_id: requestId,
    tenant: member.tenant_id,
    vault: member.vault_id,
    invoice: r.id,
  };
  const leased = await withLease(
    deps.db,
    member.tenant_id,
    "process",
    PROCESS_LEASE_SECONDS,
    async (): Promise<ConfirmResult> => {
      const begun = await beginConfirmation(deps.db, {
        tenantId: member.tenant_id,
        id: r.id,
        nonce: nonceHex,
        account: a.account,
        message,
        publicKey: signed.publicKey,
        signature: signed.signature,
        keyBlockHeight: keyCheck.blockHeight,
        keyBlockHash: keyCheck.blockHash,
        requestId,
      });
      if (!begun.ok) {
        log.warn("payables.confirm_refused", { ...at, reason: begun.reason });
        return refuse(begun.reason, begun.duplicate_id ? { duplicateId: begun.duplicate_id } : {});
      }
      const confirmation: OwnerConfirmation = {
        account: a.account,
        publicKey: signed.publicKey,
        signature: signed.signature,
        nonceHex,
        message,
        keyBlockHeight: keyCheck.blockHeight,
        keyBlockHash: keyCheck.blockHash,
        amount: rec.suggested_amount,
        invoiceHash: rec.invoice_hash,
        mandateId: rec.mandate_id,
        payee: payeeId(mandate.payee),
      };
      let outcome: SpendOutcome;
      try {
        const pb = deps.makeProbarion({
          tenant: member,
          agentKey: agent.key.secret,
          ledgerKey: ledger.key.secret,
          requestId,
        });
        pb.rules.add(ownerConfirmedRule(confirmation));
        outcome = await pb.requestSpend({
          mandateId: rec.mandate_id,
          amount: rec.suggested_amount,
          invoiceHash: rec.invoice_hash,
          ref: r.ref,
        });
      } catch (error) {
        // The SDK sends a spend only after a decision and never throws once it has: nothing went out.
        log.error("payables.confirm_failed", {
          ...at,
          error: scrubText(error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
        // Only a row that really went back waits again; otherwise it stays in processing for the watcher.
        try {
          const back = await abortConfirmation(deps.db, member.tenant_id, r.id);
          if (back.changed) return refuse("failed");
          log.error("payables.confirm_not_reverted", { ...at, row: back.status });
        } catch (abortError) {
          log.error("payables.confirm_not_reverted", {
            ...at,
            error: abortError instanceof Error ? abortError.name : "unknown",
          });
        }
        return refuse("failed_unknown");
      }
      const invoiceStatus = heldAgain(outcome) ? "awaiting_owner" : invoiceStatusOf(outcome);
      let recorded = false;
      try {
        const w = await setInvoiceOutcome(deps.db, member.tenant_id, r.id, {
          status: invoiceStatus,
          outcome,
          suggestedAmount: invoiceStatus === "awaiting_owner" ? rec.suggested_amount : null,
          mandateId: rec.mandate_id,
          anchorTxHash:
            outcome.anchorTxHash && isNearTxHash(outcome.anchorTxHash)
              ? outcome.anchorTxHash
              : null,
          promptTokens: null,
          completionTokens: null,
        });
        recorded = w.changed;
        if (!w.changed) log.error("payables.outcome_not_recorded", { ...at, row: w.status });
      } catch (error) {
        log.error("payables.outcome_not_recorded", {
          ...at,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
      log.info("payables.confirmed", {
        ...at,
        by: a.account,
        mandate_id: rec.mandate_id,
        amount: rec.suggested_amount,
        status: outcome.status,
        code: outcome.code,
        spend_id: outcome.spendId,
        tx: outcome.txHash,
        key_block_height: keyCheck.blockHeight,
      });
      // The row did not go back to waiting: saying that it waits would be false.
      if (invoiceStatus === "awaiting_owner" && !recorded) return refuse("failed_unknown");
      const label = outcomeLabel(outcome.status, outcome.code, outcome.spendId);
      return {
        ok: true,
        invoiceStatus,
        outcome,
        recorded,
        text:
          invoiceStatus === "awaiting_owner"
            ? `${label} (${outcome.code ?? "a rule"}). The invoice waits for you again until that clears.`
            : `${label} (${usdcFixed(rec.suggested_amount)} USDC, mandate ${rec.mandate_id})`,
      };
    },
  );
  return leased.acquired ? leased.value : refuse("busy");
}

const SNAPSHOT_OK = (s: RowSnapshot): boolean =>
  typeof s === "object" &&
  s !== null &&
  typeof s.suggestedAmount === "string" &&
  AMOUNT.test(s.suggestedAmount) &&
  typeof s.invoiceHash === "string" &&
  HEX32.test(s.invoiceHash) &&
  (s.mandateId === null || (Number.isSafeInteger(s.mandateId) && s.mandateId > 0));

/**
 * Reject (ruling W-T14-R1 item 7): unsigned, since it moves no money, but owner only (the action checks the role), a
 * compare-and-set on the snapshot the owner saw, and logged. It frees the row's guard keys.
 */
export async function rejectWaitingInvoice(
  deps: { db: Db },
  a: { member: MemberTenant; account: string; invoiceId: string; seen: RowSnapshot },
): Promise<{ ok: boolean; text: string }> {
  if (typeof a.invoiceId !== "string" || !UUID.test(a.invoiceId) || !SNAPSHOT_OK(a.seen)) {
    return { ok: false, text: "This invoice is not one of this vault's." };
  }
  let r: { changed: boolean; status: InvoiceStatus };
  try {
    r = await setInvoiceRejected(deps.db, a.member.tenant_id, a.invoiceId, a.account, a.seen);
  } catch (error) {
    if (error instanceof DbError && error.code === "not_found") {
      return { ok: false, text: "This invoice is not one of this vault's." };
    }
    throw error;
  }
  log.info("payables.rejected", {
    tenant: a.member.tenant_id,
    vault: a.member.vault_id,
    invoice: a.invoiceId,
    by: a.account,
    changed: r.changed,
    status: r.status,
  });
  if (r.changed) {
    return {
      ok: true,
      text: "Rejected: nothing was paid. A corrected invoice can be uploaded as a new one.",
    };
  }
  return {
    ok: false,
    text:
      r.status === "awaiting_owner"
        ? "The invoice changed after you opened it. Nothing changed: reload the page and check it again."
        : `Nothing changed: ${invoiceStatusLabel(r.status)}.`,
  };
}
