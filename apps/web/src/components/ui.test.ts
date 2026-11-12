import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AccountLink,
  actionButtonClass,
  Badge,
  buttonClass,
  Card,
  dangerButtonClass,
  dangerLineButtonClass,
  Field,
  inputClass,
  lineButtonClass,
  Notice,
  TONE_CLASSES,
  type Tone,
  TxLink,
} from "./ui";

// `children` is passed as createElement's third argument, so the props object leaves it out.
const props = (p: Omit<ComponentProps<typeof Field>, "children">) =>
  p as ComponentProps<typeof Field>;

function render(p: Omit<ComponentProps<typeof Field>, "children">, controlProps: object = {}) {
  return renderToStaticMarkup(
    createElement(
      Field,
      props(p),
      createElement("input", { className: inputClass, ...controlProps }),
    ),
  );
}

/** The value of an attribute on the first `<tag>`, or undefined when the attribute is absent. */
function attr(html: string, tag: string, name: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0] ?? "";
  return new RegExp(`\\s${name}="([^"]*)"`).exec(open)?.[1];
}

/** The id of the `<span>` that holds this text. */
function spanIdFor(html: string, text: string): string | undefined {
  return new RegExp(`<span\\b[^>]*\\sid="([^"]+)"[^>]*>${text}</span>`).exec(html)?.[1];
}

describe("Field", () => {
  it("binds the label to the control with a generated id (label for = control id)", () => {
    const html = render({ label: "Payee", hint: "Never changes." });
    const labelFor = attr(html, "label", "for");
    expect(labelFor).toBeTruthy();
    expect(attr(html, "input", "id")).toBe(labelFor);
    // The control is a sibling of the label, not nested in it.
    expect(html).toMatch(/<\/label><input/);
  });

  it("points aria-describedby at the hint's own id", () => {
    const html = render({ label: "Payee", hint: "Never changes." });
    const hintId = spanIdFor(html, "Never changes\\.");
    expect(hintId).toBeTruthy();
    expect(attr(html, "input", "aria-describedby")).toBe(hintId);
    expect(attr(html, "input", "aria-invalid")).toBeUndefined();
  });

  it("points aria-describedby at the error's id, and the error replaces the hint", () => {
    const html = render({ label: "Amount", hint: "In USDC.", error: "Required" });
    const errorId = spanIdFor(html, "Required");
    expect(errorId).toBeTruthy();
    expect(attr(html, "input", "aria-describedby")).toBe(errorId);
    expect(attr(html, "input", "aria-invalid")).toBe("true");
    expect(html).not.toContain("In USDC.");
  });

  it("sets no aria attribute when there is neither hint nor error", () => {
    const html = render({ label: "Name" });
    expect(html).not.toContain("aria-");
    expect(attr(html, "input", "id")).toBe(attr(html, "label", "for"));
  });

  it("keeps a caller-supplied id", () => {
    const html = render({ label: "Amount", error: "Required" }, { id: "amount" });
    expect(attr(html, "label", "for")).toBe("amount");
    expect(attr(html, "input", "id")).toBe("amount");
  });

  it("adds its note to an existing aria-describedby instead of replacing it", () => {
    const html = render(
      { label: "Payee", hint: "Never changes." },
      { "aria-describedby": "counter" },
    );
    const hintId = spanIdFor(html, "Never changes\\.");
    expect(attr(html, "input", "aria-describedby")).toBe(`counter ${hintId}`);
  });

  it("leaves the control's own aria attributes alone when it has nothing to add", () => {
    const html = render(
      { label: "Payee" },
      { "aria-describedby": "counter", "aria-invalid": true },
    );
    expect(attr(html, "input", "aria-describedby")).toBe("counter");
    expect(attr(html, "input", "aria-invalid")).toBe("true");
  });

  it("gives each Field its own ids", () => {
    const a = render({ label: "A", hint: "one" });
    const b = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(Field, props({ label: "A", hint: "one" }), createElement("input")),
        createElement(Field, props({ label: "B", hint: "two" }), createElement("input")),
      ),
    );
    const ids = [...b.matchAll(/<input\b[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(a).toContain("<label");
  });

  it("accepts exactly one element as its control (compile-time)", () => {
    const one = createElement("input", { key: "a" });
    // @ts-expect-error text is not an element
    const text: ComponentProps<typeof Field> = { label: "x", children: "just text" };
    // @ts-expect-error a list of elements is not one element
    const list: ComponentProps<typeof Field> = { label: "x", children: [one, one] };
    expect([text.label, list.label]).toEqual(["x", "x"]);
  });
});

// Brand v2 in the console (site audit P1-21): the console's buttons, fields, cards and notices are the landing page's
// ink pills, hairlines and colour tokens, not the Tailwind kit that came before the brand.
describe("the console kit", () => {
  const classes = (s: string) => s.split(/\s+/);

  it("every button is a pill at least 44px tall, with the site's gold focus ring", () => {
    for (const [name, cls] of Object.entries({
      buttonClass,
      lineButtonClass,
      dangerButtonClass,
      dangerLineButtonClass,
    })) {
      expect(classes(cls), name).toEqual(
        expect.arrayContaining([
          "min-h-11",
          "rounded-full",
          "focus-visible:outline-2",
          "focus-visible:outline-gold-small",
        ]),
      );
      // Red dims less than ink, so a disabled red label still reads at 4.5:1 (typography-aaa.test.ts).
      const dimmed = classes(cls).filter((c) => c.startsWith("disabled:opacity-"));
      expect(dimmed, name).toEqual([
        name.startsWith("danger") ? "disabled:opacity-75" : "disabled:opacity-65",
      ]);
      expect(cls, name).not.toMatch(/focus-visible:outline-(?:ink|bad)\b/);
    }
  });

  it("the main button is ink on paper, and the line button an ink outline", () => {
    expect(classes(buttonClass)).toEqual(expect.arrayContaining(["bg-ink", "text-paper"]));
    expect(classes(lineButtonClass)).toEqual(expect.arrayContaining(["border", "text-ink"]));
    expect(classes(lineButtonClass)).not.toContain("bg-ink");
  });

  it("the danger buttons use the bad token: solid for a dialog's action, an outline beside other actions", () => {
    expect(classes(dangerButtonClass)).toEqual(expect.arrayContaining(["bg-bad", "text-white"]));
    expect(classes(dangerLineButtonClass)).toEqual(
      expect.arrayContaining(["border", "border-bad/45", "text-bad", "hover:bg-bad-bg"]),
    );
  });

  it("an input is 16px, so a phone does not zoom in on focus, and 44px tall", () => {
    expect(classes(inputClass)).toEqual(
      expect.arrayContaining(["text-base", "min-h-11", "rounded-xl", "bg-surface"]),
    );
    expect(inputClass).not.toMatch(/\btext-sm\b/);
  });

  it("an input's edge is the landing page's mute border, which reads at 3:1 on a white card, and its ring is gold", () => {
    expect(classes(inputClass)).toEqual(
      expect.arrayContaining([
        "border",
        "border-mute",
        "focus-visible:outline-2",
        "focus-visible:outline-gold-small",
      ]),
    );
  });

  it("each tone is a pair of colour tokens", () => {
    expect(TONE_CLASSES).toEqual({
      neutral: "bg-plan-bg text-plan",
      good: "bg-ok-bg text-ok",
      warn: "bg-wait-bg text-wait",
      bad: "bg-bad-bg text-bad",
      info: "border border-line bg-paper text-ink",
    });
  });

  it("a badge and a notice wear their tone's tokens", () => {
    for (const tone of Object.keys(TONE_CLASSES) as Tone[]) {
      const badge = renderToStaticMarkup(
        createElement(Badge, { tone } as ComponentProps<typeof Badge>, "x"),
      );
      const notice = renderToStaticMarkup(
        createElement(Notice, { tone } as ComponentProps<typeof Notice>, "x"),
      );
      for (const cls of classes(TONE_CLASSES[tone])) {
        expect(attr(badge, "span", "class"), `badge ${tone}`).toContain(cls);
        expect(attr(notice, "div", "class"), `notice ${tone}`).toContain(cls);
      }
    }
    expect(attr(renderToStaticMarkup(createElement(Badge, null, "x")), "span", "class")).toContain(
      "rounded-full",
    );
    expect(attr(renderToStaticMarkup(createElement(Notice, null, "x")), "div", "class")).toContain(
      "rounded-2xl",
    );
  });

  it("a card is a hairline panel with a large radius, and its title is light only at 24px, large text", () => {
    const html = renderToStaticMarkup(
      createElement(Card, { title: "Held for approval" } as ComponentProps<typeof Card>, "x"),
    );
    expect(classes(attr(html, "section", "class") ?? "")).toEqual(
      expect.arrayContaining(["rounded-3xl", "border", "border-line", "bg-surface"]),
    );
    expect(classes(attr(html, "h2", "class") ?? "")).toEqual(
      expect.arrayContaining(["text-2xl", "font-light"]),
    );
  });

  it("a field's hint is muted and its error is the bad token", () => {
    const hint = renderToStaticMarkup(
      createElement(Field, props({ label: "A", hint: "one" }), createElement("input")),
    );
    const error = renderToStaticMarkup(
      createElement(Field, props({ label: "A", error: "two" }), createElement("input")),
    );
    expect(hint).toMatch(/<span[^>]*class="[^"]*\btext-mute\b[^"]*"[^>]*>one<\/span>/);
    expect(error).toMatch(/<span[^>]*class="[^"]*\btext-bad\b[^"]*"[^>]*>two<\/span>/);
  });

  it("explorer links are ink links like the site's, in a new tab", () => {
    for (const html of [
      renderToStaticMarkup(createElement(TxLink, { network: "testnet", hash: "abc" })),
      renderToStaticMarkup(
        createElement(AccountLink, { network: "testnet", account: "a.testnet" }),
      ),
    ]) {
      expect(classes(attr(html, "a", "class") ?? "")).toEqual(
        expect.arrayContaining(["text-ink", "underline"]),
      );
      expect(html).not.toContain("sky-");
      expect(attr(html, "a", "target")).toBe("_blank");
    }
  });
});

describe("actionButtonClass", () => {
  it("is the main button for a normal action, and the danger outline for one whose dialog says it cannot be undone", () => {
    expect(actionButtonClass()).toBe(buttonClass);
    expect(actionButtonClass(undefined)).toBe(buttonClass);
    expect(actionButtonClass("danger")).toBe(dangerLineButtonClass);
  });

  it("fills its row when asked, as the one decision on a phone-sized page, in either tone", () => {
    expect(actionButtonClass(undefined, true)).toBe(`${buttonClass} w-full`);
    expect(actionButtonClass("danger", true)).toBe(`${dangerLineButtonClass} w-full`);
    expect(actionButtonClass("danger", false)).toBe(dangerLineButtonClass);
  });
});
