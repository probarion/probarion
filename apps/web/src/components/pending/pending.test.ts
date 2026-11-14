import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SLOW_HINT, TX_PHASE_LABELS } from "@/lib/ui/pending";

// The primitives as markup. A test can make next/link report a pending navigation; left alone, LinkPending reads
// next/link's real status, which is idle outside a navigation.
const link = vi.hoisted(() => ({ pending: undefined as boolean | undefined }));
vi.mock("next/link", async (importOriginal) => {
  const real = await importOriginal<typeof import("next/link")>();
  return {
    ...real,
    useLinkStatus: () => {
      const status = real.useLinkStatus();
      return link.pending === undefined ? status : { pending: link.pending };
    },
  };
});

import { busyLabel } from "./busy-label";
import { LinkPending } from "./LinkPending";
import { SkeletonBar, SkeletonBody, SkeletonCard } from "./Skeleton";
import { Spinner } from "./Spinner";
import { SubmitButton } from "./SubmitButton";
import { elapsedClock, hintText } from "./status-line";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const button = (label: ReactElement) => html(createElement("button", { type: "button" }, label));
/** What the markup shows as text: the tags dropped. The sizers' words are CSS, so they are not in it. */
const visible = (markup: string) => markup.replace(/<[^>]*>/g, "").replaceAll("&#x27;", "'");
/** Every element whose class list holds `cls`, as its opening tag and what follows up to its close. */
const spans = (markup: string, cls: string) =>
  [...markup.matchAll(/<span\b[^>]*>(?:<\/span>)?/g)]
    .map((m) => m[0])
    .filter((tag) => new RegExp(`class="[^"]*\\b${cls}\\b`).test(tag));

describe("busyLabel", () => {
  it("shows the idle label at rest and the busy label while on, as its only text", () => {
    expect(visible(button(busyLabel("Save settings", "Saving…", false)))).toBe("Save settings");
    expect(visible(button(busyLabel("Save settings", "Saving…", true)))).toBe("Saving…");
    expect(
      visible(button(busyLabel("Sign it", "Confirming on NEAR…", true, TX_PHASE_LABELS))),
    ).toBe("Confirming on NEAR…");
  });

  it("sizes the button by every label, each sizer aria-hidden with its words in data-label and no text", () => {
    const out = button(busyLabel("Sign it", "Check your wallet…", true, TX_PHASE_LABELS));
    const sizers = spans(out, "busy-size");
    // The idle label, the busy one, then every other phase label: the busy one once, not twice.
    expect(sizers.map((t) => /data-label="([^"]*)"/.exec(t)?.[1])).toEqual([
      "Sign it",
      "Check your wallet…",
      ...TX_PHASE_LABELS.filter((l) => l !== "Check your wallet…"),
    ]);
    for (const tag of [...sizers, ...spans(out, "busy-echo")]) {
      expect(tag, tag).toContain('aria-hidden="true"');
      expect(tag, tag).toMatch(/><\/span>$/);
    }
    // Only the busy sizers leave room for the spinner.
    expect(spans(out, "busy-size-spin")).toHaveLength(TX_PHASE_LABELS.length);
  });

  it("marks itself busy, keeps the old label on screen for the gate, and spins only while on", () => {
    const on = button(busyLabel("Save", "Saving…", true));
    expect(on).toContain('<span class="busy-label" data-busy="">');
    expect(spans(on, "busy-echo").map((t) => /data-label="([^"]*)"/.exec(t)?.[1])).toEqual([
      "Save",
    ]);
    expect(on).toContain("motion-safe:animate-spin");
    const off = button(busyLabel("Save", "Saving…", false));
    expect(off).not.toContain("data-busy");
    expect(off).not.toContain("busy-echo");
    expect(off).not.toContain("animate-spin");
  });

  it("can hold a not-ready button at its action label with a spinner, sized for the phases to come", () => {
    const out = button(busyLabel("Freeze vault", "Freeze vault", true, TX_PHASE_LABELS));
    expect(visible(out)).toBe("Freeze vault");
    expect(spans(out, "busy-size").map((t) => /data-label="([^"]*)"/.exec(t)?.[1])).toEqual([
      "Freeze vault",
      "Freeze vault",
      ...TX_PHASE_LABELS,
    ]);
  });
});

describe("SubmitButton", () => {
  it("is a plain submit button with its label when no action runs", () => {
    const out = html(
      createElement(SubmitButton, { label: "Discard", busy: "Discarding…", className: "u" }),
    );
    expect(out).toMatch(/^<button type="submit" class="u">/);
    expect(out).not.toContain("aria-disabled");
    expect(out).not.toContain(" disabled");
    expect(visible(out)).toBe("Discard");
  });
});

describe("LinkPending", () => {
  it("renders nothing while its link is idle, so the link's markup is unchanged", () => {
    expect(html(createElement(LinkPending))).toBe("");
  });

  it("renders the route bar's hidden mark while its link's navigation is pending", () => {
    link.pending = true;
    try {
      expect(html(createElement(LinkPending))).toBe('<span data-link-pending="" hidden=""></span>');
    } finally {
      link.pending = undefined;
    }
  });
});

describe("the skeleton parts", () => {
  it("are decoration, each part aria-hidden, in the card's shell and the docs' soft fill", () => {
    const card = html(createElement(SkeletonCard, { bars: 2, minH: "min-h-[320px]" }));
    expect(card).toMatch(
      /^<div aria-hidden="true" class="mb-6 rounded-3xl border border-line bg-surface p-5 sm:p-7 min-h-\[320px\]">/,
    );
    expect(card.match(/bg-soft/g)).toHaveLength(3);
    expect(visible(card)).toBe("");
    const bar = html(createElement(SkeletonBar, { className: "h-[21px] w-48" }));
    expect(bar).toContain('aria-hidden="true"');
    expect(bar).toContain("motion-safe:animate-skeleton");
    expect(bar).toContain("forced-colors:border-[CanvasText]");
  });

  it("fades the body in after the gate", () => {
    expect(html(createElement(SkeletonBody, null, "x"))).toBe(
      '<div class="animate-pending-in">x</div>',
    );
  });
});

describe("the status line's pieces", () => {
  it("adds a clock from 5 s on, aria-hidden", () => {
    expect(elapsedClock(4_999)).toBeNull();
    expect(html(createElement("p", null, "Line.", elapsedClock(42_000)))).toBe(
      '<p>Line.<span aria-hidden="true" class="tabular-nums"> 0:42</span></p>',
    );
  });

  it("reads a slow hint without its clock, so the region announces it once", () => {
    const wallet = SLOW_HINT.wallet;
    if (!wallet) throw new Error("no wallet hint");
    const out = html(createElement("p", null, hintText(wallet, 24_000)));
    expect(visible(out)).toBe(
      "Still waiting for your wallet (0:24). If you closed its window, check your wallet's activity before you sign again.",
    );
    // What a screen reader gets: the aria-hidden clock dropped.
    expect(visible(out.replace(/<span aria-hidden="true"[^>]*>[^<]*<\/span>/g, ""))).toBe(
      "Still waiting for your wallet. If you closed its window, check your wallet's activity before you sign again.",
    );
    const read = SLOW_HINT.read;
    if (!read) throw new Error("no read hint");
    expect(html(createElement("p", null, hintText(read, 7_000)))).toBe(
      "<p>Trying another NEAR node…</p>",
    );
  });
});

describe("every primitive", () => {
  it("adds no live region and no aria-busy of its own: the widget's one status region speaks for it", () => {
    link.pending = true;
    try {
      const all = [
        button(busyLabel("Save", "Saving…", true, ["Saved…"])),
        button(busyLabel("Save", "Saving…", false)),
        html(createElement(Spinner)),
        html(createElement(SkeletonCard)),
        html(createElement(SkeletonBar)),
        html(createElement(SkeletonBody, null, "x")),
        html(createElement(SubmitButton, { label: "Remove", busy: "Removing…", className: "u" })),
        html(createElement(LinkPending)),
        html(createElement("p", null, elapsedClock(9_000))),
        html(
          createElement("p", null, SLOW_HINT.confirm ? hintText(SLOW_HINT.confirm, 16_000) : null),
        ),
      ];
      for (const out of all) expect(out, out).not.toMatch(/aria-busy|aria-live|\srole=/);
    } finally {
      link.pending = undefined;
    }
  });
});
