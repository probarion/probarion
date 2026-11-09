// The line after each moment that makes the point (site audit P1-16): where it goes, and that it says only what is true
// whatever the vaults hold today.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NextStep } from "@/components/site/NextStep";
import { isBuilt } from "@/lib/routes";
import { CONSOLE_ROUTE, PROOF_ROUTE } from "@/lib/site/facts";
import { NEXT_STEP } from "@/lib/site/next-step";

describe("the next steps", () => {
  it("go to the proof page after the ledger test, and to the console after the Canary, a proof page and the landing's close", () => {
    expect(NEXT_STEP.tamper.route).toBe(PROOF_ROUTE);
    expect(NEXT_STEP.canary.route).toBe(CONSOLE_ROUTE);
    expect(NEXT_STEP.proof.route).toBe(CONSOLE_ROUTE);
    expect(NEXT_STEP.closing).toEqual({
      text: "Put your agent behind a mandate",
      route: CONSOLE_ROUTE,
    });
  });

  it("go only to pages that are built, so none of them is a 'coming soon' label", () => {
    for (const step of Object.values(NEXT_STEP)) expect(isBuilt(step.route), step.text).toBe(true);
  });

  it("promise no live vault and write no count, since /proof lists no public vault until the demo vault is up", () => {
    for (const step of Object.values(NEXT_STEP)) {
      const words = `${"lead" in step ? step.lead : ""} ${step.text}`;
      expect(words, step.text).not.toMatch(/\blive\b|\d/);
    }
  });

  it("render as one line: the lead in plain text, then the link with its arrow hidden from screen readers", () => {
    expect(renderToStaticMarkup(createElement(NextStep, { step: NEXT_STEP.canary }))).toMatch(
      /^<p[^>]*><a[^>]*href="\/console"[^>]*>Put limits like these on your own agent <span aria-hidden="true">→<\/span><\/a><\/p>$/,
    );
    expect(
      renderToStaticMarkup(
        createElement(NextStep, { step: NEXT_STEP.proof, className: "x", linkClassName: "y" }),
      ),
    ).toMatch(
      /^<p class="x"><a(?=[^>]*class="y")(?=[^>]*href="\/console")[^>]*>Put your agent behind a mandate /,
    );
  });
});
