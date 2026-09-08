import { test, expect } from "@playwright/test";
import { signIn } from "./auth.js";

const API = "http://localhost:9999";

// Puts a known state in the tab, so the callback has something to match.
async function seedState(page, value) {
  await page.addInitScript(
    ([v]) => window.sessionStorage.setItem("yahoo_oauth_state", v),
    [value]
  );
}

test("a callback whose state matches imports the leagues", async ({ page }) => {
  await page.route(`${API}/yahoo/leagues`, (r) =>
    r.fulfill({ json: { leagues: [{ leagueName: "Dynasty", teams: 12, rounds: 15, format: "ppr", rosterSlots: [], userTeam: 3 }] } })
  );
  await seedState(page, "the-state");
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=the-state");

  await expect(page).toHaveURL(/\/draft\/new$/);
  await expect(page.getByTestId("yahoo-leagues")).toContainText("Dynasty");
});

// The whole point of the guard: a crafted callback must not reach our API.
test("a callback whose state does not match is refused, and nothing is sent", async ({ page }) => {
  let called = false;
  await page.route(`${API}/yahoo/leagues`, (r) => { called = true; return r.fulfill({ json: { leagues: [] } }); });
  await seedState(page, "the-real-state");
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=an-attackers-state");

  await expect(page.getByTestId("yahoo-error")).toContainText(/could not be verified/i);
  expect(called).toBe(false);
});

// Changing your mind is not a failure.
test("declining at Yahoo returns quietly, with no error", async ({ page }) => {
  await signIn(page);
  await page.goto("/yahoo/callback?error=access_denied&state=whatever");

  await expect(page).toHaveURL(/\/draft\/new$/);
  await expect(page.getByTestId("yahoo-error")).toHaveCount(0);
});

test("a failure at our API says so rather than showing a blank page", async ({ page }) => {
  await page.route(`${API}/yahoo/leagues`, (r) => r.fulfill({ status: 502, json: { message: "Could not reach Yahoo just now" } }));
  await seedState(page, "s");
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=s");

  await expect(page.getByTestId("yahoo-error")).toContainText(/could not reach yahoo/i);
});
