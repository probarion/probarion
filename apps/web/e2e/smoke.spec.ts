import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

// The built site with test settings: public pages, the console redirect, security.txt and liveness. No chain, no
// database, no wallet. The chain smoke (a real payment) is plan 03 Task 18, run by the OWNER.

test("the sign-in page offers the wallet button and the beta label", async ({ page }) => {
  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: /Sign in with NEAR wallet|Loading wallets/ }),
  ).toBeVisible();
  await expect(page.getByText("Unaudited beta").first()).toBeVisible();
  // The header's console links would lead to /console and straight back here (site audit P1-7).
  await expect(page.getByRole("link", { name: "Open console" })).toHaveCount(0);
});

test("a signed-out visit to a vault's console lands on sign-in, with the path kept", async ({
  page,
}) => {
  await page.goto("/console/acme.vaults.probarion.testnet");
  await expect(page).toHaveURL(/\/login\?next=%2Fconsole%2Facme\.vaults\.probarion\.testnet$/);
});

test("a signed-out visit to the extension's connect page lands on sign-in, with its nonce kept", async ({
  page,
}) => {
  await page.goto(`/extension?nonce=${"a".repeat(22)}`);
  await expect(page).toHaveURL(/\/login\?next=%2Fextension%3Fnonce%3Da{22}$/);
});

test("security.txt names the contact and an expiry", async ({ request }) => {
  const res = await request.get("/.well-known/security.txt");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toMatch(/^Contact: https:\/\/x\.com\/probarionhq$/m);
  expect(body).toMatch(/^Expires: /m);
});

test("the landing's download line gets the core test fixture, byte for byte", async ({
  request,
}) => {
  const res = await request.get("/samples/valid-snapshot.json");
  expect(res.status()).toBe(200);
  const fixture = readFileSync(
    new URL("../../../packages/core/test/fixtures/valid-snapshot.json", import.meta.url),
  );
  expect((await res.body()).equals(fixture)).toBe(true);
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

test("the Canary in replay mode has a title and no form", async ({ page }) => {
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

test("/privacy has the browser-extension section the store listing links to", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.locator("#browser-extension h2")).toHaveText("Browser extension");
});

// The test settings serve both networks (playwright.config.ts), so the header carries the network switch, its widest
// form. The switch appears after mount: each check waits for it before it measures.
const MAIN_NAV = 'nav[aria-label="Main"]';
const SWITCH = `${MAIN_NAV} > ul[aria-label="Network"]`;

/** How far the page, and the bar's own row, reach past their boxes: both 0 when the header fits. */
function overflowOf(page: Page): Promise<{ page: number; bar: number }> {
  return page.evaluate((nav) => {
    const root = document.documentElement;
    const bar = document.querySelector(nav);
    return {
      page: root.scrollWidth - root.clientWidth,
      bar: bar === null ? -1 : bar.scrollWidth - bar.clientWidth,
    };
  }, MAIN_NAV);
}

/** The home page at `width`, with its network switch mounted. */
async function homeWithSwitch(page: Page, url: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(url);
  await expect(page.locator(SWITCH)).toBeAttached();
}

const ADDRESSES = [
  { name: "Testnet", home: (baseURL: string) => new URL("/", baseURL).href },
  {
    name: "Mainnet",
    home: (baseURL: string) => new URL("/", baseURL).href.replace("//localhost:", "//127.0.0.1:"),
  },
];

for (const { name, home } of ADDRESSES) {
  for (const width of [375, 1120, 1200, 1280, 1440]) {
    test(`the home page and its header fit at ${width} px on the ${name} address`, async ({
      page,
      baseURL,
    }) => {
      await homeWithSwitch(page, home(baseURL ?? ""), width);
      await expect(page.locator(`${SWITCH} [aria-current]`)).toHaveText(name);
      // Below 761 px the switch is the phone menu's last row instead.
      if (width > 760) await expect(page.locator(SWITCH)).toBeVisible();
      expect(await overflowOf(page)).toEqual({ page: 0, bar: 0 });
    });
  }
}

// With one network served the switch renders nothing, so its bar is this one with the switch taken out: the links stay
// in the bar from 1241 px up, and below that they are in the menu.
for (const width of [1280, 1440]) {
  test(`with one network served, the header keeps its links in the bar at ${width} px`, async ({
    page,
  }) => {
    await homeWithSwitch(page, "/", width);
    await page.locator(SWITCH).evaluate((el) => el.remove());
    const nav = page.locator(MAIN_NAV);
    await expect(nav.getByRole("link", { name: "Verify", exact: true })).toBeVisible();
    await expect(nav.locator("summary")).toBeHidden();
    expect(await overflowOf(page)).toEqual({ page: 0, bar: 0 });
  });
}

test("with one network served, the header folds its links into the menu at 1120 px", async ({
  page,
}) => {
  await homeWithSwitch(page, "/", 1120);
  await page.locator(SWITCH).evaluate((el) => el.remove());
  const nav = page.locator(MAIN_NAV);
  await expect(nav.locator("summary")).toBeVisible();
  await expect(nav.getByRole("link", { name: "Verify", exact: true })).toBeHidden();
  expect(await overflowOf(page)).toEqual({ page: 0, bar: 0 });
});
