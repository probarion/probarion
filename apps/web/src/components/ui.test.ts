import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field, inputClass } from "./ui";

// `children` is passed as createElement's third argument, so the props object leaves it out.
const props = (p: Omit<ComponentProps<typeof Field>, "children">) =>
  p as ComponentProps<typeof Field>;

describe("Field", () => {
  it("binds the label to the control with a generated id (label for = control id)", () => {
    const html = renderToStaticMarkup(
      createElement(
        Field,
        props({ label: "Payee", hint: "Never changes." }),
        createElement("input", { className: inputClass }),
      ),
    );
    const labelFor = /<label[^>]*for="([^"]+)"/.exec(html)?.[1];
    const inputId = /<input[^>]*id="([^"]+)"/.exec(html)?.[1];
    expect(labelFor).toBeTruthy();
    expect(inputId).toBe(labelFor);
    // The control is a sibling of the label, not nested in it.
    expect(html).not.toMatch(/<label[^>]*>[^<]*<input/);
    expect(html).toContain('aria-describedby="');
  });

  it("keeps a caller-supplied id and marks the control invalid when there is an error", () => {
    const html = renderToStaticMarkup(
      createElement(
        Field,
        props({ label: "Amount", error: "Required" }),
        createElement("input", { id: "amount" }),
      ),
    );
    expect(html).toMatch(/<label[^>]*for="amount"/);
    expect(html).toMatch(/<input[^>]*id="amount"/);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("Required");
  });
});
