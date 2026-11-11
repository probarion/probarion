// The server's instructions: what an MCP client shows the model when it connects. Each rule must reach the
// client, stay short, and say what the tool text and the answers' notes say.
import type { SpendOutcome } from "@probarion/sdk";
import { describe, expect, it, vi } from "vitest";
import { serverInstructions } from "../src/server.js";
import { connect, fakePort, jsonOf, OUTCOME, textOf } from "./helpers.js";

const BUDGET = 1200;
const MODES = [
  { network: "testnet" as const, readOnly: false },
  { network: "testnet" as const, readOnly: true },
  { network: "mainnet" as const, readOnly: false },
  { network: "mainnet" as const, readOnly: true },
];

const spendArgs = {
  mandate_id: 1,
  amount: "25.50",
  invoice_hash: "a".repeat(64),
  ref: "vendor:INV-9",
  reasoning: "x",
};

/** The note request_spend answers with for this outcome, from a server that holds no earlier spend. */
async function noteOf(outcome: Partial<SpendOutcome>): Promise<string> {
  const port = fakePort({
    requestSpend: vi.fn(async () => ({ ...OUTCOME, txHash: null, ...outcome })),
    findSpendByRef: vi.fn(async () => null),
  });
  const { client, close } = await connect(port);
  const body = jsonOf(await client.callTool({ name: "request_spend", arguments: spendArgs }));
  await close();
  return body.note as string;
}

describe("probarion-mcp server instructions", () => {
  it.each(MODES)(
    "reach the client at connect, under the budget, in plain ASCII ($network, read-only $readOnly)",
    async ({ network, readOnly }) => {
      const { client, close } = await connect(fakePort(), { network, readOnly });
      const got = client.getInstructions();
      expect(got).toBe(serverInstructions({ network, readOnly }));
      expect(got?.length).toBeLessThan(BUDGET);
      expect(got).toMatch(/^[\x20-\x7e\n]+$/);
      await close();
    },
  );

  it.each(MODES)(
    "state each rule the model needs to pay safely ($network, read-only $readOnly)",
    (mode) => {
      const text = serverInstructions(mode);
      for (const rule of [
        "you cannot pay anyone who is not the payee of an active mandate bound to this server's key.",
        "There is no recipient parameter: the vault pays the mandate's payee and nobody else.",
        "When unsure, call check_spend first: it sends no transaction.",
        "Each ref and each invoice_hash pays at most once.",
        "Follow the note in each request_spend answer.",
        "held with a spend_id: Held for a human approver: the amount is above the mandate's approval threshold. Poll get_spend_status with the spend_id; do not send it again.",
        "unconfirmed: The spend was sent and may have paid. Do not send it again, least of all under a new ref: check get_spend_status (with a spend_id) or ask the vault owner.",
        "refused_by_code or refused_by_contract: the refusal is final for that request. Do not retry with another amount or ref to get around it.",
        "burned is final for the vault and does not change:",
        "so do not poll a burned spend or send it again.",
      ]) {
        expect(text).toContain(rule);
      }
    },
  );

  it.each([
    {
      network: "testnet" as const,
      says: "on testnet, intents-stub stands in for NEAR Intents and nothing leaves NEAR",
      never: /across chains|watch the release/,
    },
    {
      network: "mainnet" as const,
      says: "it was sent across chains through NEAR Intents, and Probarion does not watch the release on the destination chain yet",
      never: /intents-stub|nothing leaves NEAR/,
    },
  ])("say what a burn is on $network, and only that", ({ network, says, never }) => {
    const text = serverInstructions({ network, readOnly: false });
    expect(text).toContain(`burned is final for the vault and does not change: ${says}, so`);
    expect(text).not.toMatch(never);
  });

  it("say read-only only on a server with no keys, in the words request_spend refuses with", async () => {
    expect(serverInstructions({ network: "testnet", readOnly: false })).not.toMatch(/read-only/);
    const port = fakePort();
    const { client, close } = await connect(port, { readOnly: true });
    const refused = textOf(await client.callTool({ name: "request_spend", arguments: spendArgs }));
    expect(refused).toBe(
      "request_spend is off: this server runs read-only because no agent and ledger keys are set.",
    );
    expect(client.getInstructions()?.split("\n").at(-1)).toBe(refused);
    expect(port.requestSpend).not.toHaveBeenCalled();
    await close();
  });

  it.each(["testnet", "mainnet"] as const)(
    "use the same words as the tool descriptions and the answers' notes on %s, so the two cannot drift",
    async (network) => {
      const { client, close } = await connect(fakePort(), { network });
      const text = client.getInstructions() ?? "";
      const { tools } = await client.listTools();
      const description = (name: string) => tools.find((t) => t.name === name)?.description ?? "";
      await close();

      const burned = description("get_spend_status").indexOf("burned is final");
      expect(burned).toBeGreaterThan(0);
      expect(text).toContain(description("get_spend_status").slice(burned));
      expect(description("list_mandates")).toContain(
        "you cannot pay anyone who is not the payee of an active mandate bound to this server's key.",
      );
      expect(description("request_spend")).toContain(
        "There is no recipient parameter: the vault pays the mandate's payee and nobody else.",
      );
      expect(description("request_spend")).toContain(
        "Each ref and each invoice_hash pays at most once:",
      );

      expect(text).toContain(
        `held with a spend_id: ${await noteOf({ status: "held", spendId: 9 })}`,
      );
      expect(text).toContain(
        `unconfirmed: ${await noteOf({ status: "unconfirmed", spendId: null })}`,
      );
      for (const status of ["refused_by_code", "refused_by_contract"] as const) {
        const note = await noteOf({ status, spendId: null, code: "mandate.expired" });
        const rule = note.slice(note.indexOf("Do not retry"));
        expect(rule, status).toBe("Do not retry with another amount or ref to get around it.");
        expect(text).toContain(`the refusal is final for that request. ${rule}`);
      }
    },
  );
});
