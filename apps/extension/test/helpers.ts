import type { Fetch } from "../src/chrome";

export const ORIGIN = "https://probarion.vercel.app";
export const OTHER_ORIGIN = "https://probarion.xyz";
export const TOKEN = `pbx_${"A".repeat(43)}`;
export const NOW = Date.parse("2026-11-10T00:00:00.000Z");

export interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fake fetch that answers with `answer` and records every call. */
export function fetchOf(
  answer: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return { fetch, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const problem = (status: number, error: string, detail: string, headers = {}) =>
  json({ error, detail }, status, headers);

/** A fetch that can't reach anything, as when the computer is offline. */
export const offline: Fetch = () => Promise.reject(new TypeError("Failed to fetch"));

/** An inbox as GET /api/ext/inbox sends it: two invoices waiting, one held payment, two mandates. */
export function inboxBody(origin = ORIGIN) {
  const vault = "acme.vault.testnet";
  const base = `${origin}/console/${vault}`;
  return {
    network: "testnet",
    account: "owner.testnet",
    counts: { awaiting: 2, held: 1 },
    vaults: [
      {
        vault,
        name: "Acme operations",
        role: "owner",
        chain: "ok",
        awaiting: [
          {
            id: "6f1c2a90-0000-4000-8000-000000000001",
            ref: "INV-1038",
            amount: "1250",
            payee: "near:northwind.testnet",
            created_at: "2026-11-09T08:12:00.000Z",
            url: `${base}/payables/6f1c2a90-0000-4000-8000-000000000001`,
            source: "extension",
          },
          {
            id: "6f1c2a90-0000-4000-8000-000000000002",
            ref: "INV-0977",
            amount: "480.5",
            payee: null,
            created_at: "2026-11-08T15:40:00.000Z",
            url: `${base}/payables/6f1c2a90-0000-4000-8000-000000000002`,
            source: "console",
          },
        ],
        held: [
          {
            spend_id: 14,
            amount: "3200",
            payee: "near:contractor.testnet",
            held_until: "2026-11-10T09:00:00.000Z",
            url: base,
          },
        ],
        mandates: [
          {
            id: 3,
            label: "Northwind hosting",
            payee: "near:northwind.testnet",
            per_payment: "2000",
            remaining: "18750",
            expires_at: "2027-01-01T00:00:00.000Z",
          },
          {
            id: 5,
            label: "",
            payee: "near:contractor.testnet",
            per_payment: "5000",
            remaining: "40000",
            expires_at: "2027-01-01T00:00:00.000Z",
          },
        ],
      },
    ],
  };
}

/** A small PDF's bytes: what matters to the extension is that it starts with %PDF-. */
export const PDF = new Uint8Array(
  new TextEncoder().encode("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n"),
);
