import type { VaultErrorCode } from "@probarion/core";

export interface VaultErrorDoc {
  /** What went wrong, in one sentence. */
  meaning: string;
  /** The methods or the spend check that raise it, in code font. */
  raisedBy: string;
  /**
   * True when retrying the same call unchanged, after waiting, is the expected way it passes. The
   * table shows it in the "Retry helps" column.
   */
  retryable: boolean;
  /** What to do next, one imperative sentence. */
  next: string;
}

/** Keyed by every code, in VAULT_ERROR_CODES order (a test pins both the keys and the order). */
export const VAULT_ERRORS: Readonly<Record<VaultErrorCode, VaultErrorDoc>> = {
  NoMandate: {
    meaning: "The vault has no mandate with this id; the `check_spend` dry run reports it too.",
    raisedBy: "`spend` (check 4, and its payout), `revoke_mandate`",
    retryable: false,
    next: "Use a mandate id from the vault's mandate list; ids start at 1.",
  },
  MandateInactive: {
    meaning:
      "The mandate has been revoked, so it takes no new spend or approval; the `check_spend` dry run reports it too.",
    raisedBy: "`spend` (check 5), `approve`, `revoke_mandate` (on a revoked mandate)",
    retryable: false,
    next: "Create a new mandate if this payee should still be paid (the owner signs).",
  },
  MandateExpired: {
    meaning:
      "The block time is at or past the mandate's `expires_at_ns`; the `check_spend` dry run reports it too.",
    raisedBy: "`spend` (check 6)",
    retryable: false,
    next: "Create a new mandate with a later expiry (the owner signs).",
  },
  NotMandateAgent: {
    meaning:
      "The signing key is one of the vault's agent keys, but not the `agent_pk` this mandate names; the `check_spend` dry run reports it too.",
    raisedBy: "`spend` (check 7)",
    retryable: false,
    next: "Sign the spend with the agent key the mandate names.",
  },
  ZeroAmount: {
    meaning: "The amount is 0; the `check_spend` dry run reports it too.",
    raisedBy: "`spend` (check 8)",
    retryable: false,
    next: "Send an amount above zero, written in the token's base units.",
  },
  OverPerPayment: {
    meaning:
      "The amount is above the mandate's `max_per_payment`; the `check_spend` dry run reports it too.",
    raisedBy: "`spend` (check 9)",
    retryable: false,
    next: "Check the invoice amount, and if it is right, create a mandate with a higher cap (the owner signs).",
  },
  UsesExhausted: {
    meaning:
      "The mandate has been used `max_uses` times (a failed, rejected or expired spend gives its use back); the `check_spend` dry run reports it too.",
    raisedBy: "`spend` (check 10)",
    retryable: false,
    next: "Wait for a held or pending spend of this mandate to be released, or create a new mandate (the owner signs).",
  },
  OverMandateTotal: {
    meaning:
      "The mandate's spent and reserved amounts plus this amount would pass `max_total` (a failed, rejected or expired spend gives its reservation back); the `check_spend` dry run reports it too.",
    raisedBy: "`spend` (check 11)",
    retryable: false,
    next: "Wait for a held or pending spend of this mandate to be released, or create a new mandate with room for this payment (the owner signs).",
  },
  DuplicateInvoice: {
    meaning:
      "This `invoice_hash` belongs to another spend that is held, pending, paid or burned; the `check_spend` dry run reports it too.",
    raisedBy: "`spend` (check 12)",
    retryable: false,
    next: "Find the spend that holds this invoice in the vault's spend list, and do not pay the invoice again.",
  },
  DuplicateRef: {
    meaning:
      "The vault has already accepted a spend with this `ref`, and a ref stays used even when that spend later fails, is rejected or expires; the `check_spend` dry run reports it too.",
    raisedBy: "`spend` (check 13)",
    retryable: false,
    next: "Find the spend with this `ref` in the vault's spend list, and do not send the payment under a new `ref` until you know its status.",
  },
  OverDailyBackstop: {
    meaning:
      "The vault's total for this UTC day, plus this amount, would pass the daily backstop; the `check_spend` dry run reports it too.",
    raisedBy: "`spend` (check 14)",
    retryable: true,
    next: "Wait for the next UTC day, since the backstop is fixed when the vault is created and no method changes it.",
  },
  Frozen: {
    meaning:
      "The owner has frozen the vault, so it takes no spend and no approval; the `check_spend` dry run reports it too.",
    raisedBy: "`spend` (check 3), `approve`",
    retryable: true,
    next: "Ask the owner to call `unfreeze` with exactly 1 yoctoNEAR attached (the owner signs).",
  },
  NotAgent: {
    meaning:
      "`spend` was called from an account other than the vault, or signed with a key that is not one of the vault's agent keys; the `check_spend` dry run reports the second case.",
    raisedBy: "`spend` (its caller check, and check 1)",
    retryable: false,
    next: "Sign the spend on the vault account with one of its agent keys.",
  },
  NotOwner: {
    meaning: "The caller is not the vault's owner account.",
    raisedBy:
      "`create_mandate`, `revoke_mandate`, `add_agent`, `remove_agent`, `set_ledger_key`, `freeze`, `unfreeze`, `withdraw`, `withdraw_intents`",
    retryable: false,
    next: "Send the call from the owner account (the owner signs).",
  },
  NotApprover: {
    meaning: "The caller is not one of the vault's approvers.",
    raisedBy: "`approve`, `reject`",
    retryable: false,
    next: "Send the call from one of the vault's approver accounts (the approver signs).",
  },
  NotLedgerKey: {
    meaning: "`anchor` was not signed on the vault account with the vault's ledger key.",
    raisedBy: "`anchor`",
    retryable: false,
    next: "Sign `anchor` on the vault account with the ledger key that `set_ledger_key` set.",
  },
  NotHeld: {
    meaning: "There is no spend with this id, or the spend is not held.",
    raisedBy: "`approve`, `reject`, `expire_held`",
    retryable: false,
    next: "Read the spend with `get_spend` to see its current status.",
  },
  HoldExpired: {
    meaning: "`approve` came after the spend's `held_until_ns`.",
    raisedBy: "`approve`",
    retryable: false,
    next: "Release the spend with `expire_held`, which anyone may call, and submit the payment again with a new `ref`.",
  },
  HoldNotExpired: {
    meaning: "`expire_held` came at or before the spend's `held_until_ns`.",
    raisedBy: "`expire_held`",
    retryable: true,
    next: "Wait until `held_until_ns` has passed, then call `expire_held` again.",
  },
  BadSeq: {
    meaning: "The anchor's `seq` is not the number of anchors so far plus 1.",
    raisedBy: "`anchor`",
    retryable: false,
    next: "Read the last anchor with `list_anchors` and anchor with the next seq, as the SDK does once by itself, and keep one ledger writer per vault.",
  },
  AssetNotAllowed: {
    meaning:
      "The payee's asset is not in the vault's `allowed_assets`, or its prefix does not match the payee's chain; `check_spend` does not run this check.",
    raisedBy: "`create_mandate`, `spend` and `approve` (at payout)",
    retryable: false,
    next: "Create the mandate with an asset from the vault's `allowed_assets` that matches the payee's chain (the owner signs).",
  },
  InvalidInput: {
    meaning:
      "An argument is malformed or not allowed, for example a hash that is not 64 lowercase hex characters, a `ref` that is not 1 to 64 bytes, mandate limits that do not fit together, a zero amount or allowance, or a key the vault already holds (or, for `remove_agent`, does not hold); the `check_spend` dry run reports the spend case too.",
    raisedBy:
      "`spend` (check 2), `create_mandate`, `add_agent`, `remove_agent`, `set_ledger_key`, `withdraw`, `withdraw_intents`, `anchor`, `new`, the factory's `create_vault`",
    retryable: false,
    next: "Fix the argument the method refused and send the call again.",
  },
  InsufficientDeposit: {
    meaning:
      "Less NEAR was attached than the call needs: for `create_vault`, the factory's `min_deposit`, plus the storage of the vault wasm when the current version is embedded; for `create_mandate`, the mandate's storage plus, for a NEAR payee, the payee's USDC storage registration.",
    raisedBy: "`create_mandate`, the factory's `create_vault`",
    retryable: false,
    next: "For `create_vault`, attach at least the `min_deposit` that the factory's `get_config` returns, plus the wasm's storage for an embedded version; for `create_mandate`, attach more NEAR, since the vault refunds the excess (the owner signs).",
  },
  RequiresOneYocto: {
    meaning:
      "The call did not attach exactly 1 yoctoNEAR, which only a full-access key can attach.",
    raisedBy:
      "`unfreeze`, `withdraw`, `withdraw_intents`, `revoke_mandate`, `add_agent`, `remove_agent`, `set_ledger_key`, `approve`, `reject`",
    retryable: false,
    next: "Sign with a full-access key and attach exactly 1 yoctoNEAR.",
  },
};

export interface SdkErrorDoc {
  name: string;
  parent: string;
  /** The `.code` the class sets. */
  code: string;
  when: string;
  /** Extra fields the error carries, in code font, or "" for none. */
  fields: string;
}

/** Every error class the SDK exports (a test compares this list with packages/sdk/src). */
export const SDK_ERRORS: readonly SdkErrorDoc[] = [
  {
    name: "ProbarionError",
    parent: "Error",
    code: "InvalidInput",
    when: "The base class of every SDK error. The SDK also throws it with its own codes: `InvalidInput` (a malformed argument, refused before anything is read, sent or written), `TxSendFailed` (the transaction could not be built or signed, so nothing was sent), `TxFailed` (the transaction result could not be read) and `Internal` (a failed internal consistency check, which a caller should report).",
    fields: "`code`",
  },
  {
    name: "RpcError",
    parent: "ProbarionError",
    code: "RpcError",
    when: "A transport failure or a JSON-RPC error answer: every RPC URL failed, a node returned an error, or the time for the job ran out.",
    fields: "`attempts`, `rpcError`",
  },
  {
    name: "RpcMalformedError",
    parent: "RpcError",
    code: "RpcError",
    when: "A node answered, but not in a shape the client can read. It is never a transport failure.",
    fields: "",
  },
  {
    name: "ViewError",
    parent: "RpcError",
    code: "RpcError",
    when: "A view call failed or returned an answer that is not the expected value; `probarionCode` is the vault code when the view panicked with one.",
    fields: "`contractId`, `methodName`, `probarionCode`",
  },
  {
    name: "ContractError",
    parent: "ProbarionError",
    code: "TxFailed",
    when: "A transaction the SDK sent failed on chain, for example an `anchor` the vault refused (a refused spend is a spend outcome, not an error). `.code` is the vault code when there is one, the same value as `vaultCode`, and `TxFailed` otherwise.",
    fields: "`vaultCode`, `txHash`",
  },
  {
    name: "TxOutcomeUnknownError",
    parent: "ProbarionError",
    code: "TxOutcomeUnknown",
    when: "The transaction was signed and sent, but the node's answer was lost, so it may or may not have run. Record `txHash`, look the outcome up, and do not send the same payment again.",
    fields: "`txHash`, `signerId`",
  },
  {
    name: "TxRejectedError",
    parent: "ProbarionError",
    code: "TxRejected",
    when: "The node refused the signed transaction before running it, so nothing changed. `kind` names the refusal, for example `NotEnoughAllowance` or `AccessKeyNotFound`.",
    fields: "`kind`",
  },
  {
    name: "ConfigError",
    parent: "ProbarionError",
    code: "ConfigError",
    when: "An option or a key the SDK needs is missing or malformed, or a client method got an argument it cannot send.",
    fields: "",
  },
  {
    name: "NearAiError",
    parent: "ProbarionError",
    code: "NearAiError",
    when: "The model step failed: a missing API key, an HTTP error, a malformed answer, a missing attestation or no time left.",
    fields: "",
  },
  {
    name: "NearAiResponseTooLargeError",
    parent: "NearAiError",
    code: "NearAiError",
    when: "The model's answer is larger than 64 KiB, so it is not used and the decision is rules-only.",
    fields: "`limitBytes`",
  },
  {
    name: "LedgerError",
    parent: "ProbarionError",
    code: "LedgerError",
    when: "The ledger store failed: an append onto another vault's ledger or onto a broken last entry, a line that is not valid UTF-8 or JSON, a lock it could not take, or a decision that landed at the wrong position (`LEDGER_FORK_RISK`).",
    fields: "",
  },
  {
    name: "LedgerConflictError",
    parent: "LedgerError",
    code: "LedgerError",
    when: "Another writer moved the ledger's head since this append expected it, so nothing was written and no spend was sent.",
    fields: "`expected`, `actual`",
  },
];

export interface HttpErrorDoc {
  status: number;
  code: string;
  /** Which routes return it, for example "Console API" or "Cron routes". */
  where: string;
  meaning: string;
  next: string;
}

/**
 * Every (status, code) a route of the web app returns (a test compares this list with apps/web/src).
 * A pair only a helper no route calls yet can return is left out until a route calls it.
 */
export const HTTP_ERRORS: readonly HttpErrorDoc[] = [
  {
    status: 400,
    code: "bad_code_format",
    where: "Extension API (pairing)",
    meaning: "The pairing code is not 8 letters and digits.",
    next: "Enter the code exactly as the Browser extension page shows it, for example `K7QM-4XRA`.",
  },
  {
    status: 400,
    code: "empty",
    where: "Console invoices API, Canary attempt API",
    meaning:
      "There is no text to work on: no text could be read from the invoice (a scanned PDF has no text layer), or the Canary attempt is blank.",
    next: "Paste the invoice text instead of the file, or type a Canary attempt that is not blank.",
  },
  {
    status: 400,
    code: "invalid_amount",
    where: "Top-up API (quote)",
    meaning: "The top-up amount is not a USDC amount, or is not between 1 and 1000 USDC.",
    next: "Ask for a top-up of 1 to 1000 USDC, written as a plain decimal amount.",
  },
  {
    status: 400,
    code: "invalid_input",
    where: "Console invoices API, Canary attempt API, Extension API, Top-up API",
    meaning:
      "The request body or query is malformed: a field is missing or has the wrong type, or the body is not the JSON or form the route reads.",
    next: "Send the fields the route expects, in the shape its `detail` names when there is one.",
  },
  {
    status: 400,
    code: "invalid_link",
    where: "Alert links (stop)",
    meaning: "The unsubscribe link is not a valid link for this subscription.",
    next: "Use the unsubscribe link of a recent alert email, or turn the alert off on the vault's alerts page.",
  },
  {
    status: 400,
    code: "too_long",
    where: "Canary attempt API",
    meaning: "The Canary attempt is longer than 4,000 characters.",
    next: "Shorten the text to 4,000 characters at most and try again.",
  },
  {
    status: 400,
    code: "unreadable",
    where: "Console invoices API",
    meaning:
      "The invoice file could not be read: it is empty or over 4 MiB, it is not the PDF it claims to be, the PDF could not be read in time, or the text file is not UTF-8.",
    next: "Upload a readable PDF or a UTF-8 text file, or paste the invoice text.",
  },
  {
    status: 401,
    code: "bad_code",
    where: "Extension API (pairing)",
    meaning: "The pairing code is wrong, used or expired.",
    next: "Show a new code on the Browser extension page and enter that one.",
  },
  {
    status: 401,
    code: "bad_signature",
    where: "Sign-in API",
    meaning:
      "The wallet's signature does not verify over the sign-in challenge, or its public key is not a full-access key of the account.",
    next: "Sign in again with a full-access key of the account.",
  },
  {
    status: 401,
    code: "bad_token",
    where: "Extension API",
    meaning:
      "The extension sent no token, or a token that is unknown, expired, revoked or made at the other network's address.",
    next: "Connect the extension again: open Probarion, then Browser extension.",
  },
  {
    status: 401,
    code: "challenge_missing_or_expired",
    where: "Sign-in API",
    meaning: "The sign-in challenge is missing, expired or already used.",
    next: "Start the sign-in again, so the server issues a fresh challenge.",
  },
  {
    status: 401,
    code: "invalid_input",
    where: "Sign-in API",
    meaning:
      "The signed login is malformed: the account id, the public key or the signature is missing or not in its expected form.",
    next: "Sign in again from the wallet prompt, without changing what the wallet sends.",
  },
  {
    status: 401,
    code: "unauthenticated",
    where: "Console invoices API, Top-up API",
    meaning: "There is no signed-in session at this address.",
    next: "Sign in with your NEAR wallet and send the request again.",
  },
  {
    status: 401,
    code: "unauthorized",
    where: "Cron routes, Telegram webhook",
    meaning:
      "The call did not carry the route's secret: the cron bearer secret, or the Telegram webhook secret.",
    next: "Leave these routes to the scheduler and to Telegram, which hold their secrets.",
  },
  {
    status: 403,
    code: "bad_origin",
    where: "Sign-in API, Console invoices API, Canary attempt API, Top-up API",
    meaning:
      "The request's Origin header is missing, or is not the address the request came in at.",
    next: "Send the request from a Probarion page at this address.",
  },
  {
    status: 403,
    code: "forbidden",
    where: "Console invoices API, Top-up API",
    meaning:
      "The signed-in account is not a member of this vault with a role that may do this; a top-up quote also needs the vault's owner on chain.",
    next: "Sign in with an account that has the needed role on this vault.",
  },
  {
    status: 403,
    code: "not_member",
    where: "Extension API (queue an invoice)",
    meaning:
      "The token's account is not an owner or an approver of this vault (a vault that does not exist gets the same answer), or the vault is a Canary vault, which takes no invoices from the extension; nothing was stored.",
    next: "Choose a vault where the connected account is an owner or an approver, and not a Canary vault.",
  },
  {
    status: 404,
    code: "mandate_not_found",
    where: "Extension API (queue an invoice)",
    meaning:
      "The vault's mandates, as the chain lists them now, have no mandate with this id; nothing was stored.",
    next: "Choose a mandate that the extension lists for this vault.",
  },
  {
    status: 404,
    code: "not_found",
    where: "Proof files (snapshot.json, ledger.jsonl), Top-up API (faucet)",
    meaning:
      "There is no proof to give: the vault id is not a NEAR account id, nobody registered the vault, or its proof page is not public and you are not a member. The faucet answers it at any address but testnet's, and to anyone but the vault's owner, so a vault id is not confirmed.",
    next: "Check the vault id, or sign in as a member of the vault if its proof page is not public; for the faucet, sign in as the vault's owner at the testnet address.",
  },
  {
    status: 409,
    code: "asset_not_allowed",
    where: "Top-up API (quote)",
    meaning: "The vault does not allow Base USDC, so a top-up could not pay a Base payee from it.",
    next: "Top up a vault whose `allowed_assets` include Base USDC, since they are fixed when the vault is created.",
  },
  {
    status: 409,
    code: "busy",
    where: "Console invoices API, Canary attempt API",
    meaning: "Another invoice for this vault, or another Canary attempt, is being processed.",
    next: "Wait a few seconds and send it again.",
  },
  {
    status: 409,
    code: "duplicate",
    where: "Console invoices API",
    meaning:
      "The vault already has this invoice: the same text once normalised, or this text again after `custom.invoice_number_duplicate` refused it while the number is still blocked. The body adds `invoiceId` and `status`. Another text with the number of an invoice that was paid or may still pay is not a 409: its cycle runs and that rule refuses it, and when the rule's refusal is the outcome's code the answer adds a `notice`.",
    next: "Read the invoice's `status` instead of sending it again. A paid invoice is not paid again. A text the number rule refused goes through only after the owner rejects the earlier invoice in the console while it waits for the owner; an approver's rejection of a held spend keeps the number blocked. Ask the payee for an invoice with a new number only once the earlier one cannot pay: the vault's spends show none under its ref, or one that failed, was rejected or expired.",
  },
  {
    status: 409,
    code: "key_unavailable",
    where: "Console invoices API",
    meaning: "The mandate's agent key is not active in this console, so nothing was sent.",
    next: "Activate that key on the Keys tab, or create the mandate for an active key (the owner signs).",
  },
  {
    status: 409,
    code: "mainnet_only",
    where: "Top-up API",
    meaning: "NEAR Intents and 1Click exist on mainnet only, so a testnet vault has no top-up.",
    next: 'On testnet, press "Add test USDC" on the vault\'s Top-up tab instead.',
  },
  {
    status: 409,
    code: "no_keys",
    where: "Console invoices API, Extension API (queue an invoice)",
    meaning:
      "The vault has no active agent key, or no active ledger key, in this console; for the extension, the agent key must be the one the chosen mandate names.",
    next: "Activate the missing key on the Keys tab (the owner signs).",
  },
  {
    status: 409,
    code: "no_mandate",
    where: "Console invoices API",
    meaning:
      "No purpose document was attached, or no mandate of this vault has the attached document's hash as its `purpose_hash`.",
    next: "Attach the purpose document (the PO or contract) you hashed when you created the mandate.",
  },
  {
    status: 409,
    code: "not_owner",
    where: "Top-up API (faucet)",
    meaning:
      "The chain names another account than the signed-in one as the vault's owner, so nothing was minted.",
    next: "Sign in with the account the chain names as the vault's owner.",
  },
  {
    status: 409,
    code: "wrong_network",
    where: "Console invoices API, Extension API (queue an invoice), Top-up API",
    meaning: "The vault is on the other network than the address the request came in at.",
    next: "Open the vault at its own network's address.",
  },
  {
    status: 409,
    code: "wrong_token",
    where: "Top-up API (faucet)",
    meaning:
      "The vault's token is not testnet's USDC, so the faucet's test USDC would not count in it, and nothing was minted.",
    next: "Use the faucet on a vault made for testnet's USDC; a vault's token is set when it is created.",
  },
  {
    status: 411,
    code: "length_required",
    where: "Console invoices API, Extension API (queue an invoice)",
    meaning: "The upload has no valid Content-Length header.",
    next: "Send the upload with a Content-Length header, as a browser form does.",
  },
  {
    status: 413,
    code: "payload_too_large",
    where: "Sign-in API",
    meaning: "The sign-in body is larger than 2 KiB, which no signed login is.",
    next: "Send only the signed login the wallet returned.",
  },
  {
    status: 413,
    code: "too_large",
    where: "Console invoices API, Extension API (queue an invoice)",
    meaning:
      "The upload is too large: the invoice or the purpose document is over 4 MiB, or the whole request is over 4 MiB plus 64 KiB (4 MiB plus 16 KiB for the extension, which sends no purpose document).",
    next: "Send a smaller file, or paste the invoice text in the console instead.",
  },
  {
    status: 415,
    code: "unsupported",
    where: "Console invoices API, Extension API (queue an invoice)",
    meaning: "The invoice file is not a PDF or a plain text file.",
    next: "Send the invoice as a PDF or a plain text (`.txt`) file, or paste its text in the console instead.",
  },
  {
    status: 422,
    code: "amount_unclear",
    where: "Extension API (queue an invoice)",
    meaning:
      "The code could not read one clear USDC total from the invoice: the text has no total it can read, has totals that disagree, shows a zero total or another currency, is cut short, or is not a payable invoice; nothing was stored.",
    next: "Upload the invoice in the console instead, or send an invoice that states one clear total.",
  },
  {
    status: 422,
    code: "empty",
    where: "Extension API (queue an invoice)",
    meaning:
      "There is no text in the file (a scanned PDF has no text layer, or the text file is blank); nothing was stored.",
    next: "Upload the invoice in the console instead, where you can paste its text.",
  },
  {
    status: 422,
    code: "mandate_inactive",
    where: "Extension API (queue an invoice)",
    meaning:
      "The chosen mandate cannot take an invoice now: it is revoked or expired, has no uses or no total left, has a status, expiry, use count or total the code cannot read, or has a payee the owner's confirmation message cannot name; the `detail` names the mandate and the reason, and nothing was stored.",
    next: "Choose another mandate of this vault, or create a new one for this payee (the owner signs).",
  },
  {
    status: 422,
    code: "refused_by_code",
    where: "Extension API (queue an invoice)",
    meaning:
      "The code refused the invoice, and the body adds `rule`: `mandate.payee_mismatch` when the payee the invoice names contradicts the mandate's payee, or `contract.check_spend` when the vault's free `check_spend` view says the vault would refuse this payment now (the `detail` names the contract's code, for example `DuplicateInvoice`); nothing was stored.",
    next: "Choose the mandate that pays the payee on the invoice, or look up the contract code in `detail` in the vault error codes and fix what it names.",
  },
  {
    status: 422,
    code: "unreadable",
    where: "Extension API (queue an invoice)",
    meaning:
      "The invoice file could not be read: it is sent as a PDF but is not one, the PDF could not be read or took too long, or the text file is not UTF-8; the `detail` says which, and nothing was stored.",
    next: "Send a readable PDF or a UTF-8 text file, or upload the invoice in the console instead.",
  },
  {
    status: 429,
    code: "budget",
    where: "Canary attempt API",
    meaning:
      "The Canary's budget is used up for now: the day's model token budget, or the attempts allowed in total or from this address.",
    next: "Wait the seconds in the `Retry-After` header, then try again.",
  },
  {
    status: 429,
    code: "rate_limited",
    where:
      "Sign-in API, Console invoices API, Canary attempt API, Top-up API, Extension API, proof files, alert confirm link, Telegram webhook",
    meaning:
      "Too many requests in the route's window; the answer carries `Retry-After` and the detail `Try again in N s`.",
    next: "Wait the seconds in the `Retry-After` header before you send the request again.",
  },
  {
    status: 500,
    code: "internal",
    where: "Console invoices API",
    meaning: "The invoice pipeline returned a result the route does not know, which is a bug.",
    next: "Report it, and read the vault's invoices and spends before you upload the invoice again.",
  },
  {
    status: 502,
    code: "failed",
    where: "Console invoices API, Canary attempt API",
    meaning:
      "The cycle stopped before any payment was sent, or the Canary attempt ran out of time; the invoice or the attempt is stored as an error.",
    next: "Upload the invoice again, or send a new Canary attempt.",
  },
  {
    status: 502,
    code: "mint_failed",
    where: "Top-up API (faucet)",
    meaning:
      "The mint reached NEAR and the token refused it, so no test USDC arrived and the vault's day is used; the body adds `txHash`.",
    next: "Send @probarionhq a direct message on X with your vault's name and the `txHash`.",
  },
  {
    status: 502,
    code: "quote_rejected",
    where: "Top-up API (quote)",
    meaning: "1Click's quote does not match what was asked for, so it is not used.",
    next: "Ask for a new quote.",
  },
  {
    status: 502,
    code: "quote_unavailable",
    where: "Top-up API (quote)",
    meaning: "1Click could not give a quote.",
    next: "Ask for a quote again in a minute.",
  },
  {
    status: 502,
    code: "status_unavailable",
    where: "Top-up API (status)",
    meaning: "1Click could not report the deposit's status.",
    next: "Ask for the status again later, since 1Click also finds the deposit by itself.",
  },
  {
    status: 503,
    code: "chain_unavailable",
    where: "Console invoices API, Extension API (queue an invoice), Top-up API (quote)",
    meaning: "The vault could not be read from NEAR, so nothing was stored or sent.",
    next: "Try again when the NEAR RPC answers.",
  },
  {
    status: 503,
    code: "closed",
    where: "Canary attempt API",
    meaning: "The Canary takes no attempts (its mode is off or replay), or its ledger is full.",
    next: "Try the Canary again once it is open.",
  },
  {
    status: 503,
    code: "key_unavailable",
    where: "Console invoices API",
    meaning: "A key cannot be opened on the server, so nothing was sent; the operator is alerted.",
    next: "Try again later, once the operator has fixed the key.",
  },
  {
    status: 503,
    code: "not_configured",
    where: "Top-up API, Telegram webhook",
    meaning:
      "This deployment has not set up the service the route needs: 1Click quotes for top-ups, or the Telegram bot.",
    next: "Ask the deployment's operator to set the service up, since the request itself is fine.",
  },
  {
    status: 503,
    code: "not_ready",
    where: "Canary attempt API",
    meaning:
      "The Canary is not ready on this network: its vault, model key, mandate, keys or ledger key are not usable, or the chain did not answer in time.",
    next: "Try the Canary again later.",
  },
  {
    status: 503,
    code: "unavailable",
    where:
      "Sign-in API, Console invoices API, Canary attempt API, Top-up API, Extension API, proof files, alert links, cron routes, Telegram webhook",
    meaning:
      "Something the route depends on failed (the database, a server key, a setting or the chain), and the route answers this instead of an unhandled error.",
    next: "Try again in a moment, and quote the request id from the detail when you report it.",
  },
  {
    status: 503,
    code: "wrong_chain",
    where: "Sign-in API",
    meaning:
      "An RPC address set for this network answers for the other chain, so no sign-in is accepted.",
    next: "Tell the deployment's operator, since the fault is in its RPC setting.",
  },
];

export function errorAnchor(code: string): string {
  return code;
}

/** One anchor per row: key_unavailable comes back with 409 and 503, so the status is part of it. */
export function httpAnchor(status: number, code: string): string {
  return `http-${status}-${code}`;
}
