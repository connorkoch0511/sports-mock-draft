import { test, expect } from "@playwright/test";
import { DRAFT_ID, MOCK_PLAYERS, makeDraftState } from "./fixtures.js";
import { signIn } from "./auth.js";

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

  await signIn(page);
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

  await signIn(page);
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
  const rows = page.getByTestId("big-board-row");
  await expect(rows.first()).toContainText("CeeDee Lamb");

  const first = rows.first();
  await expect(first.getByTestId("rank-mine")).toContainText("1");
  await expect(first).toContainText("+2");
});

test("the board is fetched exactly once, even after a pick", async ({ page }) => {
  await mockPlayers(page);

  // load() is called on initial mount AND again after every pick — the same
  // draft state is returned each time so the "board fetched once" assertion
  // below isolates the board-fetch behavior from draft-state changes.
  const state = { ...makeDraftState(), boardId: BID };
  await page.route(`${API}/drafts/${DRAFT_ID}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: state });
    }
  });

  let boardRequests = 0;
  await page.route(`${API}/boards/${BID}`, async (route) => {
    boardRequests++;
    await route.fulfill({
      json: { boardId: BID, name: "My PPR Board", format: "ppr", rows: BOARD_ROWS, changelog: { added: 0, removed: 0 } },
    });
  });

  let pickPayload = null;
  await page.route(`${API}/drafts/${DRAFT_ID}/pick`, async (route) => {
    pickPayload = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto(`/draft/${DRAFT_ID}`);
  // Do NOT pause — the Draft button is enabled only when not paused.

  const draftBtn = page
    .getByTestId("big-board-row")
    .filter({ hasText: "CeeDee Lamb" })
    .getByTestId("draft-player");
  await expect(draftBtn).toBeEnabled();
  await draftBtn.click();

  // Confirms the pick — and the post-pick load() that refetches draft state —
  // actually completed, so the board-fetch count below reflects a full cycle.
  await expect(() => expect(pickPayload?.playerId).toBe("p3")).toPass();

  expect(boardRequests).toBe(1);
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

test("the draft page names the board driving it", async ({ page }) => {
  await seedBoard(page);
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: makeDraftState({ currentIndex: 0, boardId: BID, format: "ppr" }) })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({ json: { boardId: BID, name: "My PPR Board", format: "ppr", rows: BOARD_ROWS } })
  );

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  await expect(page.getByTestId("board-active-note")).toContainText("My PPR Board");
});

test("no board means no affirmation", async ({ page }) => {
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: makeDraftState({ currentIndex: 0 }) })
  );

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();

  await expect(page.getByTestId("board-active-note")).toHaveCount(0);
});

test("a board that fails to load shows the failure, not the affirmation", async ({ page }) => {
  // NOTE on coverage: this test does a single board fetch that fails, so
  // `boardMeta` is null here because it was never set to anything else — it
  // starts null via useState(null) and the failing fetch never runs the
  // success branch. That means the `board-active-note` count-0 assertion
  // below would pass identically even if `setBoardMeta(null)` were deleted
  // from Draft.jsx's catch branch; it pins the rendered outcome (no
  // affirmation note on a failed load), not the clearing logic in the catch.
  //
  // The catch's own `setBoardMeta(null)` can only matter if boardMeta was
  // previously non-null when the catch runs, which needs the board effect
  // (keyed on `draft?.boardId`) to fire a second time with a different
  // boardId inside one mount — e.g. a prior successful board load in this
  // draft followed by a failure. A single draft's boardId does not change
  // during its lifetime (see the comment above the effect in Draft.jsx), so
  // that sequence does not occur from a single draft's data changing.
  // Even granting an SPA navigation between two different drafts without an
  // unmount (same <Route path="/draft/:draftId">), the catch branch also
  // unconditionally calls `setBoardRows(null)`, and both board-active-note
  // and draft-board-format-note require `boardRows?.length > 0` in addition to
  // boardMeta. So whenever the catch runs, boardRows is already null and
  // neither note can render regardless of what setBoardMeta(null) does —
  // no rendered-DOM assertion can ever distinguish that line's presence
  // from its absence. It is defensive, not dead: safe to keep, but there is
  // no genuine UI-level test to write for it, so none is added here.
  await seedBoard(page);
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: makeDraftState({ currentIndex: 0, boardId: BID, format: "ppr" }) })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({ status: 404, json: { error: "Board not found" } })
  );

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  await expect(page.getByTestId("board-load-note")).toBeVisible();
  await expect(page.getByTestId("board-active-note")).toHaveCount(0);
});

test("a board in a different format is flagged, naming both formats", async ({ page }) => {
  await seedBoard(page);
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: makeDraftState({ currentIndex: 0, boardId: BID, format: "standard" }) })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({ json: { boardId: BID, name: "My PPR Board", format: "ppr", rows: BOARD_ROWS } })
  );

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  const note = page.getByTestId("draft-board-format-note");
  await expect(note).toBeVisible();
  // Pin which format is attributed to which, not just that both words
  // appear: the board's format ("PPR") must follow "ranked for", and the
  // draft's format ("STANDARD") must follow "this draft is". This mirrors
  // Draft.jsx's actual template ("This board is ranked for
  // {boardMeta.format} — this draft is {draft.format}.") verbatim, so
  // swapping boardMeta.format and draft.format in that template would flip
  // the words and fail this assertion — a substring-only check on each word
  // independently would not have caught that.
  await expect(note).toContainText("This board is ranked for PPR — this draft is STANDARD.");
});

test("a matching format shows no mismatch note", async ({ page }) => {
  await seedBoard(page);
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: makeDraftState({ currentIndex: 0, boardId: BID, format: "ppr" }) })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({ json: { boardId: BID, name: "My PPR Board", format: "ppr", rows: BOARD_ROWS } })
  );

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByTestId("board-active-note")).toBeVisible();

  await expect(page.getByTestId("draft-board-format-note")).toHaveCount(0);
});

// `myRank` and the pool's consensus `rank` are ordinals over different
// populations -- a board only covers players ranked in ITS format. Rendered as
// bare numbers they can repeat on adjacent rows and read as one broken
// sequence, so each says which scale it is on.
test("board ranks and consensus ranks are told apart", async ({ page }) => {
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: { ...makeDraftState(), boardId: BID } })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({
      json: { boardId: BID, name: "My PPR Board", format: "ppr", rows: BOARD_ROWS, changelog: { added: 0, removed: 0 } },
    })
  );
  await seedBoard(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  const lamb = page.getByTestId("big-board-row").filter({ hasText: "CeeDee Lamb" });
  await expect(lamb.getByTestId("rank-mine")).toContainText("1");
  await expect(lamb.getByTestId("rank-consensus")).toHaveCount(0);

  // Justin Jefferson is not on the board, so his number is the consensus one.
  const jefferson = page.getByTestId("big-board-row").filter({ hasText: "Justin Jefferson" });
  await expect(jefferson.getByTestId("rank-consensus")).toBeVisible();
  await expect(jefferson.getByTestId("rank-mine")).toHaveCount(0);
});

// A board with no players on it silently produced consensus order with no
// note at all, so the user believed they were drafting off their board.
test("an empty board says so instead of silently using consensus order", async ({ page }) => {
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: { ...makeDraftState(), boardId: BID } })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({
      json: { boardId: BID, name: "My PPR Board", format: "ppr", rows: [], changelog: { added: 0, removed: 0 } },
    })
  );
  await seedBoard(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  const note = page.getByTestId("board-empty-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("My PPR Board");
  // And the "drafting off your board" note must NOT claim the board is in use.
  await expect(page.getByTestId("board-active-note")).toHaveCount(0);
});
