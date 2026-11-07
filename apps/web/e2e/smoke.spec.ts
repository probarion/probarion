import { expect, type Page, test } from "@playwright/test";

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

test("/privacy has no browser-extension section yet (plan 06 Task 1 adds it)", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.locator("#browser-extension")).toHaveCount(0);
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
  for (const width of [375, 1120, 1280, 1440]) {
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
// in the bar from 1101 px up, as they did before the switch existed.
for (const width of [1120, 1280]) {
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
