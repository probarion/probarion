import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type Board, type FeedRow, parseBoard } from "@/lib/canary/board";
import type { Network } from "@/lib/config";
import { LatestAttempts, Scoreboard } from "./Leaderboard";

const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&times;|×/g, "x")
    .replace(/\s+/g, " ");

const board = (over: Record<string, unknown> = {}): Board => {
  const b = parseBoard({
    browsers: 9,
    addresses: 4,
    attempts_external: 31,
    attempts_team: 3,
    raw_external: 12,
    techniques: [
      {
        technique: "payee_change",
        attempts: 10,
        refused_by_code: 10,
        refused_by_contract: 5,
        held: 0,
      },
      { technique: "roleplay", attempts: 4, refused_by_code: 4, refused_by_contract: 0, held: 1 },
    ],
    contract_codes: [
      { code: "NoMandate", n: 4 },
      { code: "OverPerPayment", n: 1 },
    ],
    ...over,
  });
  if (!b) throw new Error("fixture board is malformed");
  return b;
};

const renderBoard = (b: Board | null) =>
  renderToStaticMarkup(createElement(Scoreboard, { board: b }));

describe("the scoreboard", () => {
  it("shows three tiles: visitors as the smaller of browsers and addresses, attempts with the team apart, and the raw spends", () => {
    const text = visible(renderBoard(board()));
    expect(text).toContain("At least 4 visitors");
    expect(text).toContain("the smaller of 9 browsers and 4 network addresses");
    expect(text).toContain("Attempts 31");
    expect(text).toContain("plus 3 by the team, counted apart");
    expect(text).toContain("Sent straight to the contract 12");
    expect(text).toContain("5 refused on chain");
  });

  it("counts the other way round when addresses outnumber browsers", () => {
    const text = visible(renderBoard(board({ browsers: 2, addresses: 40 })));
    expect(text).toContain("At least 2 visitors");
    expect(text).toContain("the smaller of 2 browsers and 40 network addresses");
  });

  it("says one visitor, not one visitors", () => {
    const text = visible(renderBoard(board({ browsers: 1, addresses: 1 })));
    expect(text).toContain("At least 1 visitor ");
    expect(text).not.toContain("1 visitors");
    expect(text).toContain("the smaller of 1 browser and 1 network address");
  });

  it("does not claim that every raw spend was refused, nor that anything was paid to an attacker", () => {
    const text = visible(renderBoard(board()));
    expect(text).not.toMatch(/every one|all of them|each one/i);
    expect(text).not.toMatch(/paid to an attacker/i);
  });

  it("tabulates the techniques with the five columns", () => {
    const html = renderBoard(board());
    const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(heads).toEqual(["Technique", "Attempts", "Refused by code", "Refused on chain", "Held"]);
    const text = visible(html);
    expect(text).toContain("payee_change 10 10 5 0");
    expect(text).toContain("roleplay 4 4 0 1");
  });

  it("lists the codes NEAR returned as chips, in the good colour", () => {
    const html = renderBoard(board());
    expect(visible(html)).toContain("Codes NEAR returned:");
    expect(html).toMatch(/data-tone="good"[^>]*>NoMandate x?\s*×?4</);
    expect(html).toMatch(/data-tone="good"[^>]*>OverPerPayment/);
  });

  it("says none yet when the contract has returned no code, and shows no empty table", () => {
    const html = renderBoard(board({ contract_codes: [], techniques: [] }));
    expect(visible(html)).toContain("Codes NEAR returned: none yet");
    expect(html).not.toContain("<table");
  });

  it("says it is updated every minute", () => {
    expect(visible(renderBoard(board()))).toContain("Updated every minute.");
  });

  it("says it is not available, and shows no figure, when there is no board", () => {
    const text = visible(renderBoard(null));
    expect(text).toContain("The scoreboard is not available right now.");
    expect(text).not.toContain("At least");
    expect(text).not.toContain("Updated every minute");
  });

  it("scrolls the table inside its own panel and labels that panel", () => {
    expect(renderBoard(board())).toMatch(/<section[^>]*aria-label="Attempts by technique"/);
  });
});

describe("the scoreboard before an outside visitor has tried", () => {
  const none = (team: number) =>
    board({
      browsers: 0,
      addresses: 0,
      attempts_external: 0,
      attempts_team: team,
      raw_external: 0,
      techniques: [],
      contract_codes: [],
    });

  it("is the one line, and no tile of zeros: 0 visitors, 6 by the team", () => {
    const html = renderBoard(none(6));
    const text = visible(html);
    expect(text).toContain("6 attempts so far, all by the team. Be the first visitor.");
    expect(text).toContain("Updated every minute.");
    expect(text).not.toMatch(/At least|0 visitors|Sent straight to the contract|none yet/);
    expect(html).not.toContain("<table");
  });

  it("keeps the line and the freshness note 2.5em apart (WCAG 1.4.8): 20px under the line, over .fresh's 12px", () => {
    // 17px text at 1.55 is 26.35px a line; 26.35 + 20 = 46.35px from the line's top to the note's is 2.73em.
    expect(renderBoard(none(6))).toMatch(
      /<p class="mb-5">6 attempts so far, all by the team\. Be the first visitor\.<\/p><p class="[^"]*">Updated every minute\.<\/p>/,
    );
  });

  it("says there are no attempts yet when the team has made none either", () => {
    expect(visible(renderBoard(none(0)))).toContain("No attempts yet. Be the first visitor.");
  });

  it("shows the tiles again from the first outside attempt: 1 visitor, then many", () => {
    const one = visible(
      renderBoard(
        board({
          browsers: 1,
          addresses: 1,
          attempts_external: 1,
          raw_external: 0,
          attempts_team: 6,
        }),
      ),
    );
    expect(one).toContain("At least 1 visitor ");
    expect(one).toContain("Attempts 1");
    expect(one).toContain("plus 6 by the team, counted apart");
    expect(one).not.toContain("Be the first");
    const many = visible(renderBoard(board()));
    expect(many).toContain("At least 4 visitors");
    expect(many).not.toContain("Be the first");
  });
});

const row = (over: Partial<FeedRow> = {}): FeedRow => ({
  created_at: "2026-11-06T10:15:30.123456+00:00",
  techniques: ["payee_change", "fake_invoice"],
  code_status: "refused_by_code",
  code_rule: "custom.canary_no_autopay",
  raw: true,
  contract_status: "refused_by_contract",
  contract_code: "NoMandate",
  tx_hash: "AbC123xyz",
  is_team: false,
  ...over,
});

const renderFeed = (feed: FeedRow[] | null, network: Network = "testnet") =>
  renderToStaticMarkup(createElement(LatestAttempts, { feed, network }));

describe("the latest attempts", () => {
  it("has the five columns and the UTC title", () => {
    const html = renderFeed([row()]);
    expect([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])).toEqual([
      "When",
      "Techniques",
      "Code",
      "Contract",
      "Tx",
    ]);
    expect(visible(html)).toContain("Latest attempts (UTC)");
  });

  it("shows a row: the time in UTC, the techniques, the rule that refused, the contract's code and the transaction", () => {
    const html = renderFeed([row()]);
    expect(visible(html)).toContain(
      "2026-11-06 10:15 payee_change, fake_invoice custom.canary_no_autopay NoMandate",
    );
    expect(html).toMatch(/href="https:\/\/testnet\.nearblocks\.io\/txns\/AbC123xyz"/);
  });

  it("links the transactions to the explorer of the network", () => {
    expect(renderFeed([row()], "mainnet")).toContain('href="https://nearblocks.io/txns/AbC123xyz"');
  });

  it("shows the code's status when no rule is named", () => {
    expect(visible(renderFeed([row({ code_rule: null })]))).toContain("refused_by_code NoMandate");
  });

  it("reads not sent when the attempt did not go to the contract, and shows no link", () => {
    const html = renderFeed([
      row({ raw: false, contract_status: null, contract_code: null, tx_hash: null }),
    ]);
    expect(visible(html)).toContain("not sent");
    expect(html).not.toContain("<a ");
  });

  it("falls back to the contract's status when it gave no code", () => {
    const text = visible(
      renderFeed([row({ contract_code: null, contract_status: "unconfirmed" })]),
    );
    expect(text).toContain("unconfirmed");
  });

  it("reads did not finish across the code and contract columns of a killed attempt", () => {
    const html = renderFeed([
      row({
        code_status: "killed",
        code_rule: null,
        raw: false,
        contract_status: null,
        contract_code: null,
        tx_hash: null,
      }),
    ]);
    expect(visible(html)).toContain("did not finish");
    expect(visible(html)).not.toContain("killed");
    expect(html).toMatch(/<td[^>]*colSpan="2"[^>]*>did not finish</);
    expect(visible(html)).not.toContain("not sent");
  });

  it("marks the team's own attempts with a team chip, and no other row", () => {
    const html = renderFeed([row({ is_team: true }), row({ created_at: "2026-11-06T10:10:00Z" })]);
    expect([...html.matchAll(/>team</g)]).toHaveLength(1);
  });

  it("tells an empty feed from one that could not be read", () => {
    expect(visible(renderFeed([]))).toContain("No attempts yet. Be the first.");
    expect(renderFeed([])).not.toContain("<table");
    const unread = visible(renderFeed(null));
    expect(unread).toContain("The latest attempts are not available right now.");
    expect(unread).not.toContain("No attempts yet");
  });

  it("scopes every column header of both tables to its column", () => {
    for (const html of [renderFeed([row()]), renderBoard(board())]) {
      const heads = [...html.matchAll(/<th\b[^>]*>/g)].map((m) => m[0]);
      expect(heads).toHaveLength(5);
      expect(heads.filter((h) => !h.includes('scope="col"'))).toEqual([]);
    }
  });

  // renderToStaticMarkup does not report a duplicate React key (probed with two identical keys: no console.error), so
  // this checks the rows and not the keys. The key is built from the time and the position (Leaderboard.tsx).
  it("draws two attempts of the same minute as two rows", () => {
    const html = renderFeed([row(), row()]);
    expect([...html.matchAll(/<tr/g)].length).toBe(3); // the head and two rows
  });

  it("scrolls the table inside its own panel and labels that panel", () => {
    expect(renderFeed([row()])).toMatch(/<section[^>]*aria-label="Latest attempts"/);
  });
});
