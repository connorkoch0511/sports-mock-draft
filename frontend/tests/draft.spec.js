import { test, expect } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";
import { MOCK_PLAYERS, DRAFT_ID, INVITE_TOKEN, makeDraftState, mockDraftApis, pauseRoute } from "./fixtures.js";
import { signIn } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");

const API = "http://localhost:9999";

test.describe("Draft page", () => {
  test("renders Big Board, Draft Board, and Team Rosters panels", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Draft Board" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Team Rosters" })).toBeVisible();
  });

  // FIX 3: the button reads draft.inviteToken straight off state -- a fixture
  // that never set it (every mock then serving `undefined`) is exactly how
  // this went untested, and a dropped inviteToken field would otherwise ship
  // an invite link the server 404s on (`?t=undefined`) with every other test
  // here still green.
  test("the copy-invite button copies a link carrying the real invite token", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await page.getByTestId("copy-invite").click();

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`/draft/${DRAFT_ID}/join?t=${INVITE_TOKEN}`);
    expect(copied).not.toContain("undefined");
  });

  test("big board shows player names from API", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await expect(page.getByText("Christian McCaffrey").first()).toBeVisible();
    await expect(page.getByText("Justin Jefferson").first()).toBeVisible();
    await expect(page.getByText("CeeDee Lamb").first()).toBeVisible();
  });

  test("player search filters the board", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await signIn(page);
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

    await signIn(page);
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

    await signIn(page);
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

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    // Do NOT pause -- pause (now server-driven, Task 8) replaces the
    // countdown with a "Paused" pill, which is exactly what this test must
    // not see.

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

    await signIn(page);
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

    await signIn(page);
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

    await signIn(page);
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

    await signIn(page);
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

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await page.getByTestId("nav-toggle").click();
    await page.getByTestId("nav-menu").getByRole("link", { name: "Home" }).click();
    await expect(page).toHaveURL("/");
  });

  test("draft board table shows pick numbers and team assignments", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await signIn(page);
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
    // Pause is server state as of Task 8, and this screenshot's own title
    // promises "paused" -- the click below needs a real route to land on,
    // not just local state, for that to still be true of what ships.
    page.route(`${API}/drafts/${DRAFT_ID}/pause`, pauseRoute(state));

    // Signed in: the shipped screenshot shows the normal, capable session,
    // not the "sign in to make picks" banner a signed-out visitor would see.
    await signIn(page);
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

  test("the pool shows every source's ADP, and a dash where a source has none", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);
    // Registered last, so it wins over the fixture's own /players* route.
    await page.route("**/players*", (r) =>
      r.fulfill({ json: { players: [
        { id: "p1", name: "Ja'Marr Chase", position: "WR", team: "CIN", rank: 1, adp: 4.2, tier: 1, adpBySource: { espn: 4.2, yahoo: 3.5 } },
        { id: "p2", name: "Jaylen Waddle", position: "WR", team: "MIA", rank: 40, adp: 40.1, tier: 4, adpBySource: { espn: 28.4 } },
      ] } })
    );

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    const rows = page.getByTestId("adp-trio");
    await expect(rows.first()).toHaveText(/ours\s*4\.2.*esp\s*4\.2.*yah\s*3\.5/s);
    await expect(rows.nth(1)).toHaveText(/ours\s*40\.1.*esp\s*28\.4.*yah\s*—/s);
  });

  test("sorting by a source reorders the pool without changing the numbers", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);
    await page.route("**/players*", (r) =>
      r.fulfill({ json: { players: [
        { id: "p1", name: "Ja'Marr Chase", position: "WR", team: "CIN", rank: 1, adp: 4.2, tier: 1, adpBySource: { espn: 30.0 } },
        { id: "p2", name: "Jaylen Waddle", position: "WR", team: "MIA", rank: 40, adp: 40.1, tier: 4, adpBySource: { espn: 2.0 } },
      ] } })
    );

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    // Default is our rank, so Chase leads.
    await expect(page.getByTestId("adp-trio").first()).toHaveText(/ours\s*4\.2/);

    await page.getByTestId("adp-sort").selectOption("espn");

    // ESPN has Waddle far earlier, so he leads now -- and every number shown is
    // the same number as before. Only the order moved.
    await expect(page.getByTestId("adp-trio").first()).toHaveText(/ours\s*40\.1.*esp\s*2\.0/s);
    await expect(page.getByText("Jaylen Waddle").first()).toBeVisible();
  });

  test("a player with no number for the chosen source sorts last", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);
    await page.route("**/players*", (r) =>
      r.fulfill({ json: { players: [
        { id: "p1", name: "Has None", position: "WR", team: "CIN", rank: 1, adp: 4.2, tier: 1 },
        { id: "p2", name: "Has One", position: "WR", team: "MIA", rank: 40, adp: 40.1, tier: 4, adpBySource: { espn: 2.0 } },
      ] } })
    );

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();
    await page.getByTestId("adp-sort").selectOption("espn");

    // The one with no ESPN number is last, not first -- an absent number must
    // never sort as if it were zero.
    await expect(page.getByTestId("adp-trio").last()).toHaveText(/ours\s*4\.2.*esp\s*—/s);
  });

  // The per-row "adp-trio" title= is mouse-only and, in the Big Board, sits
  // nested inside an already-titled row button -- unreachable either way.
  // Deleting PLATFORM_WIDE_NOTE from BigBoardPanel.jsx must fail this test.
  test("the platform-wide ADP caveat is visible small print, not just a title attribute", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    const note = page.getByTestId("adp-source-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("whole platform");
  });

  test("the browser never picks for another human", async ({ page }) => {
    let autoPicks = 0;
    const state = makeDraftState({ currentIndex: 0 });
    state.yourTeam = 1;
    state.seats = [
      { team: 1, sub: "me", kind: "human" },
      { team: 2, sub: "them", kind: "human" },
    ];
    // Team 2 -- another human -- is on the clock.
    state.currentIndex = 1;
    mockDraftApis(page, state);
    await page.route("**/drafts/*/auto-pick", (r) => { autoPicks += 1; return r.fulfill({ json: { ok: true } }); });

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.waitForTimeout(2000);
    expect(autoPicks).toBe(0);
  });

  // The effect above only stops the browser from firing auto-pick on its
  // own. Critical 2 also found the manual Auto Pick button offering the
  // exact same click on somebody else's turn -- disabled only on
  // paused/busy/completed, nothing about whose turn it actually is.
  test("the Auto Pick button is disabled on another human's turn", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    state.yourTeam = 1;
    state.seats = [
      { team: 1, sub: "me", kind: "human" },
      { team: 2, sub: "them", kind: "human" },
    ];
    // Team 2 -- another human -- is on the clock.
    state.currentIndex = 1;
    mockDraftApis(page, state);
    await page.route("**/drafts/*/auto-pick", (r) => r.fulfill({ json: { ok: true } }));

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);

    await expect(page.getByRole("button", { name: "Auto Pick" })).toBeDisabled();
  });

  test("a bot seat still advances immediately", async ({ page }) => {
    let autoPicks = 0;
    const state = makeDraftState({ currentIndex: 0 });
    state.yourTeam = 1;
    state.seats = [
      { team: 1, sub: "me", kind: "human" },
      { team: 2, sub: null, kind: "bot" },
    ];
    state.currentIndex = 1;
    mockDraftApis(page, state);
    await page.route("**/drafts/*/auto-pick", (r) => { autoPicks += 1; return r.fulfill({ json: { ok: true } }); });

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect.poll(() => autoPicks).toBeGreaterThan(0);
  });

  // Unlike the test above, this one sets no `seats` at all -- it is exactly
  // what a real solo draft's GET /drafts/{draftId} returns today: one human
  // seat (the creator, team 1) and a bot in every other team, straight from
  // makeDraftState's own default. Critical 1 was the real endpoint never
  // sending `seats` in the first place, which the test above could not have
  // caught -- it supplies `seats` by hand, so it would have stayed green
  // even while production sent none. This one fails exactly the way a solo
  // draft did in production: revert makeDraftState's default `seats` (or the
  // mock's projection of it) and team 2 no longer reads as a bot here.
  test("a solo draft's bot seat still auto-advances, with the response shape the real API returns", async ({ page }) => {
    let autoPicks = 0;
    const state = makeDraftState({ currentIndex: 1 }); // team 2, a bot, on the clock
    mockDraftApis(page, state);
    await page.route("**/drafts/*/auto-pick", (r) => { autoPicks += 1; return r.fulfill({ json: { ok: true } }); });

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect.poll(() => autoPicks).toBeGreaterThan(0);
  });

  // Important 3: a failed auto-pick must not leave the browser deciding
  // against stale data. Team 2 (a bot) is on the clock when the page loads,
  // so the effect fires immediately -- but by the time the request lands,
  // the server says otherwise (Critical 2's own guard refusing it, in a real
  // race). Without a reload afterward, the page would keep re-firing the
  // identical request against the same stale `draft` object forever, since
  // nothing ever told it the clock had moved on.
  test("a failed auto-pick reloads the draft instead of retrying against stale data", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 1 }); // team 2, a bot, on the clock
    let autoPickCalls = 0;

    await page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: MOCK_PLAYERS } }));
    await page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: state }));
    await page.route(`${API}/drafts/${DRAFT_ID}/auto-pick`, (r) => {
      autoPickCalls += 1;
      if (autoPickCalls === 1) {
        // The clock moved on between this browser's stale read and the
        // request landing: team 1 -- a human -- is on the clock now, and the
        // server (correctly) refuses.
        state.currentIndex = 0;
        return r.fulfill({ status: 409, json: { error: "Not your pick" } });
      }
      return r.fulfill({ json: { ok: true } });
    });

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);

    await expect.poll(() => autoPickCalls).toBeGreaterThan(0);
    // Give the effect every chance to re-fire against stale data before
    // deciding it didn't: team 1 is a human now, so a reload that saw that
    // must have stopped it, same as if the page had never been stale.
    await page.waitForTimeout(1500);
    expect(autoPickCalls).toBe(1);
  });

  // Phase 1 disabled the countdown entirely once a second human was seated.
  // Phase 2 moves the clock to the server, so a shared draft runs one same
  // as a solo one -- this pins that the regression (no clock at all in a
  // shared draft) stays fixed. See also "the countdown runs in a shared
  // draft" below, which covers a full 12-team table.
  test("a shared draft still shows the countdown on the user's own turn", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0, pickDeadline: Date.now() + 25000 }); // team 1 (me) on the clock
    state.yourTeam = 1;
    state.seats = [
      { team: 1, sub: "me", kind: "human" },
      { team: 2, sub: "them", kind: "human" },
    ];
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("pick-countdown")).toContainText(/2[0-5]/);
  });

  // Pins the exact copy: "Auto-picking other teams…" is false the moment a
  // second human is seated, since the team being waited on is a person, not
  // a bot. Nothing else in this file asserts this text, so a careless
  // revert back to the old copy would otherwise pass every other test here.
  test("the shared-draft status names whose pick it is, not bots, on somebody else's turn", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 }); // team 1 (me) on the clock
    state.yourTeam = 1;
    state.seats = [
      { team: 1, sub: "me", kind: "human" },
      { team: 2, sub: "them", kind: "human" },
    ];
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);

    // My own turn: the countdown, not a status pill -- see the test above.
    await expect(page.getByTestId("pick-countdown")).toBeVisible();
    await expect(page.getByText(/Auto-picking/i)).toHaveCount(0);

    // Somebody else's pick, in the same shared draft.
    state.currentIndex = 1; // team 2's turn
    await page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: state }));
    await page.reload();

    await expect(page.getByTestId("status-pill")).toHaveText("Waiting on Team 2");
    await expect(page.getByText(/Auto-picking/i)).toHaveCount(0);
  });

  test("the countdown runs in a shared draft", async ({ page }) => {
    // Phase 1 disabled the clock entirely whenever a second human was seated.
    // The regression this guards is that guard coming back.
    const seats = Array.from({ length: 12 }, (_, i) => {
      const team = i + 1;
      if (team === 1) return { team, sub: "me", kind: "human" };
      if (team === 2) return { team, sub: "them", kind: "human" };
      return { team, sub: null, kind: "bot" };
    });
    const state = makeDraftState({ seats, pickDeadline: Date.now() + 25000 });
    mockDraftApis(page, state);

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("pick-countdown")).toContainText(/2[0-5]/);
  });

  test("reaching zero asks the server to expire the clock, and does not auto-pick", async ({ page }) => {
    const state = makeDraftState({ pickDeadline: Date.now() - 1000 });
    mockDraftApis(page, state);

    let expires = 0;
    let autoPicks = 0;
    await page.route(`${API}/drafts/${DRAFT_ID}/expire`, (r) => {
      expires += 1;
      return r.fulfill({ status: 409, json: { error: "Clock has not expired" } });
    });
    await page.route(`${API}/drafts/${DRAFT_ID}/auto-pick`, (r) => {
      autoPicks += 1;
      return r.fulfill({ json: { ok: true } });
    });

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect.poll(() => expires).toBeGreaterThan(0);
    expect(autoPicks).toBe(0);
  });

  // Regression test for a render race the implementer found and fixed: the
  // expire effect originally scheduled off the polled `secondsLeft` display
  // state, which is still its stale initial value (0) in the very commit
  // where `draft` first resolves from null -- both effects run in that same
  // commit, so the expire effect saw 0 and fired /expire immediately, against
  // a deadline a full minute away. This reproduced on essentially every draft
  // load. A future deadline is what discriminates the fix from the bug: the
  // buggy version fires the spurious call on mount regardless of the
  // deadline, so it must stay non-zero here through several 3-second
  // background polls, not just through the first tick.
  test("a comfortably future deadline never calls /expire, across several background polls", async ({ page }) => {
    const state = makeDraftState({ pickDeadline: Date.now() + 60000 });
    mockDraftApis(page, state);

    let expires = 0;
    // Registered after mockDraftApis, so it wins over the fixture's own
    // always-409 /expire route -- this test needs to COUNT calls, not just
    // let them 409 silently.
    await page.route(`${API}/drafts/${DRAFT_ID}/expire`, (r) => {
      expires += 1;
      return r.fulfill({ status: 409, json: { error: "Clock has not expired" } });
    });

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("pick-countdown")).toBeVisible();

    // Long enough for the page to settle after mount (where the race fired)
    // and for several of the 3-second background polls to land.
    await page.waitForTimeout(10000);
    expect(expires).toBe(0);
  });

  test("a draft with no stored deadline still renders, and asks nothing of the server", async ({ page }) => {
    // Rows created before this shipped carry no pickDeadline.
    const state = makeDraftState({ pickDeadline: null });
    mockDraftApis(page, state);
    let expires = 0;
    await page.route(`${API}/drafts/${DRAFT_ID}/expire`, (r) => {
      expires += 1;
      return r.fulfill({ status: 409, json: {} });
    });

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("big-board-row").first()).toBeVisible();
    expect(expires).toBe(0);
  });

  // Task 8: pause is the draft's state, not this browser's. Before this
  // change, clicking Pause only flipped local React state -- it never told
  // the server, so it neither froze the countdown for anyone else nor
  // stopped THIS browser's own expire effect once the deadline it's still
  // watching passed.
  test("pausing posts to the server rather than stopping one browser", async ({ page }) => {
    const state = makeDraftState({});
    mockDraftApis(page, state);
    let posted = null;
    await page.route(`${API}/drafts/${DRAFT_ID}/pause`, async (r) => {
      posted = JSON.parse(r.request().postData() || "{}");
      state.pausedAt = Date.now();
      state.pausedBy = "me";
      return r.fulfill({ json: { ok: true, pausedAt: state.pausedAt, pausedBy: state.pausedBy, pickDeadline: state.pickDeadline } });
    });

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect.poll(() => posted?.paused).toBe(true);
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  });

  test("a draft somebody else paused shows as paused here", async ({ page }) => {
    const state = makeDraftState({ pausedAt: Date.now(), pausedBy: "them" });
    mockDraftApis(page, state);

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(page.getByTestId("pick-countdown")).toHaveCount(0);
  });

  // pausedByOther is only ever true when pausedBy names somebody who isn't
  // you -- pausing your OWN draft must never render the "somebody else"
  // note. pauseRoute's default `by` ("user-me") matches signIn()'s default
  // sub, so this is a genuine self-pause through the real POST /pause path,
  // not a fixture that happens to dodge the comparison.
  test("pausing your own draft does not say someone else paused it", async ({ page }) => {
    const state = makeDraftState({});
    mockDraftApis(page, state);

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();

    await expect(page.getByTestId("paused-by")).toHaveCount(0);
  });

  // The other half of pausedByOther: pausedBy naming a DIFFERENT sub than
  // the signed-in one must render the note. Falsifiable against the
  // production logic -- inverting pausedByOther's `!==` to `===` turns this
  // red (see task-8-report.md for the recorded RED run).
  test("a draft paused by someone else names it as paused by someone else", async ({ page }) => {
    const state = makeDraftState({ pausedAt: Date.now(), pausedBy: "them" });
    mockDraftApis(page, state);

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);

    await expect(page.getByTestId("paused-by")).toBeVisible();
    await expect(page.getByTestId("paused-by")).toHaveText("Paused by someone else");
  });

  // Proves the hole Task 7 left open is actually closed: a deadline that
  // passes WHILE PAUSED must never reach /expire. Before this task's fix,
  // clicking Pause never reached the server at all, so the browser's own
  // expire effect kept watching the real (server) deadline and fired right
  // on schedule regardless of what the button said.
  test("a deadline that passes while paused never calls /expire", async ({ page }) => {
    const state = makeDraftState({ pickDeadline: Date.now() + 1500 });
    mockDraftApis(page, state);

    let expires = 0;
    await page.route(`${API}/drafts/${DRAFT_ID}/expire`, (r) => {
      expires += 1;
      return r.fulfill({ status: 409, json: { error: "Clock has not expired" } });
    });

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();

    // The original deadline (1.5s out) is long past by the time this
    // resolves; a still-broken Pause would have already fired /expire.
    await page.waitForTimeout(3000);
    expect(expires).toBe(0);
  });

  test("Sim to End is not offered once somebody else is in the draft", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    state.yourTeam = 1;
    state.seats = [
      { team: 1, sub: "me", kind: "human" },
      { team: 2, sub: "them", kind: "human" },
    ];
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sim to End" })).toHaveCount(0);
  });

  test("opening an invite link seats you and opens the draft", async ({ page }) => {
    let joinedWith = null;
    await page.route("**/drafts/*/join", (r) => {
      joinedWith = r.request().postDataJSON().token;
      return r.fulfill({ json: { ok: true, team: 2 } });
    });
    const state = makeDraftState({ currentIndex: 0 });
    state.yourTeam = 2;
    mockDraftApis(page, state);

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}/join?t=abc123`);

    await expect(page).toHaveURL(new RegExp(`/draft/${DRAFT_ID}$`));
    expect(joinedWith).toBe("abc123");
  });

  test("a picked player appears without touching anything", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    state.yourTeam = 1;
    state.version = 1;
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    // Somebody else picks: the next poll should bring it in.
    const moved = { ...state, version: 2, currentIndex: 1 };
    await page.route(`**/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: moved }));

    await expect.poll(async () => (await page.getByTestId("current-pick").textContent()) || "",
      { timeout: 10000 }).toContain("2");
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
// isMyTurn && !needsSignIn`, so pausing disables the Draft button for your
// own turn too. All three sign in first -- since ownership landed, a
// signed-out caller can never reach "enabled" here, which used to be true.

test("the row's Draft button drafts that player", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0 });
  page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: MOCK_PLAYERS } }));
  page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: state }));

  let picked = null;
  page.route(`${API}/drafts/${DRAFT_ID}/pick`, (r) => {
    picked = JSON.parse(r.request().postData() || "{}").playerId;
    return r.fulfill({ json: { ok: true } });
  });

  await signIn(page);
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
  // Pause is server state as of Task 8 -- the click below now has to reach
  // an actual route rather than only flipping local state, so this test
  // (unlike most of its neighbors) needs its own /pause handler instead of
  // borrowing mockDraftApis's.
  page.route(`${API}/drafts/${DRAFT_ID}/pause`, pauseRoute(state));

  let calls = 0;
  page.route(`${API}/drafts/${DRAFT_ID}/pick`, (r) => {
    calls += 1;
    return r.fulfill({ json: { ok: true } });
  });

  await signIn(page);
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

  await signIn(page);
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

test("a joiner sees their own team as theirs, not the creator's", async ({ page }) => {
  // currentIndex: 4 puts team 5 -- nobody's turn but team 5's -- on the
  // clock. Neither yourTeam (2) nor userTeam (the creator's, 1) is on the
  // clock, so "my-team" showing 2 can only be "this is your seat", never
  // "this is who's up" -- a fixture where the two happened to coincide could
  // pass this test even if the page fell back to rendering whichever team is
  // on the clock instead of yourTeam.
  const state = makeDraftState({ currentIndex: 4 });
  // The creator made it and sits in team 1; we are the person who joined and
  // claimed team 2's seat. Team 5 -- on the clock here -- is still a bot,
  // same as any real two-human draft with ten seats left unclaimed.
  state.userTeam = 1;
  state.yourTeam = 2;
  state.seats = [
    { team: 1, sub: "alice", kind: "human" },
    { team: 2, sub: "me", kind: "human" },
    ...state.seats.slice(2),
  ];
  mockDraftApis(page, state);
  // Team 5 is a bot per the seats above, so onClockIsBot fires the moment the
  // page loads -- mocked here so that firing is harmless instead of hanging
  // the test on a real network call.
  await page.route("**/drafts/*/auto-pick", (r) => r.fulfill({ json: { ok: true } }));

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  await expect(page.getByTestId("my-team")).toContainText("2");
});
