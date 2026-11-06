// The shape of what the Canary page reads from the database: the leaderboard (service role, behind a cache) and the
// public feed. Both come from `public_canary_*` functions (migration 0008) and are checked here before a number or a
// word of them reaches the page, so a changed or damaged answer shows "not available" and never a wrong figure.
import { isRecord } from "./format";

export interface TechniqueRow {
  technique: string;
  attempts: number;
  refused_by_code: number;
  refused_by_contract: number;
  held: number;
}

export interface Board {
  /** Distinct visitor cookies of outside visitors. A script that sends none adds one per request. */
  browsers: number;
  /** Distinct IP hashes of outside visitors. A script that rotates addresses adds one per address. */
  addresses: number;
  /** The lower of the two above: a visitor count the page can stand behind, and says what it is. */
  visitors: number;
  attempts_external: number;
  attempts_team: number;
  raw_external: number;
  techniques: TechniqueRow[];
  contract_codes: { code: string; n: number }[];
}

export interface FeedRow {
  created_at: string;
  techniques: string[];
  /** Includes `killed`: an attempt that never closed its row. */
  code_status: string;
  code_rule: string | null;
  raw: boolean;
  contract_status: string | null;
  contract_code: string | null;
  tx_hash: string | null;
  is_team: boolean;
}

/** A count: a whole number, zero or more. */
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isLabel = (v: unknown): v is string => typeof v === "string" && v.length > 0;
/** A nullable column: a string, null, or absent. */
const isMaybeText = (v: unknown): v is string | null | undefined =>
  v === null || v === undefined || typeof v === "string";

function parseTechnique(v: unknown): TechniqueRow | null {
  if (!isRecord(v)) return null;
  const { technique, attempts, refused_by_code, refused_by_contract, held } = v;
  if (
    !isLabel(technique) ||
    !isCount(attempts) ||
    !isCount(refused_by_code) ||
    !isCount(refused_by_contract) ||
    !isCount(held)
  ) {
    return null;
  }
  return { technique, attempts, refused_by_code, refused_by_contract, held };
}

function parseCode(v: unknown): { code: string; n: number } | null {
  if (!isRecord(v) || !isLabel(v.code) || !isCount(v.n)) return null;
  return { code: v.code, n: v.n };
}

/** Every row, or null when any one is malformed: a scoreboard with a row missing would be a wrong one. */
function all<T>(list: unknown, one: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(list)) return null;
  const out: T[] = [];
  for (const item of list) {
    const row = one(item);
    if (row === null) return null;
    out.push(row);
  }
  return out;
}

/** The leaderboard, or null when anything in it is malformed. Only the fields the page shows are kept. */
export function parseBoard(json: unknown): Board | null {
  if (!isRecord(json)) return null;
  const { browsers, addresses, attempts_external, attempts_team, raw_external } = json;
  if (
    !isCount(browsers) ||
    !isCount(addresses) ||
    !isCount(attempts_external) ||
    !isCount(attempts_team) ||
    !isCount(raw_external)
  ) {
    return null;
  }
  const techniques = all(json.techniques, parseTechnique);
  const contract_codes = all(json.contract_codes, parseCode);
  if (techniques === null || contract_codes === null) return null;
  return {
    browsers,
    addresses,
    visitors: Math.min(browsers, addresses),
    attempts_external,
    attempts_team,
    raw_external,
    techniques,
    contract_codes,
  };
}

/** What the contract itself refused: the sum of the codes it returned. */
export const refusedOnChain = (board: Board): number =>
  board.contract_codes.reduce((sum, c) => sum + c.n, 0);

function parseRow(v: unknown): FeedRow | null {
  if (!isRecord(v)) return null;
  const {
    created_at,
    techniques,
    code_status,
    code_rule,
    raw,
    contract_status,
    contract_code,
    tx_hash,
    is_team,
  } = v;
  if (
    typeof created_at !== "string" ||
    Number.isNaN(Date.parse(created_at)) ||
    !Array.isArray(techniques) ||
    !techniques.every((t) => typeof t === "string") ||
    !isLabel(code_status) ||
    typeof raw !== "boolean" ||
    typeof is_team !== "boolean" ||
    !isMaybeText(code_rule) ||
    !isMaybeText(contract_status) ||
    !isMaybeText(contract_code) ||
    !isMaybeText(tx_hash)
  ) {
    return null;
  }
  return {
    created_at,
    techniques: techniques as string[],
    code_status,
    code_rule: code_rule ?? null,
    raw,
    contract_status: contract_status ?? null,
    contract_code: contract_code ?? null,
    tx_hash: tx_hash ?? null,
    is_team,
  };
}

/** The feed's rows that are well formed, in the order given. Anything that is not a list is an empty feed. */
export function parseFeed(json: unknown): FeedRow[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((item) => {
    const row = parseRow(item);
    return row === null ? [] : [row];
  });
}
