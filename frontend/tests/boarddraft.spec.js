import { test, expect } from "@playwright/test";
import { DRAFT_ID, MOCK_PLAYERS, makeDraftState } from "./fixtures.js";

const API = "http://localhost:9999";
const BID = "board-abc";

// Promote p3 to the top and demote p1, so board order is visibly not ADP order.
const BOARD_ROWS = [
  { playerId: "p3", name: "CeeDee Lamb", position: "WR", team: "DAL", myRank: 1, consensusRank: 3, delta: 2 },
  { playerId: "p1", name: "Christian McCaffrey", position: "RB", team: "SF", myRank: 2, consensusRank: 1, delta: -1 },
];

async function seedBoard(page, { format = "ppr" } = {}) {
  await page.goto("/");
  await page.evaluate(
    ([id, fmt]) =>
      localStorage.setItem(
        "perfectpick.myBoards",
        JSON.stringify([{ id, name: "My PPR Board", format: fmt, updatedAt: Date.now() }])
      ),
    [BID, format]
  );
}

async function mockPlayers(page) {
  await page.route(`${API}/players*`, (route) =>
    route.fulfill({
      json: { sport: "nfl", format: "standard", count: MOCK_PLAYERS.length, players: MOCK_PLAYERS },
    })
  );
}

test("selecting a board sends boardId on create", async ({ page }) => {
  let posted = null;
  await seedBoard(page);
  await page.route(`${API}/drafts`, async (route) => {
    if (route.request().method() === "POST") {
      posted = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({ json: { draftId: DRAFT_ID } });
    }
  });

  await page.goto("/draft/new");
  await page.getByTestId("board-select").selectOption(BID);
  await page.getByRole("button", { name: /Start Mock Draft/i }).click();

  await expect.poll(() => posted?.boardId).toBe(BID);
});

test("creating a draft without a board sends no boardId", async ({ page }) => {
  let posted = null;
  await seedBoard(page);
  await page.route(`${API}/drafts`, async (route) => {
    if (route.request().method() === "POST") {
      posted = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({ json: { draftId: DRAFT_ID } });
    }
  });

  await page.goto("/draft/new");
  await page.getByRole("button", { name: /Start Mock Draft/i }).click();

  await expect.poll(() => posted?.teams).toBe(12);
  expect(posted.boardId).toBeUndefined();
});

test("a format mismatch is flagged", async ({ page }) => {
  await seedBoard(page, { format: "ppr" });
  await page.goto("/draft/new");

  await page.getByTestId("board-select").selectOption(BID);
  // The form defaults to "standard"; match it to the board's format first so
  // the "no mismatch" assertion below reflects matching formats, not just an
  // unset one.
  await page.getByLabel("ADP Format").selectOption("ppr");
  await expect(page.getByTestId("board-format-note")).toHaveCount(0);

  await page.getByLabel("ADP Format").selectOption("standard");
  await expect(page.getByTestId("board-format-note")).toContainText("built for PPR");
});

test("a board without a recorded format is never flagged", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((id) =>
    localStorage.setItem(
      "perfectpick.myBoards",
      JSON.stringify([{ id, name: "Legacy board", updatedAt: Date.now() }])
    ), BID);

  await page.goto("/draft/new");
  await page.getByTestId("board-select").selectOption(BID);
  await page.getByLabel("ADP Format").selectOption("standard");

  await expect(page.getByTestId("board-format-note")).toHaveCount(0);
});

test("the Big Board renders in the board's order, not ADP order", async ({ page }) => {
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: { ...makeDraftState(), boardId: BID } })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({ json: { boardId: BID, name: "My PPR Board", format: "ppr", rows: BOARD_ROWS, changelog: { added: 0, removed: 0 } } })
  );

  await page.goto(`/draft/${DRAFT_ID}`);

  // p3 (CeeDee Lamb) is ADP #3 but the user's #1, so it must lead.
  const first = page.getByRole("button", { name: /CeeDee Lamb/ }).first();
  await expect(first).toBeVisible();
  await expect(first).toContainText("1. CeeDee Lamb");
  await expect(first).toContainText("+2");
});

test("a deleted board still leaves the draft playable", async ({ page }) => {
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: { ...makeDraftState(), boardId: BID } })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({ status: 404, json: { error: "Board not found" } })
  );

  await page.goto(`/draft/${DRAFT_ID}`);

  await expect(page.getByTestId("board-load-note")).toBeVisible();
  // Consensus order restored, and the board is still usable.
  await expect(page.getByRole("button", { name: /Christian McCaffrey/ }).first()).toBeVisible();
  await expect(page.getByText(/on the clock/i).first()).toBeVisible();
});
