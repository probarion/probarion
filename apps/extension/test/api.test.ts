import { describe, expect, it } from "vitest";
import { ApiError, api, cleanText, OFFLINE, RECONNECT, readInbox } from "../src/api";
import {
  fetchOf,
  inboxBody,
  json,
  ORIGIN,
  OTHER_ORIGIN,
  offline,
  PDF,
  problem,
  TOKEN,
} from "./helpers";

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("it did not fail");
}

describe("each request", () => {
  it("sends the token as a Bearer header, never cookies, and doesn't follow redirects", async () => {
    const f = fetchOf(() => json(inboxBody()));
    await api(ORIGIN, f.fetch).inbox(TOKEN);
    const [call] = f.calls;
    expect(call?.url).toBe(`${ORIGIN}/api/ext/inbox`);
    expect(call?.init?.credentials).toBe("omit");
    expect(call?.init?.redirect).toBe("error");
    expect(call?.init?.cache).toBe("no-store");
    expect(new Headers(call?.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("says Probarion can't be reached when the request doesn't get through", async () => {
    const e = await failure(api(ORIGIN, offline).inbox(TOKEN));
    expect([e.status, e.code, e.message]).toEqual([0, "offline", OFFLINE]);
  });
});

describe("an answer whose body breaks off", () => {
  /** A 200 whose body ends in a network error, as when the connection drops or the timeout passes mid-body. */
  const broken = (status = 200) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.error(new TypeError("network reset"));
        },
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  const send = (a: ReturnType<typeof api>) =>
    a.sendInvoice(TOKEN, { vault: "v.testnet", mandate: 3, file: new Blob([PDF]), name: "a.pdf" });

  it.each<[string, (a: ReturnType<typeof api>) => Promise<unknown>]>([
    ["the inbox", (a) => a.inbox(TOKEN)],
    ["a pairing", (a) => a.pair("K7QM-4XRA", "Chrome")],
    ["a sent invoice", send],
  ])("is Couldn't reach Probarion, not an unreadable answer, for %s", async (_name, call) => {
    const e = await failure(call(api(ORIGIN, fetchOf(() => broken()).fetch)));
    expect([e.status, e.code, e.message]).toEqual([0, "offline", OFFLINE]);
  });

  it("still says what an error status says", async () => {
    const e = await failure(api(ORIGIN, fetchOf(() => broken(401)).fetch).inbox(TOKEN));
    expect([e.status, e.message]).toEqual([401, RECONNECT]);
  });

  it("is an unreadable answer only when the body arrived and isn't what this version reads", async () => {
    const f = fetchOf(() => new Response("<html>", { status: 200 }));
    expect((await failure(api(ORIGIN, f.fetch).inbox(TOKEN))).code).toBe("bad_answer");
  });
});

describe("the inbox", () => {
  it("is read with its rows, mandates and sources", async () => {
    const f = fetchOf(() => json(inboxBody()));
    const inbox = await api(ORIGIN, f.fetch).inbox(TOKEN);
    expect(inbox.counts).toEqual({ awaiting: 2, held: 1 });
    expect(inbox.vaults[0]?.awaiting.map((a) => a.source)).toEqual(["extension", "console"]);
    expect(inbox.vaults[0]?.awaiting[1]?.payee).toBeNull();
    expect(inbox.vaults[0]?.mandates.map((m) => m.id)).toEqual([3, 5]);
  });

  it("drops a row whose link leaves Probarion's console, and cleans what it shows", () => {
    const body = inboxBody();
    const vault = body.vaults[0];
    if (vault?.awaiting[0] === undefined) throw new Error("fixture");
    vault.awaiting[0].url = "https://evil.example/console/x";
    vault.name = "Acme‮ operations";
    const inbox = readInbox(body, ORIGIN);
    expect(inbox.vaults[0]?.awaiting).toHaveLength(1);
    expect(inbox.vaults[0]?.name).toBe("Acme operations");
  });

  it("opens a link another Probarion address sent at the address the person connected through", async () => {
    const inbox = readInbox(inboxBody(OTHER_ORIGIN), ORIGIN);
    expect(inbox.vaults[0]?.awaiting[0]?.url).toBe(
      `${ORIGIN}/console/acme.vault.testnet/payables/6f1c2a90-0000-4000-8000-000000000001`,
    );
    expect(inbox.vaults[0]?.held[0]?.url).toBe(`${ORIGIN}/console/acme.vault.testnet`);
    const url = `${OTHER_ORIGIN}/console/acme.vault.testnet/payables/6f1c2a90-0000-4000-8000-000000000009`;
    const f = fetchOf(() =>
      json(
        { invoice_id: "6f1c2a90-0000-4000-8000-000000000009", status: "awaiting_owner", url },
        201,
      ),
    );
    const sent = await api(ORIGIN, f.fetch).sendInvoice(TOKEN, {
      vault: "acme.vault.testnet",
      mandate: 3,
      file: new Blob([PDF]),
      name: "a.pdf",
    });
    expect(sent.url).toBe(
      `${ORIGIN}/console/acme.vault.testnet/payables/6f1c2a90-0000-4000-8000-000000000009`,
    );
  });

  it("drops a link to a Probarion page outside the console", () => {
    const body = inboxBody();
    const vault = body.vaults[0];
    if (vault?.awaiting[0] === undefined) throw new Error("fixture");
    vault.awaiting[0].url = `${ORIGIN}/api/ext/inbox`;
    expect(readInbox(body, ORIGIN).vaults[0]?.awaiting).toHaveLength(1);
  });

  it("keeps a payee of a longer chain whole: a payee is the one string a person relies on", () => {
    const body = inboxBody();
    const payee = `solana:${"a".repeat(117)}`;
    const vault = body.vaults[0];
    if (
      vault?.awaiting[0] === undefined ||
      vault.held[0] === undefined ||
      vault.mandates[0] === undefined
    ) {
      throw new Error("fixture");
    }
    vault.awaiting[0].payee = payee;
    vault.held[0].payee = payee;
    vault.mandates[0].payee = payee;
    const inbox = readInbox(body, ORIGIN);
    expect(payee).toHaveLength(124);
    expect(inbox.vaults[0]?.awaiting[0]?.payee).toBe(payee);
    expect(inbox.vaults[0]?.held[0]?.payee).toBe(payee);
    expect(inbox.vaults[0]?.mandates[0]?.payee).toBe(payee);
  });

  it("refuses an answer that isn't an inbox", async () => {
    const f = fetchOf(() => json({ ...inboxBody(), network: "betanet" }));
    const e = await failure(api(ORIGIN, f.fetch).inbox(TOKEN));
    expect(e.code).toBe("bad_answer");
  });
});

describe("each failure", () => {
  it.each<[number, string, string, string]>([
    [401, "bad_token", "", RECONNECT],
    [403, "not_member", "", "You're not a member of this vault"],
    [
      403,
      "not_member",
      "This vault takes no invoices from the extension.",
      "This vault takes no invoices from the extension.",
    ],
    [404, "mandate_not_found", "", "This mandate can't take invoices now"],
    [404, "", "", "This Probarion address doesn't offer this yet. Try again later."],
    [422, "mandate_inactive", "", "This mandate can't take invoices now"],
    [
      422,
      "mandate_inactive",
      "This mandate can't take invoices now: mandate 3 is revoked.",
      "This mandate can't take invoices now: mandate 3 is revoked.",
    ],
    [
      422,
      "amount_unclear",
      "",
      "Couldn't read one clear amount. Upload it in the console instead.",
    ],
    [422, "empty", "", "No text in this file. Upload it in the console instead."],
    [422, "unreadable", "", "Couldn't read this file. Send a readable PDF or a UTF-8 text file."],
    [
      422,
      "refused_by_code",
      "the vault would refuse this payment now (OverPerPayment)",
      "Probarion's rules refused it: the invoice is more than the mandate allows per payment.",
    ],
    [
      422,
      "refused_by_code",
      "the vault would refuse this payment now (DuplicateInvoice)",
      "Probarion's rules refused it: the vault already paid this invoice or is holding a payment for it.",
    ],
    [
      422,
      "refused_by_code",
      "the vault would refuse this payment now (DuplicateRef)",
      "Probarion's rules refused it: the vault already paid this invoice or is holding a payment for it.",
    ],
    [
      422,
      "refused_by_code",
      "the vault would refuse this payment now (constructor)",
      "Probarion's rules refused it: the vault would refuse this payment now (constructor)",
    ],
    [
      422,
      "refused_by_code",
      "the vault would refuse this payment now (no code given)",
      "Probarion's rules refused it: the vault would refuse this payment now (no code given)",
    ],
    [409, "no_keys", "", "The vault's keys aren't active. Open the console's Keys tab."],
    [409, "wrong_network", "This vault is on NEAR mainnet.", "This vault is on NEAR mainnet."],
    [
      411,
      "length_required",
      "Send the request with a Content-Length header",
      "Probarion couldn't read this request. Try again.",
    ],
    [413, "too_large", "", "The invoice must be 4 MiB at most."],
    [415, "unsupported", "", "Send a PDF or a plain text (.txt) file."],
    [400, "invalid_input", "Choose a mandate.", "Choose a mandate."],
    [
      503,
      "unavailable",
      "Nothing was queued. Try again (request r1).",
      "Nothing was queued. Try again (request r1).",
    ],
  ])("%i %s shows its sentence", async (status, code, detail, text) => {
    const f = fetchOf(() => problem(status, code, detail));
    const e = await failure(api(ORIGIN, f.fetch).inbox(TOKEN));
    expect([e.status, e.code, e.message]).toEqual([status, code, text]);
  });

  it("names the rule that refused an invoice", async () => {
    const f = fetchOf(() =>
      json(
        {
          error: "refused_by_code",
          rule: "mandate.payee_mismatch",
          detail: "The invoice names another payee.",
        },
        422,
      ),
    );
    const e = await failure(
      api(ORIGIN, f.fetch).sendInvoice(TOKEN, {
        vault: "v.testnet",
        mandate: 3,
        file: new Blob([PDF]),
        name: "a.pdf",
      }),
    );
    expect(e.message).toBe("Probarion's rules refused it: The invoice names another payee.");
  });

  it("says when to try again after too many requests", async () => {
    const f = fetchOf(() =>
      problem(429, "rate_limited", "Try again in 42 s", { "Retry-After": "42" }),
    );
    expect((await failure(api(ORIGIN, f.fetch).inbox(TOKEN))).message).toBe(
      "Too many requests. Try again in 42 s",
    );
  });

  it.each<[string, Record<string, string>]>([
    ["no Retry-After", {}],
    ["a Retry-After that is a date", { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }],
    ["a Retry-After with a sign", { "Retry-After": "-5" }],
    ["a Retry-After of six digits", { "Retry-After": "999999" }],
  ])("says 60 s after too many requests with %s", async (_name, headers) => {
    const f = fetchOf(() => problem(429, "rate_limited", "Try again later", headers));
    expect((await failure(api(ORIGIN, f.fetch).inbox(TOKEN))).message).toBe(
      "Too many requests. Try again in 60 s",
    );
  });

  it("says it in minutes when the wait is two minutes or more", async () => {
    const f = fetchOf(() =>
      problem(429, "rate_limited", "Try again in 600 s", { "Retry-After": "600" }),
    );
    expect((await failure(api(ORIGIN, f.fetch).inbox(TOKEN))).message).toBe(
      "Too many requests. Try again in 10 min",
    );
  });
});

describe("pairing", () => {
  it("trades a code for a connection", async () => {
    const answer = {
      token: TOKEN,
      account: "owner.testnet",
      network: "testnet",
      expires_at: "2026-12-10T00:00:00.000Z",
    };
    const f = fetchOf(() => json(answer));
    expect(await api(ORIGIN, f.fetch).pair("K7QM-4XRA", "Chrome on Windows")).toEqual(answer);
    expect(f.calls[0]?.url).toBe(`${ORIGIN}/api/ext/pair`);
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({
      code: "K7QM-4XRA",
      label: "Chrome on Windows",
    });
    expect(new Headers(f.calls[0]?.init?.headers).has("authorization")).toBe(false);
  });

  it("shows the server's sentence for a wrong code", async () => {
    const f = fetchOf(() => problem(401, "bad_code", "This code is wrong, used or expired."));
    expect((await failure(api(ORIGIN, f.fetch).pair("K7QM-4XRA", "Chrome"))).message).toBe(
      "This code is wrong, used or expired.",
    );
  });
});

describe("sending an invoice", () => {
  const send = (f: ReturnType<typeof fetchOf>) =>
    api(ORIGIN, f.fetch).sendInvoice(TOKEN, {
      vault: "acme.vault.testnet",
      mandate: 3,
      file: new Blob([PDF], { type: "application/pdf" }),
      name: "invoice-1042.pdf",
    });
  const url = `${ORIGIN}/console/acme.vault.testnet/payables/6f1c2a90-0000-4000-8000-000000000009`;

  it("posts the vault, the mandate and the file as multipart", async () => {
    const f = fetchOf(() =>
      json(
        { invoice_id: "6f1c2a90-0000-4000-8000-000000000009", status: "awaiting_owner", url },
        201,
      ),
    );
    expect(await send(f)).toEqual({
      id: "6f1c2a90-0000-4000-8000-000000000009",
      status: "awaiting_owner",
      duplicate: false,
      url,
    });
    const body = f.calls[0]?.init?.body;
    if (!(body instanceof FormData)) throw new Error("not multipart");
    expect(body.get("vault")).toBe("acme.vault.testnet");
    expect(body.get("mandate")).toBe("3");
    expect((body.get("file") as File).name).toBe("invoice-1042.pdf");
  });

  it("reads a duplicate", async () => {
    const f = fetchOf(() =>
      json({
        invoice_id: "6f1c2a90-0000-4000-8000-000000000009",
        status: "awaiting_owner",
        duplicate: true,
        url,
      }),
    );
    expect((await send(f)).duplicate).toBe(true);
  });

  it("refuses an Open link to another site", async () => {
    const f = fetchOf(() =>
      json(
        { invoice_id: "x", status: "awaiting_owner", url: "https://evil.example/console/x" },
        201,
      ),
    );
    expect((await failure(send(f))).code).toBe("bad_answer");
  });
});

it("cleans server text before it is shown", () => {
  expect(cleanText("ok\u0007‮ done ")).toBe("ok done");
  expect(cleanText(42)).toBe("");
  expect(cleanText("x".repeat(400))).toHaveLength(300);
});
