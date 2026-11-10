import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// What the static render cannot show, because TxButton needs a browser and a wallet: that it asks the owner in the
// console's own dialog, and that asking comes before everything that starts a signature. The dialog's answers are
// tested in lib/console/confirm-dialog.test.ts; this holds the button to using them in the right order.
const source = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "TxButton.tsx"),
  "utf8",
);
const run = source.slice(
  source.indexOf("async function run("),
  source.indexOf("return (\n    <div"),
);

describe("TxButton's confirm step", () => {
  it("asks in the console's dialog, not the browser's", () => {
    expect(source).toContain("useConfirm()");
    expect(source).toContain("walletConfirm(");
    expect(source).not.toMatch(/window\s*\.\s*confirm/);
  });

  it("builds the question from its own label, its confirm text and its tone", () => {
    expect(source).toMatch(
      /walletConfirm\(\{\s*label: props\.label,\s*confirm: props\.confirm,\s*confirmTone: props\.confirmTone,?\s*\}\)/,
    );
  });

  it("puts the dialog in the button's own markup", () => {
    expect(source).toMatch(/\{dialog\}/);
  });

  it("asks only when there is a confirm text, and returns on a no before anything else runs", () => {
    const ask = run.indexOf("await ask(");
    expect(ask).toBeGreaterThan(-1);
    expect(run.slice(0, ask)).toContain("if (props.confirm)");
    expect(run.slice(0, ask)).toContain("if (inflight.current || locked) return;");
    // a "no" leaves: nothing below the ask has run (no busy state, no error, no lock)
    const returnsOnNo = run.indexOf("if (!(await ask(question, opener))) return;");
    expect(returnsOnNo).toBeGreaterThan(-1);
    expect(returnsOnNo).toBeLessThan(run.indexOf("inflight.current = true"));
  });

  it("looks again at the in-flight guard and the lock after the dialog answers, before it goes on", () => {
    const answered = run.indexOf("if (!(await ask(question, opener))) return;");
    const again = run.indexOf("if (inflight.current || lockedNow.current) return;", answered);
    expect(again).toBeGreaterThan(answered);
    expect(again).toBeLessThan(run.indexOf("inflight.current = true"));
    // the lock is read through a ref, so it is the lock now and not the one the click saw
    expect(source).toMatch(/lockedNow\.current = locked;/);
  });

  it("gives the dialog the button that was clicked, to hand the focus back to", () => {
    expect(source).toContain("onClick={(e) => run(e.currentTarget)}");
    expect(source).toMatch(/async function run\(opener\?: HTMLElement\)/);
  });

  it("starts the busy state, the in-flight guard and the signature only after the owner said yes", () => {
    const ask = run.indexOf("await ask(");
    for (const step of [
      "inflight.current = true",
      "setBusy(true)",
      "setError(null)",
      "setResult(null)",
      "props.prepare?.()",
      "sendTx(",
      "writeLock(",
    ]) {
      expect(run.indexOf(step), step).toBeGreaterThan(ask);
    }
  });
});

describe("TxButton's look", () => {
  it("follows its confirm tone, so a held payment's Reject does not look like its Approve", () => {
    expect(source).toContain("className={actionButtonClass(props.confirmTone, props.wide)}");
    expect(source).not.toContain("className={buttonClass}");
  });
});

describe('TxButton\'s "You sign" line', () => {
  it("is shown unless the page names the transaction itself (hidePreview)", () => {
    expect(source).toMatch(/\{preview && !props\.hidePreview \? \(\s*<p/);
  });
});
