// A stand-in for chrome.* and for GET /api/ext/inbox, for the store screenshots only (scripts/render.mjs).
const ORIGIN = "https://probarion.xyz";
const VAULT = "acme.vault.testnet";
const local = {
  schema: 1,
  selectedOrigin: ORIGIN,
  connections: {
    [ORIGIN]: {
      network: "testnet",
      account: "acme-finance.testnet",
      token: `pbx_${"x".repeat(43)}`,
      expires_at: "2030-01-01T00:00:00.000Z",
      connected_at: "2026-11-09T10:00:00.000Z",
      expired: false,
    },
  },
};
const session = {
  pending: {
    state: "ready",
    seen: true,
    item: {
      name: "northwind-invoice-1042.pdf",
      type: "application/pdf",
      size: 184320,
      base64: "JVBERi0=",
      preview: null,
    },
  },
};
const area = (data) => ({
  get: async (keys) =>
    Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys])
        .filter((k) => k in data)
        .map((k) => [k, structuredClone(data[k])]),
    ),
  set: async (items) => {
    Object.assign(data, structuredClone(items));
  },
  remove: async (keys) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
  },
});
const inert = { addListener() {} };
window.chrome = {
  runtime: {
    id: "preview",
    getURL: (p) => p,
    sendMessage: async () => undefined,
    onMessage: inert,
    onInstalled: inert,
    onStartup: inert,
  },
  storage: { local: area(local), session: area(session), onChanged: inert },
  alarms: {
    create: async () => {},
    clear: async () => true,
    get: async () => ({ name: "inbox" }),
    onAlarm: inert,
  },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    openPopup: async () => {},
  },
  contextMenus: { create() {}, removeAll: async () => {}, onClicked: inert },
  tabs: {
    create: async () => ({}),
    query: async () => [{ url: "https://billing.northwind.example/invoices/1042.pdf" }],
  },
};
const invoice = (n, ref, amount, payee, source) => ({
  id: `6f1c2a90-0000-4000-8000-00000000000${n}`,
  ref,
  amount,
  payee,
  created_at: "2026-11-09T08:12:00.000Z",
  url: `${ORIGIN}/console/${VAULT}/payables/6f1c2a90-0000-4000-8000-00000000000${n}`,
  source,
});
const inbox = {
  network: "testnet",
  account: "acme-finance.testnet",
  counts: { awaiting: 2, held: 1 },
  vaults: [
    {
      vault: VAULT,
      name: "Acme operations",
      role: "owner",
      chain: "ok",
      awaiting: [
        invoice(1, "INV-1038", "1250", "near:northwind.testnet", "extension"),
        invoice(2, "INV-0977", "480.5", "near:hosting.testnet", "console"),
      ],
      held: [
        {
          spend_id: 14,
          amount: "3200",
          payee: "near:contractor.testnet",
          held_until: "2026-11-10T09:00:00.000Z",
          url: `${ORIGIN}/console/${VAULT}`,
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
          label: "Contractors",
          payee: "near:contractor.testnet",
          per_payment: "5000",
          remaining: "40000",
          expires_at: "2027-01-01T00:00:00.000Z",
        },
      ],
    },
  ],
};
window.fetch = async (url) =>
  String(url).endsWith("/api/ext/inbox")
    ? new Response(JSON.stringify(inbox), { headers: { "content-type": "application/json" } })
    : new Response(null, { status: 404 });
