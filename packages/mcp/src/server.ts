// The five tools. Each is a thin call into the port; amounts go in as USDC and come out in both forms.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ModelProposal, NETWORKS } from "@probarion/core";
import type { SpendOutcomeStatus } from "@probarion/sdk";
import { mandateSummary, spendSummary, verifySummary } from "./format.js";
import type { ProbarionPort, ServerInfo } from "./port.js";
import {
  checkSpendInput,
  getSpendStatusInput,
  listMandatesInput,
  requestSpendInput,
  verifyInput,
} from "./schemas.js";
import { formatUsdc, parseUsdc } from "./units.js";

export const TOOL_NAMES = [
  "list_mandates",
  "check_spend",
  "request_spend",
  "get_spend_status",
  "verify",
] as const;

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});
const fail = (message: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

/**
 * Error text for the client. Secret-length ed25519 strings (64-byte keys) are redacted, public keys stay
 * readable, and a URL's query string (where an RPC provider's API key would sit) is dropped.
 */
export function safeMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m
    .replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/g, "ed25519:[redacted]")
    .replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g, "$1?[redacted]")
    .slice(0, 1000);
}

async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(safeMessage(e));
  }
}

const NOTES: Readonly<Record<SpendOutcomeStatus, string>> = {
  paid: "Paid on NEAR to the mandate's payee.",
  burned:
    "Sent across chains through NEAR Intents; the bridge releases the funds on the destination chain. Poll get_spend_status.",
  settled: "Settled on the destination chain.",
  held: "Held for a human approver: the amount is above the mandate's approval threshold. With a spend_id, poll get_spend_status; do not send it again.",
  refused_by_code:
    "Refused by Probarion's rules before any transaction; the refusal is in the vault's signed ledger. Do not retry with another amount or ref to get around it.",
  refused_by_contract:
    "Refused by the vault contract. Do not retry with another amount or ref to get around it.",
  failed: "Not paid. Tell the vault owner.",
  unconfirmed:
    "The spend was sent and may have paid. Do not send it again, least of all under a new ref: check get_spend_status (with a spend_id) or ask the vault owner.",
};

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function createServer(port: ProbarionPort, info: ServerInfo): McpServer {
  const server = new McpServer({ name: "probarion", version: info.version });
  const explorer = NETWORKS[info.network].explorerTx;

  server.registerTool(
    "list_mandates",
    {
      title: "List mandates",
      description:
        "List the spending mandates of this Probarion vault: for each, the payee, the per-payment cap, the total cap and what is left of it, the uses left, the approval threshold and the expiry. The vault owner signs mandates; you cannot create or change one, and you cannot pay anyone who is not the payee of an active mandate.",
      inputSchema: listMandatesInput,
      annotations: READ_ONLY,
    },
    async () =>
      guarded(async () =>
        ok({
          vault: info.vault,
          network: info.network,
          read_only: info.readOnly,
          mandates: (await port.listMandates()).map(mandateSummary),
        }),
      ),
  );

  server.registerTool(
    "check_spend",
    {
      title: "Dry-run a payment",
      description:
        "Ask the vault contract whether it would pay this amount under this mandate, without sending a transaction. Returns ok, the contract's refusal code if any, and whether the payment would be held for a human approver.",
      inputSchema: checkSpendInput,
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const amount = parseUsdc(args.amount);
        const r = await port.checkSpend({
          mandateId: args.mandate_id,
          amount,
          invoiceHash: args.invoice_hash,
          ref: args.ref,
        });
        return ok({
          ok: r.ok,
          code: r.code,
          would_hold: r.would_hold,
          amount_usdc: formatUsdc(amount),
          amount_units: amount,
        });
      }),
  );

  server.registerTool(
    "request_spend",
    {
      title: "Pay under a mandate",
      description:
        "Ask the vault to pay an invoice under a mandate. There is no recipient parameter: the vault pays the mandate's payee and nobody else. Probarion's rules and then the contract check the mandate's caps, uses and expiry; a payment above the approval threshold waits for a human approver. Each ref and each invoice_hash pays at most once, so retrying with the same ref is safe. Your reasoning is stored in the vault's signed ledger.",
      inputSchema: requestSpendInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      guarded(async () => {
        if (info.readOnly) {
          return fail(
            "request_spend is off: this server runs read-only because PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY are not set.",
          );
        }
        const amount = parseUsdc(args.amount);
        const proposal: ModelProposal = {
          action: "pay",
          mandate_id: args.mandate_id,
          amount,
          payee_hint: null,
          reasoning: `mcp: ${args.reasoning}`,
          confidence: 1,
        };
        const out = await port.requestSpend({
          mandateId: args.mandate_id,
          amount,
          invoiceHash: args.invoice_hash,
          ref: args.ref,
          proposal,
        });
        return ok({
          status: out.status,
          spend_id: out.spendId,
          code: out.code,
          tx_hash: out.txHash,
          explorer: out.txHash === null ? null : `${explorer}${out.txHash}`,
          ledger_seq: out.ledgerSeq,
          decision_hash: out.decisionHash,
          anchor_tx_hash: out.anchorTxHash,
          ...(out.ledgerComplete === false ? { ledger_complete: false } : {}),
          amount_usdc: formatUsdc(amount),
          note: NOTES[out.status],
        });
      }),
  );

  server.registerTool(
    "get_spend_status",
    {
      title: "Get a spend's status",
      description:
        "Read a spend from the vault by id: held, pending, paid, burned (sent across chains, waiting for the bridge), failed, rejected or expired.",
      inputSchema: getSpendStatusInput,
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const s = await port.getSpend(args.spend_id);
        return s === null
          ? fail(`spend ${args.spend_id} not found on ${info.vault}`)
          : ok(spendSummary(s));
      }),
  );

  server.registerTool(
    "verify",
    {
      title: "Verify the vault",
      description:
        "Run Probarion's verifier on this vault: ledger signatures, hash links, on-chain anchors, a decision behind every spend, attestations, the vault's keys and code, burn memos and the factory version. Read-only; it can take tens of seconds.",
      inputSchema: verifyInput,
      annotations: READ_ONLY,
    },
    async () => guarded(async () => ok(verifySummary(await port.verify()))),
  );

  return server;
}
