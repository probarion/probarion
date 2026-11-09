import { expect, type Locator, type Page, test } from "@playwright/test";

// The docs on the built site with test settings (playwright.config.ts).
// Local only, like the smoke spec.

const ARTICLE = "/docs/concepts/payment-checks";
const ARTICLE_TITLE = "How a payment is checked";

// Fixed, so no result depends on Playwright's defaults. Tests that need another size set it.
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });

const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/**
 * Waits until the search dialog has attached its listeners (it sets data-ready="true" then). A key
 * press or a click before that is lost. In a throttled browser it took about 6 s. The dialog is in
 * the docs layout, so every docs page has it, the 404 included.
 */
async function searchReady(page: Page) {
  await expect(page.locator('dialog[data-ready="true"]')).toBeAttached({ timeout: 15_000 });
}

/** Waits for the page's fonts, so a measurement sees the final text widths. */
async function fontsReady(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/** Opens the search dialog with Ctrl K, once the page has hydrated. */
async function openSearch(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Search the docs" });
  await searchReady(page);
  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * How far the element's top edge sits below the bottom edge of the sticky header(s), once the
 * scroll has stopped (the same value two frames in a row). Below 0, a header covers it.
 */
const clearance = (page: Page, id: string) =>
  page.evaluate(async (target) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const gap = () => {
      const el = document.getElementById(target);
      const headers = Array.from(document.querySelectorAll("header")).filter(
        (h) => getComputedStyle(h).position === "sticky",
      );
      if (el === null || headers.length === 0) return Number.NaN;
      const bottom = Math.max(...headers.map((h) => h.getBoundingClientRect().bottom));
      return el.getBoundingClientRect().top - bottom;
    };
    let last = gap();
    for (let i = 0; i < 120; i++) {
      await frame();
      const now = gap();
      if (now === last) return now;
      last = now;
    }
    return last;
  }, id);

/** An element's id, which must be there. */
async function idOf(locator: Locator) {
  const id = await locator.getAttribute("id");
  expect(id).toBeTruthy();
  return id ?? "";
}

test("the docs home shows its four doors above the fold at 1440 x 900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs");
  const doors = page.locator("[data-door]");
  await expect(doors).toHaveCount(4);
  await searchReady(page);
  await fontsReady(page);
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

test("Ctrl K finds an error code, the arrow keys move, and Enter opens its row", async ({
  page,
}) => {
  await page.goto("/docs/start/what-is-probarion");
  const dialog = await openSearch(page);
  const box = dialog.getByRole("combobox", { name: "Search the docs" });
  await expect(box).toBeFocused();
  await box.pressSequentially("NoMandate");
  const options = dialog.getByRole("option");
  await expect(options.first()).toContainText("NoMandate");
  expect(await options.count()).toBeGreaterThan(1);
  // Focus stays in the box; aria-activedescendant names the active option.
  await box.press("ArrowDown");
  await expect(box).toHaveAttribute("aria-activedescendant", await idOf(options.nth(1)));
  await box.press("ArrowUp");
  await expect(box).toHaveAttribute("aria-activedescendant", await idOf(options.first()));
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/docs\/build\/errors#NoMandate$/);
  await expect(page.locator('[id="NoMandate"]')).toBeInViewport();
  // In view, and not under the sticky site header.
  await expect.poll(() => clearance(page, "NoMandate")).toBeGreaterThanOrEqual(0);
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

test("reopening the search keeps the last query, all of it selected", async ({ page }) => {
  await page.goto(ARTICLE);
  const dialog = await openSearch(page);
  const box = dialog.getByRole("combobox", { name: "Search the docs" });
  await box.fill("mandate");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("mandate");
  const selection = await box.evaluate((el: HTMLInputElement) => [
    el.selectionStart,
    el.selectionEnd,
  ]);
  expect(selection).toEqual([0, "mandate".length]);
});

test("a popular search opens the search with its query", async ({ page }) => {
  await page.goto("/docs");
  await searchReady(page);
  await page
    .locator("[data-docs-popular]")
    .getByRole("link", { name: "PROBARION:NoMandate" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Search the docs" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Search the docs" })).toHaveValue(
    "PROBARION:NoMandate",
  );
  await expect(dialog.getByRole("option").first()).toContainText("NoMandate");
  // The dialog took the click: the link did not navigate.
  await expect(page).toHaveURL(/\/docs$/);
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
  const box = dialog.getByRole("combobox", { name: "Search the docs" });
  // The button goes as the load starts, so focus moves to the box first.
  await expect(box).toBeFocused();
  await box.fill("mandate");
  await expect(dialog.getByRole("option").first()).toBeVisible();
});

test("a table-of-contents link scrolls to its heading and marks it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ARTICLE);
  const last = page.getByRole("complementary", { name: "On this page" }).getByRole("link").last();
  const id = ((await last.getAttribute("href")) ?? "").split("#")[1] ?? "";
  expect(id).not.toBe("");
  await last.click();
  await expect(page).toHaveURL(new RegExp(`#${id}$`));
  await expect(page.locator(`[id="${id}"]`)).toBeInViewport();
  // The scroll-spy (Toc) marks the heading it scrolled to.
  await expect(last).toHaveAttribute("aria-current", "location");
});

test("on a phone, the Contents drawer opens the sidebar, its links work and it closes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(ARTICLE);
  await searchReady(page);
  await fontsReady(page);
  const drawer = page.getByRole("navigation", { name: "Docs contents" });
  const details = page.locator("details", {
    has: page.locator('nav[aria-label="Docs contents"]'),
  });
  await page.locator("summary", { hasText: "Contents" }).click();
  await expect(drawer).toBeVisible();
  expect(await sideways(page)).toBe(0);
  await drawer.locator('a[href="/docs/concepts/mandates"]').click();
  await expect(page).toHaveURL(/\/docs\/concepts\/mandates$/);
  await expect(details).toHaveJSProperty("open", false);
  await expect(drawer).toBeHidden();
});

// Measured on the hydrated page: an article's Copy buttons only show once it has hydrated.
for (const { path, article } of [
  { path: "/docs", article: false },
  { path: ARTICLE, article: true },
  { path: "/docs/build/errors", article: true },
  { path: "/docs/zzz", article: false },
]) {
  test(`${path} does not scroll sideways at 390 px`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await searchReady(page);
    if (article) await expect(page.getByRole("button", { name: "Copy page" })).toBeVisible();
    await fontsReady(page);
    expect(await sideways(page)).toBe(0);
  });
}

test("the Markdown twins and the llms files carry their routes' headers", async ({ request }) => {
  const res = await request.get(`${ARTICLE}.md`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^text\/markdown/);
  expect(res.headers()["x-robots-tag"]).toBe("noindex");
  expect(await res.text()).toMatch(new RegExp(`^# ${ARTICLE_TITLE}$`, "m"));
  // As each route sets them: app/docs-md/[[...slug]]/route.ts for the twins, and the llms.txt and
  // llms-full.txt routes, which set no X-Robots-Tag.
  for (const { path, type, robots } of [
    { path: `${ARTICLE}.md`, type: "text/markdown; charset=utf-8", robots: "noindex" },
    { path: "/docs.md", type: "text/markdown; charset=utf-8", robots: "noindex" },
    { path: "/llms.txt", type: "text/plain; charset=utf-8", robots: undefined },
    { path: "/llms-full.txt", type: "text/plain; charset=utf-8", robots: undefined },
  ]) {
    const answer = await request.get(path);
    expect(answer.status(), path).toBe(200);
    expect(answer.headers()["content-type"], path).toBe(type);
    expect(answer.headers()["x-robots-tag"], path).toBe(robots);
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
    // named "Search the docs" (its Ctrl K key cap is aria-hidden). The hrefs are not-found.tsx's.
    const missing = page.locator("section", { has: page.getByRole("heading", { level: 1 }) });
    for (const { name, href } of [
      { name: "Search the docs", href: "/docs#popular" },
      { name: "Docs home", href: "/docs" },
      { name: "Glossary", href: "/docs/resources/glossary" },
    ]) {
      const link = missing.getByRole("link", { name, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", href);
    }
    // The docs bar is there too, outside the section: its search trigger comes first.
    const bar = page.locator("[data-docs-search]").first();
    await expect(bar).toBeVisible();
    expect(await bar.evaluate((e) => e.closest("section") === null)).toBe(true);
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

// copyText (lib/docs/clipboard.ts) answers false both when writeText rejects and when there is no
// navigator.clipboard at all (an insecure context, an old browser): the button shows Copy failed.
// `inPlace` tells that the page sees the stand-in, not the browser's own clipboard.
const BLOCKED_CLIPBOARDS = [
  {
    name: "rejects the write",
    init: () => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("blocked")) },
      });
    },
    inPlace: () => navigator.clipboard !== undefined && !(navigator.clipboard instanceof Clipboard),
  },
  {
    name: "is missing",
    init: () => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    },
    inPlace: () => navigator.clipboard === undefined,
  },
];

for (const { name, init, inPlace } of BLOCKED_CLIPBOARDS) {
  test(`Copy page says and announces Copy failed when the clipboard ${name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(init);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(ARTICLE);
    expect(await page.evaluate(inPlace)).toBe(true);
    // The button stays hidden until it has hydrated, and the click waits for it to show.
    await page.getByRole("button", { name: "Copy page" }).click();
    await expect(page.getByRole("button", { name: "Copy failed" })).toBeVisible();
    // The status region next to the button announces it (Task 2's CopyButton), and nothing threw.
    await expect(page.getByRole("status").filter({ hasText: "Copy failed" })).toBeAttached();
    expect(errors).toEqual([]);
  });
}
