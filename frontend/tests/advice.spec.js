import { test, expect } from "@playwright/test";
import {
  MOCK_PLAYERS,
  DRAFT_ID,
  makeDraftState,
  makeCompletedDraft,
} from "./fixtures.js";

const API = "http://localhost:9999";

// The shared pool carries no stat lines and nobody is hurt in it, so the two
// things the card has to be honest about -- that a stat reason is LAST
// SEASON's, and that a drawback is shown as a drawback -- would have nothing
// to render. This pool is the shared one with exactly two players changed,
// so the board order, the ADPs and the tiers every other spec depends on are
// untouched.
const SEASON = 2025;
const POOL = MOCK_PLAYERS.map((p) => {
  if (p.id === "p1") {
    return {
      ...p,
      statsSeason: SEASON,
      stats: {
        rush_att: 300,
        rec_tgt: 80,
        off_snp: 900,
        tm_off_snp: 1000,
        rec_rz_tgt: 20,
        pos_rank_ppr: 1,
      },
    };
  }
  // Ranked 9th and still on page one of the board, so the row is reachable
  // without searching -- and searching would filter the card away with it.
  if (p.id === "p9") return { ...p, injuryStatus: "IR", injuryBodyPart: "Knee" };
  return p;
});

function mockPool(page, draftState) {
  page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: POOL } }));
  page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: draftState }));
}

function rowFor(page, name) {
  return page.getByTestId("big-board-row").filter({ hasText: name });
}

test("the recommendation card names a player and gives a reason", async ({ page }) => {
  mockPool(page, makeDraftState({ currentIndex: 0 }));

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  const card = page.getByTestId("advice-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Christian McCaffrey");
  await expect(card.getByTestId("advice-reason").first()).toBeVisible();

  // What it reasons about, said on the card itself: strategy and history,
  // never a forecast.
  await expect(card).toContainText(/not a projection/i);
});

test("a stat-derived reason names the season it came from", async ({ page }) => {
  mockPool(page, makeDraftState({ currentIndex: 0 }));

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  // The engine puts the season in the reason text; the card must not strip
  // it. Without the year this reads as a forecast.
  await expect(page.getByTestId("advice-card")).toContainText(
    `300 carries and 80 targets in ${SEASON}.`
  );
});

test("the why control reveals reasons for that player", async ({ page }) => {
  mockPool(page, makeDraftState({ currentIndex: 0 }));

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  await rowFor(page, "Justin Jefferson").getByTestId("why-player").click();

  const panel = page.getByTestId("why-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Justin Jefferson");
  await expect(panel.getByTestId("advice-reason").first()).toBeVisible();

  // The panel is about the row you asked about, not about the suggestion.
  await expect(panel).not.toContainText("Christian McCaffrey");
  await expect(page.getByTestId("advice-card")).toContainText("Christian McCaffrey");
});

test("the why control explains a player who cannot be recommended", async ({ page }) => {
  mockPool(page, makeDraftState({ currentIndex: 0 }));

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  // Stefon Diggs is on IR in this pool: barred from the suggestion, but he
  // keeps his reasons, and the drawback is shown as a drawback.
  await expect(page.getByTestId("advice-card")).not.toContainText("Stefon Diggs");

  await rowFor(page, "Stefon Diggs").getByTestId("why-player").click();

  const panel = page.getByTestId("why-panel");
  await expect(panel).toContainText("On injured reserve.");
  await expect(panel).toContainText("-25");
});

test("using the why control drafts nobody", async ({ page }) => {
  mockPool(page, makeDraftState({ currentIndex: 0 }));

  let pickRequests = 0;
  await page.route(`${API}/drafts/${DRAFT_ID}/pick`, (r) => {
    pickRequests += 1;
    return r.fulfill({ json: { ok: true } });
  });

  await page.goto(`/draft/${DRAFT_ID}`);
  // Deliberately NOT paused: the rows are live, so every why click below
  // lands on a row that WOULD have drafted somebody had it drafted anybody.

  for (const name of ["Christian McCaffrey", "Justin Jefferson", "Travis Kelce"]) {
    const row = rowFor(page, name);
    await expect(row.locator("button").first()).toBeEnabled();
    await row.getByTestId("why-player").click();
    await expect(page.getByTestId("why-panel")).toContainText(name);
  }

  expect(pickRequests).toBe(0);

  // And the counter is not asleep: the draft button on the same row still
  // sends exactly one pick.
  await rowFor(page, "Travis Kelce").locator("button").first().click();
  await expect(() => expect(pickRequests).toBe(1)).toPass();
});

test("the why control works when it is not your turn", async ({ page }) => {
  // Pick #2 belongs to Team 2 and the user is Team 1.
  mockPool(page, makeDraftState({ currentIndex: 1 }));
  await page.route(`${API}/drafts/${DRAFT_ID}/auto-pick`, (r) =>
    r.fulfill({ json: { ok: true } })
  );

  let pickRequests = 0;
  await page.route(`${API}/drafts/${DRAFT_ID}/pick`, (r) => {
    pickRequests += 1;
    return r.fulfill({ json: { ok: true } });
  });

  await page.goto(`/draft/${DRAFT_ID}`);
  // The page auto-picks for whoever is on the clock and the mock answers
  // with the same state every time, so it would loop. Pausing stops the
  // loop; the draft is still parked on Team 2's pick, which is the part
  // under test.
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("R1 P2 • Team 2")).toBeVisible();

  const row = rowFor(page, "Justin Jefferson");
  await expect(row.locator("button").first()).toBeDisabled();

  await row.getByTestId("why-player").click();
  await expect(page.getByTestId("why-panel")).toContainText("Justin Jefferson");

  expect(pickRequests).toBe(0);
});

test("a completed draft recommends nobody", async ({ page }) => {
  mockPool(page, makeCompletedDraft());

  await page.goto(`/draft/${DRAFT_ID}`);

  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
  await expect(page.getByTestId("big-board-row").first()).toBeVisible();
  await expect(page.getByTestId("advice-card")).toHaveCount(0);
});
