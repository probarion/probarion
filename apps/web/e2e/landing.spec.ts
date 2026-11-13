import { readFileSync } from "node:fs";
import { expect, type Page, type Route, test } from "@playwright/test";

// The landing page's live check against the recorded answers: both public testnet RPCs are intercepted, so the test
// is the same whatever the chain says today. Local only, like smoke.spec.ts.
const recorded = JSON.parse(
  readFileSync(new URL("../src/lib/site/live-check-recorded.json", import.meta.url), "utf8"),
) as {
  mandates: Record<string, unknown>;
  answers: Record<string, { value: unknown }>;
};
const HOSTS = ["https://rpc.testnet.fastnear.com/**", "https://rpc.testnet.near.org/**"];

/**
 * Answers each view from the recorded file: check_spend by the scenario its arguments match. The hijacked prompt sends
 * the normal invoice's request, so it gets the normal answer; only the inflated invoice asks above the limit.
 */
function answer(route: Route) {
  const body = JSON.parse(route.request().postData() ?? "{}");
  const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString());
  let value: unknown = null;
  if (body.params.method_name === "get_mandate")
    value = recorded.mandates[String(args.mandate_id)] ?? null;
  else {
    const { mandate_id, amount } = args.request;
    const other = !String(args.signer_pk).startsWith("ed25519:5err");
    const id = other
      ? "otherkey"
      : mandate_id === 999
        ? "nomandate"
        : Number(amount) > 5_000_000
          ? "inflated"
          : "normal";
    value = recorded.answers[id]?.value;
  }
  return route.fulfill({
    json: {
      jsonrpc: "2.0",
      id: 1,
      result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1 },
    },
  });
}

async function mockChain(page: Page) {
  for (const h of HOSTS) await page.route(h, answer);
}

test("each scenario shows the contract's answer", async ({ page }) => {
  await mockChain(page);
  await page.goto("/#try");
  // The page has hydrated and the first live answer has arrived before any click: a click before that goes nowhere.
  await expect(page.getByText(/Answer from /)).toBeVisible();
  // Scoped to #try: the ledger test has its own live region further down. The region holds the verdict, then its sentence.
  const verdict = page.locator('#try [aria-live="polite"] p').first();
  await expect(verdict).toHaveText("Allow");
  for (const [name, word] of [
    ["A hijacked prompt", "Allow. The attacker gets 0."],
    ["An inflated invoice", "Block: OverPerPayment"],
    ["A made-up mandate", "Block: NoMandate"],
    ["Someone else's key", "Block: NotAgent"],
    ["A normal invoice", "Allow"],
  ] as const) {
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await expect(verdict).toHaveText(word);
  }
  // The hijack's allow says why the attacker gets nothing; the normal invoice's, the same request, does not.
  await expect(page.getByText(/no field for the attacker's address/)).toHaveCount(0);
  await page.getByRole("button", { name: /A hijacked prompt/ }).click();
  await expect(page.getByText(/no field for the attacker's address/)).toBeVisible();
});

test("a typed amount that is not one sends nothing and says so", async ({ page }) => {
  await mockChain(page);
  await page.goto("/#try");
  // The first answer has arrived before the count starts.
  await expect(page.getByText(/Answer from /)).toBeVisible();
  let calls = 0;
  page.on("request", (r) => {
    if (r.url().includes("rpc.testnet")) calls++;
  });
  await page.getByLabel("Amount", { exact: true }).fill("1,5");
  await expect(page.getByText("Not an amount", { exact: true })).toBeVisible();
  // A grace window for a negative assertion: the typed text is debounced by 250 ms, so a request that was going to
  // leave would have left well within 400 ms. There is nothing to wait for, which is the point.
  await page.waitForTimeout(400);
  expect(calls).toBe(0);
});

test("with both RPC hosts down it shows the recorded answer, dated", async ({ page }) => {
  for (const h of HOSTS) await page.route(h, (r) => r.abort());
  await page.goto("/#try");
  await expect(page.getByText(/No RPC host answered/)).toBeVisible();
  await expect(page.getByText(/Recorded answer from \d{4}-\d{2}-\d{2}/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask again" })).toBeVisible();
});

for (const width of [320, 390, 1440]) {
  test(`the landing page does not scroll sideways at ${width} px`, async ({ page }) => {
    await mockChain(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    // Hydrated, with the first live answer, before any click.
    await expect(page.getByText(/Answer from /)).toBeVisible();
    const verdict = page.locator('#try [aria-live="polite"] p').first();
    const noSideScroll = async () => {
      const [sw, cw] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      expect(sw).toBe(cw);
    };

    await page.getByRole("button", { name: /An inflated invoice/ }).click();
    await expect(verdict).toHaveText("Block: OverPerPayment");
    await noSideScroll();

    // Mandate 2 pays a Base address: its payee is the long 0x... one. Wait for its own answer, then measure again.
    await page.locator("#try select").first().selectOption("2");
    await expect(
      page.getByRole("heading", { name: /Mandate 2, as the chain has it/ }),
    ).toBeVisible();
    await expect(verdict).toHaveText("Block: OverPerPayment");
    await noSideScroll();
  });
}

// The #mainnet question goes to one mainnet host. Its answers here are the chain's of 2026-11-13 (1 USDC ok, 2 USDC
// OverPerPayment); a host that does not answer gives "could not read the chain", never a verdict.
test("the mainnet question sends one request a click, and names no verdict when the chain cannot be read", async ({
  page,
}) => {
  let calls = 0;
  let down = false;
  await page.route("https://rpc.mainnet.fastnear.com/**", (route) => {
    calls++;
    if (down) return route.abort();
    const body = JSON.parse(route.request().postData() ?? "{}");
    const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString());
    const value =
      Number(args.request.amount) <= 1_000_000
        ? { ok: true, code: null, would_hold: false }
        : { ok: false, code: "OverPerPayment", would_hold: false };
    return route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: 1,
        result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1 },
      },
    });
  });
  await page.goto("/#mainnet");
  const ask = page.locator('section[aria-labelledby="mainnet-ask-title"]');
  const headline = ask.locator('[aria-live="polite"] p').first();
  await ask.getByRole("button", { name: "1 USDC" }).click();
  await expect(headline).toHaveText("Allow");
  expect(calls).toBe(1);
  await ask.getByRole("button", { name: "2 USDC" }).click();
  await expect(headline).toHaveText("Block: OverPerPayment");
  expect(calls).toBe(2);
  down = true;
  await ask.getByRole("button", { name: "1 USDC" }).click();
  await expect(headline).toHaveText("Could not read the chain, try again.");
  expect(calls).toBe(3);
  await expect(ask.getByText(/^(Allow|Block)/)).toHaveCount(0);
});
