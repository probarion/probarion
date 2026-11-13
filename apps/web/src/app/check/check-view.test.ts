// /check's pure parts: the form, the examples, the fragment link, and how a request is written down.
import { lookalikeOf, parsePayeeRef } from "@probarion/core";
import { describe, expect, it } from "vitest";
import {
  blocklistCount,
  cliCommand,
  describeCall,
  EXAMPLES,
  exampleFor,
  formFromHash,
  formOf,
  formToHash,
  networkHint,
  POISONED_BASE,
  parseCheckForm,
  type RequestEntry,
  recordingFetch,
  statusLine,
  utc,
  VERDICT_WORDS,
} from "./check-view";

const form = (payee: string, vault = "", network = "mainnet") => ({ network, payee, vault });

describe("the form", () => {
  it("takes the CLI's payee forms, a bare NEAR account and an optional vault", () => {
    expect(parseCheckForm(form("near:vendor.near"))).toEqual({
      ok: true,
      input: { network: "mainnet", payee: { chain: "near", address: "vendor.near" } },
    });
    expect(parseCheckForm(form("  vendor.near ", " v0.probarion.near "))).toEqual({
      ok: true,
      input: {
        network: "mainnet",
        payee: { chain: "near", address: "vendor.near" },
        vault: "v0.probarion.near",
      },
    });
    expect(parseCheckForm(form(`base:${POISONED_BASE}`, "", "testnet"))).toMatchObject({
      ok: true,
    });
  });

  it("names the one field that is wrong, in a sentence", () => {
    expect(parseCheckForm(form(""))).toEqual({
      ok: false,
      field: "payee",
      problem: "Name a payee.",
    });
    expect(parseCheckForm(form("0xabc"))).toEqual({
      ok: false,
      field: "payee",
      problem: "Write near:0xabc or base:0xabc: a bare 0x value is both.",
    });
    expect(parseCheckForm(form("base:0x12"))).toMatchObject({ ok: false, field: "payee" });
    expect(parseCheckForm(form("near:vendor.near", "Not A Vault"))).toEqual({
      ok: false,
      field: "vault",
      problem: "Not A Vault is not a NEAR account id.",
    });
    expect(parseCheckForm(form("near:vendor.near", "", "betanet"))).toMatchObject({
      ok: false,
      field: "network",
    });
  });

  it("notes a name that ends in the other network's suffix, and still lets it run", () => {
    const run = (payee: string, network: string) => {
      const parsed = parseCheckForm(form(payee, "", network));
      if (!parsed.ok) throw new Error(parsed.problem);
      return networkHint(parsed.input);
    };
    expect(run("near:vendor.near", "testnet")).toBe(
      "vendor.near ends in .near, a mainnet name, and the network chosen is testnet.",
    );
    expect(run("near:vendor.testnet", "mainnet")).toContain("a testnet name");
    expect(run("near:vendor.near", "mainnet")).toBeNull();
    expect(run(`base:${POISONED_BASE}`, "testnet")).toBeNull();
  });
});

describe("the examples", () => {
  it("each parse, and each one's form is found again as that example", () => {
    expect(EXAMPLES.map((e) => e.id)).toEqual([
      "mandate-1",
      "one-letter-off",
      "base-payee",
      "poisoned-base",
      "blocklisted",
    ]);
    for (const e of EXAMPLES) {
      expect(parseCheckForm(e.form), e.id).toMatchObject({ ok: true });
      expect(exampleFor(e.form)?.id).toBe(e.id);
    }
    expect(exampleFor(form("near:vendor.near"))).toBeNull();
  });

  it("make the poisoned Base address a lookalike of the vault's Base payee and not that payee", () => {
    expect(POISONED_BASE).toMatch(/^0x[0-9A-Fa-f]{40}$/);
    const base = EXAMPLES.find((e) => e.id === "base-payee")?.form.payee ?? "";
    const real = parsePayeeRef(base);
    const fake = parsePayeeRef(`base:${POISONED_BASE}`);
    if (!real.ok || !fake.ok) throw new Error("examples do not parse");
    expect(lookalikeOf(fake.payee, real.payee)).toBe("the same first 4 and last 4 hex characters");
  });

  it("name the blocklisted example from the seed list, which has testnet entries only", () => {
    expect(blocklistCount("testnet")).toBeGreaterThan(0);
    expect(blocklistCount("mainnet")).toBe(0);
    expect(EXAMPLES.find((e) => e.id === "blocklisted")?.form).toEqual({
      network: "testnet",
      payee: "near:attacker-eval.testnet",
      vault: "",
    });
  });
});

describe("a check in a link", () => {
  it("goes in the fragment and comes back out of it", () => {
    const f = form(`base:${POISONED_BASE}`, "v0.probarion.near");
    const hash = formToHash(f);
    expect(hash.startsWith("#network=mainnet&payee=base%3A0x")).toBe(true);
    expect(formFromHash(hash)).toEqual(f);
    expect(formToHash(form("near:vendor.near"))).toBe("#network=mainnet&payee=near%3Avendor.near");
  });

  it("names no check without a payee, and leaves a network it does not know to the page", () => {
    expect(formFromHash("")).toBeNull();
    expect(formFromHash("#network=mainnet")).toBeNull();
    expect(formFromHash("#payee=vendor.near&network=betanet")).toEqual({ payee: "vendor.near" });
  });

  it("is made from a parsed check the same way as from its form", () => {
    const parsed = parseCheckForm(form("vendor.near", "v0.probarion.near"));
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(formOf(parsed.input)).toEqual(form("near:vendor.near", "v0.probarion.near"));
    expect(cliCommand(parsed.input)).toBe(
      "node packages/cli/dist/bin.js payee check near:vendor.near --network mainnet --vault v0.probarion.near",
    );
  });
});

describe("the requests, written down", () => {
  const body = (method: string, params: unknown) =>
    JSON.stringify({ jsonrpc: "2.0", id: "x", method, params });

  it("says what each JSON-RPC call reads, and which read it serves", () => {
    expect(describeCall(body("block", { finality: "final" }))).toEqual({
      call: "block header at final",
      read: "account_past",
    });
    expect(
      describeCall(
        body("query", { request_type: "view_account", account_id: "a.near", finality: "final" }),
      ),
    ).toEqual({ call: "view_account a.near at final", read: "account_now" });
    expect(
      describeCall(
        body("query", { request_type: "view_account", account_id: "a.near", block_id: 7 }),
      ),
    ).toEqual({ call: "view_account a.near at block 7", read: "account_past" });
    expect(
      describeCall(
        body("query", {
          request_type: "call_function",
          account_id: "v.near",
          method_name: "list_spends",
        }),
      ),
    ).toEqual({ call: "list_spends on v.near", read: "history" });
    expect(describeCall(body("eth_getCode", ["0xabc", "latest"]))).toEqual({
      call: "eth_getCode 0xabc",
      read: "base_code",
    });
    expect(describeCall(body("eth_getTransactionCount", ["0xabc", "latest"]))).toEqual({
      call: "eth_getTransactionCount 0xabc",
      read: "base_nonce",
    });
    expect(describeCall("not json")).toEqual({ call: "a request", read: "other" });
    expect(describeCall(undefined)).toEqual({ call: "a request", read: "other" });
  });

  it("records the host and the status, hands the answer back untouched, and rethrows a failure", async () => {
    const log: RequestEntry[] = [];
    let t = 0;
    const ok = recordingFetch(
      async () => new Response("{}", { status: 200 }),
      (e) => log.push(e),
      () => (t += 10),
    );
    const response = await ok("https://rpc.mainnet.fastnear.com/", {
      body: body("block", { finality: "final" }),
    });
    expect(await response.text()).toBe("{}");
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const down = recordingFetch(
      async () => {
        throw timeout;
      },
      (e) => log.push(e),
      () => (t += 10),
    );
    await expect(
      down(new URL("https://mainnet.base.org"), { body: body("eth_getCode", ["0x1"]) }),
    ).rejects.toBe(timeout);
    expect(log).toEqual([
      {
        at: 20,
        host: "rpc.mainnet.fastnear.com",
        call: "block header at final",
        read: "account_past",
        answer: "HTTP 200",
        ms: 10,
      },
      {
        at: 40,
        host: "mainnet.base.org",
        call: "eth_getCode 0x1",
        read: "base_code",
        answer: "no answer in time",
        ms: 10,
      },
    ]);
  });
});

describe("the words", () => {
  it("give each verdict a word and a line, so the colour never carries it alone", () => {
    expect(VERDICT_WORDS.allow.label).toBe("Allow");
    expect(VERDICT_WORDS.warn.tone).toBe("warn");
    expect(VERDICT_WORDS.block.line).toBe("A reason not to write this payee into a mandate.");
  });

  it("say a check's end in one line, for a screen reader", () => {
    const reasons = [
      { id: "lookalike", level: "block", text: "x" },
      { id: "first_payment", level: "warn", text: "y" },
      { id: "found", level: "info", text: "z" },
    ] as const;
    expect(
      statusLine({
        verdict: "block",
        reasons: [...reasons],
        network: "mainnet",
        payee: { chain: "near", address: "a.near" },
        checked_at: "2026-11-14T00:00:00.000Z",
      }),
    ).toBe("Block: 3 reasons, 2 of them warnings or blocks.");
    expect(utc("2026-11-13T20:51:30.229Z")).toBe("2026-11-13 20:51:30 UTC");
    expect(utc("soon")).toBe("soon");
  });
});
