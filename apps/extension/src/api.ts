import type { Fetch } from "./chrome";
import { isKnownOrigin } from "./origins";
import { field, isAccount, isNetwork, isTime, type Network, TOKEN_RE } from "./storage";

// The client of Probarion's extension API (spec §4.3). It sends a Bearer token and never cookies. Every failure
// becomes an ApiError carrying the sentence the popup shows (spec §5.6).

export interface InboxInvoice {
  id: string;
  ref: string;
  amount: string;
  payee: string | null;
  created_at: string;
  url: string;
  source: "console" | "extension";
}

export interface InboxHeld {
  spend_id: number;
  amount: string;
  payee: string;
  held_until: string | null;
  url: string;
}

export interface InboxMandate {
  id: number;
  label: string;
  payee: string;
  per_payment: string;
  remaining: string;
  expires_at: string;
}

export interface InboxVault {
  vault: string;
  name: string;
  role: "owner" | "approver";
  chain: "ok" | "unavailable";
  awaiting: InboxInvoice[];
  held: InboxHeld[];
  mandates: InboxMandate[];
}

export interface Inbox {
  network: Network;
  account: string;
  counts: { awaiting: number; held: number };
  vaults: InboxVault[];
}

export interface Paired {
  token: string;
  account: string;
  network: Network;
  expires_at: string;
}

export interface Sent {
  id: string;
  status: string;
  duplicate: boolean;
  url: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const RECONNECT = "Your connection expired. Reconnect";
export const OFFLINE = "Couldn't reach Probarion. Retry";

/** Characters that hide or reorder text. */
const hidden = (code: number) =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069) ||
  code === 0xfeff;

/** Text from the server, safe to show: no hidden characters, spaces collapsed, 300 characters at most. */
export function cleanText(v: unknown): string {
  if (typeof v !== "string") return "";
  return [...v]
    .filter((ch) => !hidden(ch.codePointAt(0) ?? 0))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** Plain words for the vault contract's codes a person can act on, as check_spend names them (contracts/vault/src/errors.rs). */
const VAULT_CODE_TEXT: Record<string, string> = {
  OverPerPayment: "the invoice is more than the mandate allows per payment.",
  OverMandateTotal: "the invoice is more than what is left of the mandate's total.",
  UsesExhausted: "the mandate has no payments left.",
  DuplicateInvoice: "the vault already has a payment for this invoice.",
  DuplicateRef: "the vault already has a payment for this invoice.",
  OverDailyBackstop: "paying it would pass the vault's daily limit.",
  MandateExpired: "the mandate has expired.",
  MandateInactive: "the mandate is no longer active.",
  Frozen: "the vault is frozen.",
};

/** "the vault would refuse this payment now (OverPerPayment)" in plain words, or the server's own detail. */
function refusal(detail: string): string {
  const named = /\(([A-Za-z]+)\)$/.exec(detail)?.[1];
  const plain =
    named !== undefined && Object.hasOwn(VAULT_CODE_TEXT, named)
      ? VAULT_CODE_TEXT[named]
      : undefined;
  return `Probarion's rules refused it: ${plain ?? (detail || "no reason given")}`;
}

/** The popup's sentence for a failed answer (spec §5.6). `detail` is the server's own, used where it says more. */
export function messageFor(
  status: number,
  code: string,
  detail: string,
  retryAfter: string | null,
): string {
  switch (status) {
    case 400:
      return detail || "Probarion couldn't read this request.";
    case 401:
      return code === "bad_code" ? detail || "This code is wrong, used or expired." : RECONNECT;
    case 403:
      // A Canary vault's own sentence (the inbox never lists one, so only a stale list reaches it); else the spec's.
      return detail.startsWith("This vault takes no invoices")
        ? detail
        : "You're not a member of this vault";
    case 404:
      return code === "mandate_not_found"
        ? "This mandate can't take invoices now"
        : "This Probarion address doesn't offer this yet. Try again later.";
    case 409:
      return code === "no_keys"
        ? "The vault's keys aren't active. Open the console's Keys tab."
        : detail || "Probarion refused this on this network.";
    case 411:
      return "Probarion couldn't read this request. Try again.";
    case 413:
      return "The invoice must be 4 MiB at most.";
    case 415:
      return "Send a PDF or a plain text (.txt) file.";
    case 422:
      // The server's sentence starts with the spec's and adds the reason.
      if (code === "mandate_inactive") return detail || "This mandate can't take invoices now";
      if (code === "amount_unclear")
        return "Couldn't read one clear amount. Upload it in the console instead.";
      if (code === "refused_by_code") return refusal(detail);
      if (code === "empty") return "No text in this file. Upload it in the console instead.";
      if (code === "unreadable")
        return "Couldn't read this file. Send a readable PDF or a UTF-8 text file.";
      return detail || "Probarion couldn't take this invoice.";
    case 429: {
      const seconds = /^[0-9]{1,5}$/.test(retryAfter ?? "") ? Number(retryAfter) : 60;
      return `Too many requests. Try again in ${seconds >= 120 ? `${Math.ceil(seconds / 60)} min` : `${seconds} s`}`;
    }
    default:
      return status >= 500
        ? detail || "Probarion couldn't do this now. Try again in a moment."
        : `Probarion answered ${status}. Try again.`;
  }
}

async function call(
  fetchFn: Fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      ...init,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError(0, "offline", OFFLINE);
  }
  if (res.ok) return res;
  const body: unknown = await res.json().catch(() => null);
  const code = typeof field(body, "error") === "string" ? (field(body, "error") as string) : "";
  throw new ApiError(
    res.status,
    code,
    messageFor(res.status, code, cleanText(field(body, "detail")), res.headers.get("retry-after")),
  );
}

const badAnswer = (what: string) =>
  new ApiError(
    200,
    "bad_answer",
    `Probarion sent ${what} this version can't read. Update the extension.`,
  );

/**
 * The console page a server link names, rebuilt at `origin`, the address this connection was made at; null when it
 * is not a console page of a Probarion address. The server writes its links at its network's one configured address
 * (apps/web/src/lib/network.ts softRequestOrigin), so a connection made at probarion.vercel.app gets probarion.xyz
 * links. The person's session cookie is on the address they connected through, so the link opens there.
 */
export function consoleLink(origin: string, url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (!isKnownOrigin(u.origin)) return null;
    if (u.pathname !== "/console" && !u.pathname.startsWith("/console/")) return null;
    return `${origin}${u.pathname}`;
  } catch {
    return null;
  }
}

const text = (v: unknown, max: number): string | null => {
  const t = cleanText(v).slice(0, max);
  return t === "" ? null : t;
};
const count = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const id = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v < 1e15 ? v : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, 50) : []);

/** A payee is the one string a person relies on, so it is never cut short: 160 holds a 124-character Solana payee. */
const PAYEE_MAX = 160;

/** GET /api/ext/inbox as the popup shows it. A row it can't show, or whose link leaves the console, is dropped. */
export function readInbox(raw: unknown, origin: string): Inbox {
  const network = field(raw, "network");
  const account = field(raw, "account");
  if (!isNetwork(network) || !isAccount(account)) throw badAnswer("a list");
  const vaults = list(field(raw, "vaults")).flatMap((v): InboxVault[] => {
    const vault = text(field(v, "vault"), 64);
    const role = field(v, "role");
    if (vault === null || (role !== "owner" && role !== "approver")) return [];
    return [
      {
        vault,
        name: text(field(v, "name"), 64) ?? vault,
        role,
        chain: field(v, "chain") === "ok" ? "ok" : "unavailable",
        awaiting: list(field(v, "awaiting")).flatMap((a): InboxInvoice[] => {
          const invoice = text(field(a, "id"), 64);
          const url = consoleLink(origin, field(a, "url"));
          if (invoice === null || url === null) return [];
          return [
            {
              id: invoice,
              ref: text(field(a, "ref"), 64) ?? "",
              amount: text(field(a, "amount"), 40) ?? "unreadable",
              payee: text(field(a, "payee"), PAYEE_MAX),
              created_at: text(field(a, "created_at"), 40) ?? "",
              url,
              source: field(a, "source") === "extension" ? "extension" : "console",
            },
          ];
        }),
        held: list(field(v, "held")).flatMap((h): InboxHeld[] => {
          const spend = id(field(h, "spend_id"));
          const url = consoleLink(origin, field(h, "url"));
          if (spend === null || url === null) return [];
          return [
            {
              spend_id: spend,
              amount: text(field(h, "amount"), 40) ?? "unreadable",
              payee: text(field(h, "payee"), PAYEE_MAX) ?? "an unreadable payee",
              held_until: text(field(h, "held_until"), 40),
              url,
            },
          ];
        }),
        mandates: list(field(v, "mandates")).flatMap((m): InboxMandate[] => {
          const mandate = id(field(m, "id"));
          const payee = text(field(m, "payee"), PAYEE_MAX);
          if (mandate === null || payee === null) return [];
          return [
            {
              id: mandate,
              label: text(field(m, "label"), 64) ?? "",
              payee,
              per_payment: text(field(m, "per_payment"), 40) ?? "unreadable",
              remaining: text(field(m, "remaining"), 40) ?? "unreadable",
              expires_at: text(field(m, "expires_at"), 40) ?? "",
            },
          ];
        }),
      },
    ];
  });
  const counts = field(raw, "counts");
  return {
    network,
    account,
    counts: { awaiting: count(field(counts, "awaiting")), held: count(field(counts, "held")) },
    vaults,
  };
}

function readPaired(raw: unknown): Paired {
  const token = field(raw, "token");
  const account = field(raw, "account");
  const network = field(raw, "network");
  const expires = field(raw, "expires_at");
  if (typeof token !== "string" || !TOKEN_RE.test(token) || !isAccount(account))
    throw badAnswer("a connection");
  if (!isNetwork(network) || !isTime(expires)) throw badAnswer("a connection");
  return { token, account, network, expires_at: expires };
}

function readSent(raw: unknown, origin: string): Sent {
  const invoice = text(field(raw, "invoice_id"), 64);
  const status = text(field(raw, "status"), 32);
  const url = consoleLink(origin, field(raw, "url"));
  if (invoice === null || status === null || url === null) throw badAnswer("an answer");
  return { id: invoice, status, duplicate: field(raw, "duplicate") === true, url };
}

/** Probarion's extension API at `origin`. */
export function api(origin: string, fetchFn: Fetch) {
  const at = (path: string) => `${origin}${path}`;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  return {
    /** The pairing-code fallback. No token: the code is the credential. */
    async pair(code: string, label: string): Promise<Paired> {
      const res = await call(
        fetchFn,
        at("/api/ext/pair"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, label }),
        },
        15_000,
      );
      return readPaired(await res.json().catch(() => null));
    },
    async inbox(token: string): Promise<Inbox> {
      const res = await call(fetchFn, at("/api/ext/inbox"), { headers: bearer(token) }, 30_000);
      return readInbox(await res.json().catch(() => null), origin);
    },
    /** Queues the invoice. The server's limit is 60 s; the client waits a little longer before it says "Retry". */
    async sendInvoice(
      token: string,
      i: { vault: string; mandate: number; file: Blob; name: string },
    ): Promise<Sent> {
      const form = new FormData();
      form.set("vault", i.vault);
      form.set("mandate", String(i.mandate));
      form.set("file", i.file, i.name);
      const res = await call(
        fetchFn,
        at("/api/ext/invoices"),
        { method: "POST", headers: bearer(token), body: form },
        70_000,
      );
      return readSent(await res.json().catch(() => null), origin);
    },
    async revoke(token: string): Promise<void> {
      await call(
        fetchFn,
        at("/api/ext/revoke"),
        { method: "POST", headers: bearer(token) },
        15_000,
      );
    },
  };
}
