import { describe, expect, it } from "vitest";
import { readInbox } from "../src/api";
import { DEFAULT_ORIGIN, OFFERED } from "../src/origins";
import {
  browserLabel,
  connectChoices,
  itemText,
  mandateLabel,
  NOTE,
  noteFor,
  sentText,
  sizeText,
  usdc,
  utc,
  vaultsWithMandates,
  waitingCount,
  waitingRows,
} from "../src/popup/view";
import { inboxBody, ORIGIN } from "./helpers";

const inbox = readInbox(inboxBody(), ORIGIN);
const base = `${ORIGIN}/console/acme.vault.testnet`;

describe("the popup's text", () => {
  it("has the note under Send, word for word", () => {
    expect(NOTE).toBe(
      "Nothing is paid from the browser. It waits until you confirm it in the console with your wallet.",
    );
  });

  it("says the owner confirms when the person is the vault's approver", () => {
    const sent = { id: "x", url: `${base}/payables/x`, status: "awaiting_owner" };
    expect(noteFor("owner")).toBe(NOTE);
    expect(noteFor("approver")).toBe(
      "Nothing is paid from the browser. It waits until the vault's owner confirms it in the console with their wallet.",
    );
    expect(sentText({ ...sent, duplicate: false }, "approver")).toBe(
      "Queued. It waits for the owner's confirmation.",
    );
    expect(sentText({ ...sent, duplicate: true }, "approver")).toBe(
      "Already queued. It waits for the owner's confirmation.",
    );
  });

  it("writes amounts in USDC", () => {
    expect(usdc("1250")).toBe("1250 USDC");
    expect(usdc("480.5")).toBe("480.5 USDC");
    expect(usdc("unreadable")).toBe("an unreadable amount");
  });

  it("labels a mandate as label · payee · per-payment", () => {
    const [named, unnamed] = inbox.vaults[0]?.mandates ?? [];
    expect(named && mandateLabel(named)).toBe(
      "Northwind hosting · near:northwind.testnet · 2000 USDC per payment",
    );
    expect(unnamed && mandateLabel(unnamed)).toBe(
      "Mandate #5 · near:contractor.testnet · 5000 USDC per payment",
    );
  });

  it("lists the invoices first, then the held payments", () => {
    expect(waitingRows(inbox)).toEqual([
      {
        title: "1250 USDC to near:northwind.testnet",
        detail: "INV-1038 · Acme operations · sent from the extension",
        url: `${base}/payables/6f1c2a90-0000-4000-8000-000000000001`,
      },
      {
        title: "480.5 USDC to a payee NEAR couldn't show",
        detail: "INV-0977 · Acme operations",
        url: `${base}/payables/6f1c2a90-0000-4000-8000-000000000002`,
      },
      {
        title: "3200 USDC to near:contractor.testnet",
        detail: "Held payment #14 · Acme operations · until 2026-11-10 09:00 UTC",
        url: base,
      },
    ]);
    expect(waitingCount(inbox)).toBe(3);
  });

  it("offers only the vaults with an active mandate", () => {
    const vault = inbox.vaults[0];
    if (vault === undefined) throw new Error("fixture");
    expect(
      vaultsWithMandates({
        ...inbox,
        vaults: [vault, { ...vault, vault: "b.testnet", mandates: [] }],
      }),
    ).toEqual([vault]);
  });

  it("says what happened to a sent invoice", () => {
    const sent = { id: "x", url: `${base}/payables/x` };
    expect(sentText({ ...sent, status: "awaiting_owner", duplicate: false })).toBe(
      "Queued. It waits for your confirmation.",
    );
    expect(sentText({ ...sent, status: "awaiting_owner", duplicate: true })).toBe(
      "Already queued. It waits for your confirmation.",
    );
    expect(sentText({ ...sent, status: "decided", duplicate: true })).toBe(
      "Probarion already has this invoice. Open it to see what happened.",
    );
  });

  it("shows a file by its name and size, a selection by its start", () => {
    const pdf = {
      name: "a.pdf",
      type: "application/pdf" as const,
      size: 184_320,
      base64: "",
      preview: null,
    };
    expect(itemText(pdf)).toBe("a.pdf · 180 KB");
    expect(
      itemText({ ...pdf, name: "selection.txt", type: "text/plain", preview: "Total 120 USDC" }),
    ).toBe('"Total 120 USDC"');
    expect(sizeText(900)).toBe("900 B");
    expect(sizeText(3_500_000)).toBe("3.3 MB");
  });

  it("names the browser for the connections list", () => {
    expect(browserLabel({ platform: "Windows" })).toBe("Chrome on Windows");
    expect(browserLabel(undefined)).toBe("Chrome");
    expect(browserLabel({ platform: 7 })).toBe("Chrome");
  });

  it("writes times in UTC", () => {
    expect(utc("2026-11-10T09:00:00.000Z")).toBe("2026-11-10 09:00 UTC");
    expect(utc("soon")).toBe("an unknown time");
  });
});

describe("Connect's address list", () => {
  it("preselects probarion.xyz and still offers probarion.vercel.app", () => {
    const { options, selected } = connectChoices(OFFERED, DEFAULT_ORIGIN);
    expect(selected).toBe("https://probarion.xyz");
    expect(options).toEqual([
      ["https://probarion.vercel.app", "probarion.vercel.app"],
      ["https://probarion.xyz", "probarion.xyz"],
    ]);
  });

  it("does not offer an address that doesn't serve Probarion yet", () => {
    const hosts = connectChoices(OFFERED, DEFAULT_ORIGIN).options.map(([, host]) => host);
    expect(hosts).not.toContain("testnet.probarion.xyz");
  });

  it("falls back to the first offered address when the preferred one isn't offered", () => {
    expect(
      connectChoices(["https://a.example", "https://b.example"], "https://c.example").selected,
    ).toBe("https://a.example");
  });
});
