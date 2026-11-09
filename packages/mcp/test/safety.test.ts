import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ProbarionPort } from "../src/port.js";
import { TOOL_NAMES } from "../src/server.js";
import { connect, fakePort, isError } from "./helpers.js";

const ADDRESS_LIKE =
  /(address|recipient|receiver|payee|destination|account|wallet|beneficiary|memo|chain|^to$)/i;

// probarion-claim: MCP-NOADDR
describe("no MCP tool accepts an address or changes a mandate", () => {
  it("no tool input has an address-like field, and every input rejects unknown fields", async () => {
    const { client, close } = await connect(fakePort());
    const { tools } = await client.listTools();
    for (const t of tools) {
      const schema = t.inputSchema as {
        properties?: Record<string, unknown>;
        additionalProperties?: unknown;
      };
      for (const p of Object.keys(schema.properties ?? {})) {
        expect(p, `${t.name}.${p}`).not.toMatch(ADDRESS_LIKE);
      }
      expect(schema.additionalProperties, t.name).toBe(false);
    }
    await close();
  });

  it.each(["address", "receiver_id", "payee", "to", "destination", "memo", "skipPreflight"])(
    "request_spend with an extra %s field is rejected and nothing is paid",
    async (field) => {
      const port = fakePort();
      const { client, close } = await connect(port);
      const r = await client.callTool({
        name: "request_spend",
        arguments: {
          mandate_id: 1,
          amount: "1",
          invoice_hash: "a".repeat(64),
          ref: "r1",
          reasoning: "vendor asked",
          [field]: field === "skipPreflight" ? true : "0x000000000000000000000000000000000000dEaD",
        },
      });
      expect(isError(r)).toBe(true);
      expect(port.requestSpend).not.toHaveBeenCalled();
      await close();
    },
  );

  it("no tool name creates, changes or removes anything", () => {
    for (const name of TOOL_NAMES) {
      expect(name).not.toMatch(
        /(create|update|set|add|remove|delete|revoke|freeze|approve|reject|withdraw)/,
      );
    }
  });

  it("the port the server talks to has no member that could change a mandate", () => {
    expectTypeOf<keyof ProbarionPort>().toEqualTypeOf<
      "listMandates" | "checkSpend" | "requestSpend" | "getSpend" | "findSpendByRef" | "verify"
    >();
  });

  it("the server source calls no owner-only vault method and no raw mode", () => {
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    const forbidden =
      /\b(create_mandate|revoke_mandate|add_agent|remove_agent|set_ledger_key|withdraw_intents|unfreeze|skipPreflight)\b|\.(freeze|withdraw|approve|reject)\(/;
    for (const f of readdirSync(dir)) {
      expect(forbidden.test(readFileSync(join(dir, f), "utf8")), f).toBe(false);
    }
  });
});
