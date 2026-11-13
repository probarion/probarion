import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type El, elements, mount, textOf } from "../../../test/fixtures/mini-react";

// What /check does when it is used, run as a plain function with React's hooks replaced (test/fixtures/mini-react.ts):
// the handlers it returns are called the way the browser would. The run itself is replaced here (run.test.ts covers
// it), so these tests hold the page's own rules: the form's errors, one check at a time, the link in the fragment, and
// a failed run shown as "could not run".
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  ...(await import("../../../test/fixtures/mini-react")).hooks,
}));
const mocks = vi.hoisted(() => ({ runCheck: vi.fn() }));
vi.mock("./run", () => ({ runCheck: mocks.runCheck }));

import type { PayeeAssessment } from "@probarion/core";
import { CheckFailed, CheckResult } from "./CheckResult";
import { type CheckInput, EXAMPLES, statusLine } from "./check-view";
import { PayeeCheck } from "./PayeeCheck";

const replaceState = vi.fn();
function stubWindow(hash = "") {
  vi.stubGlobal("window", {
    location: { hash, host: "localhost:3604" },
    history: { replaceState },
  });
}

const doneRun = (input: CheckInput) => ({
  kind: "done" as const,
  input,
  signals: {},
  assessment: {
    verdict: "warn",
    reasons: [{ id: "first_payment", level: "warn", text: "not paid before" }],
    network: input.network,
    payee: input.payee,
    checked_at: "2026-11-14T00:00:00.000Z",
  } satisfies PayeeAssessment as PayeeAssessment,
  log: [],
  tookMs: 1200,
});

type Change = (e: { target: { value: string } }) => void;

function open() {
  const view = mount(() => PayeeCheck());
  view.flush();
  const all = () => elements(view.result);
  const fieldOf = (label: string) => {
    const field = all().find((e) => e.props.label === label);
    if (field === undefined) throw new Error(`no field ${label}`);
    return field;
  };
  const control = (label: string) => fieldOf(label).props.children as El;
  const submit = () => all().find((e) => e.type === "button" && e.props.type === "submit") as El;
  const examples = () => all().filter((e) => e.type === "button" && "aria-pressed" in e.props);
  const status = () => all().find((e) => e.props.role === "status") as El;
  const region = () => all().find((e) => "aria-busy" in e.props) as El;
  return {
    view,
    fieldOf,
    control,
    submit,
    examples,
    status,
    region,
    type(label: string, value: string) {
      (control(label).props.onChange as Change)({ target: { value } });
      view.flush();
    },
    async send() {
      const form = all().find((e) => e.type === "form") as El;
      (form.props.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault() {} });
      view.flush();
      await Promise.resolve();
      await Promise.resolve();
      view.flush();
    },
  };
}

/** A run that resolves when `release` is called. */
function gated() {
  let release: (v: unknown) => void = () => {};
  mocks.runCheck.mockImplementationOnce(
    (input: CheckInput) =>
      new Promise((resolve) => {
        release = (v) => resolve(v ?? doneRun(input));
      }),
  );
  return { release: (v?: unknown) => release(v) };
}

beforeEach(() => {
  mocks.runCheck.mockReset();
  mocks.runCheck.mockImplementation(async (input: CheckInput) => doneRun(input));
  replaceState.mockReset();
  stubWindow();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the check, used", () => {
  it("starts on the address's own network, with the button on once the page runs in the browser", () => {
    const f = open();
    // Test settings publish no origins, so every address is the default network, testnet.
    expect(f.control("Network").props.value).toBe("testnet");
    expect(f.submit().props.disabled).toBe(false);
    expect(textOf(f.submit())).toBe("Check the payee");
    expect(mocks.runCheck).not.toHaveBeenCalled();
  });

  it("names the field that is wrong, and reads nothing", async () => {
    const f = open();
    await f.send();
    expect(f.fieldOf("Payee").props.error).toBe("Name a payee.");
    f.type("Payee", "0xabc");
    await f.send();
    expect(f.fieldOf("Payee").props.error).toBe(
      "Write near:0xabc or base:0xabc: a bare 0x value is both.",
    );
    f.type("Payee", "near:vendor.testnet");
    f.type("Vault (optional)", "Not A Vault");
    await f.send();
    expect(f.fieldOf("Payee").props.error).toBeUndefined();
    expect(f.fieldOf("Vault (optional)").props.error).toBe("Not A Vault is not a NEAR account id.");
    expect(mocks.runCheck).not.toHaveBeenCalled();
  });

  it("runs one check at a time, says so meanwhile, then shows the result and puts the check in the fragment", async () => {
    const gate = gated();
    const f = open();
    f.type("Payee", "vendor.testnet");
    await f.send();
    expect(textOf(f.submit())).toBe("Reading the chain");
    expect(f.submit().props["aria-disabled"]).toBe(true);
    expect(f.submit().props.disabled).toBe(false);
    expect(f.region().props["aria-busy"]).toBe(true);
    expect(textOf(f.status())).toBe("Reading the chain");
    // A second press, and an example, while it reads: ignored.
    await f.send();
    ((f.examples()[0] as El).props.onClick as () => void)();
    expect(mocks.runCheck).toHaveBeenCalledTimes(1);
    const input = mocks.runCheck.mock.calls[0]?.[0] as CheckInput;
    expect(input).toEqual({
      network: "testnet",
      payee: { chain: "near", address: "vendor.testnet" },
    });
    expect(typeof mocks.runCheck.mock.calls[0]?.[1].fetch).toBe("function");
    gate.release();
    await Promise.resolve();
    await Promise.resolve();
    f.view.flush();
    const shown = elements(f.region()).find((e) => e.type === CheckResult);
    expect(shown?.props.run).toEqual(doneRun(input));
    expect(shown?.props.shareHref).toBe("#network=testnet&payee=near%3Avendor.testnet");
    expect(textOf(f.status())).toBe(statusLine(doneRun(input).assessment));
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "#network=testnet&payee=near%3Avendor.testnet",
    );
    expect(textOf(f.submit())).toBe("Check the payee");
  });

  it("shows a check that could not run as not an allow, and leaves the address alone", async () => {
    mocks.runCheck.mockImplementationOnce(async (input: CheckInput) => ({
      kind: "failed",
      input,
      message: "a bug in the reads",
      log: [],
    }));
    const f = open();
    f.type("Payee", "near:vendor.testnet");
    await f.send();
    expect(elements(f.region()).some((e) => e.type === CheckResult)).toBe(false);
    const failed = elements(f.region()).find((e) => e.type === CheckFailed) as El;
    expect((failed.props.run as { message: string }).message).toBe("a bug in the reads");
    expect(textOf(f.status())).toContain("This is not an allow");
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("fills the form from an example, network included, and runs it", async () => {
    const f = open();
    const example = EXAMPLES.find((e) => e.id === "one-letter-off");
    const button = f.examples().find((e) => textOf(e) === example?.label);
    ((button as El).props.onClick as () => void)();
    f.view.flush();
    await Promise.resolve();
    f.view.flush();
    expect(f.control("Network").props.value).toBe("mainnet");
    expect(f.control("Payee").props.value).toBe("near:probarion-duonq.near");
    expect(f.control("Vault (optional)").props.value).toBe("v0.probarion.near");
    expect(mocks.runCheck).toHaveBeenCalledWith(
      {
        network: "mainnet",
        payee: { chain: "near", address: "probarion-duonq.near" },
        vault: "v0.probarion.near",
      },
      expect.anything(),
    );
    const pressed = f.examples().filter((e) => e.props["aria-pressed"] === true);
    expect(pressed.map(textOf)).toEqual([example?.label]);
  });

  it("runs the check a link carries in its fragment, once, on the network it names", async () => {
    stubWindow("#network=mainnet&payee=base%3A0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27");
    const f = open();
    await Promise.resolve();
    f.view.flush();
    expect(mocks.runCheck).toHaveBeenCalledTimes(1);
    expect(mocks.runCheck.mock.calls[0]?.[0]).toEqual({
      network: "mainnet",
      payee: { chain: "base", address: "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27" },
    });
    expect(f.control("Network").props.value).toBe("mainnet");
    expect(f.control("Payee").props.value).toBe("base:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27");
  });

  it("notes a .near name checked on testnet, and still runs it", async () => {
    const f = open();
    f.type("Payee", "near:vendor.near");
    expect(textOf(f.view.result)).toContain(
      "vendor.near ends in .near, a mainnet name, and the network chosen is testnet.",
    );
    await f.send();
    expect(mocks.runCheck).toHaveBeenCalledTimes(1);
  });
});
