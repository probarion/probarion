import { expect, type Page, test } from "@playwright/test";

// The docs on the built site with test settings (playwright.config.ts).
// Local only, like the smoke spec.

const ARTICLE = "/docs/concepts/payment-checks";
const ARTICLE_TITLE = "How a payment is checked";

const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/**
 * Waits until the search dialog has attached its listeners (it sets data-ready="true" then). A key
 * press or a click before that is lost. In a throttled browser it took about 6 s.
 */
async function searchReady(page: Page) {
  await expect(page.locator('dialog[data-ready="true"]')).toBeAttached({ timeout: 15_000 });
}

/** Opens the search dialog with Ctrl K, once the page has hydrated. */
async function openSearch(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Search the docs" });
  await searchReady(page);
  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the docs home shows its four doors above the fold at 1440 x 900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs");
  const doors = page.locator("[data-door]");
  await expect(doors).toHaveCount(4);
  const bottoms = await doors.evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect().bottom),
  );
  // The measurement goes into the report (the JSON reporter keeps annotations).
  test.info().annotations.push({ type: "fold", description: `${Math.max(...bottoms)} px` });
  for (const bottom of bottoms) expect(bottom).toBeLessThanOrEqual(900);
});

test("the site header links to the docs", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Docs", exact: true })
    .click();
  await expect(page).toHaveURL(/\/docs$/);
});

test("Ctrl K finds an error code, and Enter opens its row", async ({ page }) => {
  await page.goto("/docs/start/what-is-probarion");
  const dialog = await openSearch(page);
  const box = dialog.getByRole("combobox", { name: "Search the docs" });
  await expect(box).toBeFocused();
  await box.fill("NoMandate");
  await expect(dialog.getByRole("option").first()).toContainText("NoMandate");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/docs\/build\/errors#NoMandate$/);
  await expect(page.locator('[id="NoMandate"]')).toBeInViewport();
});

test("Escape closes the search and gives focus back", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ARTICLE);
  // openSearch waits for the dialog to be ready: before that, the trigger is a plain link to
  // /docs#popular.
  const dialog = await openSearch(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const trigger = page.locator("[data-docs-search]").first();
  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("when the search index fails, the dialog says so and Try again loads it", async ({ page }) => {
  let fail = true;
  await page.route("**/docs/search-index.json", (route) =>
    fail ? route.fulfill({ status: 500, body: "down" }) : route.continue(),
  );
  await page.goto("/docs");
  const dialog = await openSearch(page);
  await expect(dialog.getByRole("alert")).toContainText("The search index did not load.");
  fail = false;
  await dialog.getByRole("button", { name: "Try again" }).click();
  await dialog.getByRole("combobox", { name: "Search the docs" }).fill("mandate");
  await expect(dialog.getByRole("option").first()).toBeVisible();
});

test("a table-of-contents link scrolls to its heading", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ARTICLE);
  const last = page.getByRole("complementary", { name: "On this page" }).getByRole("link").last();
  const id = ((await last.getAttribute("href")) ?? "").split("#")[1] ?? "";
  expect(id).not.toBe("");
  await last.click();
  await expect(page).toHaveURL(new RegExp(`#${id}$`));
  await expect(page.locator(`[id="${id}"]`)).toBeInViewport();
});

test("on a phone, the Contents drawer opens the sidebar and its links work", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(ARTICLE);
  await page.locator("summary", { hasText: "Contents" }).click();
  const drawer = page.getByRole("navigation", { name: "Docs contents" });
  await expect(drawer).toBeVisible();
  await drawer.locator('a[href="/docs/concepts/mandates"]').click();
  await expect(page).toHaveURL(/\/docs\/concepts\/mandates$/);
});

for (const path of ["/docs", ARTICLE, "/docs/build/errors", "/docs/zzz"]) {
  test(`${path} does not scroll sideways at 390 px`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    expect(await sideways(page)).toBe(0);
  });
}

test("a page's Markdown twin is text/markdown that search engines skip", async ({ request }) => {
  const res = await request.get(`${ARTICLE}.md`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^text\/markdown/);
  expect(res.headers()["x-robots-tag"]).toBe("noindex");
  expect(await res.text()).toMatch(new RegExp(`^# ${ARTICLE_TITLE}$`, "m"));
  for (const path of ["/docs.md", "/llms.txt", "/llms-full.txt"]) {
    expect((await request.get(path)).status(), path).toBe(200);
  }
});

for (const path of ["/docs/zzz", "/docs/start/zzz", "/docs/start/what-is-probarion/extra"]) {
  test(`${path} answers 404 with the docs not-found page`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "This docs page does not exist",
    );
    // The 404's own links (Task 5), looked for in its own section: the bar's search trigger is also
    // named "Search the docs" (its Ctrl K key cap is aria-hidden).
    const missing = page.locator("section", { has: page.getByRole("heading", { level: 1 }) });
    await expect(missing.getByRole("link", { name: "Search the docs", exact: true })).toBeVisible();
    await expect(missing.getByRole("link", { name: "Docs home" })).toBeVisible();
    await expect(missing.getByRole("link", { name: "Glossary", exact: true })).toBeVisible();
  });
}

test("an unknown Markdown twin answers 404", async ({ request }) => {
  expect((await request.get("/docs/zzz.md")).status()).toBe(404);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("a page shows its article, sidebar and links, and search falls back to the popular list", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(ARTICLE);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ARTICLE_TITLE);
    await expect(page.getByRole("navigation", { name: "Docs", exact: true })).toBeVisible();
    await page.locator("[data-docs-search]").first().click();
    await expect(page).toHaveURL(/\/docs#popular$/);
    await expect(page.locator("#popular")).toBeVisible();
  });
});

test("Copy page says and announces Copy failed when the clipboard is blocked", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("blocked")) },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ARTICLE);
  // The button stays hidden until it has hydrated, and the click waits for it to show.
  await page.getByRole("button", { name: "Copy page" }).click();
  await expect(page.getByRole("button", { name: "Copy failed" })).toBeVisible();
  // The status region next to the button announces it (Task 2's CopyButton), and nothing threw.
  await expect(page.getByRole("status").filter({ hasText: "Copy failed" })).toBeAttached();
  expect(errors).toEqual([]);
});
