// The /check page's pure parts: the form's input, the examples, the requests the browser sent and what each read
// gave, and the words for a verdict. The page (PayeeCheck.tsx) runs `readPayeeSignals` in the browser and core's
// `assessPayee` on what it read. Nothing here touches the network, and nothing here turns a read that failed into
// anything but "unknown".
import {
  isNearAccountId,
  type NetworkId,
  PAYEE_BLOCKLIST,
  type PayeeAssessment,
  type PayeeLevel,
  type PayeeRef,
  type PayeeSignals,
  type PayeeVerdict,
  parsePayeeRef,
} from "@probarion/core";
import type { Tone } from "@/components/ui";

export interface CheckInput {
  network: NetworkId;
  payee: PayeeRef;
  vault?: string;
}

export interface CheckForm {
  network: string;
  payee: string;
  vault: string;
}

export type FormResult =
  | { ok: true; input: CheckInput }
  | { ok: false; field: "network" | "payee" | "vault"; problem: string };

const isNetworkId = (value: string): value is NetworkId =>
  value === "mainnet" || value === "testnet";

/** The form as a check to run, or the one field that is wrong and why. The same payee formats as the CLI. */
export function parseCheckForm(form: CheckForm): FormResult {
  if (!isNetworkId(form.network)) {
    return { ok: false, field: "network", problem: "Choose mainnet or testnet." };
  }
  if (form.payee.trim() === "") {
    return { ok: false, field: "payee", problem: "Name a payee." };
  }
  const parsed = parsePayeeRef(form.payee);
  if (!parsed.ok) return { ok: false, field: "payee", problem: `${sentence(parsed.problem)}.` };
  const vault = form.vault.trim();
  if (vault === "") return { ok: true, input: { network: form.network, payee: parsed.payee } };
  if (!isNearAccountId(vault)) {
    return { ok: false, field: "vault", problem: `${vault} is not a NEAR account id.` };
  }
  return { ok: true, input: { network: form.network, payee: parsed.payee, vault } };
}

function sentence(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

/**
 * A soft note when a named NEAR payee ends in the other network's suffix (a `.near` name on testnet, say). The check
 * still runs: such a name is not on the chosen network, and `not_found` says so.
 */
export function networkHint(input: CheckInput): string | null {
  if (input.payee.chain !== "near") return null;
  const other: NetworkId = input.network === "mainnet" ? "testnet" : "mainnet";
  const suffix = other === "mainnet" ? ".near" : ".testnet";
  return input.payee.address.endsWith(suffix)
    ? `${input.payee.address} ends in ${suffix}, a ${other} name, and the network chosen is ${input.network}.`
    : null;
}

// --- examples --------------------------------------------------------------------------------------------------

export interface Example {
  id: string;
  label: string;
  note: string;
  form: CheckForm;
}

/** The mainnet vault of the S1 and S2 payouts, and the payees its mandates name (read from the chain on 2026-11-13). */
const MAINNET_VAULT = "v0.probarion.near";
const MANDATE_1_PAYEE = "probarion-duong.near";
const BASE_PAYEE = "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27";
/** Made up for this page: the Base payee's first and last 4 hex characters around zeros. No one is known to hold it. */
export const POISONED_BASE = `0xB22E${"0".repeat(32)}EB27`;

/** One click fills the form and runs it. Each example reads live, so its answer is what the chain says now. */
export const EXAMPLES: readonly Example[] = [
  {
    id: "mandate-1",
    label: "Mandate 1's payee",
    note: `Mainnet: the payee of mandate 1 of ${MAINNET_VAULT}, the owner's own account.`,
    form: { network: "mainnet", payee: `near:${MANDATE_1_PAYEE}`, vault: MAINNET_VAULT },
  },
  {
    id: "one-letter-off",
    label: "One letter off",
    note: `Mainnet: probarion-duonq.near, one edit from mandate 1's payee.`,
    form: { network: "mainnet", payee: "near:probarion-duonq.near", vault: MAINNET_VAULT },
  },
  {
    id: "base-payee",
    label: "The Base payee",
    note: "Mainnet: the owner's own Base address, the payee of mandates 2 and 3.",
    form: { network: "mainnet", payee: `base:${BASE_PAYEE}`, vault: MAINNET_VAULT },
  },
  {
    id: "poisoned-base",
    label: "A poisoned Base address",
    note: "Made up for this page: the same first and last 4 hex characters as the Base payee.",
    form: { network: "mainnet", payee: `base:${POISONED_BASE}`, vault: MAINNET_VAULT },
  },
  {
    id: "blocklisted",
    label: "A blocklisted name",
    note: "Testnet: the attacker's account in Probarion's own eval cases, with no vault.",
    form: { network: "testnet", payee: "near:attacker-eval.testnet", vault: "" },
  },
];

/** The example a form is, if it is one. */
export function exampleFor(form: CheckForm): Example | null {
  return (
    EXAMPLES.find(
      (e) =>
        e.form.network === form.network &&
        e.form.payee === form.payee.trim() &&
        e.form.vault === form.vault.trim(),
    ) ?? null
  );
}

// --- a check in the address bar ---------------------------------------------------------------------------------

/**
 * `#network=…&payee=…&vault=…`: a check a link can carry. The fragment never reaches a server, so a shared link sends
 * the payee to no one but the nodes the check reads.
 */
export function formToHash(form: CheckForm): string {
  const params = new URLSearchParams({ network: form.network, payee: form.payee.trim() });
  if (form.vault.trim() !== "") params.set("vault", form.vault.trim());
  return `#${params.toString()}`;
}

/** A check as the form shows it. */
export function formOf(input: CheckInput): CheckForm {
  return {
    network: input.network,
    payee: `${input.payee.chain}:${input.payee.address}`,
    vault: input.vault ?? "",
  };
}

/** The form a fragment names, or null when it names no payee. A missing network is left to the page. */
export function formFromHash(hash: string): Partial<CheckForm> | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const payee = params.get("payee");
  if (payee === null || payee.trim() === "") return null;
  const out: Partial<CheckForm> = { payee: payee.trim() };
  const network = params.get("network");
  if (network !== null && isNetworkId(network)) out.network = network;
  const vault = params.get("vault");
  if (vault !== null) out.vault = vault.trim();
  return out;
}

// --- the requests the browser sent ---------------------------------------------------------------------------------

/** Which read a request was for: it decides the row of "What we read, from where" it belongs to. */
export type ReadId =
  | "account_now"
  | "account_past"
  | "history"
  | "base_code"
  | "base_nonce"
  | "other";

export interface RequestEntry {
  /** Milliseconds from the start of the check to the answer (or the failure). */
  at: number;
  host: string;
  /** The JSON-RPC call, in words: `view_account vendor.near at block 1234`. */
  call: string;
  read: ReadId;
  /** `HTTP 200`, `HTTP 429`, or why there was no answer. */
  answer: string;
  ms: number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** What a JSON-RPC body asks for, in words, and which read it serves. */
export function describeCall(body: unknown): { call: string; read: ReadId } {
  let parsed: unknown;
  try {
    parsed = typeof body === "string" ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }
  if (!isObject(parsed) || typeof parsed.method !== "string")
    return { call: "a request", read: "other" };
  const { method } = parsed;
  const params = isObject(parsed.params) ? parsed.params : {};
  const at = typeof params.block_id === "number" ? `at block ${params.block_id}` : "at final";
  if (method === "block") return { call: `block header ${at}`, read: "account_past" };
  if (method === "query" && params.request_type === "view_account") {
    const account = String(params.account_id);
    return {
      call: `view_account ${account} ${at}`,
      read: typeof params.block_id === "number" ? "account_past" : "account_now",
    };
  }
  if (method === "query" && params.request_type === "call_function") {
    return {
      call: `${String(params.method_name)} on ${String(params.account_id)}`,
      read: "history",
    };
  }
  const first = Array.isArray(parsed.params) ? String(parsed.params[0]) : "";
  if (method === "eth_getCode") return { call: `eth_getCode ${first}`, read: "base_code" };
  if (method === "eth_getTransactionCount") {
    return { call: `eth_getTransactionCount ${first}`, read: "base_nonce" };
  }
  return { call: method, read: "other" };
}

function failureText(error: unknown): string {
  if (isObject(error) && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "no answer in time";
  }
  return "no answer (network or CORS error)";
}

/**
 * `inner`, with every request it sends written down: the host, the call and the HTTP status or the failure. The
 * answer itself goes back untouched; reading it stays the SDK's job.
 */
export function recordingFetch(
  inner: typeof fetch,
  onEntry: (entry: RequestEntry) => void,
  clock: () => number,
): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const started = clock();
    const { call, read } = describeCall(init?.body);
    const entry = (answer: string) => {
      const ended = clock();
      onEntry({
        at: Math.round(ended),
        host: hostOf(url),
        call,
        read,
        answer,
        ms: Math.round(ended - started),
      });
    };
    try {
      const response = await inner(input, init);
      entry(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      entry(failureText(error));
      throw error;
    }
  };
}

// --- what we read, from where -----------------------------------------------------------------------------------

export type RowState = "read" | "unknown" | "not_read";

export interface ReadRow {
  id: "blocklist" | Exclude<ReadId, "other"> | "solana";
  /** What was read. */
  what: string;
  /** The call, and what the verdict uses it for. */
  how: string;
  /** The hosts that answered or were asked, in the order they were first asked. */
  from: string[];
  state: RowState;
  value: string;
}

function hostsFor(log: readonly RequestEntry[], read: ReadId): string[] {
  return [...new Set(log.filter((e) => e.read === read).map((e) => e.host))];
}

function unknownValue(signals: PayeeSignals, name: keyof PayeeSignals["why_unknown"]): string {
  const why = signals.why_unknown[name];
  return typeof why === "string" && why.trim() !== "" ? `unknown: ${why.trim()}` : "unknown";
}

/** Probarion's seed blocklist for one network: how many entries it has. */
export function blocklistCount(network: NetworkId): number {
  return PAYEE_BLOCKLIST.filter((e) => e.network === network).length;
}

/**
 * One row per read the check made or could not make, from the signals and the requests the browser sent. A signal
 * that is "unknown" shows as unknown with its reason; one that does not apply says why it was not read.
 */
export function readRows(
  input: CheckInput,
  signals: PayeeSignals,
  assessment: PayeeAssessment,
  log: readonly RequestEntry[],
): ReadRow[] {
  const n = blocklistCount(input.network);
  const listed = assessment.reasons.some((r) => r.id === "blocklisted");
  const rows: ReadRow[] = [
    {
      id: "blocklist",
      what: "Probarion's seed blocklist",
      how: `${n} ${n === 1 ? "entry" : "entries"} for ${input.network}, shipped in this page's code (payee-blocklist.json)`,
      from: ["this page"],
      state: "read",
      value: listed ? "listed" : "not listed",
    },
  ];
  const { payee } = input;
  if (payee.chain === "near") {
    const now: ReadRow = {
      id: "account_now",
      what: "The account now",
      how: "view_account at the final block: does it exist, does it hold code",
      from: hostsFor(log, "account_now"),
      state: "read",
      value: "",
    };
    if (signals.exists === true) {
      now.value =
        signals.contract === true
          ? "exists, holds contract code"
          : signals.contract === false
            ? "exists, no contract code"
            : `exists; code ${unknownValue(signals, "contract")}`;
    } else if (signals.exists === false) {
      now.value = "no account";
    } else {
      now.state = "unknown";
      now.value = unknownValue(signals, "exists");
    }
    const past: ReadRow = {
      id: "account_past",
      what: "The account about 7 days ago",
      how: "two block headers give the block about 7 days back, then view_account at that block on an archival node: is it new, did its code change",
      from: hostsFor(log, "account_past"),
      state: "read",
      value: "",
    };
    if (signals.exists === false) {
      past.state = "not_read";
      past.value = "not used: there is no account now";
    } else if (signals.new_7d === true) {
      past.value = `no account at block ${signals.past_block ?? "about 7 days back"}: new`;
    } else if (signals.new_7d === false) {
      const code =
        signals.code_changed_7d === true
          ? "its code changed since"
          : signals.code_changed_7d === false
            ? "the same code as now"
            : `code ${unknownValue(signals, "code_changed_7d")}`;
      past.value = `existed at block ${signals.past_block ?? "about 7 days back"}, ${code}`;
      if (signals.code_changed_7d === "unknown") past.state = "unknown";
    } else {
      past.state = "unknown";
      past.value = unknownValue(signals, "new_7d");
    }
    rows.push(now, past);
  } else if (payee.chain === "base") {
    const code: ReadRow = {
      id: "base_code",
      what: "Code at the Base address",
      how: "eth_getCode at latest: is it a contract",
      from: hostsFor(log, "base_code"),
      state: "read",
      value:
        signals.contract === true
          ? "contract code"
          : signals.contract === false
            ? "no code (0x)"
            : "",
    };
    if (signals.contract !== true && signals.contract !== false) {
      code.state = "unknown";
      code.value = unknownValue(signals, "contract");
    }
    const nonce: ReadRow = {
      id: "base_nonce",
      what: "Transactions sent from the Base address",
      how: "eth_getTransactionCount at latest: a nonce of 0 is a weaker sign of a new address (a nonce does not show age)",
      from: hostsFor(log, "base_nonce"),
      state: "read",
      value: signals.new_7d === true ? "nonce 0" : signals.new_7d === false ? "nonce above 0" : "",
    };
    if (signals.new_7d !== true && signals.new_7d !== false) {
      nonce.state = "unknown";
      nonce.value = unknownValue(signals, "new_7d");
    }
    rows.push(code, nonce);
  } else {
    rows.push({
      id: "solana",
      what: "The Solana address",
      how: "contract code and age",
      from: [],
      state: "unknown",
      value: unknownValue(signals, "contract"),
    });
  }
  const history: ReadRow = {
    id: "history",
    what: input.vault === undefined ? "The vault's payees" : `The payees of ${input.vault}`,
    how: "list_mandates and list_spends: lookalikes of its payees, and past payments",
    from: hostsFor(log, "history"),
    state: "read",
    value: "",
  };
  if (signals.known_payees === null) {
    history.state = "not_read";
    history.value = "not read: no vault given, so this is a warning";
  } else if (signals.known_payees === "unknown" || !Array.isArray(signals.known_payees)) {
    history.state = "unknown";
    history.value = unknownValue(signals, "known_payees");
  } else {
    const k = signals.known_payees.length;
    history.value = `${k} ${k === 1 ? "payee" : "payees"} in its mandates and spends`;
  }
  rows.push(history);
  return rows;
}

// --- words for a verdict ---------------------------------------------------------------------------------------

export const VERDICT_WORDS: Readonly<
  Record<PayeeVerdict, { label: string; tone: Tone; line: string }>
> = {
  allow: { label: "Allow", tone: "good", line: "Every check passed." },
  warn: {
    label: "Warn",
    tone: "warn",
    line: "Confirm something with the payee first, or a signal could not be read.",
  },
  block: {
    label: "Block",
    tone: "bad",
    line: "A reason not to write this payee into a mandate.",
  },
};

export const LEVEL_TONES: Readonly<Record<PayeeLevel, Tone>> = {
  info: "neutral",
  warn: "warn",
  block: "bad",
};

/** The one line a screen reader hears when a check ends. */
export function statusLine(assessment: PayeeAssessment): string {
  const n = assessment.reasons.length;
  const top = assessment.reasons.filter((r) => r.level !== "info").length;
  return `${VERDICT_WORDS[assessment.verdict].label}: ${n} ${n === 1 ? "reason" : "reasons"}, ${top} of them ${top === 1 ? "a warning or a block" : "warnings or blocks"}.`;
}

/** "2026-11-13 20:51:30 UTC" for an ISO time; anything else as it is. */
export function utc(at: string): string {
  const t = Date.parse(at);
  return Number.isNaN(t) ? at : `${new Date(t).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** The same check from a clone's terminal, once the CLI is built. */
export function cliCommand(input: CheckInput): string {
  const ref = `${input.payee.chain}:${input.payee.address}`;
  const vault = input.vault === undefined ? "" : ` --vault ${input.vault}`;
  return `node packages/cli/dist/bin.js payee check ${ref} --network ${input.network}${vault}`;
}
