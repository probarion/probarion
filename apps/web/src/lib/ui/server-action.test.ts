import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTION_READ_TIMEOUT_MS } from "./pending";
import { handFocus, type ReadFailure, readAction, saveAction } from "./server-action";

afterEach(() => {
  vi.useRealTimers();
});

const fail = (why: ReadFailure) => `no answer: ${why}`;

describe("readAction", () => {
  it("answers the action's own answer, a refusal included", async () => {
    expect(await readAction(async () => "Checked on chain: nothing changed.", fail)).toBe(
      "Checked on chain: nothing changed.",
    );
  });

  it("answers `failed` when the call itself fails, at once or on the way", async () => {
    expect(
      await readAction(async () => {
        throw new Error("Failed to fetch");
      }, fail),
    ).toBe("no answer: failed");
    expect(
      await readAction(() => {
        throw new Error("thrown before any promise");
      }, fail),
    ).toBe("no answer: failed");
  });

  it("stops waiting after 20 s and answers `timeout`; an answer after that changes nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let late: (s: string) => void = () => {};
    const read = readAction(() => new Promise<string>((resolve) => (late = resolve)), fail);
    await vi.advanceTimersByTimeAsync(ACTION_READ_TIMEOUT_MS - 1);
    let settled = false;
    void read.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await read).toBe("no answer: timeout");
    late("too late");
    expect(await read).toBe("no answer: timeout");
  });

  it("takes another timeout when it is given one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const read = readAction(() => new Promise<string>(() => {}), fail, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await read).toBe("no answer: timeout");
  });
});

describe("saveAction", () => {
  it("answers the action's own answer, and waits as long as it takes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const save = saveAction(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("Saved."), 60_000)),
      "unclear",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await save).toBe("Saved.");
  });

  it("answers `failed` when the call fails on the way, as it may have saved", async () => {
    expect(
      await saveAction(async () => {
        throw new Error("Failed to fetch");
      }, "unclear"),
    ).toBe("unclear");
  });
});

describe("handFocus", () => {
  const element = (doc: { activeElement: unknown }) =>
    ({ ownerDocument: doc, focus: vi.fn() }) as unknown as HTMLElement & {
      focus: ReturnType<typeof vi.fn>;
    };

  it("moves the focus to the form's button only when Try again holds it", () => {
    const doc = { activeElement: null as unknown };
    const retry = element(doc);
    const button = element(doc);
    handFocus(retry, button);
    expect(button.focus).not.toHaveBeenCalled();
    doc.activeElement = retry;
    handFocus(retry, button);
    expect(button.focus).toHaveBeenCalledTimes(1);
  });

  it("does nothing when either is not on the page", () => {
    const doc = { activeElement: null as unknown };
    const button = element(doc);
    expect(() => handFocus(null, button)).not.toThrow();
    expect(() => handFocus(button, null)).not.toThrow();
    expect(button.focus).not.toHaveBeenCalled();
  });
});
