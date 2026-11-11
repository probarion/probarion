import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveTx, rejectTx, revokeMandateTx } from "@/lib/near/tx";
import { isSourceFile, toPosix, walk } from "../../../test/deploy-scan";

// Which confirm dialogs are the red, "Cannot be undone" kind: revoking a mandate, removing an agent key, rejecting a
// spend, rejecting an invoice, and replacing a ledger key that the user's own agent holds or that the Agent (MCP) tab
// replaces. Everything else (freeze, approve, withdraw, create a vault, send NEAR, replace the console's own ledger
// key) is the normal dialog. The wallet button is replaced by a stub that records its props.

type Captured = { label: string; confirm?: string; confirmTone?: string };
const h = vi.hoisted(() => ({ buttons: [] as Captured[] }));

vi.mock("@/components/wallet/TxButton", () => ({
  TxButton: (p: Captured) => {
    h.buttons.push(p);
    return createElement("button", { type: "button" }, p.label);
  },
}));

import {
  KeyTxButton,
  outsideLedgerConfirm,
  REPLACE_MAYBE_OUTSIDE_LEDGER_CONFIRM,
  REPLACE_OUTSIDE_LEDGER_CONFIRM,
} from "./KeyActions";
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

  it("a new ledger key asks about a ledger key held outside Probarion as a fact only when the chain says so", () => {
    expect(outsideLedgerConfirm(true)).toBe(REPLACE_OUTSIDE_LEDGER_CONFIRM);
    // The chain could not be read: the dialog says it is not known.
    expect(outsideLedgerConfirm(null)).toBe(REPLACE_MAYBE_OUTSIDE_LEDGER_CONFIRM);
    expect(REPLACE_MAYBE_OUTSIDE_LEDGER_CONFIRM).toContain("could not be read");
    expect(REPLACE_MAYBE_OUTSIDE_LEDGER_CONFIRM).toContain("If your own agent holds");
    expect(outsideLedgerConfirm(false)).toBeUndefined();
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

/** A tone chosen by a condition, such as `confirmTone={held ? "danger" : undefined}`. */
function countConditionalDanger(source: string): number {
  return (source.match(/confirmTone=\{[^{}]*\?\s*["']danger["'][^{}]*\}/g) ?? []).length;
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

  it("counts a tone chosen by a condition apart", () => {
    expect(countConditionalDanger('<B confirmTone={x ? "danger" : undefined} />')).toBe(1);
    expect(countConditionalDanger('<B confirmTone="danger" />')).toBe(0);
    expect(countDangerProps('<B confirmTone={x ? "danger" : undefined} />')).toBe(0);
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

  it("rejecting a spend on its approval page (the page an alert links to) is a danger dialog", () => {
    const el = elementWith(
      read("app", "console", "[vault]", "approve", "[spend]", "page.tsx"),
      "its reservation goes back to the mandate.",
    );
    expect(el).toContain("<VaultTxButton");
    expect(el).toContain('label="Reject"');
    expect(el).toContain('confirmTone="danger"');
    const approve = elementWith(
      read("app", "console", "[vault]", "approve", "[spend]", "page.tsx"),
      "Approve paying",
    );
    expect(approve).not.toContain("confirmTone");
  });

  it("revoking a mandate is a danger dialog", () => {
    const el = elementWith(
      read("components", "console", "RevokeMandateButton.tsx"),
      "Revoke mandate #",
    );
    expect(el).toContain("<TxButton");
    expect(el).toContain('confirmTone="danger"');
  });

  it("nothing else is: the danger tone appears at exactly those four call sites", () => {
    const users = walk(SRC)
      .filter(isSourceFile)
      .flatMap((f) => {
        const n = countDangerProps(readFileSync(f, "utf8"));
        return n === 0 ? [] : [`${toPosix(relative(SRC, f))} x${n}`];
      })
      .sort();
    expect(users).toEqual([
      "app/console/[vault]/approve/[spend]/page.tsx x1",
      // Remove for a key the console made, and for one held outside Probarion.
      "app/console/[vault]/keys/page.tsx x2",
      "app/console/[vault]/page.tsx x1",
      // Replace an unused ledger key, and remove the agent's key (Agent (MCP) tab).
      "components/console/ConnectAgentPanel.tsx x2",
      "components/console/RevokeMandateButton.tsx x1",
    ]);
  });

  it("a tone chosen by a condition appears only where a ledger key held outside Probarion may be replaced", () => {
    const users = walk(SRC)
      .filter(isSourceFile)
      .flatMap((f) => {
        const n = countConditionalDanger(readFileSync(f, "utf8"));
        return n === 0 ? [] : [`${toPosix(relative(SRC, f))} x${n}`];
      })
      .sort();
    expect(users).toEqual([
      "app/console/[vault]/keys/page.tsx x1",
      "components/console/KeyActions.tsx x1",
    ]);
  });

  it("replacing the ledger key from the Agent (MCP) tab, and removing the agent's key there, are danger dialogs", () => {
    const panel = read("components", "console", "ConnectAgentPanel.tsx");
    const replace = elementWith(panel, 'label="Replace the ledger key in my wallet"');
    expect(replace).toContain("confirm={REPLACE_CONFIRM}");
    expect(replace).toContain('confirmTone="danger"');
    const remove = elementWith(panel, 'label="Remove this agent key"');
    expect(remove).toContain('confirmTone="danger"');
    // The plain set (no ledger key yet) has no dialog at all.
    expect(elementWith(panel, 'label="Set ledger key in my wallet"')).not.toContain("confirm");
  });

  it("the other keys-page and vault-page confirms keep the normal dialog", () => {
    const keys = read("app", "console", "[vault]", "keys", "page.tsx");
    const ledger = elementWith(keys, "Replace the vault's ledger key with this one?");
    expect(ledger).toContain('label="Set as ledger key"');
    // Red only when the ledger key it replaces is held outside Probarion (or that could not be read).
    expect(ledger).toContain(
      'confirmTone={view.ledgerHeldElsewhere !== false ? "danger" : undefined}',
    );
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
