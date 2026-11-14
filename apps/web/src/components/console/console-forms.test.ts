import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TX_PHASE_LABEL } from "@/lib/ui/pending";

// The console's forms as the first render draws them (the server's HTML): each holds its one status region, mounted
// empty, so what an action answers is read out when it lands; each button's text is its label, with its busy label
// only a sizer (aria-hidden, words in CSS), so the button already has its busy width; and nothing is disabled.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/console/actions", () => ({
  registerVaultAction: async () => ({ ok: false, error: "x" }),
}));

import { AddEmailForm } from "./AddEmailForm";
import { KeyKeepButton, KeySyncButton } from "./KeyActions";
import { RegisterVaultForm } from "./RegisterVaultForm";
import { SettingsForm } from "./SettingsForm";
import { TelegramConnect } from "./TelegramConnect";

const html = (el: ReactElement) => renderToStaticMarkup(el).replaceAll("&#x27;", "'");
const never = <T>() => new Promise<T>(() => {});

/** Each button: its opening tag, the text it shows (the tags dropped), and the labels its sizers hold. */
const buttons = (markup: string) =>
  [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    attrs: m[1] ?? "",
    text: (m[2] ?? "").replace(/<[^>]*>/g, ""),
    sizes: [...(m[2] ?? "").matchAll(/data-label="([^"]*)"/g)].map((s) => s[1]),
  }));

const FORMS: [string, ReactElement, { regions: number; labels: string[]; busy: string[] }][] = [
  [
    "SettingsForm",
    createElement(SettingsForm, {
      vault: "v.vaults.probarion.near",
      kind: "team",
      zeroRetention: false,
      proofPublic: false,
      save: never,
      refresh: never,
    }),
    {
      regions: 2,
      labels: ["Save settings", "Re-sync approvers from the chain"],
      busy: ["Saving…", "Reading the chain…"],
    },
  ],
  [
    "AddEmailForm",
    createElement(AddEmailForm, { add: never }),
    { regions: 1, labels: ["Send confirmation"], busy: ["Sending…"] },
  ],
  [
    "KeySyncButton",
    createElement(KeySyncButton, { sync: never }),
    { regions: 1, labels: ["Check on-chain status"], busy: ["Reading the chain…"] },
  ],
  [
    "KeyKeepButton",
    createElement(KeyKeepButton, { keep: never }),
    { regions: 1, labels: ["Keep"], busy: ["Reading the chain…"] },
  ],
  [
    "RegisterVaultForm",
    createElement(RegisterVaultForm, { placeholder: "acme.vaults.probarion.near" }),
    { regions: 1, labels: ["Register existing vault"], busy: ["Checking the chain…"] },
  ],
  [
    "TelegramConnect",
    createElement(TelegramConnect, { connect: never }),
    { regions: 1, labels: ["Create a Telegram link"], busy: ["Making the link…"] },
  ],
];

describe.each(FORMS)("%s's first render", (_name, element, want) => {
  const out = html(element);

  it("holds its status region, mounted and empty, and no other live region", () => {
    expect(out.split('<div role="status"></div>').length - 1).toBe(want.regions);
    expect(out.match(/role="(?:status|alert)"|aria-live=/g)).toHaveLength(want.regions);
  });

  it("shows each button's label as its text, sized already for its busy label, and disables none", () => {
    const shown = buttons(out);
    expect(shown.map((b) => b.text)).toEqual(want.labels);
    want.busy.forEach((busy, i) => {
      expect(shown[i]?.sizes, busy).toContain(busy);
    });
    // The attributes, not the class list's disabled: and aria-disabled: variants.
    const names = (attrs: string) =>
      [...attrs.replace(/="[^"]*"/g, "").matchAll(/[a-z-]+/g)].map((a) => a[0]);
    for (const b of shown) {
      expect(names(b.attrs), b.text).toContain("type");
      expect(names(b.attrs), b.text).not.toContain("disabled");
      expect(names(b.attrs), b.text).not.toContain("aria-disabled");
    }
  });
});

describe("the console forms' busy labels", () => {
  it("register's button is as wide as its refresh label too, which it shows while the vault list is read again", () => {
    const [register] = buttons(html(FORMS[4]?.[1] as ReactElement));
    expect(register?.sizes).toEqual([
      "Register existing vault",
      "Checking the chain…",
      TX_PHASE_LABEL.refresh,
    ]);
  });

  it("keep their underline on a text button, whose busyLabel grid takes none from the button", () => {
    const [save, resync] = buttons(html(FORMS[0]?.[1] as ReactElement));
    expect(save?.attrs).not.toContain("busy-now");
    expect(resync?.attrs).toContain("[&amp;_.busy-now]:underline");
    const [keep] = buttons(html(FORMS[3]?.[1] as ReactElement));
    expect(keep?.attrs).toContain("[&amp;_.busy-now]:underline");
  });

  it("write their words with no dash characters and their busy labels with the ellipsis character", () => {
    for (const file of [
      "SettingsForm.tsx",
      "AddEmailForm.tsx",
      "KeyActions.tsx",
      "RegisterVaultForm.tsx",
      "TelegramConnect.tsx",
      "form-run.tsx",
      "form-look.ts",
    ]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/[–—]/);
      expect(source, file).not.toMatch(/\w\.\.\.["`]/);
    }
  });
});
