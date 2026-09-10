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

// What this route owns: verifying the state, sending the code, and handing the
// result on. RENDERING the leagues belongs to the New Draft panel, so this
// asserts the code reached our API and the person arrived where the panel
// lives -- not what that panel shows.
test("a callback whose state matches sends the code and returns to New Draft", async ({ page }) => {
  let sentCode = null;
  await page.route(`${API}/yahoo/leagues`, (r) => {
    sentCode = r.request().postDataJSON().code;
    return r.fulfill({ json: { leagues: [{ leagueName: "Dynasty", teams: 12, rounds: 15, format: "ppr", rosterSlots: [], userTeam: 3 }] } });
  });
  await seedState(page, "the-state");
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=the-state");

  await expect(page).toHaveURL(/\/draft\/new$/);
  await expect.poll(() => sentCode).toBe("abc");
  // yahoo-panel-error, not yahoo-error: the latter lives only on the callback
  // route, so asserting its absence here would pass against anything.
  await expect(page.getByTestId("yahoo-panel-error")).toHaveCount(0);
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

test("the Yahoo panel sends you to Yahoo with a state", async ({ page }) => {
  await signIn(page);
  await page.goto("/draft/new");

  // Catch the navigation rather than following it off-site.
  await page.route("https://api.login.yahoo.com/**", (r) => r.fulfill({ status: 200, body: "stub" }));
  await page.getByTestId("import-platform").selectOption("yahoo");
  await page.getByTestId("yahoo-import").click();

  await expect(page).toHaveURL(/api\.login\.yahoo\.com\/oauth2\/request_auth/);
  const url = new URL(page.url());
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(url.searchParams.get("response_type")).toBe("code");
});

test("leagues carried back from the callback are listed and apply to the form", async ({ page }) => {
  await page.route(`${API}/yahoo/leagues`, (r) =>
    r.fulfill({ json: { leagues: [{ leagueName: "Money League", teams: 10, rounds: 16, format: "half-ppr", rosterSlots: ["QB", "RB"], userTeam: 4 }] } })
  );
  await page.addInitScript(([v]) => window.sessionStorage.setItem("yahoo_oauth_state", v), ["s"]);
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=s");

  await expect(page.getByTestId("yahoo-leagues")).toContainText("Money League");
  await page.getByTestId("yahoo-leagues").getByRole("button", { name: /Money League/ }).click();

  // The same form the Sleeper import fills.
  await expect(page.getByLabel(/teams/i)).toHaveValue("10");
  await expect(page.getByLabel(/rounds/i)).toHaveValue("16");
});

// An account with no NFL leagues is not an error, and must not read as one.
test("an account with no Yahoo leagues says so plainly", async ({ page }) => {
  await page.route(`${API}/yahoo/leagues`, (r) => r.fulfill({ json: { leagues: [] } }));
  await page.addInitScript(([v]) => window.sessionStorage.setItem("yahoo_oauth_state", v), ["s"]);
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=s");

  await expect(page.getByTestId("yahoo-leagues-empty")).toContainText(/no yahoo nfl leagues/i);
  await expect(page.getByTestId("yahoo-error")).toHaveCount(0);
});

// A Yahoo authorisation code can be redeemed exactly once, so exchanging it
// twice fails the second time and shows an error on top of an import that
// already worked. StrictMode double-invokes effects in development, and this
// suite runs against the dev server -- so without this assertion the doubled
// path is exercised on every run and noticed on none of them.
test("a valid callback exchanges the code exactly once", async ({ page }) => {
  let calls = 0;
  await page.route(`${API}/yahoo/leagues`, (r) => {
    calls += 1;
    return r.fulfill({ json: { leagues: [] } });
  });
  await seedState(page, "once-only");
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=once-only");

  await expect(page).toHaveURL(/\/draft\/new$/);
  // Settle, so a late second request would still be counted.
  await page.waitForTimeout(500);
  expect(calls).toBe(1);
});

// The roster summary is filled by whichever import ran, but it used to sit
// inside the Sleeper card -- so a Yahoo import rendered its slots under the
// Sleeper heading, and the note below them named Sleeper as the reason the
// counts differed.
test("a Yahoo import's roster summary does not blame Sleeper", async ({ page }) => {
  await page.route(`${API}/yahoo/leagues`, (r) =>
    r.fulfill({ json: { leagues: [{ leagueName: "Money League", teams: 10, rounds: 16, format: "half-ppr", rosterSlots: ["QB", "RB"], userTeam: 4 }] } })
  );
  await seedState(page, "s");
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=s");

  await page.getByTestId("yahoo-leagues").getByRole("button", { name: /Money League/ }).click();

  const summary = page.getByTestId("roster-summary");
  await expect(summary).toContainText("Money League");
  // 2 slots against 16 rounds, so the explanatory note renders -- and must not
  // name a platform this league did not come from.
  await expect(page.getByTestId("roster-rounds-note")).toBeVisible();
  await expect(page.getByTestId("roster-rounds-note")).not.toContainText(/sleeper/i);
});

test("the platform dropdown swaps which import is on screen", async ({ page }) => {
  await signIn(page);
  await page.goto("/draft/new");

  // Sleeper is the default, so its field is there without touching anything.
  await expect(page.getByTestId("sleeper-username")).toBeVisible();
  await expect(page.getByTestId("yahoo-import")).toHaveCount(0);

  await page.getByTestId("import-platform").selectOption("yahoo");
  await expect(page.getByTestId("yahoo-import")).toBeVisible();
  await expect(page.getByTestId("sleeper-username")).toHaveCount(0);

  await page.getByTestId("import-platform").selectOption("sleeper");
  await expect(page.getByTestId("sleeper-username")).toBeVisible();
});

test("a Yahoo callback lands with Yahoo already selected", async ({ page }) => {
  // Coming back from Yahoo with leagues, the dropdown must not be sitting on
  // Sleeper -- the leagues just authorised would be hidden behind it.
  await page.route(`${API}/yahoo/leagues`, (r) =>
    r.fulfill({ json: { leagues: [{ leagueName: "Money League", teams: 10, rounds: 16, format: "half-ppr", rosterSlots: ["QB", "RB"], userTeam: 4 }] } })
  );
  await page.addInitScript(([v]) => window.sessionStorage.setItem("yahoo_oauth_state", v), ["s"]);
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=s");

  await expect(page.getByTestId("import-platform")).toHaveValue("yahoo");
  await expect(page.getByTestId("yahoo-leagues")).toContainText("Money League");
});
