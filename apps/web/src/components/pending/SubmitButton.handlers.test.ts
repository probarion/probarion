import { describe, expect, it, vi } from "vitest";
import { textOf } from "../../../test/fixtures/mini-react";

// The server forms' submit button (Discard, Remove, Save zero retention), held to its real click handler: it runs as a
// plain function, with its form's status from useFormStatus set by the test.
const status = vi.hoisted(() => ({ pending: false }));
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  useFormStatus: () => status,
}));

import { SubmitButton } from "./SubmitButton";

function press(pending: boolean) {
  status.pending = pending;
  const button = SubmitButton({ label: "Discard", busy: "Discarding…", className: "u" });
  const e = { preventDefault: vi.fn() };
  (button.props.onClick as (e: { preventDefault: () => void }) => void)(e);
  return { button, e };
}

describe("SubmitButton's click", () => {
  it("does nothing while its form's action runs, Enter in a field included, and says it is busy", () => {
    const { button, e } = press(true);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(textOf(button)).toBe("Discarding…");
    // Busy, not disabled: the button keeps the focus.
    expect(button.props["aria-disabled"]).toBe(true);
    expect(button.props.disabled).toBeUndefined();
  });

  it("submits its form when no action runs", () => {
    const { button, e } = press(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(textOf(button)).toBe("Discard");
    expect(button.props["aria-disabled"]).toBeUndefined();
  });
});
