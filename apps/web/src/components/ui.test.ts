import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field, inputClass } from "./ui";

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
