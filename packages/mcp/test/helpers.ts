// Shared set-up for the MCP tests: a fake port, an in-memory MCP client, and readers for tool results.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MandateView, SpendView, VerifyReport } from "@probarion/core";
import type { SpendOutcome } from "@probarion/sdk";
import { vi } from "vitest";
import type { ProbarionPort, ServerInfo } from "../src/port.js";
import { createServer } from "../src/server.js";

export const TX = "8qkFz1q7mJpQd9wZ3yX4hT6uV2bN5cR1sE7gK3aL9mP";
const AGENT_PK = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

export const MANDATE: MandateView = {
  id: 1,
  payee: { type: "near", account_id: "vendor.testnet" },
  purpose_hash: "e".repeat(64),
  max_per_payment: "100000000",
  max_total: "1000000000",
  spent: "250000000",
  reserved: "0",
  max_uses: 10,
  uses: 2,
  expires_at_ns: "1798761599000000000", // 2026-12-31T23:59:59Z
  approval_above: "50000000",
  agent_pk: AGENT_PK,
  label: "Vendor hosting",
  status: "active",
  created_at_ns: "1793491200000000000",
};

export const SPEND: SpendView = {
  id: 7,
  mandate_id: 1,
  amount: "25500000",
  invoice_hash: "a".repeat(64),
  ref: "vendor:INV-1",
  decision_hash: "d".repeat(64),
  agent_pk: AGENT_PK,
  destination: { type: "near", account_id: "vendor.testnet" },
  status: "paid",
  created_at_ns: "1794355200000000000", // 2026-11-11T00:00:00Z
  held_until_ns: null,
  memo: null,
};

export const REPORT: VerifyReport = {
  vault: "acme.vaults.probarion.testnet",
  network: "testnet",
  ok: true,
  checks: [{ id: "a", name: "ledger-signatures", status: "pass", detail: "3 entries signed" }],
  entries: 3,
  anchors: 3,
  generated_at: "2026-11-11T00:00:00.000Z",
  unproven: [],
};

export const OUTCOME: SpendOutcome = {
  status: "paid",
  spendId: 7,
  code: null,
  txHash: TX,
  ledgerSeq: 12,
  decisionHash: "d".repeat(64),
  anchorTxHash: null,
};

export function fakePort(over: Partial<ProbarionPort> = {}) {
  return {
    listMandates: vi.fn(async () => [MANDATE]),
    checkSpend: vi.fn(async () => ({ ok: true, code: null, would_hold: false })),
    requestSpend: vi.fn(async () => OUTCOME),
    getSpend: vi.fn(async (id: number) => (id === 7 ? SPEND : null)),
    verify: vi.fn(async () => REPORT),
    ...over,
  };
}

export async function connect(port: ProbarionPort, info: Partial<ServerInfo> = {}) {
  const server = createServer(port, {
    vault: "acme.vaults.probarion.testnet",
    network: "testnet",
    version: "0.0.0-test",
    readOnly: false,
    ...info,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probarion-mcp-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export const textOf = (result: unknown): string =>
  ((result as { content?: { type: string; text?: string }[] }).content ?? [])
    .map((c) => c.text ?? "")
    .join("\n");
export const isError = (result: unknown): boolean =>
  (result as { isError?: boolean }).isError === true;
export const jsonOf = (result: unknown): Record<string, unknown> =>
  JSON.parse(textOf(result)) as Record<string, unknown>;
