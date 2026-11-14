import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The popup's stylesheet: the rules that keep long text inside the 360 px popup and the brand heading looking as text.

const css = readFileSync(new URL("../static/popup.css", import.meta.url), "utf8");

/** Each rule's selectors and declarations, from a flat stylesheet (no nesting, no at-rules). */
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, selectors = "", body = ""]) => ({
    selectors: selectors.split(",").map((s) => s.trim().replace(/\s+/g, " ")),
    decls: Object.fromEntries(
      body
        .split(";")
        .map((d) => d.split(":").map((x) => x.trim()))
        .filter((d) => d.length === 2 && d[0] !== ""),
    ) as Record<string, string>,
  }),
);

/** What the stylesheet sets on `selector`, in source order (a later rule wins). */
const on = (selector: string): Record<string, string> =>
  Object.assign({}, ...rules.filter((r) => r.selectors.includes(selector)).map((r) => r.decls));

describe("the popup's stylesheet", () => {
  it("keeps Clear on one line at its own width next to a long captured item", () => {
    expect(on(".item")).toMatchObject({ display: "flex", "overflow-wrap": "anywhere" });
    expect(on(".item > button")).toMatchObject({ flex: "none", "overflow-wrap": "normal" });
  });

  it("wraps a message line that names a long account, such as a 64-character implicit one", () => {
    for (const line of [".ok", ".bad", ".title", ".detail"]) {
      expect(on(line)["overflow-wrap"], line).toBe("anywhere");
    }
  });

  it("draws the brand h1 like the text around it", () => {
    expect(on(".brand")).toMatchObject({
      margin: "0",
      "font-size": "inherit",
      "font-weight": "600",
    });
  });
});
