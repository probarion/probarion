// What the buyer keeps after a paid call: a check of the data it bought, and one JSON line per purchase in a
// receipts file. The check runs after the payment, so it cannot stop one: a failed check is recorded as such,
// and the money has already moved.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson, sha256Hex } from "@probarion/core";

/** The field of a paid answer that states the sha256 of the data, over its RFC 8785 canonical JSON. */
export const DATA_SHA256_FIELD = "data_sha256";

/** sha256 (lowercase hex) of the RFC 8785 canonical JSON of `data`: what the seller states and the buyer recomputes. */
export function dataSha256(data: unknown): string {
  return sha256Hex(canonicalJson(data));
}

/** A schema for the bought data: the problems it finds, none when the data fits. */
export type DataSchema = (data: unknown) => string[];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface DataCheck {
  /** True when the schema found nothing and the stated sha256 matches the one recomputed. */
  ok: boolean;
  schema_ok: boolean;
  sha256_ok: boolean;
  /** What the seller stated, or null when the answer has no such field. */
  stated_sha256: string | null;
  /** What the buyer computed from the data it got, or null when the data has no canonical JSON. */
  computed_sha256: string | null;
  problems: string[];
}

/** Checks the body of a paid answer: its `data` against the schema, and its stated sha256 against the data. */
export function checkBought(body: unknown, schema: DataSchema): DataCheck {
  const problems: string[] = [];
  const data = isRecord(body) ? body.data : undefined;
  if (data === undefined) problems.push("the answer has no data");
  const schemaProblems = data === undefined ? [] : schema(data);
  problems.push(...schemaProblems);
  const statedRaw = isRecord(body) ? body[DATA_SHA256_FIELD] : undefined;
  const stated = typeof statedRaw === "string" ? statedRaw : null;
  if (stated === null) problems.push(`the answer states no ${DATA_SHA256_FIELD}`);
  let computed: string | null = null;
  if (data !== undefined) {
    try {
      computed = dataSha256(data);
    } catch {
      problems.push("the data has no canonical JSON form");
    }
  }
  const sha256Ok = stated !== null && computed !== null && stated === computed;
  if (stated !== null && computed !== null && !sha256Ok) {
    problems.push(`${DATA_SHA256_FIELD} does not match the data`);
  }
  const schemaOk = data !== undefined && schemaProblems.length === 0;
  return {
    ok: schemaOk && sha256Ok,
    schema_ok: schemaOk,
    sha256_ok: sha256Ok,
    stated_sha256: stated,
    computed_sha256: computed,
    problems,
  };
}

/** One line of receipts.jsonl: one call that was paid and answered 200. */
export interface Receipt {
  v: 1;
  /** When the agent wrote the receipt (ISO 8601). */
  at: string;
  resource: string;
  /** The payee of the mandate the agent paid under, `near:<account>`. */
  seller: string;
  network: "mainnet" | "testnet";
  vault: string;
  mandate_id: number;
  /** The first quote's id. */
  quote_id: string;
  /** The id of the quote the seller issued for the counter, or null when the agent did not counter. */
  countered_quote_id: string | null;
  countered: boolean;
  list_price_usdc: string;
  paid_usdc: string;
  spend_id: number;
  /**
   * What this call's request_spend answered: `paid`; `held` or `unconfirmed` when the spend was then read
   * until paid; or a refusal (`refused_by_code`, `refused_by_contract`) that named an earlier spend paying
   * this same quote. tx_hash, tx, ledger_seq and decision_hash come from that answer: they are the payment's
   * own only when it is `paid`. Otherwise they point at that request (for a held spend, the transaction that
   * created it, not the approval that paid it; for a refusal, its ledger entry and no transaction).
   */
  request_status: string;
  tx_hash: string | null;
  /** The explorer link of the request's transaction, or null (no transaction, or a test double chain). */
  tx: string | null;
  /** The seq of the last entry this call's request_spend wrote to the vault's signed ledger. */
  ledger_seq: number | null;
  /** The body hash of that request's decision entry in the ledger. */
  decision_hash: string | null;
  data_check: DataCheck;
  /** Present when the data check failed: the payment was made before the check, and is not undone by it. */
  note?: string;
  /** Present when the chain was the SDK's test double: nothing real was paid. */
  test_double?: true;
}

export const FAILED_CHECK_NOTE =
  "The data failed its check after the payment was made: the money moved, and this check does not refund it. Take it up with the seller.";

/** Appends one receipt as one JSON line, creating the file and its folder when they are missing. */
export async function appendReceipt(path: string, receipt: Receipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(receipt)}\n`, "utf8");
}
