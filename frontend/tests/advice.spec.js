import { test, expect } from "@playwright/test";
import {
  MOCK_PLAYERS,
  DRAFT_ID,
  makeDraftState,
  makeCompletedDraft,
  pauseRoute,
} from "./fixtures.js";
import { signIn } from "./auth.js";

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
  // Pause is server state as of Task 8. Every test in this file clicks
  // Pause purely to disable manual picking while it inspects the advice
  // card/drill-down -- none of them care about pause itself -- but the
  // click now has to land somewhere real or the resulting "Failed to
  // fetch" banner (and the countdown ticking forever, since pausedAt never
  // moves) destabilizes the page layout underneath the very rows these
  // tests are about to click.
  page.route(`${API}/drafts/${DRAFT_ID}/pause`, pauseRoute(draftState));
}

function rowFor(page, name) {
  return page.getByTestId("big-board-row").filter({ hasText: name });
}

test("the recommendation card names a player and gives a reason", async ({ page }) => {
  mockPool(page, makeDraftState({ currentIndex: 0 }));

  await signIn(page);
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

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  // The engine puts the season in the reason text; the card must not strip
  // it. Without the year this reads as a forecast.
  await expect(page.getByTestId("advice-card")).toContainText(
    `300 carries and 80 targets in ${SEASON}.`
  );
});

test("opening a player reveals the reasons for him", async ({ page }) => {
  mockPool(page, makeDraftState({ currentIndex: 0 }));

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  await rowFor(page, "Justin Jefferson").getByTestId("open-player").click();

  const panel = page.getByTestId("player-modal");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Justin Jefferson");
  await expect(panel.getByTestId("advice-reason").first()).toBeVisible();

  // The panel is about the row you asked about, not about the suggestion.
  await expect(panel).not.toContainText("Christian McCaffrey");
  await expect(page.getByTestId("advice-card")).toContainText("Christian McCaffrey");
});

test("the drill-down explains a player who cannot be recommended", async ({ page }) => {
  mockPool(page, makeDraftState({ currentIndex: 0 }));

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  // Stefon Diggs is on IR in this pool: barred from the suggestion, but he
  // keeps his reasons, and the drawback is shown as a drawback.
  await expect(page.getByTestId("advice-card")).not.toContainText("Stefon Diggs");

  await rowFor(page, "Stefon Diggs").getByTestId("open-player").click();

  const panel = page.getByTestId("player-modal");
  await expect(panel).toContainText("On injured reserve.");
  await expect(panel).toContainText("-25");
});

test("opening a player drafts nobody", async ({ page }) => {
  mockPool(page, makeDraftState({ currentIndex: 0 }));

  let pickRequests = 0;
  await page.route(`${API}/drafts/${DRAFT_ID}/pick`, (r) => {
    pickRequests += 1;
    return r.fulfill({ json: { ok: true } });
  });

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  // Deliberately NOT paused: the rows are live, so every row opened below
  // sits beside a Draft button that WOULD have drafted somebody.

  for (const name of ["Christian McCaffrey", "Justin Jefferson", "Travis Kelce"]) {
    const row = rowFor(page, name);
    await expect(row.getByTestId("draft-player")).toBeEnabled();
    await row.getByTestId("open-player").click();
    await expect(page.getByTestId("player-modal")).toContainText(name);
    await page.getByTestId("player-modal-close").click();
    await expect(page.getByTestId("player-modal")).toHaveCount(0);
  }

  expect(pickRequests).toBe(0);

  // And the counter is not asleep: the Draft button on the same row still
  // sends exactly one pick.
  await rowFor(page, "Travis Kelce").getByTestId("draft-player").click();
  await expect(() => expect(pickRequests).toBe(1)).toPass();
});

test("the drill-down works when it is not your turn", async ({ page }) => {
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

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  // The page auto-picks for whoever is on the clock and the mock answers
  // with the same state every time, so it would loop. Pausing stops the
  // loop; the draft is still parked on Team 2's pick, which is the part
  // under test.
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("R1 P2 • Team 2")).toBeVisible();

  const row = rowFor(page, "Justin Jefferson");
  // Drafting is off — it is not your pick — but reading is not.
  await expect(row.getByTestId("draft-player")).toBeDisabled();
  await expect(row.getByTestId("open-player")).toBeEnabled();

  await row.getByTestId("open-player").click();
  await expect(page.getByTestId("player-modal")).toContainText("Justin Jefferson");

  expect(pickRequests).toBe(0);
});

test("no card when it is not your turn", async ({ page }) => {
  // Pick #2 belongs to Team 2 and the user is Team 1. The card weighs value
  // and scarcity against the USER's next pick, and its heading claims the
  // user is on the clock -- on somebody else's turn both are wrong, and the
  // app auto-picks the other eleven teams, so this is where you spend eleven
  // twelfths of the draft.
  mockPool(page, makeDraftState({ currentIndex: 1 }));
  await page.route(`${API}/drafts/${DRAFT_ID}/auto-pick`, (r) =>
    r.fulfill({ json: { ok: true } })
  );

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("R1 P2 • Team 2")).toBeVisible();

  await expect(page.getByTestId("advice-card")).toHaveCount(0);

  // But the board is still readable: reading about a player is not picking
  // one, so the why control keeps working here.
  await rowFor(page, "Justin Jefferson").getByTestId("open-player").click();
  await expect(page.getByTestId("player-modal")).toContainText("Justin Jefferson");
});

test("the card outlives the search and position filters", async ({ page }) => {
  mockPool(page, makeDraftState({ currentIndex: 0 }));

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  const card = page.getByTestId("advice-card");
  const search = page.getByPlaceholder("Search player…");
  await expect(card).toContainText("Christian McCaffrey");
  const restingY = (await search.boundingBox()).y;

  // Searching for somebody else does not delete the suggestion, and -- since
  // the card sits ABOVE the search box -- does not drag the box out from
  // under the caret either.
  await search.fill("Kelce");
  await expect(rowFor(page, "Travis Kelce")).toBeVisible();
  await expect(card).toContainText("Christian McCaffrey");
  expect((await search.boundingBox()).y).toBe(restingY);

  // Filtering to a position is how you ask "who should I take at RB?". The
  // answer must survive the question.
  await search.fill("");
  await page.getByTestId("position-filter").selectOption("RB");
  await expect(card).toContainText("Christian McCaffrey");
  await expect(card).toContainText("RB");
  expect((await search.boundingBox()).y).toBe(restingY);

  // Even filtered to a position he is not in, where the card is the only
  // thing on screen still naming him -- it says which position and team he
  // is, so it is not pointing at nothing.
  await page.getByTestId("position-filter").selectOption("QB");
  await expect(rowFor(page, "Christian McCaffrey")).toHaveCount(0);
  await expect(card).toContainText("Christian McCaffrey");
  expect((await search.boundingBox()).y).toBe(restingY);
});

test("a completed draft does not call unevaluated players neutral", async ({ page }) => {
  mockPool(page, makeCompletedDraft());

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);

  // Josh Allen went undrafted in this fixture, so his row is still there and
  // still clickable -- as ~3,700 rows are at the end of a real draft.
  await rowFor(page, "Josh Allen").getByTestId("open-player").click();

  const panel = page.getByTestId("player-modal");
  await expect(panel).toContainText("Josh Allen");
  // The engine never ran here. Saying nothing "moves him either way" would
  // report a verdict from an evaluation that never happened.
  await expect(panel).not.toContainText("moves him either way");
  await expect(panel).toContainText("nobody has been evaluated");
});

test("a completed draft recommends nobody", async ({ page }) => {
  mockPool(page, makeCompletedDraft());

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);

  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
  await expect(page.getByTestId("big-board-row").first()).toBeVisible();
  await expect(page.getByTestId("advice-card")).toHaveCount(0);
});

// The card gives up height before anything else in the panel, and the line
// naming WHO to draft is the one thing it exists to say. Measured boardless at
// 1280 and 1512 (identical geometry -- width does not enter into it): the inner
// scroll region falls to 13px at a 700px viewport and cuts that line through
// the glyphs, while the cue below still advertises "5 more reasons" nobody can
// reach. A board attached costs another ~40px, so a real user meets this about
// 40px earlier than these numbers do.
//
// Heights, not widths, and three of them: 660 and 700 are where the squeeze
// bites, 740 passes today and is here to catch a fix that trades the short
// viewports for the tall ones.
for (const vh of [660, 700, 740]) {
  test(`the suggested player's name survives a ${vh}px screen`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: vh });
    mockPool(page, makeDraftState({ currentIndex: 0 }));

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByTestId("advice-card")).toBeVisible();

    // Not toBeVisible(): Playwright calls a box visible when any part of it is,
    // and a name line cut through the middle is exactly that -- partly there.
    //
    // TWO clipping edges, and the tighter one governs. The card sets
    // overflow-hidden, but the name line sits inside advice-scroll, which sets
    // overflow-auto -- so the scroller clips it first. Measuring only the card
    // reports a 700px viewport as fine while the scroller, 8px of padding
    // higher, is cutting the name through the glyphs; "scrollable back into
    // view" is not the same as shown, and this line is the one thing the card
    // exists to say.
    const cut = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="advice-card"]');
      const scroll = document.querySelector('[data-testid="advice-scroll"]');
      const name = document.querySelector('[data-testid="advice-name"]');
      if (!card || !scroll || !name) return { missing: true };

      const clipBottom = (el) => {
        const r = el.getBoundingClientRect();
        const border = (r.height - el.clientHeight) / 2;
        return r.bottom - border;
      };

      const n = name.getBoundingClientRect();
      const edge = Math.min(clipBottom(card), clipBottom(scroll));
      return {
        missing: false,
        px: Math.max(0, Math.round(n.bottom - edge)),
        nameH: Math.round(n.height),
      };
    });

    expect(cut.missing, "advice card and name line both render").toBe(false);
    expect(cut.nameH, "the name line has real height").toBeGreaterThan(0);
    expect(cut.px, `the name line is cut off by ${cut.px}px at ${vh}px tall`).toBe(0);
  });
}
