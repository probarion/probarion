import { describe, expect, it } from "vitest";
import { providerError } from "./errors";

describe("providerError", () => {
  it("keeps a provider's words and cuts them to 200 characters", () => {
    expect(providerError("Forbidden: bot was blocked by the user", "424242")).toBe(
      "Forbidden: bot was blocked by the user",
    );
    expect(providerError("x".repeat(500), "424242")).toHaveLength(200);
  });

  it("takes an email address out of the text, whatever the address", () => {
    const text = providerError(
      "Invalid `to` field: Owner.Name+tag@sub.example.com, or a@b.co",
      "x@y.zz",
    );
    expect(text).toBe("Invalid `to` field: [address], or [address]");
  });

  it("takes the target out of the text when it is a chat id long enough to be one, and leaves short numbers alone", () => {
    expect(providerError("chat 424242 not found", "424242")).toBe("chat [target] not found");
    expect(providerError("error 400 at 7", "7")).toBe("error 400 at 7");
  });

  it("cuts after it has taken things out, so no half of an address is left at the edge", () => {
    const text = providerError(`${"x".repeat(190)} owner@example.com`, "a@b.co");
    expect(text).not.toContain("@");
    expect(text.length).toBeLessThanOrEqual(200);
  });
});
