import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Network } from "@/lib/config";
import { PLANNED_ROUTES } from "@/lib/routes";
import { LINKS } from "@/lib/site/facts";
import {
  baseLine,
  budgetText,
  CANARY_COPY,
  characterCount,
  describeRaw,
  eyebrow,
  mandateParts,
  moreMandates,
  type Part,
  RAW_SKIP_TEXT,
  REPLY_TEXT,
  RULES_HEAD,
  rateLimitedText,
  refusedSub,
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
    rateLimitedText(7),
    budgetText(0, 5),
    budgetText(2, 5),
    ...rawCases.map((r) => describeRaw(r).text),
  ];
  for (const network of NETWORKS) {
    out.push(
      eyebrow(network),
      tokenNoun(network),
      runsOn(network),
      ...strings(rulesCopy(network, LINKS.security)),
    );
  }
  return out;
}

describe("the words the Canary pages must not use", () => {
  it("promises nothing for winning, and names no contract refusal that does not exist", () => {
    const banned = /bounty|keep what you extract|prize|reward|PayeeMismatch/i;
    expect(allCopy().filter((t) => banned.test(t))).toEqual([]);
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
      ...strings(rulesCopy("testnet", LINKS.security)),
      ...rawCases.map((r) => describeRaw(r).text),
    ];
    expect(testnet.filter((t) => /mainnet/i.test(t))).toEqual([]);
  });

  it("says a testnet build runs on testnet in the rules, and a mainnet build makes no such claim", () => {
    const fine = (n: Network) => strings(rulesCopy(n, LINKS.security).at(-1)?.body).join("");
    expect(fine("testnet")).toContain("It runs on testnet, with test tokens that have no value.");
    expect(fine("mainnet")).not.toContain("test tokens");
    expect(runsOn("testnet")).toBe(
      "This runs on testnet, and no third party has audited the code.",
    );
  });
});

describe("the numbers in the copy are the limits in code", () => {
  const limitsRule = (n: Network = "testnet") =>
    strings(rulesCopy(n, LINKS.security).find((r) => r.title === "Limits.")?.body).join("");

  it("quotes the text length wherever a visitor can hit it", () => {
    const max = thousands(CANARY_LIMITS.maxTextChars);
    expect(CANARY_COPY.form.note).toContain(`Up to ${max} characters`);
    expect(REPLY_TEXT.tooLong).toBe(`Your text is over ${max} characters.`);
    expect(characterCount(5)).toBe(`5 / ${max}`);
    expect(limitsRule()).toContain(`at most ${max} characters`);
  });

  it("quotes every limit of the rules from CANARY_LIMITS", () => {
    const text = limitsRule();
    expect(text).toContain(`${CANARY_LIMITS.attemptsPerIpPerHour} model attempts an hour`);
    expect(text).toContain(`every ${CANARY_LIMITS.rawVisitorWindowS / 60} minutes`);
    expect(text).toContain(`at most ${CANARY_LIMITS.rawGlobalPerHour} an hour`);
    expect(text).toContain(`${thousands(CANARY_LIMITS.dailyTokenBudget)} tokens`);
    expect(text).toContain("0.2 NEAR");
    expect(CANARY_LIMITS.minAllowanceYocto).toBe(200_000_000_000_000_000_000_000n);
  });

  it("reads the same on every network", () => {
    expect(limitsRule("mainnet")).toBe(limitsRule("testnet"));
  });
});

describe("raw-mode texts against the code they explain", () => {
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
  const rules = rulesCopy("testnet", LINKS.security);
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

  it("asks for a report by email and does not offer to let the finder keep anything", () => {
    const goal = rules[0];
    expect(links(goal?.body ?? [])).toEqual([
      { text: "security@probarion.xyz", href: "mailto:security@probarion.xyz" },
    ]);
    expect(strings(goal?.body).join("")).toContain(
      "pay anyone other than its single mandated payee",
    );
  });

  it("sends bug reports to the email or to SECURITY.md on GitHub, and links no page that is not built", () => {
    const scope = rules.find((r) => r.title === "Out of scope.");
    expect(links(scope?.body ?? []).map((l) => l.href)).toEqual([
      "mailto:security@probarion.xyz",
      "https://github.com/probarion/probarion/blob/main/SECURITY.md",
    ]);
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
    const counted = strings(rules.find((r) => r.title === "How you are counted.")?.body).join("");
    expect(counted).toBe(
      "You are a challenge participant, not a customer. These numbers are kept apart from the product's own.",
    );
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
