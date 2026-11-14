// N2: receipt-bound NEP-297 events. Any contract can log `EVENT_JSON:{"standard":"nep141",...}`, and a failed receipt
// keeps the logs it wrote before it failed, so an event means something when the contract that emitted it is the
// one it describes and its receipt succeeded. Every reader here takes the emitter as a required argument and, by
// default, counts receipts that succeeded. The idea comes from @probarion/sdk's snapshot.ts (eventItems,
// succeeded, findBurnPair); this module is stricter: an exact NEP-297 parse, typed NEP-141, NEP-245 and NEP-171
// data with canonical U128 amounts, and every refused event or item reported as a problem instead of skipped.
import { decodeBase64, isAccountId, isBase58Hash, isRecord, parseU128 } from "./encoding.js";
import { NearFormatError } from "./errors.js";
import type { OutcomeSource, ReceiptStatusKind } from "./types.js";

/** NEP-297: an event is one log line, this prefix and then one JSON object. */
export const EVENT_JSON_PREFIX = "EVENT_JSON:";

/** A NEP-297 event: `standard`, `version` and `event` are required, `data` is optional and its shape is the standard's. */
export interface Nep297Event {
  standard: string;
  version: string;
  event: string;
  data?: unknown;
}

export type EventLogParse =
  | { kind: "event"; event: Nep297Event }
  | { kind: "plain" } // no EVENT_JSON: prefix
  | { kind: "malformed"; problem: string }; // the prefix, but not a NEP-297 object

/** Bounds the text of a refused value kept in a problem. */
const MAX_DETAIL = 80;

/**
 * A refused value for a problem's text. Lists and objects are named by their shape, not serialized: a contract's
 * log can nest thousands of levels deep, and stringifying that could overflow the stack.
 */
function excerpt(value: unknown): string {
  if (Array.isArray(value)) return `a list of ${value.length}`;
  if (typeof value === "object" && value !== null) return "an object";
  const text = typeof value === "string" ? JSON.stringify(value) : String(value);
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}...` : text;
}

/**
 * One log line as NEP-297 reads it. The prefix is exact (case and position: `event_json:` or a leading space is a
 * plain log). The rest must be one JSON value (JSON allows whitespace around it) that is an object, not an array,
 * with non-empty string `standard`, `version` and `event`; `data`, when present, is kept as it is, and other fields
 * are dropped. Total: never throws, whatever it is given.
 */
export function parseEventLog(log: string): EventLogParse {
  if (typeof log !== "string") return { kind: "malformed", problem: "the log is not a string" };
  if (!log.startsWith(EVENT_JSON_PREFIX)) return { kind: "plain" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(log.slice(EVENT_JSON_PREFIX.length));
  } catch {
    return { kind: "malformed", problem: "the text after EVENT_JSON: is not JSON" };
  }
  if (!isRecord(parsed)) {
    return { kind: "malformed", problem: "the JSON after EVENT_JSON: is not an object" };
  }
  const { standard, version, event } = parsed;
  for (const [field, value] of [
    ["standard", standard],
    ["version", version],
    ["event", event],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      return { kind: "malformed", problem: `"${field}" is not a non-empty string` };
    }
  }
  const out: Nep297Event = {
    standard: standard as string,
    version: version as string,
    event: event as string,
  };
  if (Object.hasOwn(parsed, "data")) out.data = parsed.data;
  return { kind: "event", event: out };
}

/**
 * A receipt (or transaction) outcome status as RPC prints it: `{ SuccessValue: base64 }` or
 * `{ SuccessReceiptId: hash }` is success, `{ Failure: ... }` is failure. Missing, null, `"Unknown"`, a value that is
 * not canonical base64 or a 32-byte base58 hash, or an object with more than one variant is unknown: fail closed,
 * it does not count as a success.
 */
export function receiptStatusKind(status: unknown): ReceiptStatusKind {
  if (!isRecord(status)) return "unknown";
  const keys = Object.keys(status);
  if (keys.length !== 1) return "unknown";
  if (keys[0] === "Failure") return "failure";
  if (keys[0] === "SuccessValue" && decodeBase64(status.SuccessValue) !== null) return "success";
  if (keys[0] === "SuccessReceiptId" && isBase58Hash(status.SuccessReceiptId)) return "success";
  return "unknown";
}

export interface EventQuery {
  /** Required: there is no "any contract" mode. At runtime an empty list throws TypeError. */
  emitters: readonly [string, ...string[]];
  standard?: string;
  event?: string;
  /** Default "success": events of receipts whose status is SuccessValue or SuccessReceiptId. */
  status?: "success" | "any";
}

export interface BoundEvent extends Nep297Event {
  /** The outcome's id: the receipt id (the transaction hash for transaction_outcome). */
  receiptId: string;
  /** The account that ran the receipt and wrote the log (`executor_id`). */
  emitter: string;
  /** The log's index among all logs of that outcome, plain ones included. */
  logIndex: number;
  status: ReceiptStatusKind;
  /** True when read from ProvenOutcome[] (trusts the head), false from an RPC tx answer (trusts that RPC). */
  proven: boolean;
}

export interface EventProblem {
  receiptId: string;
  emitter: string;
  /** -1 when the problem is the outcome itself, not one of its logs. */
  logIndex: number;
  /**
   * A stable code, a colon, then the detail. Codes: `malformed_outcome`, `duplicate_outcome`, `malformed_event`,
   * `unknown_status`, `unsupported_version`, `bad_data`, `bad_item`.
   */
  problem: string;
}

// ---------- the source walk ----------

/** One outcome of a source, checked for the fields the readers use. */
interface WalkedOutcome {
  id: string;
  executor: string;
  logs: readonly string[];
  status: ReceiptStatusKind;
  proven: boolean;
}

interface WalkedSource {
  outcomes: WalkedOutcome[];
  problems: EventProblem[];
}

const PROVEN_STATUS_KIND: Readonly<Record<string, ReceiptStatusKind>> = {
  success_value: "success",
  success_receipt_id: "success",
  failure: "failure",
  unknown: "unknown",
};

function isLogList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((log) => typeof log === "string");
}

function problemAt(
  receiptId: string,
  emitter: string,
  logIndex: number,
  problem: string,
): EventProblem {
  return { receiptId, emitter, logIndex, problem };
}

function walkProven(value: unknown, index: number): WalkedOutcome | string {
  if (!isRecord(value)) return `proven outcome ${index} is not an object`;
  const { id, executorId, logs, status } = value;
  if (typeof id !== "string" || id.length === 0) return `proven outcome ${index} has no id`;
  if (typeof executorId !== "string") return `proven outcome ${id} has no executorId`;
  if (!isLogList(logs)) return `the logs of proven outcome ${id} are not a list of strings`;
  const kind =
    isRecord(status) &&
    typeof status.kind === "string" &&
    Object.hasOwn(PROVEN_STATUS_KIND, status.kind)
      ? PROVEN_STATUS_KIND[status.kind]
      : undefined;
  if (kind === undefined) return `the status of proven outcome ${id} is not a ProvenStatus`;
  return { id, executor: executorId, logs, status: kind, proven: true };
}

function walkRpc(value: unknown, where: string): WalkedOutcome | string {
  if (!isRecord(value)) return `${where} is not an object`;
  const { id, outcome } = value;
  if (typeof id !== "string" || id.length === 0) return `${where} has no id`;
  if (!isRecord(outcome)) return `${where} (${id}) has no outcome`;
  if (typeof outcome.executor_id !== "string") return `${where} (${id}) has no executor_id`;
  if (!isLogList(outcome.logs)) return `the logs of ${where} (${id}) are not a list of strings`;
  return {
    id,
    executor: outcome.executor_id,
    logs: outcome.logs,
    status: receiptStatusKind(outcome.status),
    proven: false,
  };
}

/**
 * The outcomes of a source in its order: `transaction_outcome` (when present) then `receipts_outcome`, or the
 * ProvenOutcome array as given. An outcome without the fields read here, or a second outcome with an id already
 * seen (its events would count twice), is a problem and is left out.
 */
function walkSource(source: unknown): WalkedSource {
  const outcomes: WalkedOutcome[] = [];
  const problems: EventProblem[] = [];
  const seen = new Set<string>();
  const add = (walked: WalkedOutcome | string) => {
    if (typeof walked === "string") {
      problems.push(problemAt("", "", -1, `malformed_outcome: ${walked}`));
    } else if (seen.has(walked.id)) {
      problems.push(
        problemAt(walked.id, walked.executor, -1, `duplicate_outcome: ${walked.id} appears twice`),
      );
    } else {
      seen.add(walked.id);
      outcomes.push(walked);
    }
  };
  if (Array.isArray(source)) {
    for (const [index, value] of source.entries()) add(walkProven(value, index));
  } else if (isRecord(source) && Array.isArray(source.receipts_outcome)) {
    if (source.transaction_outcome !== undefined) {
      add(walkRpc(source.transaction_outcome, "transaction_outcome"));
    }
    for (const [index, value] of source.receipts_outcome.entries()) {
      add(walkRpc(value, `receipts_outcome[${index}]`));
    }
  } else {
    problems.push(
      problemAt(
        "",
        "",
        -1,
        "malformed_outcome: the source is not a tx answer with receipts_outcome or a list of proven outcomes",
      ),
    );
  }
  return { outcomes, problems };
}

// ---------- queries ----------

interface CheckedQuery {
  emitters: ReadonlySet<string>;
  standard: string | undefined;
  event: string | undefined;
  status: "success" | "any";
}

function checkStatusOption(status: unknown, where: string): "success" | "any" {
  if (status === undefined) return "success";
  if (status !== "success" && status !== "any") {
    throw new TypeError(`${where}: status must be "success" or "any", not ${excerpt(status)}`);
  }
  return status;
}

function checkQuery(query: EventQuery): CheckedQuery {
  if (!isRecord(query)) throw new TypeError("eventsOf: the query is not an object");
  const emitters: unknown = query.emitters;
  if (!Array.isArray(emitters) || emitters.length === 0) {
    throw new TypeError(
      "eventsOf: emitters must list at least one account (there is no any-contract mode)",
    );
  }
  for (const emitter of emitters) {
    if (!isAccountId(emitter)) {
      throw new TypeError(`eventsOf: emitter ${excerpt(emitter)} is not a NEAR account id`);
    }
  }
  for (const field of ["standard", "event"] as const) {
    const value: unknown = query[field];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw new TypeError(`eventsOf: ${field} must be a non-empty string when given`);
    }
  }
  return {
    emitters: new Set(emitters as string[]),
    standard: query.standard,
    event: query.event,
    status: checkStatusOption(query.status, "eventsOf"),
  };
}

function bind(outcome: WalkedOutcome, logIndex: number, event: Nep297Event): BoundEvent {
  return {
    ...event,
    receiptId: outcome.id,
    emitter: outcome.executor,
    logIndex,
    status: outcome.status,
    proven: outcome.proven,
  };
}

/**
 * The events of the bound emitters, and (for the typed readers) what stood in the way of reading them all: the
 * walk's problems, a malformed EVENT_JSON: line written by a bound emitter in a counted receipt (it may be the
 * event a reader is after), and matching events left out because their receipt's status is unknown.
 */
function collect(
  walked: WalkedSource,
  query: CheckedQuery,
): { events: BoundEvent[]; problems: EventProblem[] } {
  const problems = [...walked.problems];
  const events: BoundEvent[] = [];
  for (const outcome of walked.outcomes) {
    if (!query.emitters.has(outcome.executor)) continue;
    const counted = query.status === "any" || outcome.status === "success";
    let hidden = 0;
    outcome.logs.forEach((log, logIndex) => {
      const parsed = parseEventLog(log);
      if (parsed.kind === "plain") return;
      if (parsed.kind === "malformed") {
        if (counted) {
          problems.push(
            problemAt(outcome.id, outcome.executor, logIndex, `malformed_event: ${parsed.problem}`),
          );
        }
        return;
      }
      const event = parsed.event;
      if (query.standard !== undefined && event.standard !== query.standard) return;
      if (query.event !== undefined && event.event !== query.event) return;
      if (counted) events.push(bind(outcome, logIndex, event));
      else if (outcome.status === "unknown") hidden++;
    });
    if (hidden > 0) {
      // A Failure is the normal case (its logs do not count); a missing status leaves the reader unable to tell.
      problems.push(
        problemAt(
          outcome.id,
          outcome.executor,
          -1,
          `unknown_status: ${hidden} matching event(s) not counted, the receipt's status is missing or not a known variant`,
        ),
      );
    }
  }
  return { events, problems };
}

/**
 * The NEP-297 events written by `query.emitters`, in source order (`transaction_outcome`, then `receipts_outcome`,
 * or the ProvenOutcome array order), filtered by `standard` and `event` when given. By default a receipt counts
 * when it succeeded; `status: "any"` returns failed and unknown ones too, each with its `status`. Plain and
 * malformed logs are skipped (`scanAllEvents` lists the malformed ones).
 *
 * Throws TypeError for an invalid query, and NearFormatError (`what` "source") when the source is not a tx answer
 * or a ProvenOutcome list, or holds an outcome without the fields read here or the same outcome twice: a reader
 * with no problem list refuses rather than return fewer events than the source holds.
 */
export function eventsOf(source: OutcomeSource, query: EventQuery): BoundEvent[] {
  const checked = checkQuery(query);
  const walked = walkSource(source);
  const broken = walked.problems[0];
  if (broken !== undefined) throw new NearFormatError("source", broken.problem);
  return collect(walked, checked).events;
}

/**
 * Every NEP-297 event of every outcome, any emitter and any status, plus every malformed EVENT_JSON: log and
 * malformed outcome. For diagnostics and display: none of it is bound to a contract, so none of it is evidence
 * that a token moved. Never throws.
 */
export function scanAllEvents(source: OutcomeSource): {
  events: BoundEvent[];
  malformed: EventProblem[];
} {
  const { outcomes, problems } = walkSource(source);
  const events: BoundEvent[] = [];
  for (const outcome of outcomes) {
    outcome.logs.forEach((log, logIndex) => {
      const parsed = parseEventLog(log);
      if (parsed.kind === "event") events.push(bind(outcome, logIndex, parsed.event));
      else if (parsed.kind === "malformed") {
        problems.push(
          problemAt(outcome.id, outcome.executor, logIndex, `malformed_event: ${parsed.problem}`),
        );
      }
    });
  }
  return { events, malformed: problems };
}

// ---------- typed standards ----------

export interface TypedItem<T> {
  item: T;
  /** The event the item came from (its receipt, emitter, log index, status). */
  event: BoundEvent;
  /** The item's index in the event's `data`. */
  itemIndex: number;
}

/** The items that passed the standard's schema, and every event or item that did not (none is dropped silently). */
export interface TypedEvents<T> {
  items: TypedItem<T>[];
  problems: EventProblem[];
}

export type FtEvent =
  | { event: "ft_mint" | "ft_burn"; ownerId: string; amount: bigint; memo: string | null }
  | {
      event: "ft_transfer";
      oldOwnerId: string;
      newOwnerId: string;
      amount: bigint;
      memo: string | null;
    };

export type MtEvent =
  | {
      event: "mt_mint";
      ownerId: string;
      tokenIds: readonly string[];
      amounts: readonly bigint[];
      memo: string | null;
    }
  | {
      event: "mt_burn";
      ownerId: string;
      authorizedId: string | null;
      tokenIds: readonly string[];
      amounts: readonly bigint[];
      memo: string | null;
    }
  | {
      event: "mt_transfer";
      oldOwnerId: string;
      newOwnerId: string;
      authorizedId: string | null;
      tokenIds: readonly string[];
      amounts: readonly bigint[];
      memo: string | null;
    };

export type NftEvent =
  | { event: "nft_mint"; ownerId: string; tokenIds: readonly string[]; memo: string | null }
  | {
      event: "nft_transfer";
      oldOwnerId: string;
      newOwnerId: string;
      authorizedId: string | null;
      tokenIds: readonly string[];
      memo: string | null;
    }
  | {
      event: "nft_burn";
      ownerId: string;
      authorizedId: string | null;
      tokenIds: readonly string[];
      memo: string | null;
    };

/** Why an item was refused: the text after `bad_item:`. */
class ItemError extends Error {}

/** Strict reads of one event item's fields; each throws ItemError on a value it refuses. */
class ItemReader {
  constructor(private readonly item: Record<string, unknown>) {}

  account(field: string): string {
    const value = this.item[field];
    if (!isAccountId(value)) {
      throw new ItemError(`${field} ${excerpt(value)} is not a NEAR account id`);
    }
    return value;
  }

  /** NEP-178's `authorized_id`: an account, null or absent (absent reads as null). */
  optionalAccount(field: string): string | null {
    const value = this.item[field];
    return value === undefined || value === null ? null : this.account(field);
  }

  amount(field: string): bigint {
    const value = this.item[field];
    const amount = parseU128(value);
    // A JSON number has already lost digits above 2^53, and "01" or "-1" is not a U128: both are refused.
    if (amount === null) {
      throw new ItemError(`${field} ${excerpt(value)} is not a canonical U128 decimal string`);
    }
    return amount;
  }

  memo(): string | null {
    const value = this.item.memo;
    if (value === undefined || value === null) return null;
    if (typeof value !== "string")
      throw new ItemError(`memo ${excerpt(value)} is not a string or null`);
    return value;
  }

  tokenIds(): string[] {
    const value = this.item.token_ids;
    if (!Array.isArray(value) || value.length === 0) {
      throw new ItemError("token_ids is not a list of at least one id");
    }
    for (const id of value) {
      if (typeof id !== "string") throw new ItemError(`token id ${excerpt(id)} is not a string`);
    }
    return [...(value as string[])];
  }

  /** NEP-245: `amounts[i]` is the amount of `token_ids[i]`, so the two lists have one length. */
  amountsFor(tokenIds: readonly string[]): bigint[] {
    const value = this.item.amounts;
    if (!Array.isArray(value)) throw new ItemError("amounts is not a list");
    if (value.length !== tokenIds.length) {
      throw new ItemError(
        `token_ids has ${tokenIds.length} entries and amounts has ${value.length}`,
      );
    }
    return value.map((amount: unknown, index) => {
      const parsed = parseU128(amount);
      if (parsed === null) {
        throw new ItemError(
          `amounts[${index}] ${excerpt(amount)} is not a canonical U128 decimal string`,
        );
      }
      return parsed;
    });
  }
}

type ItemParser<T> = (reader: ItemReader) => T;

/** Major version 1 in semver form (`1.0.0`, `1.2.0`): the schemas below are those of major version 1. */
const MAJOR_ONE_RE = /^1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

interface ReadOptions {
  status?: "success" | "any";
}

function readTyped<T>(
  source: OutcomeSource,
  emitter: string,
  standard: string,
  parsers: Readonly<Record<string, ItemParser<T>>>,
  opts: ReadOptions | undefined,
  where: string,
): TypedEvents<T> {
  if (!isAccountId(emitter)) {
    throw new TypeError(`${where}: ${excerpt(emitter)} is not a NEAR account id`);
  }
  if (opts !== undefined && !isRecord(opts)) throw new TypeError(`${where}: opts is not an object`);
  const status = checkStatusOption(opts?.status, where);
  const { events, problems } = collect(walkSource(source), {
    emitters: new Set([emitter]),
    standard,
    event: undefined,
    status,
  });
  const items: TypedItem<T>[] = [];
  for (const event of events) {
    const at = (problem: string) =>
      problemAt(event.receiptId, event.emitter, event.logIndex, problem);
    if (!MAJOR_ONE_RE.test(event.version)) {
      // A later major version may rename events or change their data: none of it is read.
      problems.push(
        at(
          `unsupported_version: ${standard} version ${excerpt(event.version)}, this reader reads 1.x.y`,
        ),
      );
      continue;
    }
    const parse = Object.hasOwn(parsers, event.event) ? parsers[event.event] : undefined;
    if (parse === undefined) continue; // another event of the standard (nft_metadata_update, ...): not typed here
    if (!Array.isArray(event.data)) {
      problems.push(at(`bad_data: the data of ${event.event} is not a list`));
      continue;
    }
    event.data.forEach((item: unknown, itemIndex) => {
      if (!isRecord(item)) {
        problems.push(at(`bad_item: ${event.event} item ${itemIndex} is not an object`));
        return;
      }
      try {
        items.push({ item: parse(new ItemReader(item)), event, itemIndex });
      } catch (error) {
        if (!(error instanceof ItemError)) throw error;
        problems.push(at(`bad_item: ${event.event} item ${itemIndex}: ${error.message}`));
      }
    });
  }
  return { items, problems };
}

const FT_PARSERS: Readonly<Record<string, ItemParser<FtEvent>>> = {
  ft_mint: (r) => ({
    event: "ft_mint",
    ownerId: r.account("owner_id"),
    amount: r.amount("amount"),
    memo: r.memo(),
  }),
  ft_burn: (r) => ({
    event: "ft_burn",
    ownerId: r.account("owner_id"),
    amount: r.amount("amount"),
    memo: r.memo(),
  }),
  ft_transfer: (r) => ({
    event: "ft_transfer",
    oldOwnerId: r.account("old_owner_id"),
    newOwnerId: r.account("new_owner_id"),
    amount: r.amount("amount"),
    memo: r.memo(),
  }),
};

const MT_PARSERS: Readonly<Record<string, ItemParser<MtEvent>>> = {
  mt_mint: (r) => {
    const tokenIds = r.tokenIds();
    return {
      event: "mt_mint",
      ownerId: r.account("owner_id"),
      tokenIds,
      amounts: r.amountsFor(tokenIds),
      memo: r.memo(),
    };
  },
  mt_burn: (r) => {
    const tokenIds = r.tokenIds();
    return {
      event: "mt_burn",
      ownerId: r.account("owner_id"),
      authorizedId: r.optionalAccount("authorized_id"),
      tokenIds,
      amounts: r.amountsFor(tokenIds),
      memo: r.memo(),
    };
  },
  mt_transfer: (r) => {
    const tokenIds = r.tokenIds();
    return {
      event: "mt_transfer",
      oldOwnerId: r.account("old_owner_id"),
      newOwnerId: r.account("new_owner_id"),
      authorizedId: r.optionalAccount("authorized_id"),
      tokenIds,
      amounts: r.amountsFor(tokenIds),
      memo: r.memo(),
    };
  },
};

const NFT_PARSERS: Readonly<Record<string, ItemParser<NftEvent>>> = {
  nft_mint: (r) => ({
    event: "nft_mint",
    ownerId: r.account("owner_id"),
    tokenIds: r.tokenIds(),
    memo: r.memo(),
  }),
  nft_transfer: (r) => ({
    event: "nft_transfer",
    oldOwnerId: r.account("old_owner_id"),
    newOwnerId: r.account("new_owner_id"),
    authorizedId: r.optionalAccount("authorized_id"),
    tokenIds: r.tokenIds(),
    memo: r.memo(),
  }),
  nft_burn: (r) => ({
    event: "nft_burn",
    ownerId: r.account("owner_id"),
    authorizedId: r.optionalAccount("authorized_id"),
    tokenIds: r.tokenIds(),
    memo: r.memo(),
  }),
};

/**
 * NEP-141 `ft_mint`, `ft_burn` and `ft_transfer` items logged by `token` itself (major version 1). Amounts are
 * canonical U128 decimal strings read as bigint; account ids must be valid; `memo` is a string, null or absent
 * (null). Other nep141 events are skipped; an event or item that breaks the schema is a problem, not an item.
 * Throws TypeError for an invalid `token` or option; a malformed source is a problem, not a throw.
 */
export function nep141Events(
  source: OutcomeSource,
  token: string,
  opts?: ReadOptions,
): TypedEvents<FtEvent> {
  return readTyped(source, token, "nep141", FT_PARSERS, opts, "nep141Events");
}

/**
 * NEP-245 `mt_mint`, `mt_burn` and `mt_transfer` items logged by `contract` itself (NEAR Intents' `intents.near`
 * is one). `token_ids` and `amounts` have one length, at least 1; `authorized_id` is an account, null or absent.
 * The rest as nep141Events.
 */
export function nep245Events(
  source: OutcomeSource,
  contract: string,
  opts?: ReadOptions,
): TypedEvents<MtEvent> {
  return readTyped(source, contract, "nep245", MT_PARSERS, opts, "nep245Events");
}

/**
 * NEP-171 `nft_mint`, `nft_transfer` and `nft_burn` items logged by `contract` itself. `token_ids` is a list of at
 * least one string; `authorized_id` is an account, null or absent. `contract_metadata_update` and
 * `nft_metadata_update` (versions 1.1.0 and 1.2.0) are skipped. The rest as nep141Events.
 */
export function nep171Events(
  source: OutcomeSource,
  contract: string,
  opts?: ReadOptions,
): TypedEvents<NftEvent> {
  return readTyped(source, contract, "nep171", NFT_PARSERS, opts, "nep171Events");
}

function addTo(deltas: Map<string, bigint>, key: string, change: bigint): void {
  deltas.set(key, (deltas.get(key) ?? 0n) + change);
}

/**
 * Net change per account from `token`'s own NEP-141 events in receipts that succeeded: mint +, burn -, transfer
 * - old and + new. An `ft_transfer_call` refund is the token's second `ft_transfer` (receiver back to sender,
 * logged by `ft_resolve_transfer`), so it nets out here. Every account an event names has an entry, 0n when it
 * nets to zero. The deltas are complete when `problems` is empty; with problems, some events were not counted.
 */
export function ftDeltas(
  source: OutcomeSource,
  token: string,
): { deltas: Map<string, bigint>; problems: EventProblem[] } {
  const { items, problems } = nep141Events(source, token);
  const deltas = new Map<string, bigint>();
  for (const { item } of items) {
    if (item.event === "ft_transfer") {
      addTo(deltas, item.oldOwnerId, -item.amount);
      addTo(deltas, item.newOwnerId, item.amount);
    } else {
      addTo(deltas, item.ownerId, item.event === "ft_mint" ? item.amount : -item.amount);
    }
  }
  return { deltas, problems };
}

/**
 * Net change per account and token id from `contract`'s own NEP-245 events in receipts that succeeded (outer map:
 * account; inner map: token id). The same rules as ftDeltas.
 */
export function mtDeltas(
  source: OutcomeSource,
  contract: string,
): { deltas: Map<string, Map<string, bigint>>; problems: EventProblem[] } {
  const { items, problems } = nep245Events(source, contract);
  const deltas = new Map<string, Map<string, bigint>>();
  const add = (account: string, tokenId: string, change: bigint) => {
    let perToken = deltas.get(account);
    if (perToken === undefined) {
      perToken = new Map();
      deltas.set(account, perToken);
    }
    addTo(perToken, tokenId, change);
  };
  for (const { item } of items) {
    item.tokenIds.forEach((tokenId, index) => {
      const amount = item.amounts[index] ?? 0n; // the schema check made the two lists one length
      if (item.event === "mt_transfer") {
        add(item.oldOwnerId, tokenId, -amount);
        add(item.newOwnerId, tokenId, amount);
      } else {
        add(item.ownerId, tokenId, item.event === "mt_mint" ? amount : -amount);
      }
    });
  }
  return { deltas, problems };
}
