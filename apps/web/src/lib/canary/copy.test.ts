import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Network } from "@/lib/config";
import { LIMITS } from "@/lib/ratelimit";
import { PLANNED_ROUTES } from "@/lib/routes";
import { LINKS } from "@/lib/site/facts";
import {
  baseLine,
  CANARY_COPY,
  characterCount,
  describeRaw,
  eyebrow,
  limitText,
  mandateParts,
  moreMandates,
  type Part,
  RAW_SKIP_TEXT,
  REPLY_TEXT,
  RULES_HEAD,
  refusedSub,
  replayRows,
  rulesCopy,
  runsOn,
  teamSub,
  tokenNoun,
  visitorsSub,
  visitorsUnit,
} from "./copy";
import { thousands } from "./format";
import { CANARY_LIMITS, type RawSkip } from "./limits";

const NETWORKS: Network[] = ["testnet", "mainnet"];

/** Every string reachable from a value: object values, array items, and the text and href of a link part. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

const rawCases: Parameters<typeof describeRaw>[0][] = [
  ...(Object.keys(RAW_SKIP_TEXT) as RawSkip[]).map((skipped) => ({
    sent: false as const,
    skipped,
  })),
  { sent: true, status: "refused_by_contract", code: "NoMandate", txHash: "T" },
  { sent: true, status: "refused_by_contract", code: null, txHash: "T" },
  { sent: true, status: "held", code: null, txHash: "T" },
  { sent: true, status: "paid", code: null, txHash: "T" },
  { sent: true, status: "burned", code: null, txHash: "T" },
  { sent: true, status: "settled", code: null, txHash: "T" },
  { sent: true, status: "unconfirmed", code: "deadline", txHash: null },
  { sent: true, status: "failed", code: null, txHash: "T" },
];

/** All the copy a visitor can be shown, for both networks. */
function allCopy(): string[] {
  const out = [
    ...strings(CANARY_COPY),
    ...strings(RAW_SKIP_TEXT),
    ...strings(REPLY_TEXT),
    ...strings(RULES_HEAD),
    visitorsUnit(1),
    visitorsUnit(3),
    visitorsSub(1, 1),
    visitorsSub(12, 34),
    teamSub(5),
    refusedSub(7),
    characterCount(123),
    moreMandates(2),
    baseLine("5", "test USDC"),
    ...Object.values(
      mandateParts(
        { count: 1, payee: "p.testnet", maxPerPayment: "1", holdsEverySpend: true },
        "test USDC",
      ),
    ),
    ...Object.values(
      mandateParts(
        { count: 3, payee: "p.testnet", maxPerPayment: "1", holdsEverySpend: false },
        "USDC",
      ),
    ),
    replayRows([{ network: "testnet" }]),
    replayRows([{ network: "testnet" }, { network: "mainnet" }]),
    limitText(1),
    limitText(41),
    limitText(60),
    limitText(125),
    ...rawCases.map((r) => describeRaw(r).text),
  ];
  for (const network of NETWORKS) {
    out.push(
      eyebrow(network),
      tokenNoun(network),
      runsOn(network),
      ...strings(rulesCopy(network, LINKS)),
    );
  }
  return out;
}

describe("the words the Canary pages must not use", () => {
  it("promises nothing for winning, and names no contract refusal that does not exist", () => {
    const banned = /bounty|keep what you extract|prize|reward|PayeeMismatch/i;
    expect(allCopy().filter((t) => banned.test(t))).toEqual([]);
  });

  it("does not name one cause for a limit that has several: there is no model budget wording", () => {
    // The attempt route answers `budget` for an address's own cap, the global caps and the token budget alike.
    expect(allCopy().filter((t) => /model budget/i.test(t))).toEqual([]);
    expect(allCopy().filter((t) => /used up|used your attempts/i.test(t))).toEqual([]);
  });

  it("has no plan placeholder in a public sentence", () => {
    expect(allCopy().filter((t) => /to be reviewed|legal advice/i.test(t))).toEqual([]);
  });

  it("has no link to the proof page: the Canary's ledger is private, so it would be a 404", () => {
    expect(strings(CANARY_COPY).filter((t) => /\/proof/.test(t))).toEqual([]);
    expect(Object.keys(CANARY_COPY.head)).not.toContain("proof");
  });

  it("uses no em dash, as the rest of the site does not", () => {
    expect(allCopy().filter((t) => t.includes("—"))).toEqual([]);
  });

  it("leaves those words out of the page's own source too", () => {
    const web = fileURLToPath(new URL("../../..", import.meta.url));
    const files = [
      join("src", "app", "canary", "page.tsx"),
      join("src", "app", "canary", "rules", "page.tsx"),
      ...[
        "AttemptResult",
        "CanaryForm",
        "Leaderboard",
        "ReplayView",
        "StaticCards",
        "VaultCard",
      ].map((n) => join("src", "components", "canary", `${n}.tsx`)),
    ];
    const banned = /bounty|keep what you extract|prize|reward|PayeeMismatch/i;
    const hits = files.filter((f) => banned.test(readFileSync(join(web, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("never says that the contract refuses a payee mismatch: that is a code rule", () => {
    expect(allCopy().filter((t) => /payee.mismatch/i.test(t))).toEqual([]);
  });
});

describe("a testnet-aware page", () => {
  it("names the token a test token on testnet and plain USDC on mainnet", () => {
    expect(tokenNoun("testnet")).toBe("test USDC");
    expect(tokenNoun("mainnet")).toBe("USDC");
  });

  it("names the network from the environment", () => {
    expect(eyebrow("testnet")).toBe("Public challenge · NEAR testnet");
    expect(eyebrow("mainnet")).toBe("Public challenge · NEAR mainnet");
  });

  it("says the testnet pill in the words the owner approved", () => {
    expect(CANARY_COPY.head.testnetPill).toBe("Testnet: test tokens, no value");
  });

  it("does not mention mainnet in the copy of a testnet build", () => {
    const testnet = [
      ...strings(CANARY_COPY),
      ...strings(RAW_SKIP_TEXT),
      ...strings(REPLY_TEXT),
      eyebrow("testnet"),
      runsOn("testnet"),
      ...strings(rulesCopy("testnet", LINKS)),
      ...rawCases.map((r) => describeRaw(r).text),
      replayRows([{ network: "testnet" }]),
      replayRows([{ network: "testnet" }, { network: "testnet" }]),
    ];
    expect(testnet.filter((t) => /mainnet/i.test(t))).toEqual([]);
  });

  it("says the testnet address runs on testnet in the rules, and the mainnet address makes no such claim", () => {
    const fine = (n: Network) => strings(rulesCopy(n, LINKS).at(-1)?.body).join("");
    expect(fine("testnet")).toContain("It runs on testnet, with test tokens that have no value.");
    expect(fine("mainnet")).not.toContain("test tokens");
    expect(runsOn("testnet")).toBe(
      "This runs on testnet, and no third party has audited the code.",
    );
  });
});

describe("the numbers in the copy are the limits in code", () => {
  const limitsRule = (n: Network = "testnet") =>
    strings(rulesCopy(n, LINKS).find((r) => r.title === "Limits.")?.body).join("");

  it("quotes the text length wherever a visitor can hit it", () => {
    const max = thousands(CANARY_LIMITS.maxTextChars);
    expect(CANARY_COPY.form.note).toContain(`Up to ${max} characters`);
    expect(REPLY_TEXT.tooLong).toBe(`Your text is over ${max} characters.`);
    expect(characterCount(5)).toBe(`5 / ${max}`);
    expect(limitsRule()).toContain(`at most ${max} characters`);
  });

  it("states every limit of the rules, each number built from the constants", () => {
    const [modelMax, modelWindowS] = LIMITS.canaryModelVisitor;
    expect(limitsRule()).toBe(
      [
        `A message is at most ${thousands(CANARY_LIMITS.maxTextChars)} characters.`,
        `One network address gets at most ${modelMax} model attempts every ${modelWindowS / 60} minutes and ${CANARY_LIMITS.attemptsPerIpPerHour} an hour.`,
        `All visitors together get at most ${CANARY_LIMITS.attemptsGlobalPerHour} an hour and ${CANARY_LIMITS.attemptsGlobalPerDay} a day.`,
        `On chain, one visitor gets 1 attempt every ${CANARY_LIMITS.rawVisitorWindowS / 60} minutes, and all visitors together get at most ${CANARY_LIMITS.rawGlobalPerHour} an hour.`,
        `There is also a daily budget of ${thousands(CANARY_LIMITS.dailyTokenBudget)} model tokens for everyone together.`,
        "Raw mode pauses when the agent key's gas allowance falls below 0.2 NEAR.",
      ].join(" "),
    );
    expect(CANARY_LIMITS.minAllowanceYocto).toBe(200_000_000_000_000_000_000_000n);
  });

  it("has no number in the limits that the constants do not give", () => {
    const [modelMax, modelWindowS] = LIMITS.canaryModelVisitor;
    const given = new Set([
      thousands(CANARY_LIMITS.maxTextChars),
      String(modelMax),
      String(modelWindowS / 60),
      String(CANARY_LIMITS.attemptsPerIpPerHour),
      String(CANARY_LIMITS.attemptsGlobalPerHour),
      String(CANARY_LIMITS.attemptsGlobalPerDay),
      "1",
      String(CANARY_LIMITS.rawVisitorWindowS / 60),
      String(CANARY_LIMITS.rawGlobalPerHour),
      thousands(CANARY_LIMITS.dailyTokenBudget),
      "0.2",
    ]);
    const found = limitsRule().match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
    expect(found.filter((n) => !given.has(n))).toEqual([]);
    expect(found.length).toBeGreaterThanOrEqual(given.size - 1);
  });

  it("says the address's own limits, the global ones and the on-chain ones apart", () => {
    const text = limitsRule();
    expect(text).toMatch(
      /One network address gets at most \d+ model attempts every \d+ minutes and \d+ an hour\./,
    );
    expect(text).toMatch(/All visitors together get at most \d+ an hour and \d+ a day\./);
    expect(text).toMatch(/On chain, one visitor gets 1 attempt every \d+ minutes/);
  });

  it("reads the same on every network", () => {
    expect(limitsRule("mainnet")).toBe(limitsRule("testnet"));
  });
});

describe("raw-mode texts against the code they explain", () => {
  it("says the allowance is below the amount the rules name, or unreadable, and that raw mode is paused", () => {
    expect(RAW_SKIP_TEXT.allowance_low).toBe(
      "The agent key's gas allowance is below 0.2 NEAR or could not be read, so raw mode is paused for now.",
    );
    expect(RAW_SKIP_TEXT.allowance_low).not.toMatch(/tops? it up/);
  });

  it("says a raw spend the contract would accept is never sent", () => {
    expect(RAW_SKIP_TEXT.contract_would_accept).toMatch(/sends only what the contract refuses/);
  });

  it("does not say a code-refused spend that was skipped went to the contract", () => {
    expect(RAW_SKIP_TEXT.not_refused_by_code).not.toMatch(/went to the contract/);
  });

  it("shows the contract's code when it refused and a plain sentence when it gave none", () => {
    expect(
      describeRaw({
        sent: true,
        status: "refused_by_contract",
        code: "OverPerPayment",
        txHash: "T",
      }),
    ).toEqual({
      tone: "good",
      text: "Even with the code rules bypassed, the NEAR contract refused it: OverPerPayment.",
    });
    expect(
      describeRaw({ sent: true, status: "refused_by_contract", code: null, txHash: "T" }).text,
    ).toBe("Even with the code rules bypassed, the NEAR contract refused it.");
  });

  it("says that only the mandated payee can be paid, whatever the contract did", () => {
    for (const status of ["held", "paid", "burned", "settled"] as const) {
      expect(describeRaw({ sent: true, status, code: null, txHash: "T" }).text).toMatch(
        /mandated payee/,
      );
    }
  });

  it("keeps a skip neutral and an unknown contract result plain", () => {
    expect(describeRaw({ sent: false, skipped: "error" }).tone).toBe("neutral");
    expect(
      describeRaw({ sent: true, status: "unconfirmed", code: "deadline", txHash: null }),
    ).toEqual({
      tone: "neutral",
      text: "Contract result: unconfirmed.",
    });
  });
});

describe("the scoreboard's sentences", () => {
  it("says where the visitor figure comes from, singular and plural", () => {
    expect(visitorsSub(12, 34)).toBe("the smaller of 12 browsers and 34 network addresses");
    expect(visitorsSub(1, 1)).toBe("the smaller of 1 browser and 1 network address");
    expect(visitorsUnit(1)).toBe("visitor");
    expect(visitorsUnit(0)).toBe("visitors");
  });

  it("says the team is counted apart and does not claim every raw spend was refused", () => {
    expect(teamSub(4)).toBe("plus 4 by the team, counted apart");
    expect(refusedSub(9)).toBe("9 refused on chain");
    expect(CANARY_COPY.board.raw).toBe("Sent straight to the contract");
  });
});

describe("the rules of the challenge", () => {
  const rules = rulesCopy("testnet", LINKS);
  const links = (parts: readonly Part[]) =>
    parts.flatMap((p) => (typeof p === "string" ? [] : [p]));

  it("has the eight rules in order", () => {
    expect(rules.map((r) => r.title)).toEqual([
      "The goal.",
      "How it works.",
      "Why an address in your message cannot work.",
      "Limits.",
      "Out of scope.",
      "Your data.",
      "How you are counted.",
      "The fine print.",
    ]);
  });

  it("asks for a report the way SECURITY.md does and does not offer to let the finder keep anything", () => {
    const goal = rules[0];
    expect(links(goal?.body ?? [])).toEqual([
      { text: "@probarionhq", href: "https://x.com/probarionhq" },
      { text: "SECURITY.md", href: "https://github.com/probarion/probarion/blob/main/SECURITY.md" },
    ]);
    expect(strings(goal?.body).join("")).toContain(
      "pay anyone other than its single mandated payee",
    );
  });

  it("sends bug reports to SECURITY.md on GitHub, names no email address, and links no page that is not built", () => {
    const scope = rules.find((r) => r.title === "Out of scope.");
    expect(links(scope?.body ?? []).map((l) => l.href)).toEqual([
      "https://github.com/probarion/probarion/blob/main/SECURITY.md",
    ]);
    // SECURITY.md reports through an X direct message or the repository's private GitHub advisory form; no mailbox
    const all = rules.flatMap((r) => r.body);
    expect(strings(all).join("")).not.toMatch(/@probarion\.xyz/);
    expect(links(all).filter((l) => l.href.startsWith("mailto:"))).toEqual([]);
    const hrefs = [...links(rules.flatMap((r) => r.body)), CANARY_COPY.attacker].map((l) => l.href);
    for (const href of hrefs.filter((h) => h.startsWith("/"))) {
      expect(PLANNED_ROUTES).not.toContain(href.replace(/[?#].*$/, ""));
    }
    expect(hrefs.filter((h) => /\/(open|security)$/.test(h))).toEqual([]);
  });

  it("says how a message is kept, word for word", () => {
    const data = strings(rules.find((r) => r.title === "Your data.")?.body).join("");
    expect(data).toBe(
      "Your message goes to a private model on NEAR AI Cloud. We store a sha256 hash of it, not the text, plus technique labels and the on-chain result. Your IP address and cookie are stored only as keyed hashes, for rate limits. Do not submit personal data.",
    );
    const counted = rules.find((r) => r.title === "How you are counted.")?.body ?? [];
    expect(counted.map((p) => (typeof p === "string" ? p : p.text)).join("")).toBe(
      "You are a challenge participant, not a customer. The Usage page counts you apart from the product's own users.",
    );
    // The words "Usage page" are the link, and the page it names is built.
    expect(links(counted)).toEqual([{ text: "Usage page", href: "/usage" }]);
    expect(PLANNED_ROUTES).not.toContain("/usage");
  });

  it("ends with a sentence that is true on its own, not a note to the team", () => {
    const fine = strings(rules.at(-1)?.body).join("");
    expect(fine).toContain("These rules may change while the challenge runs.");
    expect(fine).toContain("The challenge may pause or end at any time");
    expect(fine).not.toMatch(/legal advice|to be reviewed/);
  });

  it("says raw mode sends only what the contract's dry run says it would refuse", () => {
    const how = strings(rules[1]?.body).join("");
    expect(how).toMatch(/dry run says it would refuse/);
    expect(how).toContain("on chain");
  });
});

describe("the Freysa card", () => {
  it("states the figures that The Block reported, and no other incident", () => {
    const { body } = CANARY_COPY.freysa;
    for (const fact of ["November 2024", "482nd", "13.19 ETH", "$47,000"]) {
      expect(body).toContain(fact);
    }
    expect(body).toContain("it only proposes");
  });
});
