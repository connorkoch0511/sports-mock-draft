import { test, expect } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";
import { MOCK_PLAYERS, DRAFT_ID, makeDraftState, mockDraftApis } from "./fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");

const API = "http://localhost:9999";

test.describe("Draft page", () => {
  test("renders Big Board, Draft Board, and Team Rosters panels", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Draft Board" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Team Rosters" })).toBeVisible();
  });

  test("big board shows player names from API", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await expect(page.getByText("Christian McCaffrey").first()).toBeVisible();
    await expect(page.getByText("Justin Jefferson").first()).toBeVisible();
    await expect(page.getByText("CeeDee Lamb").first()).toBeVisible();
  });

  test("player search filters the board", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await page.getByPlaceholder("Search player…").fill("Kelce");

    await expect(page.getByText("Travis Kelce").first()).toBeVisible();
    // Scoped to the board: this test is about which ROWS survive the filter.
    // Asserting against the whole page also asserted that nothing else on it
    // mentions the player, which is a claim this test never meant to make.
    await expect(
      page.getByTestId("big-board-row").filter({ hasText: "Christian McCaffrey" })
    ).toHaveCount(0);
  });

  test("position filter shows only selected position", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await page.locator("select").first().selectOption("QB");

    await expect(page.getByText("Josh Allen").first()).toBeVisible();
    await expect(page.getByText("Lamar Jackson").first()).toBeVisible();
    // Scoped to the board, for the same reason as the search test above.
    await expect(
      page.getByTestId("big-board-row").filter({ hasText: "Christian McCaffrey" })
    ).toHaveCount(0);
  });

  test("pause and resume toggle button label", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await page.goto(`/draft/${DRAFT_ID}`);

    const btn = page.getByRole("button", { name: /Pause|Resume/ });
    await expect(btn).toHaveText("Pause");

    await btn.click();
    await expect(btn).toHaveText("Resume");

    await btn.click();
    await expect(btn).toHaveText("Pause");
  });

  test("shows countdown timer when Team 1 is on the clock", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 }); // pick #1 = Team 1
    mockDraftApis(page, state);

    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    // Anchored on the clock glyph. A bare /\d+s/ also matches copy like
    // "Starts 1st on the consensus board", which is a different thing on the
    // same screen.
    await expect(page.getByText(/⏱\s*\d+s/)).toBeVisible();
  });

  test("Auto Pick button calls the auto-pick endpoint", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    let autoPickCalled = false;
    await page.route(`${API}/drafts/${DRAFT_ID}/auto-pick`, async (route) => {
      autoPickCalled = true;
      await route.fulfill({ json: { ok: true, picked: MOCK_PLAYERS[0] } });
    });

    await page.goto(`/draft/${DRAFT_ID}`);
    // Do NOT pause — Auto Pick is disabled when paused

    await page.getByRole("button", { name: "Auto Pick" }).click();
    await expect(() => expect(autoPickCalled).toBe(true)).toPass();
  });

  test("Sim to End button calls the sim-to-end endpoint", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    let simCalled = false;
    await page.route(`${API}/drafts/${DRAFT_ID}/sim-to-end`, async (route) => {
      simCalled = true;
      await route.fulfill({ json: { ok: true, completed: true } });
    });

    await page.goto(`/draft/${DRAFT_ID}`);
    // Do NOT pause — Sim to End is disabled when paused

    await page.getByRole("button", { name: "Sim to End" }).click();
    await expect(() => expect(simCalled).toBe(true)).toPass();
  });

  test("shows View Results button when draft is completed", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    const completedState = { ...state, currentIndex: state.picks.length, completed: true };

    page.route(`${API}/players*`, async (route) => {
      await route.fulfill({ json: { players: MOCK_PLAYERS } });
    });
    page.route(`${API}/drafts/${DRAFT_ID}`, async (route) => {
      await route.fulfill({ json: completedState });
    });

    await page.goto(`/draft/${DRAFT_ID}`);

    await expect(page.getByRole("link", { name: /View Results/i })).toBeVisible();
  });

  test("manual pick is sent to API when Team 1 is on clock", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });

    page.route(`${API}/players*`, async (route) => {
      await route.fulfill({ json: { players: MOCK_PLAYERS } });
    });

    let pickPayload = null;
    page.route(`${API}/drafts/${DRAFT_ID}/pick`, async (route) => {
      pickPayload = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({ json: { ok: true } });
    });

    // After pick, return same base state to prevent cascade
    page.route(`${API}/drafts/${DRAFT_ID}`, async (route) => {
      await route.fulfill({ json: state });
    });

    await page.goto(`/draft/${DRAFT_ID}`);
    // Do NOT pause — the Draft button is enabled only when not paused

    const draftBtn = page
      .getByTestId("big-board-row")
      .filter({ hasText: "Christian McCaffrey" })
      .getByTestId("draft-player");
    await expect(draftBtn).toBeEnabled();
    await draftBtn.click();

    await expect(() => expect(pickPayload?.playerId).toBe("p1")).toPass();
  });

  test("nav menu Home link navigates to home", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await page.getByTestId("nav-toggle").click();
    await page.getByTestId("nav-menu").getByRole("link", { name: "Home" }).click();
    await expect(page).toHaveURL("/");
  });

  test("draft board table shows pick numbers and team assignments", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    // Draft board table shows overall pick numbers and team labels
    await expect(page.getByText("#1").first()).toBeVisible();
    await expect(page.getByText("T1").first()).toBeVisible();
  });

  // The README's front-page image. The shared pool carries no stat lines, so
  // the suggestion card read "No prior season of production on record: a
  // rookie, or he did not play." about Christian McCaffrey -- true of the
  // fixture, and nonsense to anyone who knows football. The pool is fixed
  // here rather than in fixtures.js: MOCK_PLAYERS is shared by a dozen specs
  // and its ADPs, ranks and tiers are load-bearing for them.
  test("screenshot — draft page (paused, team 1 on clock)", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    // The season before the fixture's draft year, which is what the engine
    // reasons from and says out loud.
    const LAST_SEASON = state.year - 1;
    const pool = MOCK_PLAYERS.map((p) =>
      p.id === "p1"
        ? {
            ...p,
            statsSeason: LAST_SEASON,
            stats: {
              rush_att: 272,
              rec_tgt: 83,
              off_snp: 715,
              tm_off_snp: 1024,
              rec_rz_tgt: 12,
              pos_rank_ppr: 1,
            },
          }
        : p
    );
    page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: pool } }));
    page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: state }));

    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
    await expect(page.getByText("Christian McCaffrey").first()).toBeVisible();

    // The image is only worth shipping if the card is in it saying something
    // real, so the shot waits for the stat-derived reason rather than for
    // the card alone.
    const card = page.getByTestId("advice-card");
    await expect(card).toContainText("Christian McCaffrey");
    await expect(card).toContainText(`Finished RB1 in PPR scoring in ${LAST_SEASON}.`);
    await expect(card).not.toContainText("No prior season of production");

    await page.screenshot({ path: `${SCREENSHOTS}/draft.png`, fullPage: false });
  });

});

// --- Pinning the Big Board row before it is restructured -------------------
//
// Every manual pick goes through this row. It is one <button> calling
// makePick, and the advice work turns it into a container holding that button
// plus a separate control. These three describe what it does today and must
// pass UNMODIFIED afterwards -- needing to edit one is the signal that
// something moved which should not have.
//
// Note: no Pause click. canManualPick is `!paused && !busy && !completed &&
// isMyTurn`, so pausing disables the Draft button for your own turn too.

test("the row's Draft button drafts that player", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0 });
  page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: MOCK_PLAYERS } }));
  page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: state }));

  let picked = null;
  page.route(`${API}/drafts/${DRAFT_ID}/pick`, (r) => {
    picked = JSON.parse(r.request().postData() || "{}").playerId;
    return r.fulfill({ json: { ok: true } });
  });

  await page.goto(`/draft/${DRAFT_ID}`);
  // The row itself opens the player now; only this button drafts him.
  const draftBtn = page
    .getByTestId("big-board-row")
    .filter({ hasText: "Christian McCaffrey" })
    .getByTestId("draft-player");
  await expect(draftBtn).toBeEnabled();
  await draftBtn.click();

  await expect(() => expect(picked).toBe("p1")).toPass();
});

test("the Draft button is disabled when picking is not allowed", async ({ page }) => {
  // Pause is the stable way to reach canManualPick === false. Driving it via
  // "not your turn" instead would let the autopick effect loop against a
  // static mock, and the row would end up disabled by `busy` rather than by
  // the condition under test.
  const state = makeDraftState({ currentIndex: 0 });
  page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: MOCK_PLAYERS } }));
  page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: state }));

  let calls = 0;
  page.route(`${API}/drafts/${DRAFT_ID}/pick`, (r) => {
    calls += 1;
    return r.fulfill({ json: { ok: true } });
  });

  await page.goto(`/draft/${DRAFT_ID}`);
  const draftBtn = page
    .getByTestId("big-board-row")
    .filter({ hasText: "Christian McCaffrey" })
    .getByTestId("draft-player");
  const openBtn = page
    .getByTestId("big-board-row")
    .filter({ hasText: "Christian McCaffrey" })
    .getByTestId("open-player");
  await expect(draftBtn).toBeEnabled();

  await page.getByRole("button", { name: "Pause" }).click();

  await expect(draftBtn).toBeDisabled();
  // Reading is never gated on being able to pick.
  await expect(openBtn).toBeEnabled();
  expect(calls).toBe(0);
});

test("a player can be drafted from the keyboard", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0 });
  page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: MOCK_PLAYERS } }));
  page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: state }));

  let picked = null;
  page.route(`${API}/drafts/${DRAFT_ID}/pick`, (r) => {
    picked = JSON.parse(r.request().postData() || "{}").playerId;
    return r.fulfill({ json: { ok: true } });
  });

  await page.goto(`/draft/${DRAFT_ID}`);
  const draftBtn = page
    .getByTestId("big-board-row")
    .filter({ hasText: "Christian McCaffrey" })
    .getByTestId("draft-player");
  await expect(draftBtn).toBeEnabled();
  await draftBtn.focus();
  await page.keyboard.press("Enter");

  await expect(() => expect(picked).toBe("p1")).toPass();
});
