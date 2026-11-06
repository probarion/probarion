import { expect, test } from "@playwright/test";

// The built site with test settings: public pages, the console redirect, security.txt and liveness. No chain, no
// database, no wallet. The chain smoke (a real payment) is plan 03 Task 18, run by the OWNER.

test("the sign-in page offers the wallet button and the beta label", async ({ page }) => {
  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: /Sign in with NEAR wallet|Loading wallets/ }),
  ).toBeVisible();
  await expect(page.getByText("Unaudited beta").first()).toBeVisible();
});

test("a signed-out visit to a vault's console lands on sign-in, with the path kept", async ({
  page,
}) => {
  await page.goto("/console/acme.vaults.probarion.testnet");
  await expect(page).toHaveURL(/\/login\?next=%2Fconsole%2Facme\.vaults\.probarion\.testnet$/);
});

test("security.txt names the contact and an expiry", async ({ request }) => {
  const res = await request.get("/.well-known/security.txt");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toMatch(/^Contact: https:\/\/x\.com\/probarionhq$/m);
  expect(body).toMatch(/^Expires: /m);
});

test("the liveness route answers for the default network", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    service: "probarion-web",
    network: "testnet",
  });
});

test("the Canary in replay mode shows recorded attacks and no form", async ({ page }) => {
  await page.goto("/canary");
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.locator("textarea")).toHaveCount(0);
});

test("the Canary rules state the model limit", async ({ page }) => {
  await page.goto("/canary/rules");
  await expect(page.getByText(/model attempts every \d+ minutes/).first()).toBeVisible();
});

for (const path of ["/security", "/status", "/terms", "/privacy"]) {
  test(`${path} answers with its title`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.locator("h1").first()).toBeVisible();
  });
}

test("/privacy has no browser-extension section yet (plan 06 Task 1 adds it)", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.locator("#browser-extension")).toHaveCount(0);
});

for (const width of [375, 1120, 1280]) {
  test(`the home page and its header fit at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    const nav = await page.locator('nav[aria-label="Main"]').boundingBox();
    expect(nav).not.toBeNull();
    expect((nav?.x ?? 0) + (nav?.width ?? 0)).toBeLessThanOrEqual(width);
  });
}
