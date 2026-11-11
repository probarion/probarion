import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConfirmOptions } from "@/lib/console/confirm-dialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { buttonClass, dangerButtonClass, lineButtonClass } from "./ui";

// The dialog's markup as the server renders it (no browser here). Opening it, focus and the keyboard are
// the browser's `<dialog>` and are held by the pure logic in lib/console/confirm-dialog.test.ts, plus the wiring
// checks at the end of this file.

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const REVOKE_BODY = `Revoke mandate #3 "Acme Design" (pays bob.near)?\n\nThis cannot be undone. The agent can no longer spend on it and a held payment can no longer be approved; a payout already pending still settles.`;

const base: ConfirmOptions = {
  title: "Approve",
  body: "Approve paying 5 USDC to bob.near (spend #7)?",
  actionLabel: "Approve",
};

const render = (options: ConfirmOptions | null) =>
  renderToStaticMarkup(createElement(ConfirmDialog, { options, onSettle: () => {} }));

/** The attributes of the first element that has this id, or the first `<tag>`. */
const openTag = (html: string, pattern: RegExp) => pattern.exec(html)?.[0] ?? "";
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const buttons = (html: string) =>
  [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    attrs: m[1] ?? "",
    text: m[2] ?? "",
  }));

describe("ConfirmDialog markup", () => {
  it("renders nothing while no question is open", () => {
    expect(render(null)).toBe("");
  });

  it("is a native <dialog>, shut until showModal() opens it", () => {
    const html = render(base);
    expect(html).toMatch(/^<dialog\b/);
    expect(openTag(html, /^<dialog\b[^>]*>/)).not.toMatch(/\sopen[\s=>]/);
  });

  it("titles the dialog with the action's own label, and labels it for a screen reader by that title", () => {
    const html = render({ ...base, title: "Withdraw all 12.5 USDC to my wallet" });
    const h2 = openTag(html, /<h2\b[^>]*>/);
    const id = attr(h2, "id");
    expect(id).toBeTruthy();
    expect(html).toContain(`>Withdraw all 12.5 USDC to my wallet</h2>`);
    expect(attr(openTag(html, /^<dialog\b[^>]*>/), "aria-labelledby")).toBe(id);
  });

  it("describes the dialog by its body", () => {
    const html = render(base);
    const bodyTag = openTag(html, /<p\b[^>]*id="[^"]*"[^>]*>(?=Approve paying)/);
    const id = attr(bodyTag, "id");
    expect(id).toBeTruthy();
    expect(attr(openTag(html, /^<dialog\b[^>]*>/), "aria-describedby")).toBe(id);
    expect(attr(openTag(html, /^<dialog\b[^>]*>/), "aria-labelledby")).not.toBe(id);
  });

  it("shows the confirm text as it was, and keeps a paragraph break as a paragraph break", () => {
    const html = render({ ...base, title: "Revoke", actionLabel: "Revoke", body: REVOKE_BODY });
    expect(html).toContain(escapeHtml(REVOKE_BODY)); // byte for byte, with its two newlines
    const bodyTag = openTag(html, /<p\b[^>]*whitespace-pre-line[^>]*>/);
    expect(bodyTag).toContain("whitespace-pre-line");
    expect(html).toContain(">Revoke mandate #3 ");
  });

  it("shows a footnote when there is one, and none otherwise", () => {
    const note = "Next, your wallet asks you to sign. Nothing is sent until you do.";
    expect(render({ ...base, footnote: note })).toContain(`>${note}</p>`);
    expect(render(base)).not.toContain("Next, your wallet");
    expect(render(base)).not.toContain("Nothing is sent");
  });

  it("has two buttons, Cancel first and the action second, neither of which submits a form", () => {
    const [cancel, action, ...rest] = buttons(render(base));
    expect(rest).toEqual([]);
    expect(cancel?.text).toBe("Cancel");
    expect(action?.text).toBe("Approve");
    expect(attr(cancel?.attrs ?? "", "type")).toBe("button");
    expect(attr(action?.attrs ?? "", "type")).toBe("button");
  });

  it("puts the initial focus on Cancel, not on the action", () => {
    const [cancel, action] = buttons(render(base));
    expect(cancel?.attrs).toMatch(/\bautofocus=""/);
    expect(action?.attrs).not.toMatch(/autofocus/);
  });

  it("labels the action button with the action's label, whatever the title says", () => {
    const [, action] = buttons(
      render({ ...base, title: "Reject invoice", actionLabel: "Reject invoice" }),
    );
    expect(action?.text).toBe("Reject invoice");
  });

  it("escapes the text it is given", () => {
    const html = render({ ...base, body: '<img src=x onerror="boom()"> & more' });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;boom()&quot;&gt; &amp; more");
  });

  describe("tones", () => {
    it("a normal dialog has no eyebrow, and its action button is the console's button", () => {
      const html = render(base);
      expect(html).not.toContain("Cannot be undone");
      const [, action] = buttons(html);
      expect(attr(action?.attrs ?? "", "class")).toBe(buttonClass);
      expect(html).not.toContain("rose-");
    });

    it("an unspecified tone is the normal one", () => {
      expect(render({ ...base, tone: "normal" })).toBe(render(base));
    });

    it("a danger dialog has the 'Cannot be undone' eyebrow above its title, and a red action button", () => {
      const html = render({ ...base, tone: "danger" });
      expect(html.indexOf("Cannot be undone")).toBeGreaterThan(-1);
      expect(html.indexOf("Cannot be undone")).toBeLessThan(html.indexOf("<h2"));
      expect(openTag(html, /<p\b[^>]*>(?=Cannot be undone)/)).toMatch(/class="[^"]*\btext-bad\b/);
      const [, action] = buttons(html);
      expect(attr(action?.attrs ?? "", "class")).toBe(dangerButtonClass);
      expect(dangerButtonClass).toContain("bg-bad");
      expect(dangerButtonClass).toContain("text-white");
    });

    it("its Cancel is the console's outline button, in either tone", () => {
      for (const tone of ["normal", "danger"] as const) {
        const [cancel] = buttons(render({ ...base, tone }));
        expect(cancel?.text, tone).toBe("Cancel");
        expect(attr(cancel?.attrs ?? "", "class"), tone).toBe(lineButtonClass);
      }
    });

    it("the eyebrow is not the title: the dialog is still named by the action", () => {
      const html = render({ ...base, tone: "danger" });
      const id = attr(openTag(html, /<h2\b[^>]*>/), "id");
      expect(attr(openTag(html, /^<dialog\b[^>]*>/), "aria-labelledby")).toBe(id);
      expect(html).toMatch(/<h2\b[^>]*>Approve<\/h2>/);
    });

    it("a danger dialog is announced as an alert dialog, and its 'Cannot be undone' line is read first", () => {
      const html = render({ ...base, tone: "danger" });
      const dialog = openTag(html, /^<dialog\b[^>]*>/);
      expect(attr(dialog, "role")).toBe("alertdialog");
      const eyebrow = openTag(html, /<p\b[^>]*>(?=Cannot be undone)/);
      const eyebrowId = attr(eyebrow, "id");
      const bodyId = attr(openTag(html, /<p\b[^>]*id="[^"]*"[^>]*>(?=Approve paying)/), "id");
      expect(eyebrowId).toBeTruthy();
      expect(bodyId).toBeTruthy();
      expect(attr(dialog, "aria-describedby")).toBe(`${eyebrowId} ${bodyId}`);
    });

    it("a normal dialog is a plain dialog, described by its text alone", () => {
      const html = render(base);
      const dialog = openTag(html, /^<dialog\b[^>]*>/);
      expect(attr(dialog, "role")).toBeUndefined();
      const bodyId = attr(openTag(html, /<p\b[^>]*id="[^"]*"[^>]*>(?=Approve paying)/), "id");
      expect(attr(dialog, "aria-describedby")).toBe(bodyId);
    });
  });

  describe("styling", () => {
    it("is a white panel with a hairline border and a large radius, over a dimmed backdrop", () => {
      const cls = attr(openTag(render(base), /^<dialog\b[^>]*>/), "class") ?? "";
      expect(cls).toContain("rounded-3xl");
      expect(cls).toContain("border-line");
      expect(cls).toContain("bg-surface");
      expect(cls).toContain("backdrop:bg-ink/45");
      // Tailwind's reset zeroes the margin the browser centres a modal with.
      expect(cls).toContain("m-auto");
    });

    it("wraps a long account id anywhere, so a 64-character implicit owner does not scroll the dialog sideways", () => {
      const implicit = "35008ecd0f274c7af302e0ecbcfe39211231069c3953cdb228ff5eca1399242b";
      const html = render({
        title: "Create vault in my wallet",
        actionLabel: "Create vault in my wallet",
        body: `Create acme.vaults.probarion.testnet with ${implicit} as its owner and a 0.5 NEAR deposit?`,
        footnote: `Signed in as ${implicit}.`,
      });
      const body = openTag(html, /<p\b[^>]*>(?=Create acme)/);
      expect(body).toMatch(/class="[^"]*\bwrap-anywhere\b[^"]*"/);
      expect(body).toContain("whitespace-pre-line"); // the paragraph breaks are kept too
      expect(openTag(html, /<h2\b[^>]*>/)).toMatch(/class="[^"]*\bwrap-anywhere\b[^"]*"/);
      expect(openTag(html, /<p\b[^>]*>(?=Signed in as)/)).toMatch(
        /class="[^"]*\bwrap-anywhere\b[^"]*"/,
      );
      expect(html).toContain(implicit); // whole, so it can still be copied
    });
  });
});

describe("the dialog's wiring", () => {
  const source = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "ConfirmDialog.tsx"),
    "utf8",
  );

  it("is a client component that opens with showModal(), so the page behind it is inert", () => {
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).toContain(".showModal()");
  });

  it("turns Esc (the dialog's cancel event) into a cancel, and stops the browser closing it itself", () => {
    expect(source).toMatch(/onCancel=\{/);
    expect(source).toContain("preventDefault()");
    expect(source).toContain('"escape"');
  });

  it("cancels on a click on the backdrop, and on Cancel; only the action button confirms", () => {
    expect(source).toContain("isBackdropClick(");
    expect(source).toContain('"backdrop"');
    expect(source).toContain('"cancel-button"');
    expect(source.match(/"action"/g)).toHaveLength(1);
  });

  it("gives the focus back to the button that opened it", () => {
    expect(source).toContain("document.activeElement");
    expect(source).toMatch(/opener[\s\S]*\.focus\(\)/);
  });

  it("answers an open question when it unmounts, so no caller waits for ever", () => {
    expect(source).toContain('settle("unmount")');
  });

  it("is rendered into document.body, so no fieldset or clickable ancestor of the button reaches it", () => {
    expect(source).toContain("createPortal(");
    expect(source).toContain("document.body");
    expect(source).toContain('typeof document === "undefined"'); // the server render has none
  });

  it("is told which element to give the focus back to, and says what it did on a close of its own", () => {
    expect(source).toContain("pickOpener(");
    expect(source).toContain('onSettle("close")');
  });
});
