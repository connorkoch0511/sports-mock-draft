import { test, expect } from "@playwright/test";

const API = "**/drafts/*/shared*";

const SHARED_BODY = {
  format: "ppr",
  teams: 2,
  rounds: 2,
  rosterSlots: ["QB", "RB"],
  picks: [
    { overall: 1, round: 1, team: 1, playerId: "p1", player: { id: "p1", name: "Ja'Marr Chase", position: "WR", team: "CIN" } },
    { overall: 2, round: 1, team: 2, playerId: "p2", player: { id: "p2", name: "Bijan Robinson", position: "RB", team: "ATL" } },
  ],
};

test("a signed-out visitor can read a shared result", async ({ page }) => {
  await page.route(API, (r) => r.fulfill({ json: SHARED_BODY }));
  await page.goto("/shared/d1?t=share-abc");

  await expect(page.getByText("Ja'Marr Chase")).toBeVisible();
  await expect(page.getByText("Bijan Robinson")).toBeVisible();
});

test("the shared view sends no Authorization header", async ({ page }) => {
  let auth = "unset";
  await page.route(API, (r) => {
    auth = r.request().headers()["authorization"] ?? null;
    return r.fulfill({ json: SHARED_BODY });
  });
  await page.goto("/shared/d1?t=share-abc");
  await expect(page.getByText("Ja'Marr Chase")).toBeVisible();

  expect(auth, "an anonymous read must not carry a bearer token").toBeNull();
});

test("a bad token shows a plain not-found, not a crash or a sign-in wall", async ({ page }) => {
  await page.route(API, (r) => r.fulfill({ status: 404, json: { error: "Not found" } }));
  await page.goto("/shared/d1?t=wrong");

  await expect(page.getByTestId("shared-missing")).toBeVisible();
  // It must not bounce to sign-in: the whole point is that a stranger can open it.
  await expect(page).toHaveURL(/\/shared\/d1/);
});

test("the shared view offers nothing that implies participation", async ({ page }) => {
  await page.route(API, (r) => r.fulfill({ json: SHARED_BODY }));
  await page.goto("/shared/d1?t=share-abc");
  await expect(page.getByText("Ja'Marr Chase")).toBeVisible();

  await expect(page.getByRole("button", { name: /copy invite/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /export|download/i })).toHaveCount(0);
});
