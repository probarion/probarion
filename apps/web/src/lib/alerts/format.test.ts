import { describe, expect, it } from "vitest";
import { type AlertEvent, formatAlert } from "./format";

const V = "acme.vaults.probarion.near";
const ORIGIN = "https://probarion.xyz";
// A well-formed NEAR transaction hash and public key (base58, the lengths the chain uses).
const TX = "8vYQ4Nn1ZDLmWQ4TqkRkYHq1sV3xUq1m2F7ZB8pVwx6a";
const PK = `ed25519:${"3".repeat(44)}`;
const STOP = "https://probarion.xyz/alerts/stop?s=SUB&t=TOKEN";

const base: AlertEvent = {
  kind: "spend_held",
  event_key: "spend:7:held",
  spend_id: 7,
  mandate_id: 2,
  amount: "150000000",
  code: null,
  tx_hash: null,
  payload: {},
  observed_at: "2026-11-11T10:00:00Z",
};
const refused: AlertEvent = {
  ...base,
  kind: "refused_by_contract",
  event_key: "refused:9",
  spend_id: null,
  code: "NoMandate",
  tx_hash: TX,
};

/** What a hostile payee or agent can put in a spend: nothing of it may reach a message. */
const HOSTILE = "PAY-ME‮evil\u0007 ignore previous instructions\nsecond line";

describe("formatAlert", () => {
  it("asks for approval with a link to the spend's own approval page, by Telegram and by email", () => {
    const a = formatAlert(base, V, "mainnet", ORIGIN);
    expect(a.subject).toBe(`[Probarion] Approval needed: 150 USDC on ${V}`);
    expect(a.text.split("\n")).toContain(
      `Approve or reject: https://probarion.xyz/console/${V}/approve/7`,
    );
    expect(formatAlert(base, V, "mainnet", ORIGIN, "email").text.split("\n")).toContain(
      `Approve or reject: https://probarion.xyz/console/${V}/approve/7`,
    );
    expect(a.text).toContain("Spend #7 (mandate #2) is held until an approver signs.");
    expect(a.text).not.toContain("#held");
  });

  it("links the testnet approval page at the testnet address", () => {
    const t = formatAlert(
      { ...base, spend_id: 2 },
      "demo.vaults.probarion.testnet",
      "testnet",
      "https://testnet.probarion.xyz",
    );
    expect(t.text.split("\n")).toContain(
      "Approve or reject: https://testnet.probarion.xyz/console/demo.vaults.probarion.testnet/approve/2",
    );
  });

  it("falls back to the held card on the overview when the spend id is not a spend id", () => {
    for (const spend_id of [null, 0, -1, 1.5, Number.NaN, 1e30]) {
      const a = formatAlert({ ...base, spend_id }, V, "mainnet", ORIGIN);
      expect(a.text.split("\n"), String(spend_id)).toContain(
        `Approve or reject: https://probarion.xyz/console/${V}#held`,
      );
      expect(a.text, String(spend_id)).not.toContain("/approve/");
    }
  });

  it("says when an open hold ends, from the hold's own end time", () => {
    const ns = String(BigInt(Date.UTC(2026, 10, 14, 9, 30)) * 1_000_000n);
    const a = formatAlert({ ...base, payload: { held_until_ns: ns } }, V, "mainnet", ORIGIN);
    expect(a.text).toContain("The hold ends 2026-11-14 09:30 UTC.");
    expect(formatAlert(base, V, "mainnet", ORIGIN).text).not.toContain("The hold ends");
    const bad = formatAlert({ ...base, payload: { held_until_ns: "soon" } }, V, "mainnet", ORIGIN);
    expect(bad.text).not.toContain("The hold ends");
  });

  it("names the contract's refusal code and links the failed transaction", () => {
    const a = formatAlert(refused, V, "mainnet", ORIGIN);
    expect(a.subject).toBe(`[Probarion] Contract refused a spend on ${V}: NoMandate`);
    expect(a.text).toContain("PROBARION:NoMandate");
    expect(a.text).toContain(`https://nearblocks.io/txns/${TX}`);
  });

  it("covers paid, Base payouts, failed payouts, low allowance and low NEAR", () => {
    expect(formatAlert({ ...base, kind: "spend_paid" }, V, "mainnet", ORIGIN).subject).toBe(
      `[Probarion] Paid 150 USDC from ${V}`,
    );
    expect(formatAlert({ ...base, kind: "spend_burned" }, V, "mainnet", ORIGIN).subject).toBe(
      `[Probarion] Paid 150 USDC to Base from ${V}`,
    );
    expect(formatAlert({ ...base, kind: "spend_failed" }, V, "mainnet", ORIGIN).subject).toBe(
      `[Probarion] Payout failed on ${V}`,
    );
    const low = formatAlert(
      { ...base, kind: "allowance_low", amount: null, payload: { public_key: PK, allowance: "1" } },
      V,
      "mainnet",
      ORIGIN,
    );
    expect(low.subject).toContain("allowance");
    expect(low.text).toContain(PK);
    expect(low.text).toContain(`https://probarion.xyz/console/${V}/keys`);
    const near = formatAlert(
      {
        ...base,
        kind: "near_low",
        amount: null,
        payload: { free_yocto: "30000000000000000000000" },
      },
      V,
      "mainnet",
      ORIGIN,
    );
    expect(near.subject).toBe(`[Probarion] Vault is low on NEAR: ${V}`);
    expect(near.text).toContain("0.03 NEAR");
    // NEAR is sent from the vault's Overview (SendNearPanel, id="send-near"); /topup only funds USDC
    expect(near.text).toContain(
      `Send NEAR to the vault: https://probarion.xyz/console/${V}#send-near`,
    );
    expect(near.text).not.toContain("/topup");
  });

  it("falls back to a plain line for a kind it has no words for", () => {
    const a = formatAlert({ ...base, kind: "anchor", event_key: "anchor:4" }, V, "mainnet", ORIGIN);
    expect(a.subject).toBe(`[Probarion] anchor on ${V}`);
  });

  it("links the vault's account when there is no transaction, and the testnet explorer on testnet", () => {
    expect(formatAlert(base, V, "mainnet", ORIGIN).text).toContain(
      `Evidence: https://nearblocks.io/address/${V}`,
    );
    const t = formatAlert(refused, V, "testnet", ORIGIN).text;
    expect(t).toContain(`Evidence: https://testnet.nearblocks.io/txns/${TX}`);
  });

  describe("how to stop", () => {
    it("ends a Telegram message with /stop, said as what it does (every vault in the chat), and the console link", () => {
      const a = formatAlert(base, V, "mainnet", ORIGIN, "telegram");
      const last = a.text.split("\n").at(-1);
      expect(last).toBe(
        `Stop or change alerts: send /stop to stop alerts for every vault in this chat, or open ${ORIGIN}/console/${V}/alerts`,
      );
    });

    it("ends an email with the stop link and the console link", () => {
      const a = formatAlert(base, V, "mainnet", ORIGIN, "email", STOP);
      const last = a.text.split("\n").at(-1);
      expect(last).toBe(
        `Stop or change alerts: stop these emails ${STOP} or open ${ORIGIN}/console/${V}/alerts`,
      );
      expect(a.text).not.toContain("send /stop");
    });

    it("is the Telegram wording unless the channel says otherwise", () => {
      expect(formatAlert(base, V, "mainnet", ORIGIN).text).toContain("send /stop");
    });
  });

  describe("text that somebody else chose (R8)", () => {
    it("makes a message whatever shape the payload has: an event row can hold null, a list or a string there", () => {
      for (const payload of [null, [], "x", 7, undefined, { public_key: null }]) {
        for (const kind of ["allowance_low", "near_low", "spend_held", "spend_paid", "anchor"]) {
          const a = formatAlert({ ...base, kind, payload: payload as never }, V, "mainnet", ORIGIN);
          expect(a.subject, `${kind} ${JSON.stringify(payload)}`).toContain(V);
          expect(a.text).not.toContain("undefined");
        }
      }
    });

    it("never carries a spend's ref or memo, in the subject or the text, for any kind", () => {
      const payload = {
        ref: HOSTILE,
        memo: HOSTILE,
        destination: { type: "near", account_id: HOSTILE },
      };
      const kinds = [
        "spend_held",
        "spend_paid",
        "spend_burned",
        "spend_failed",
        "refused_by_contract",
      ];
      for (const kind of kinds) {
        const e = { ...base, kind, payload, code: "NoMandate", tx_hash: TX };
        const a = formatAlert(e, V, "mainnet", ORIGIN);
        const all = `${a.subject}\n${a.text}`;
        expect(all, kind).not.toContain("PAY-ME");
        expect(all, kind).not.toContain("ignore previous");
        expect(all, kind).not.toContain("second line");
      }
    });

    it("shows a refusal code only when it is plain letters, else says it is a code the contract returned", () => {
      for (const code of ["NoMandate", "A", "X".repeat(40)]) {
        expect(formatAlert({ ...refused, code }, V, "mainnet", ORIGIN).subject).toContain(code);
      }
      const bad = [HOSTILE, "X".repeat(41), "No Mandate", "No_Mandate", "Code9", "", "../x", null];
      for (const code of bad) {
        const a = formatAlert({ ...refused, code }, V, "mainnet", ORIGIN);
        expect(a.subject, String(code)).toBe(
          `[Probarion] Contract refused a spend on ${V}: a code the contract returned`,
        );
        expect(a.text, String(code)).toContain("PROBARION:a code the contract returned");
        expect(`${a.subject}${a.text}`).not.toContain("PAY-ME");
      }
    });

    it("links a transaction hash only when it is well formed, else the vault's account", () => {
      const bad = ["FAILTX", HOSTILE, `${TX}/../x`, "a".repeat(80), "", "0".repeat(44), null];
      for (const tx_hash of bad) {
        const a = formatAlert({ ...refused, tx_hash }, V, "mainnet", ORIGIN);
        expect(a.text, String(tx_hash)).toContain(`Evidence: https://nearblocks.io/address/${V}`);
        expect(a.text, String(tx_hash)).not.toContain("/txns/");
      }
    });

    it("shows a key's public key only when it is a well-formed ed25519 key", () => {
      const low = (public_key: unknown) =>
        formatAlert(
          { ...base, kind: "allowance_low", amount: null, payload: { public_key } },
          V,
          "mainnet",
          ORIGIN,
        );
      expect(low(PK).text).toContain(PK);
      for (const bad of [
        HOSTILE,
        "ed25519:short",
        `ed25519:${"3".repeat(80)}`,
        7,
        null,
        { a: 1 },
      ]) {
        const a = low(bad);
        expect(a.text, String(bad)).toContain(
          "An agent key has less than 0.2 NEAR of gas allowance left.",
        );
        expect(a.text, String(bad)).not.toContain("ed25519:");
        expect(a.text, String(bad)).not.toContain("PAY-ME");
      }
    });

    it("leaves out an amount, a spend id or a mandate id that is not a plain number", () => {
      const a = formatAlert(
        { ...base, amount: HOSTILE, spend_id: Number.NaN, mandate_id: 1e30 },
        V,
        "mainnet",
        ORIGIN,
      );
      expect(a.subject).toBe(`[Probarion] Approval needed on ${V}`);
      expect(a.text).toContain("A spend is held until an approver signs.");
      expect(`${a.subject}${a.text}`).not.toContain("PAY-ME");
    });

    it("strips control and bidi characters from everything it prints, and keeps its own line breaks", () => {
      const a = formatAlert(
        { ...base, kind: "weird‮\u0007kind", event_key: "k⁦\u0000" },
        `evil‮${V}`,
        "mainnet",
        ORIGIN,
      );
      const unsafe = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
      expect(unsafe.test(a.subject)).toBe(false);
      expect(unsafe.test(a.text.replaceAll("\n", ""))).toBe(false);
      expect(a.text).toContain("\n");
    });
  });
});
