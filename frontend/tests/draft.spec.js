import { test, expect } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";
import { MOCK_PLAYERS, DRAFT_ID, makeDraftState } from "./fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");

const API = "http://localhost:9999";

function mockDraftApis(page, draftState) {
  page.route(`${API}/players*`, async (route) => {
    await route.fulfill({ json: { players: MOCK_PLAYERS } });
  });
  page.route(`${API}/drafts/${DRAFT_ID}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: draftState });
    }
  });
}

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
    await expect(page.getByText("Christian McCaffrey")).not.toBeVisible();
  });

  test("position filter shows only selected position", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await page.locator("select").first().selectOption("QB");

    await expect(page.getByText("Josh Allen").first()).toBeVisible();
    await expect(page.getByText("Lamar Jackson").first()).toBeVisible();
    await expect(page.getByText("Christian McCaffrey")).not.toBeVisible();
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

    await expect(page.getByText(/\d+s/)).toBeVisible();
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
    // Do NOT pause — players are clickable only when not paused

    const firstPlayer = page.getByRole("button", { name: /Christian McCaffrey/ }).first();
    await expect(firstPlayer).toBeEnabled();
    await firstPlayer.click();

    await expect(() => expect(pickPayload?.playerId).toBe("p1")).toPass();
  });

  test("← Home link navigates to home", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await page.getByRole("link", { name: "← Home" }).click();
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

  test("screenshot — draft page (paused, team 1 on clock)", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
    await expect(page.getByText("Christian McCaffrey").first()).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOTS}/draft.png`, fullPage: false });
  });
});
