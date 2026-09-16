import { test, expect } from "@playwright/test";

// A manifest that names an icon nobody serves is the most common way this
// feature breaks silently: the install prompt just never appears, with no
// error anywhere. So every URL it declares is fetched, not merely declared.
test("the manifest is linked, parses, and every icon it names resolves", async ({ page, request }) => {
  await page.goto("/");

  const href = await page.getAttribute('link[rel="manifest"]', "href");
  expect(href, "index.html must link a manifest").toBeTruthy();

  const res = await request.get(new URL(href, page.url()).toString());
  expect(res.status()).toBe(200);
  const manifest = await res.json();

  expect(manifest.start_url).toBe("/drafts");
  expect(manifest.display).toBe("standalone");
  expect(manifest.background_color).toBe("#070A0F");
  expect(manifest.theme_color).toBe("#070A0F");
  expect(manifest.short_name).toBe("PerfectPick");

  const sizes = manifest.icons.map((i) => i.sizes);
  expect(sizes, "Chrome requires both 192 and 512").toEqual(
    expect.arrayContaining(["192x192", "512x512"])
  );
  expect(
    manifest.icons.some((i) => (i.purpose || "").includes("maskable")),
    "Android crops icons; a maskable variant must exist"
  ).toBe(true);

  for (const icon of manifest.icons) {
    const iconRes = await request.get(new URL(icon.src, page.url()).toString());
    expect(iconRes.status(), `${icon.src} must actually be served`).toBe(200);
    const body = await iconRes.body();
    expect(body.length, `${icon.src} must not be empty`).toBeGreaterThan(500);
  }
});

test("the iOS fallbacks are present, since Safari ignores most of the manifest", async ({ page, request }) => {
  await page.goto("/");

  const apple = await page.getAttribute('link[rel="apple-touch-icon"]', "href");
  expect(apple, "iOS reads apple-touch-icon, not the manifest icons").toBeTruthy();
  const res = await request.get(new URL(apple, page.url()).toString());
  expect(res.status()).toBe(200);

  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#070A0F"
  );
  await expect(
    page.locator('meta[name="apple-mobile-web-app-capable"]')
  ).toHaveCount(1);
});

test("a visitor who never asked for notifications still gets a service worker", async ({ page }) => {
  // The whole point: Chrome will not offer to install an app with no active
  // worker, and registration used to happen only behind the notification
  // opt-in.
  let permissionAsked = false;
  await page.addInitScript(() => {
    window.__notifAsked = false;
    if (window.Notification) {
      const real = window.Notification.requestPermission;
      window.Notification.requestPermission = (...a) => {
        window.__notifAsked = true;
        return real.apply(window.Notification, a);
      };
    }
  });

  await page.goto("/");
  const scriptURL = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.active?.scriptURL || "";
  });

  expect(scriptURL, "the registered worker must keep its apiBase query").toMatch(
    /\/sw\.js\?apiBase=/
  );

  permissionAsked = await page.evaluate(() => window.__notifAsked);
  expect(
    permissionAsked,
    "registering must never prompt for notification permission"
  ).toBe(false);
});
