import type { SpendOutcome } from "@probarion/sdk";
import { describe, expect, it, vi } from "vitest";
import { withSingleWriterGuard } from "../src/guard.js";
import { safeMessage, TOOL_NAMES } from "../src/server.js";
import { connect, fakePort, isError, jsonOf, OUTCOME, TX, textOf } from "./helpers.js";

const spendArgs = {
  mandate_id: 1,
  amount: "25.50",
  invoice_hash: "a".repeat(64),
  ref: "vendor:INV-1",
};

describe("probarion-mcp tools", () => {
  it("lists exactly the five tools, the reads marked read-only", async () => {
    const { client, close } = await connect(fakePort());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(t.name !== "request_spend");
    }
    await close();
  });

  it("list_mandates shows caps in USDC, what is left, and the uses left", async () => {
    const { client, close } = await connect(fakePort());
    const body = jsonOf(await client.callTool({ name: "list_mandates", arguments: {} }));
    expect(body).toMatchObject({
      vault: "acme.vaults.probarion.testnet",
      network: "testnet",
      read_only: false,
    });
    expect((body.mandates as unknown[])[0]).toMatchObject({
      id: 1,
      payee: "NEAR account vendor.testnet",
      payee_detail: { type: "near", account_id: "vendor.testnet" },
      max_per_payment_usdc: "100.00",
      remaining_usdc: "750.00",
      uses_left: 8,
      approval_above_usdc: "50.00",
      expires_at: "2026-12-31T23:59:59.000Z",
    });
    await close();
  });

  it("check_spend converts USDC to smallest units and passes the rest through", async () => {
    const port = fakePort();
    const { client, close } = await connect(port);
    const r = await client.callTool({ name: "check_spend", arguments: spendArgs });
    expect(isError(r)).toBe(false);
    expect(port.checkSpend).toHaveBeenCalledWith({
      mandateId: 1,
      amount: "25500000",
      invoiceHash: "a".repeat(64),
      ref: "vendor:INV-1",
    });
    expect(jsonOf(r)).toMatchObject({ ok: true, amount_usdc: "25.50", amount_units: "25500000" });
    await close();
  });

  it("request_spend records the reasoning as an unattested MCP proposal with no payee hint", async () => {
    const port = fakePort();
    const { client, close } = await connect(port);
    const r = await client.callTool({
      name: "request_spend",
      arguments: { ...spendArgs, amount: "25.5", reasoning: "Monthly hosting per PO-77" },
    });
    expect(port.requestSpend).toHaveBeenCalledWith({
      mandateId: 1,
      amount: "25500000",
      invoiceHash: "a".repeat(64),
      ref: "vendor:INV-1",
      proposal: {
        action: "pay",
        mandate_id: 1,
        amount: "25500000",
        payee_hint: null,
        reasoning: "mcp: Monthly hosting per PO-77",
        confidence: 1,
      },
    });
    expect(jsonOf(r)).toMatchObject({
      status: "paid",
      spend_id: 7,
      explorer: `https://testnet.nearblocks.io/txns/${TX}`,
      amount_usdc: "25.50",
    });
    await close();
  });

  it.each<[SpendOutcome["status"], RegExp]>([
    ["refused_by_code", /Do not retry with another amount or ref/],
    ["unconfirmed", /Do not send it again, least of all under a new ref/],
    ["held", /Held for a human approver/],
  ])("request_spend explains a %s outcome", async (status, note) => {
    const out: SpendOutcome = { ...OUTCOME, status, txHash: null, spendId: null };
    const { client, close } = await connect(fakePort({ requestSpend: vi.fn(async () => out) }));
    const body = jsonOf(
      await client.callTool({ name: "request_spend", arguments: { ...spendArgs, reasoning: "x" } }),
    );
    expect(body.status).toBe(status);
    expect(body.explorer).toBeNull();
    expect(body.note).toMatch(note);
    await close();
  });

  it("request_spend is refused in read-only mode without calling the port", async () => {
    const port = fakePort();
    const { client, close } = await connect(port, { readOnly: true });
    const r = await client.callTool({
      name: "request_spend",
      arguments: { ...spendArgs, reasoning: "x" },
    });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/read-only/);
    expect(port.requestSpend).not.toHaveBeenCalled();
    await close();
  });

  it.each(["25 USDC", "1e3", "25,50", "-1", "0", "0.0000001", " 1"])(
    "rejects amount %j in check_spend and request_spend without calling the port",
    async (amount) => {
      const port = fakePort();
      const { client, close } = await connect(port);
      const check = await client.callTool({
        name: "check_spend",
        arguments: { ...spendArgs, amount },
      });
      const request = await client.callTool({
        name: "request_spend",
        arguments: { ...spendArgs, amount, reasoning: "x" },
      });
      for (const r of [check, request]) {
        expect(isError(r)).toBe(true);
        expect(textOf(r)).toMatch(/amount/);
      }
      expect(port.checkSpend).not.toHaveBeenCalled();
      expect(port.requestSpend).not.toHaveBeenCalled();
      await close();
    },
  );

  it.each([
    ["invoice_hash", "A".repeat(64)],
    ["invoice_hash", "a".repeat(63)],
    ["ref", ""],
    ["ref", "x".repeat(65)],
    ["ref", "é".repeat(33)],
    ["mandate_id", 0],
    ["mandate_id", 1.5],
  ])("rejects %s %j without calling the port", async (field, value) => {
    const port = fakePort();
    const { client, close } = await connect(port);
    const r = await client.callTool({
      name: "request_spend",
      arguments: { ...spendArgs, reasoning: "x", [field]: value },
    });
    expect(isError(r)).toBe(true);
    expect(port.requestSpend).not.toHaveBeenCalled();
    await close();
  });

  it("get_spend_status returns the spend or a clear not-found error", async () => {
    const { client, close } = await connect(fakePort());
    expect(
      jsonOf(await client.callTool({ name: "get_spend_status", arguments: { spend_id: 7 } })),
    ).toMatchObject({
      spend_id: 7,
      status: "paid",
      amount_usdc: "25.50",
      destination: "NEAR account vendor.testnet",
      created_at: "2026-11-11T00:00:00.000Z",
    });
    const missing = await client.callTool({ name: "get_spend_status", arguments: { spend_id: 8 } });
    expect(isError(missing)).toBe(true);
    expect(textOf(missing)).toContain("spend 8 not found");
    await close();
  });

  it("verify returns every check", async () => {
    const { client, close } = await connect(fakePort());
    expect(jsonOf(await client.callTool({ name: "verify", arguments: {} }))).toMatchObject({
      ok: true,
      entries: 3,
      checks: [{ id: "a", status: "pass" }],
    });
    await close();
  });

  it("a port failure becomes an error result with secret-length keys and URL queries redacted", async () => {
    const secret = `ed25519:${"3".repeat(87)}`;
    const port = fakePort({
      verify: vi.fn(async () => {
        throw new Error(`rpc https://rpc.example/v1?apikey=s3cr3t failed while using ${secret}`);
      }),
    });
    const { client, close } = await connect(port);
    const r = await client.callTool({ name: "verify", arguments: {} });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toContain("ed25519:[redacted]");
    expect(textOf(r)).toContain("https://rpc.example/v1?[redacted]");
    expect(textOf(r)).not.toContain(secret);
    expect(textOf(r)).not.toContain("s3cr3t");
    await close();
  });

  it("safeMessage keeps a public key readable", () => {
    const pk = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
    expect(safeMessage(new Error(`key ${pk}`))).toBe(`key ${pk}`);
  });

  it("a ledger fork risk is reported as a tool error and nothing is sent", async () => {
    const port = fakePort();
    const guarded = withSingleWriterGuard(port, { all: async () => [] }, async () => ({
      seq: 1,
      root: "x",
      count: 1,
    }));
    const { client, close } = await connect(guarded);
    const r = await client.callTool({
      name: "request_spend",
      arguments: { ...spendArgs, reasoning: "x" },
    });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toContain("LEDGER_FORK_RISK");
    expect(port.requestSpend).not.toHaveBeenCalled();
    await close();
  });
});
