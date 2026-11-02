import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TxResult } from "@/lib/near/outcome";
import { TxResultNote } from "./TxResultNote";

const HASH = "9fV2pZ7mUq5f6p3rGq7bX1tYkqfUu1Vb3bWm2C5g7h8J";

const render = (result: TxResult, account: string | null = "owner.testnet") =>
  renderToStaticMarkup(createElement(TxResultNote, { result, network: "testnet", account }));

const r = (over: Partial<TxResult>): TxResult => ({
  status: "ok",
  txHash: HASH,
  code: null,
  error: null,
  ...over,
});

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("TxResultNote", () => {
  it("shows Done and the transaction link on success", () => {
    const html = render(r({}));
    expect(html).toContain("Done");
    expect(hrefs(html)).toEqual([`https://testnet.nearblocks.io/txns/${HASH}`]);
  });

  it("shows the contract's code on a refusal", () => {
    const html = render(r({ status: "failed", code: "NotOwner", error: "panicked" }));
    expect(html).toContain("Refused: NotOwner");
    expect(html).toContain("panicked");
    expect(hrefs(html)).toEqual([`https://testnet.nearblocks.io/txns/${HASH}`]);
  });

  it("an unknown outcome says sent and links to the transaction, with no retry wording", () => {
    const html = render(
      r({ status: "unknown", error: "Exceeded 60 seconds waiting for the transaction" }),
    );
    expect(html).toContain("Sent: confirm on the explorer");
    expect(hrefs(html)).toEqual([`https://testnet.nearblocks.io/txns/${HASH}`]);
    expect(html).toContain("Exceeded 60 seconds");
    expect(html).not.toMatch(/try again|retry/i);
    expect(html).not.toMatch(/Refused/);
  });

  it("an unknown outcome with no hash (a cancel, a closed wallet) says not confirmed, and links to the signer's account page", () => {
    const html = render(r({ status: "unknown", txHash: null, error: "User rejected the request" }));
    expect(html).toContain(
      "Not confirmed: if you approved in your wallet, check the explorer first",
    );
    expect(html).toContain("User rejected the request");
    expect(hrefs(html)).toEqual(["https://testnet.nearblocks.io/address/owner.testnet"]);
    expect(html).not.toMatch(/try again|retry|Refused/i);
    expect(html).not.toContain("Sent: confirm");
  });

  it("an unknown outcome with no hash and no account has no link, but still says where to look", () => {
    const html = render(r({ status: "unknown", txHash: null, error: "no outcome" }), null);
    expect(html).toContain("check the explorer first");
    expect(hrefs(html)).toEqual([]);
  });

  it("an unknown outcome shows its code next to the words", () => {
    const html = render(
      r({ status: "unknown", code: "LackBalanceForState", error: "out of NEAR" }),
    );
    expect(html).toContain("LackBalanceForState: out of NEAR");
  });

  it("a send that never left is Not sent, with no link", () => {
    const html = render(
      r({ status: "failed", txHash: null, error: "Your wallet is connected as a.near" }),
    );
    expect(html).toContain("Not sent");
    expect(html).toContain("Your wallet is connected as a.near");
    expect(hrefs(html)).toEqual([]);
  });

  it("colours success green, an unconfirmed send amber and a refusal red", () => {
    expect(render(r({}))).toContain("bg-emerald-100");
    expect(render(r({ status: "unknown" }))).toContain("bg-amber-100");
    expect(render(r({ status: "failed", error: "no" }))).toContain("bg-rose-100");
  });

  it("escapes the wallet's text", () => {
    const html = render(
      r({ status: "failed", txHash: null, error: "<img src=x onerror=alert(1)>" }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
