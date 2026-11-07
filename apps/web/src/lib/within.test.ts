import { afterEach, describe, expect, it, vi } from "vitest";
import { within } from "./within";

afterEach(() => {
  vi.useRealTimers();
});

describe("within", () => {
  it("gives the answer of a read that is in time, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const read = within(() => Promise.resolve("ok"), 1000);
    await expect(read).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects after the time given, with how long that was", async () => {
    vi.useFakeTimers();
    const read = within(() => new Promise<never>(() => {}), 5000);
    const settled = expect(read).rejects.toThrow("timed out after 5000 ms");
    await vi.advanceTimersByTimeAsync(5000);
    await settled;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes on the rejection of a read, and a throw before its first promise, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    await expect(within(() => Promise.reject(new Error("db down")), 1000)).rejects.toThrow(
      "db down",
    );
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      within(() => {
        throw new Error("no key");
      }, 1000),
    ).rejects.toThrow("no key");
    expect(vi.getTimerCount()).toBe(0);
  });
});
