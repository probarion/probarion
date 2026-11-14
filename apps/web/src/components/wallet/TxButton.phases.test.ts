import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TxResult } from "@/lib/near/outcome";
import type { WalletTx } from "@/lib/near/tx";
import { type El, elements, mount, textOf } from "../../../test/fixtures/mini-react";

// The click, held to the real handler: TxButton is run as a plain function with React's hooks replaced
// (test/fixtures/mini-react.ts), and the wallet, the router and the dialog stand in for the browser's. Each phase is
// read in the same tick as the step that starts it, as the label and ARIA change at once (only the look waits, in CSS).
const h = vi.hoisted(() => ({
  ready: true,
  accountId: "owner.testnet" as string | null,
  sends: [] as {
    tx: unknown;
    opts?: { onPhase?: (phase: "confirm") => void };
    answer: (r: TxResult) => void;
  }[],
  refreshes: 0,
  endRefresh: () => {},
}));

vi.mock("react", async (importOriginal) => {
  const mini = (await import("../../../test/fixtures/mini-react")).hooks;
  return {
    ...(await importOriginal<typeof import("react")>()),
    ...mini,
    // React's transition as far as TxButton uses it: pending from the call until the page's refresh is over.
    useTransition: () => {
      const [pending, setPending] = mini.useState(false);
      const start = (fn: () => void) => {
        setPending(true);
        h.endRefresh = () => setPending(false);
        fn();
      };
      return [pending, start] as const;
    },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => {
      h.refreshes++;
    },
  }),
}));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => ({ ask: async () => true, dialog: null }),
}));
vi.mock("./WalletProvider", () => ({
  useWallet: () => ({
    ready: h.ready,
    accountId: h.accountId,
    sendTx: (tx: unknown, _signerId?: string, opts?: { onPhase?: (phase: "confirm") => void }) =>
      new Promise<TxResult>((answer) => h.sends.push({ tx, opts, answer })),
  }),
}));

import { freezeTx } from "@/lib/near/tx";
import { TX_PHASE_LABELS, TX_PHASE_LINE } from "@/lib/ui/pending";
import { TxButton, type TxButtonBaseProps } from "./TxButton";

const VAULT = "acme.vaults.probarion.testnet";
const HASH = "9fV2pZ7mUq5f6p3rGq7bX1tYkqfUu1Vb3bWm2C5g7h8J";
const ok: TxResult = { status: "ok", txHash: HASH, code: null, error: null };
const noHash: TxResult = { status: "unknown", txHash: null, code: null, error: "User rejected" };

const source = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "TxButton.tsx"),
  "utf8",
);
const run = source.slice(
  source.indexOf("async function run("),
  source.indexOf("return (\n    <div"),
);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  h.ready = true;
  h.accountId = "owner.testnet";
  h.sends = [];
  h.refreshes = 0;
  h.endRefresh = () => {};
});
afterEach(() => vi.useRealTimers());

function open(props: Partial<TxButtonBaseProps> = {}) {
  const all = { label: "Freeze", network: "testnet", tx: freezeTx(VAULT), ...props };
  const view = mount(() => TxButton(all as TxButtonBaseProps));
  const tree = () => elements(view.result);
  const main = (): El => {
    const b = tree().find((e) => e.type === "button");
    if (!b) throw new Error("no button");
    return b;
  };
  const region = (): El => {
    const found = tree().filter((e) => e.props.role === "status");
    expect(found).toHaveLength(1); // one region, in every state
    return found[0] as El;
  };
  const lines = () =>
    elements(region().props.children)
      .filter((e) => e.type === "p")
      .map(textOf);
  const click = () => {
    const pending = (main().props.onClick as (e: { currentTarget?: HTMLElement }) => unknown)({});
    view.flush();
    return Promise.resolve(pending);
  };
  return { view, tree, main, region, lines, click };
}

describe("TxButton's source", () => {
  it("is disabled only when it cannot act, never because it is busy", () => {
    const attr = source.match(/\n {8}disabled=\{([^}]*)\}/);
    expect(attr?.[1]).toBe("!ready || wrongSigner || locked");
    expect(attr?.[1]).not.toContain("busy");
    expect(source).toContain("aria-disabled={busy || refreshing ? true : undefined}");
  });

  it("keeps a refreshing guard beside the in-flight one, before and after the dialog", () => {
    const guard = "if (refreshingNow.current) return;";
    const first = run.indexOf(guard);
    const answered = run.indexOf("if (!(await ask(question, opener))) return;");
    expect(first).toBeGreaterThan(run.indexOf("if (inflight.current || locked) return;"));
    expect(first).toBeLessThan(answered);
    expect(run.indexOf(guard, answered)).toBeGreaterThan(answered);
    expect(run.indexOf(guard, answered)).toBeLessThan(run.indexOf("inflight.current = true"));
    // the refresh runs in a transition, and the guard is up before the render that shows it
    expect(run.indexOf("refreshingNow.current = true;")).toBeLessThan(
      run.indexOf("startRefresh(() => router.refresh());"),
    );
  });

  it("signs once per click: one sendTx, and the lock written from its result", () => {
    expect(run.match(/sendTx\(/g)).toHaveLength(1);
    expect(run).toContain(
      "const r = await sendTx(next, props.expectedSigner, { onPhase: setPhase });",
    );
    expect(run.indexOf("writeLock(")).toBeGreaterThan(run.indexOf("sendTx("));
  });
});

describe("TxButton's phases", () => {
  it("names who it waits on, in order, and stays focusable while it does", async () => {
    const { main, lines, click } = open();
    expect(textOf(main())).toBe("Freeze");
    expect(main().props["aria-disabled"]).toBeUndefined();
    expect(lines()).toEqual([]);

    void click();
    expect(h.sends).toHaveLength(1);
    expect(textOf(main())).toBe("Check your wallet…");
    expect(main().props.disabled).toBe(false);
    expect(main().props["aria-disabled"]).toBe(true);
    expect(lines()).toEqual([TX_PHASE_LINE.wallet]);
  });

  it("goes from the wallet to NEAR to the page, then back to its label", async () => {
    const { view, main, lines, click, region } = open();
    const done = click();
    h.sends[0]?.opts?.onPhase?.("confirm");
    view.flush();
    expect(textOf(main())).toBe("Confirming on NEAR…");
    expect(lines()).toEqual([TX_PHASE_LINE.confirm]);

    h.sends[0]?.answer(ok);
    await done;
    view.flush();
    expect(h.refreshes).toBe(1);
    expect(textOf(main())).toBe("Updating the page…");
    expect(main().props["aria-disabled"]).toBe(true);
    // the result is in the button's region, with no role of its own
    const note = elements(region().props.children).find((e) => e.props.result === ok);
    expect(note?.props.inRegion).toBe(true);
    expect(lines()).toEqual([]);

    h.endRefresh();
    view.flush();
    expect(textOf(main())).toBe("Freeze");
    expect(main().props["aria-disabled"]).toBeUndefined();
  });

  it("a click while busy or while the page refreshes does nothing", async () => {
    const { view, main, click } = open();
    const done = click();
    await click();
    await click();
    expect(h.sends).toHaveLength(1);
    h.sends[0]?.answer(ok);
    await done;
    view.flush();
    expect(textOf(main())).toBe("Updating the page…");
    await click();
    expect(h.sends).toHaveLength(1);
    h.endRefresh();
    view.flush();
    void click(); // a new click once all is over is a new, deliberate send
    expect(h.sends).toHaveLength(2);
  });

  it("says Preparing… while the console builds the transaction, and names the page's own finish", async () => {
    let give: (p: WalletTx | { error: string }) => void = () => {};
    let finished: () => void = () => {};
    const { view, main, lines, click } = open({
      tx: undefined,
      prepare: () => new Promise((resolve) => (give = resolve)),
      lockKey: `register:${VAULT}`,
      finishing: "Registering the vault…",
      onResult: () => new Promise<void>((resolve) => (finished = resolve)),
    });
    const done = click();
    expect(textOf(main())).toBe("Preparing…");
    expect(lines()).toEqual([TX_PHASE_LINE.prepare]);
    expect(h.sends).toHaveLength(0);

    give(freezeTx(VAULT));
    await settle();
    view.flush();
    expect(h.sends).toHaveLength(1);
    expect(textOf(main())).toBe("Check your wallet…");

    h.sends[0]?.answer(ok);
    await settle();
    view.flush();
    expect(textOf(main())).toBe("Registering the vault…");
    expect(lines()).toEqual([]);
    expect(h.refreshes).toBe(0);

    finished();
    await done;
    view.flush();
    expect(h.refreshes).toBe(1);
    expect(textOf(main())).toBe("Updating the page…");
  });

  it("a prepare that refuses shows why, sends nothing and is ready again", async () => {
    let give: (p: WalletTx | { error: string }) => void = () => {};
    const { view, main, lines, click } = open({
      tx: undefined,
      prepare: () => new Promise((resolve) => (give = resolve)),
      lockKey: `register:${VAULT}`,
    });
    const done = click();
    give({ error: "The console could not build it." });
    await done;
    view.flush();
    expect(h.sends).toHaveLength(0);
    expect(lines()).toEqual(["The console could not build it."]);
    expect(textOf(main())).toBe("Freeze");
    expect(main().props["aria-disabled"]).toBeUndefined();
  });

  it("an unclear outcome locks the button as before, says where to look and offers no retry", async () => {
    const { view, main, tree, click } = open();
    const done = click();
    h.sends[0]?.answer(noHash);
    await done;
    view.flush();
    h.endRefresh();
    view.flush();
    expect(main().props.disabled).toBe(true);
    expect(textOf(tree()[0])).not.toMatch(/try again|retry/i);
    expect(tree().some((e) => textOf(e) === "I checked the explorer: unlock this button")).toBe(
      true,
    );
    await click();
    expect(h.sends).toHaveLength(1);
  });
});

describe("TxButton's clock and hints", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
  });

  const wait = (view: { flush(): void }, ms: number) => {
    vi.advanceTimersByTime(ms);
    view.flush();
  };

  it("adds the wallet's hint at 20 s as a new line under the phase line, with the clocks hidden", () => {
    const { view, region, lines, click } = open();
    void click();
    wait(view, 4_000);
    expect(lines()).toEqual([TX_PHASE_LINE.wallet]);
    wait(view, 1_000);
    expect(lines()).toEqual([`${TX_PHASE_LINE.wallet} 0:05`]);
    wait(view, 14_000);
    expect(lines()).toHaveLength(1);
    wait(view, 1_000);
    expect(lines()).toEqual([
      `${TX_PHASE_LINE.wallet} 0:20`,
      "Still waiting for your wallet (0:20). If you closed its window, check your wallet's activity before you sign again.",
    ]);
    // every clock is aria-hidden, so the region does not read out each second
    const clocks = elements(region().props.children).filter((e) =>
      /^ \(?\d+:\d\d\)?$/.test(textOf(e)),
    );
    expect(clocks.length).toBe(2);
    for (const c of clocks) expect(c.props["aria-hidden"]).toBe("true");
  });

  it("never times out the wallet: ten minutes on, it still waits on the same one signature", () => {
    const { view, main, lines, click } = open();
    void click();
    wait(view, 600_000);
    expect(textOf(main())).toBe("Check your wallet…");
    expect(h.sends).toHaveLength(1);
    expect(lines().join(" ")).not.toMatch(/try again|retry|timed out|did not answer/i);
  });

  it("starts NEAR's clock from 0 and adds its hint at 15 s, without the wallet's", () => {
    const { view, lines, click } = open();
    void click();
    wait(view, 25_000);
    h.sends[0]?.opts?.onPhase?.("confirm");
    view.flush();
    expect(lines()).toEqual([TX_PHASE_LINE.confirm]);
    wait(view, 14_000);
    expect(lines()).toEqual([`${TX_PHASE_LINE.confirm} 0:14`]);
    wait(view, 1_000);
    expect(lines()).toEqual([
      `${TX_PHASE_LINE.confirm} 0:15`,
      "NEAR is slow to confirm (0:15). Do not sign again: this button is still checking the same transaction.",
    ]);
  });
});

describe("TxButton before the wallet is ready", () => {
  it("is disabled with its own label and a spinner, described as loading the wallet", () => {
    h.ready = false;
    const { main, tree } = open();
    expect(main().props.disabled).toBe(true);
    expect(textOf(main())).toBe("Freeze");
    const id = main().props["aria-describedby"];
    expect(typeof id).toBe("string");
    const description = tree().find((e) => e.props.id === id);
    expect(description?.props.hidden).toBe(true);
    expect(textOf(description)).toBe("Loading your wallet…");
    expect(elements(main().props.children).some((e) => e.props["data-busy"] === "")).toBe(true);
  });

  it("is sized from its own label and every phase label, so it does not move when the wallet is ready", () => {
    const sizers = (view: El) =>
      elements(view.props.children)
        .filter(
          (e) => typeof e.props["data-label"] === "string" && e.props.className !== "busy-echo",
        )
        .map((e) => e.props["data-label"])
        .sort();
    h.ready = false;
    const before = sizers(open().main());
    h.ready = true;
    const after = sizers(open().main());
    expect(before).toEqual(after);
    expect(new Set(after)).toEqual(new Set(["Freeze", ...TX_PHASE_LABELS]));
  });

  it("the wrong account disables it, as before", () => {
    const { main } = open({ expectedSigner: "cfo.testnet" });
    expect(main().props.disabled).toBe(true);
  });
});
