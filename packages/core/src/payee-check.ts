// Payee check: what the owner learns about a payee before signing a mandate for it. The agent never picks a
// payee (`spend` has no address field), so this check runs where a payee enters: when the owner writes one into a
// mandate. It is advice for that owner. It changes nothing on chain, and the contract still pays only a mandate's
// payee.
//
// Pure: the chain reads live in @probarion/sdk (`readPayeeSignals`). A signal that could not be read is "unknown",
// and an unknown signal is a warn reason, so a failed read never turns into allow.
import type { NetworkId } from "./constants.js";
import { isEvmAddress, isNearAccountId, isSolanaAddress } from "./formats.js";
import blocklistFile from "./payee-blocklist.json" with { type: "json" };
import type { Chain, Payee } from "./types.js";

/** The chain a payee is on: a NEAR account, or an address on Base or Solana paid through NEAR Intents. */
export type PayeeChain = "near" | Chain;

/** A payee as the owner names it: `near:<account>`, `base:<0x address>` or `solana:<address>`. */
export interface PayeeRef {
  chain: PayeeChain;
  address: string;
}

/** A signal read from a chain: its value, "unknown" when the read failed, or null where it does not apply. */
export type PayeeSignal<T> = T | "unknown" | null;

/** The signals `why_unknown` can name. */
export type PayeeSignalName = "exists" | "contract" | "new_7d" | "code_changed_7d" | "known_payees";

/** A payee of the vault: in one of its mandates, or paid by one of its spends. */
export interface KnownPayee {
  payee: PayeeRef;
  /** Spends of the vault to this payee that were paid out (status `paid` or `burned`). */
  paid: number;
  /** Ids of the vault's mandates that pay it, lowest first. */
  mandates: readonly number[];
}

/** What `readPayeeSignals` (@probarion/sdk) read about one payee. */
export interface PayeeSignals {
  network: NetworkId;
  payee: PayeeRef;
  /** When the reads ran (ISO 8601). It becomes the assessment's `checked_at`. */
  read_at: string;
  /** NEAR: the account is on chain now. Base and Solana: null, an address needs no account. */
  exists: PayeeSignal<boolean>;
  /** NEAR: its code hash is not 1111…1 (or it uses a global contract). Base: eth_getCode is not 0x. */
  contract: PayeeSignal<boolean>;
  /** NEAR: no account at a block about 7 days back. Base: it has sent no transaction (nonce 0). */
  new_7d: PayeeSignal<boolean>;
  /** NEAR: its code identity differs from the one at the block about 7 days back. Null on Base and Solana. */
  code_changed_7d: PayeeSignal<boolean>;
  /** The NEAR block about 7 days back that the age and code reads used, when one was read. */
  past_block: number | null;
  /** The vault's payees, read when a vault was given; null when none was given. */
  known_payees: readonly KnownPayee[] | "unknown" | null;
  /** Why a signal is "unknown": one short line per failed read. */
  why_unknown: Partial<Record<PayeeSignalName, string>>;
}

export type PayeeLevel = "info" | "warn" | "block";
export type PayeeVerdict = "allow" | "warn" | "block";

/**
 * Each check gives exactly one reason. The ids of a finding are the brief's: `not_found`, `blocklisted`,
 * `lookalike`, `contract`, `new_7d`, `code_changed_7d`, `first_payment`, `paid_before`. The others say a check
 * passed (info), could not run (`*_unknown`, warn) or was not asked for (`history_not_checked`, info).
 */
export type PayeeReasonId =
  | "invalid_address"
  | "blocklisted"
  | "not_blocklisted"
  | "lookalike"
  | "no_lookalike"
  | "not_found"
  | "found"
  | "exists_unknown"
  | "contract"
  | "no_contract"
  | "contract_unknown"
  | "new_7d"
  | "older_than_7d"
  | "age_unknown"
  | "code_changed_7d"
  | "code_unchanged_7d"
  | "code_change_unknown"
  | "first_payment"
  | "paid_before"
  | "history_unknown"
  | "history_not_checked";

export interface PayeeReason {
  id: PayeeReasonId;
  level: PayeeLevel;
  text: string;
  /** A public URL that backs the reason (a blocklist entry's evidence). */
  evidence?: string;
}

export interface PayeeAssessment {
  /** The highest level among the reasons: block, else warn, else allow. */
  verdict: PayeeVerdict;
  /** Block reasons first, then warn, then info; within a level, in the order the checks ran. */
  reasons: PayeeReason[];
  network: NetworkId;
  payee: PayeeRef;
  /** The signals' `read_at`. */
  checked_at: string;
}

export interface PayeeBlocklistEntry {
  network: NetworkId;
  payee: PayeeRef;
  reason: string;
  /** A public URL a reader can check the reason against. */
  evidence: string;
  /** YYYY-MM-DD. */
  added: string;
}

export interface AssessPayeeOptions {
  /** The vault's payees. Defaults to `signals.known_payees`. */
  knownPayees?: readonly KnownPayee[] | "unknown" | null;
  /** Defaults to `PAYEE_BLOCKLIST`. */
  blocklist?: readonly PayeeBlocklistEntry[];
}

/** The seed blocklist (payee-blocklist.json): payees Probarion's own demo texts name, and nothing else. */
export const PAYEE_BLOCKLIST: readonly PayeeBlocklistEntry[] = Object.freeze(
  (blocklistFile.entries as PayeeBlocklistEntry[]).map((e) => Object.freeze({ ...e })),
);

const IMPLICIT_RE = /^[0-9a-f]{64}$/;
const ETH_IMPLICIT_RE = /^0x[0-9a-f]{40}$/;
const LEVEL_RANK: Readonly<Record<PayeeLevel, number>> = { info: 0, warn: 1, block: 2 };
/** Named NEAR accounts this many edits apart, or fewer, look alike (when both are at least `LOOKALIKE_MIN_LENGTH`). */
const LOOKALIKE_MAX_EDITS = 2;
const LOOKALIKE_MIN_LENGTH = 6;
/** How many characters of an address's start and end a person compares by eye. */
const EDGE = 4;

/** `near:vendor.near`, `base:0x…`, `solana:…`: the form the CLI takes and prints. */
export function formatPayeeRef(ref: PayeeRef): string {
  return `${ref.chain}:${ref.address}`;
}

/** A mandate's payee as a `PayeeRef`; an Intents payee's asset is not part of who gets paid. */
export function payeeRefOf(payee: Payee): PayeeRef {
  return payee.type === "near"
    ? { chain: "near", address: payee.account_id }
    : { chain: payee.chain, address: payee.address };
}

/**
 * Parses `near:<account>`, `base:<0x address>` or `solana:<address>`. A bare NEAR account id is read as `near:`,
 * except a bare `0x` value, which could be an ETH-implicit NEAR account or a Base address: that one must say which.
 */
export function parsePayeeRef(
  text: string,
): { ok: true; payee: PayeeRef } | { ok: false; problem: string } {
  const value = text.trim();
  const colon = value.indexOf(":");
  if (colon === -1) {
    if (/^0x/i.test(value)) {
      return {
        ok: false,
        problem: `write near:${value} or base:${value}: a bare 0x value is both`,
      };
    }
    if (isNearAccountId(value)) return { ok: true, payee: { chain: "near", address: value } };
    return {
      ok: false,
      problem: "a payee is near:<account>, base:<0x address> or solana:<address>",
    };
  }
  const chain = value.slice(0, colon);
  const payee = { chain, address: value.slice(colon + 1) } as PayeeRef;
  if (chain !== "near" && chain !== "base" && chain !== "solana") {
    return { ok: false, problem: `${JSON.stringify(chain)} is not near, base or solana` };
  }
  const problem = payeeRefProblem(payee);
  return problem === null ? { ok: true, payee } : { ok: false, problem };
}

/** Why `ref` is not a payee the vault could pay, or null. The same formats `create_mandate` checks. */
export function payeeRefProblem(ref: PayeeRef): string | null {
  switch (ref.chain) {
    case "near":
      return isNearAccountId(ref.address) ? null : `${ref.address} is not a valid NEAR account id`;
    case "base":
      return isEvmAddress(ref.address)
        ? null
        : `${ref.address} is not a 0x-prefixed 20-byte address`;
    case "solana":
      return isSolanaAddress(ref.address) ? null : `${ref.address} is not a base58 Solana address`;
    default:
      return `${JSON.stringify((ref as { chain: unknown }).chain)} is not near, base or solana`;
  }
}

/** A NEAR account that no one registers: a 64-hex implicit or a 0x ETH-implicit account. A transfer creates it. */
export function isImplicitNearAccount(accountId: string): boolean {
  return IMPLICIT_RE.test(accountId) || ETH_IMPLICIT_RE.test(accountId);
}

/** One payee: the same chain, and the same address (a Base address in any letter case, like the vault compares it). */
export function samePayee(a: PayeeRef, b: PayeeRef): boolean {
  if (a.chain !== b.chain) return false;
  return a.chain === "base"
    ? a.address.toLowerCase() === b.address.toLowerCase()
    : a.address === b.address;
}

/** The hex digits of a Base address or an implicit NEAR account, lowercased; null for any other payee. */
function hexDigits(ref: PayeeRef): string | null {
  if (ref.chain === "base")
    return isEvmAddress(ref.address) ? ref.address.slice(2).toLowerCase() : null;
  if (ref.chain !== "near") return null;
  if (IMPLICIT_RE.test(ref.address)) return ref.address;
  if (ETH_IMPLICIT_RE.test(ref.address)) return ref.address.slice(2);
  return null;
}

/** Edit distance with adjacent swaps (Damerau-Levenshtein, optimal string alignment). */
export function editDistance(a: string, b: string): number {
  const w = b.length + 1;
  const d = new Array<number>((a.length + 1) * w).fill(0);
  const at = (i: number, j: number): number => d[i * w + j] ?? 0;
  for (let i = 0; i <= a.length; i++) d[i * w] = i;
  for (let j = 0; j <= b.length; j++) d[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1);
      }
      d[i * w + j] = best;
    }
  }
  return at(a.length, b.length);
}

/** Letters that read alike in an account name, folded to one: rn and m, l and 1, o and 0. */
function foldConfusables(text: string): string {
  return text.toLowerCase().replaceAll("rn", "m").replaceAll("l", "1").replaceAll("o", "0");
}

/**
 * How `payee` imitates `known`, or null when it does not. Never for the same payee: a Base address in other letter
 * case (an EIP-55 checksum) is the same address. Base and implicit NEAR addresses look alike when their first 4 and
 * last 4 hex digits match, the part a person checks by eye; Solana addresses the same way, in exact case (base58
 * is case-sensitive). Named NEAR accounts look alike when they are equal after folding rn/m, l/1 and o/0, or at
 * most 2 edits apart with both at least 6 characters long.
 */
export function lookalikeOf(payee: PayeeRef, known: PayeeRef): string | null {
  if (samePayee(payee, known)) return null;
  const hexA = hexDigits(payee);
  const hexB = hexDigits(known);
  if (hexA !== null || hexB !== null) {
    // The same digits on another chain is the same key holder, not an imitation.
    if (hexA === null || hexB === null || hexA.length !== hexB.length || hexA === hexB) return null;
    return edgesMatch(hexA, hexB) ? `the same first ${EDGE} and last ${EDGE} hex characters` : null;
  }
  if (payee.chain === "solana" || known.chain === "solana") {
    if (payee.chain !== known.chain) return null;
    return edgesMatch(payee.address, known.address)
      ? `the same first ${EDGE} and last ${EDGE} characters`
      : null;
  }
  if (payee.chain !== "near" || known.chain !== "near") return null;
  if (foldConfusables(payee.address) === foldConfusables(known.address)) {
    return "the same after reading rn as m, l as 1 and o as 0";
  }
  if (Math.min(payee.address.length, known.address.length) < LOOKALIKE_MIN_LENGTH) return null;
  const edits = editDistance(payee.address, known.address);
  if (edits > LOOKALIKE_MAX_EDITS) return null;
  return edits === 1 ? "one edit apart" : `${edits} edits apart`;
}

function edgesMatch(a: string, b: string): boolean {
  return a.slice(0, EDGE) === b.slice(0, EDGE) && a.slice(-EDGE) === b.slice(-EDGE);
}

function unknownLine(signals: PayeeSignals, name: PayeeSignalName): string {
  const why = signals.why_unknown?.[name];
  return why === undefined || why.trim() === "" ? "" : ` (${why.trim()})`;
}

function mandateList(known: KnownPayee): string {
  if (known.mandates.length === 0) return "a payee this vault paid";
  const ids = known.mandates.join(", ");
  return known.mandates.length === 1
    ? `the payee of mandate ${ids}`
    : `the payee of mandates ${ids}`;
}

/**
 * The verdict on a payee from its signals. Pure: the same signals and options give the same assessment. Every
 * signal adds one reason. A finding warns or blocks, a passed check is info, and a signal that could not be read
 * warns, so an assessment never allows a payee whose existence (or any other signal) is unknown.
 */
export function assessPayee(signals: PayeeSignals, opts: AssessPayeeOptions = {}): PayeeAssessment {
  const reasons: PayeeReason[] = [];
  const add = (id: PayeeReasonId, level: PayeeLevel, text: string, evidence?: string) => {
    reasons.push(evidence === undefined ? { id, level, text } : { id, level, text, evidence });
  };
  const { payee, network } = signals;
  const shown = formatPayeeRef(payee);
  const finish = (): PayeeAssessment => {
    const ranked = reasons
      .map((reason, order) => ({ reason, order }))
      .sort((x, y) => LEVEL_RANK[y.reason.level] - LEVEL_RANK[x.reason.level] || x.order - y.order)
      .map((r) => r.reason);
    const top = ranked.reduce((max, r) => Math.max(max, LEVEL_RANK[r.level]), 0);
    const verdict: PayeeVerdict = top === 2 ? "block" : top === 1 ? "warn" : "allow";
    return { verdict, reasons: ranked, network, payee: { ...payee }, checked_at: signals.read_at };
  };

  const problem = payeeRefProblem(payee);
  if (problem !== null) {
    add("invalid_address", "block", `${problem}: the vault could not pay it.`);
    return finish();
  }

  const blocklist = opts.blocklist ?? PAYEE_BLOCKLIST;
  const listed = blocklist.find((e) => e.network === network && samePayee(e.payee, payee));
  if (listed !== undefined) {
    add(
      "blocklisted",
      "block",
      `${shown} is on Probarion's seed blocklist: ${listed.reason}.`,
      listed.evidence,
    );
  } else {
    const n = blocklist.filter((e) => e.network === network).length;
    add(
      "not_blocklisted",
      "info",
      `Not on Probarion's seed blocklist for ${network} (${n} ${n === 1 ? "entry" : "entries"}; a seed list, not a reputation service).`,
    );
  }

  const knownPayees = opts.knownPayees !== undefined ? opts.knownPayees : signals.known_payees;
  if (knownPayees === "unknown") {
    add(
      "history_unknown",
      "warn",
      `Could not read this vault's mandates and spends, so past payments and lookalikes were not checked${unknownLine(signals, "known_payees")}.`,
    );
  } else if (knownPayees === null) {
    add(
      "history_not_checked",
      "info",
      "No vault given: past payments and lookalikes were not checked.",
    );
  } else {
    const others = knownPayees.filter((k) => !samePayee(k.payee, payee));
    let flagged = false;
    for (const known of others) {
      const how = lookalikeOf(payee, known.payee);
      if (how === null) continue;
      flagged = true;
      add(
        "lookalike",
        "block",
        `${shown} looks like ${formatPayeeRef(known.payee)}, ${mandateList(known)} (${how}). Check every character with the payee through another channel before you sign.`,
      );
    }
    if (!flagged) {
      const n = others.length;
      add(
        "no_lookalike",
        "info",
        `Looks like none of this vault's ${n} other ${n === 1 ? "payee" : "payees"}.`,
      );
    }
    const paid = knownPayees
      .filter((k) => samePayee(k.payee, payee))
      .reduce((sum, k) => sum + (Number.isSafeInteger(k.paid) && k.paid > 0 ? k.paid : 0), 0);
    if (paid > 0) {
      add(
        "paid_before",
        "info",
        `This vault paid ${shown} ${paid === 1 ? "once" : `${paid} times`} before.`,
      );
    } else {
      add(
        "first_payment",
        "warn",
        `This vault has never paid ${shown}. Set approval_above to 0 on its mandate, so an approver signs each payment until you trust this payee.`,
      );
    }
  }

  const chainName =
    payee.chain === "near" ? `NEAR ${network}` : payee.chain === "base" ? "Base" : "Solana";
  if (payee.chain === "near") {
    const implicit = isImplicitNearAccount(payee.address);
    if (signals.exists === true) {
      add("found", "info", `The account exists on ${chainName}.`);
    } else if (signals.exists === false) {
      if (implicit) {
        add(
          "not_found",
          "warn",
          `Implicit account ${payee.address} is not on ${chainName} yet: it has never been funded. A transfer creates it, so check every character with the payee.`,
        );
      } else {
        add(
          "not_found",
          "block",
          `No account ${payee.address} exists on ${chainName}. Check the name with the payee: whoever creates this account would receive the payments.`,
        );
      }
    } else {
      // "unknown", or a reader that left it out: a NEAR payee always has an existence to read.
      add(
        "exists_unknown",
        "warn",
        `Could not read whether ${payee.address} exists on ${chainName}${unknownLine(signals, "exists")}.`,
      );
    }
  }

  // Signals that do not apply are null: on NEAR, those of an account that is not there; code changes off NEAR.
  const missing = payee.chain === "near" && signals.exists === false;
  if (!missing) {
    if (signals.contract === true) {
      add(
        "contract",
        "warn",
        payee.chain === "near"
          ? `${shown} holds contract code, so its code decides where funds go next. A Safe or another multisig is also a contract: confirm whose it is.`
          : `${shown} has contract code on ${chainName}. A Safe is also a contract: confirm whose it is.`,
      );
    } else if (signals.contract === false) {
      add("no_contract", "info", `No contract code on ${chainName}: a plain account.`);
    } else {
      add(
        "contract_unknown",
        "warn",
        `Could not read whether ${shown} has contract code${unknownLine(signals, "contract")}.`,
      );
    }

    const block = signals.past_block === null ? "" : ` (block ${signals.past_block})`;
    if (signals.new_7d === true) {
      add(
        "new_7d",
        "warn",
        payee.chain === "near"
          ? `The account did not exist about 7 days ago${block}: it is new.`
          : `${shown} has sent no transaction on ${chainName} (nonce 0): it may be new or unused.`,
      );
    } else if (signals.new_7d === false) {
      add(
        "older_than_7d",
        "info",
        payee.chain === "near"
          ? `The account existed about 7 days ago${block}.`
          : `It has sent transactions on ${chainName} (nonce above 0).`,
      );
    } else {
      add(
        "age_unknown",
        "warn",
        `Could not read how old ${shown} is${unknownLine(signals, "new_7d")}.`,
      );
    }

    // A new NEAR account has no code from 7 days ago to compare (new_7d already warns). On Base a code change is
    // not read: any code at all is already the contract warning above.
    if (payee.chain === "near" && signals.new_7d !== true) {
      if (signals.code_changed_7d === true) {
        add(
          "code_changed_7d",
          "warn",
          `Its code changed in about the last 7 days${block}: check what it runs now.`,
        );
      } else if (signals.code_changed_7d === false) {
        add("code_unchanged_7d", "info", `Its code is the same as about 7 days ago${block}.`);
      } else {
        add(
          "code_change_unknown",
          "warn",
          `Could not compare its code with about 7 days ago${unknownLine(signals, "code_changed_7d")}.`,
        );
      }
    }
  }
  return finish();
}
