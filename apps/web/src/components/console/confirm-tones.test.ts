import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveTx, rejectTx, revokeMandateTx } from "@/lib/near/tx";
import { isSourceFile, toPosix, walk } from "../../../test/deploy-scan";

// Which confirm dialogs are the red, "Cannot be undone" kind: revoking a mandate, removing an agent key, rejecting a
// spend, rejecting an invoice. Everything else (freeze, approve, withdraw, create a vault, send NEAR, replace the
// ledger key) is the normal dialog. The wallet button is replaced by a stub that records its props.

type Captured = { label: string; confirm?: string; confirmTone?: string };
const h = vi.hoisted(() => ({ buttons: [] as Captured[] }));

vi.mock("@/components/wallet/TxButton", () => ({
  TxButton: (p: Captured) => {
    h.buttons.push(p);
    return createElement("button", { type: "button" }, p.label);
  },
}));

import { KeyTxButton } from "./KeyActions";
import { RevokeMandateButton } from "./RevokeMandateButton";
import { VaultTxButton } from "./VaultTxButton";

const VAULT = "acme.vaults.probarion.near";
const last = () => {
  const b = h.buttons.at(-1);
  if (!b) throw new Error("no button rendered");
  return b;
};

beforeEach(() => {
  h.buttons.length = 0;
});

describe("the buttons that wrap TxButton pass the tone through", () => {
  const vaultProps = {
    label: "Reject",
    network: "mainnet" as const,
    tx: rejectTx(VAULT, 7),
    outOfNearCodes: [],
    vaultNearLow: false,
    confirm: "Reject spend #7? Its reservation goes back to the mandate.",
  };

  it("VaultTxButton forwards confirmTone when it is given, and sends none when it is not", () => {
    renderToStaticMarkup(createElement(VaultTxButton, { ...vaultProps, confirmTone: "danger" }));
    expect(last().confirmTone).toBe("danger");
    renderToStaticMarkup(
      createElement(VaultTxButton, { ...vaultProps, label: "Approve", tx: approveTx(VAULT, 7) }),
    );
    expect(last().confirmTone).toBeUndefined();
  });

  it("KeyTxButton forwards confirmTone when it is given, and sends none when it is not", () => {
    const props = {
      label: "Remove",
      network: "mainnet" as const,
      signer: "acme.near",
      tx: rejectTx(VAULT, 1),
      lockKey: "keys:remove:x",
      confirm: "Remove this agent key from the vault? Payables stops using it at once.",
      outOfNearCodes: [],
      sync: async () => null,
    };
    renderToStaticMarkup(createElement(KeyTxButton, { ...props, confirmTone: "danger" }));
    expect(last().confirmTone).toBe("danger");
    renderToStaticMarkup(createElement(KeyTxButton, props));
    expect(last().confirmTone).toBeUndefined();
  });

  it("RevokeMandateButton asks with the danger dialog, and keeps its text", () => {
    renderToStaticMarkup(
      createElement(RevokeMandateButton, {
        vault: VAULT,
        mandateId: 3,
        mandateLabel: "Acme Design",
        payeeText: "bob.near",
        network: "mainnet",
        signer: "acme.near",
        tx: revokeMandateTx(VAULT, 3),
        outOfNearCodes: [],
      }),
    );
    expect(last().label).toBe("Revoke");
    expect(last().confirmTone).toBe("danger");
    expect(last().confirm).toBe(
      `Revoke mandate #3 "Acme Design" (pays bob.near)?\n\nThis cannot be undone. The agent can no longer spend on it and a held payment can no longer be approved; a payout already pending still settles.`,
    );
  });
});

/** How many times a source file gives a button the danger tone, however the prop is spelled. */
function countDangerProps(source: string): number {
  return (source.match(/confirmTone=(?:"danger"|\{\s*["']danger["']\s*\})/g) ?? []).length;
}

describe("countDangerProps (so the count below cannot be dodged by how the prop is written)", () => {
  it("counts the string form and the expression forms alike", () => {
    expect(countDangerProps('<B confirmTone="danger" />')).toBe(1);
    expect(countDangerProps('<B confirmTone={"danger"} />')).toBe(1);
    expect(countDangerProps('<B confirmTone={ "danger" } />')).toBe(1);
    expect(countDangerProps("<B confirmTone={'danger'} />")).toBe(1);
    expect(countDangerProps('<A confirmTone="danger" /><B confirmTone={"danger"} />')).toBe(2);
  });

  it("does not count another tone, or no tone", () => {
    expect(countDangerProps("<B confirmTone={undefined} />")).toBe(0);
    expect(countDangerProps('<B confirm="danger" />')).toBe(0);
  });
});

describe("where the danger tone is used", () => {
  const SRC = fileURLToPath(new URL("../../", import.meta.url));
  const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");

  /** The wallet-button element (from its `<Name` to its `/>`) that holds `needle`. */
  function elementWith(source: string, needle: string): string {
    const at = source.indexOf(needle);
    if (at < 0) throw new Error(`not found: ${needle}`);
    const open = /<(?:Vault|Key)?TxButton\b/g;
    let from = -1;
    for (let m = open.exec(source); m && m.index < at; m = open.exec(source)) from = m.index;
    if (from < 0) throw new Error(`no wallet button before: ${needle}`);
    return source.slice(from, source.indexOf("/>", at) + 2);
  }

  it("removing an agent key (the keys page) is a danger dialog", () => {
    const el = elementWith(
      read("app", "console", "[vault]", "keys", "page.tsx"),
      '"Remove this agent key from the vault? Payables stops using it at once."',
    );
    expect(el).toContain("<KeyTxButton");
    expect(el).toContain('label="Remove"');
    expect(el).toContain('confirmTone="danger"');
  });

  it("rejecting a spend (the vault page) is a danger dialog", () => {
    const el = elementWith(
      read("app", "console", "[vault]", "page.tsx"),
      "Its reservation goes back to the mandate.",
    );
    expect(el).toContain("<VaultTxButton");
    expect(el).toContain('label="Reject"');
    expect(el).toContain('confirmTone="danger"');
  });

  it("revoking a mandate is a danger dialog", () => {
    const el = elementWith(
      read("components", "console", "RevokeMandateButton.tsx"),
      "Revoke mandate #",
    );
    expect(el).toContain("<TxButton");
    expect(el).toContain('confirmTone="danger"');
  });

  it("nothing else is: the danger tone appears at exactly those three call sites", () => {
    const users = walk(SRC)
      .filter(isSourceFile)
      .flatMap((f) => {
        const n = countDangerProps(readFileSync(f, "utf8"));
        return n === 0 ? [] : [`${toPosix(relative(SRC, f))} x${n}`];
      })
      .sort();
    expect(users).toEqual([
      "app/console/[vault]/keys/page.tsx x1",
      "app/console/[vault]/page.tsx x1",
      "components/console/RevokeMandateButton.tsx x1",
    ]);
  });

  it("the other keys-page and vault-page confirms keep the normal dialog", () => {
    const keys = read("app", "console", "[vault]", "keys", "page.tsx");
    const ledger = elementWith(keys, "Replace the vault's ledger key with this one?");
    expect(ledger).toContain('label="Set as ledger key"');
    expect(ledger).not.toContain("confirmTone");
    const page = read("app", "console", "[vault]", "page.tsx");
    for (const needle of [
      "Unfreeze the vault? Agents can spend again",
      "confirm={FREEZE_CONFIRM}",
      "Approve paying",
      "Withdraw the vault's whole balance",
      "Withdraw the vault's whole Base USDC balance",
    ]) {
      expect(elementWith(page, needle), needle).not.toContain("confirmTone");
    }
  });

  it("rejecting an invoice is a danger dialog from the panel", () => {
    const panel = read("components", "console", "ConfirmInvoicePanel.tsx");
    expect(panel).toContain("useConfirm()");
    expect(panel).toContain("REJECT_INVOICE_CONFIRM");
    // and hands the dialog the Reject button that was clicked, to give the focus back to
    expect(panel).toContain("ask(REJECT_INVOICE_CONFIRM, opener)");
    expect(panel).toContain("onClick={(e) => onReject(e.currentTarget)}");
  });
});
