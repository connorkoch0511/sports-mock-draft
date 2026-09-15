import { test, expect } from "@playwright/test";
import { DRAFT_ID, MOCK_PLAYERS, makeDraftState, mockDraftApis } from "./fixtures.js";
import { signIn } from "./auth.js";

const API = "http://localhost:9999";

// The suite's default project is wide enough (>=1280px) to sit at `xl`,
// where the queue is the fourth grid column rather than a fourth tab -- so
// every test below finds panel-queue directly, the same way the existing
// suite finds panel-rosters without touching a tab.

test("adding from a Big Board row appends to the queue and posts the whole array", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0, yourQueue: ["p1"] });
  mockDraftApis(page, state);
  let posted = null;
  // Registered after mockDraftApis's own queue route -- Playwright matches
  // the most-recently-added handler first -- so this one wins and can watch
  // what actually got sent, the way draft.spec.js's seat-board test does.
  await page.route(`${API}/drafts/${DRAFT_ID}/queue`, async (r) => {
    posted = JSON.parse(r.request().postData() || "{}");
    state.yourQueue = posted.queue;
    await r.fulfill({ json: { ok: true, queue: state.yourQueue } });
  });

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByTestId("panel-queue")).toBeVisible();

  const row = page.getByTestId("big-board-row").filter({ hasText: "Justin Jefferson" });
  await row.getByTestId("queue-add").click();

  // The whole array, p1 already queued plus p2 appended at the end -- not a
  // delta, not p2 alone. The server replaces wholesale; a partial payload
  // here would silently drop p1 the moment this landed.
  await expect.poll(() => posted?.queue).toEqual(["p1", "p2"]);

  const queuePanel = page.getByTestId("panel-queue");
  await expect(queuePanel.getByTestId("queue-row").last()).toContainText("Justin Jefferson");
});

test("removing a row takes him out and posts the remainder", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0, yourQueue: ["p1", "p2", "p3"] });
  mockDraftApis(page, state);
  let posted = null;
  await page.route(`${API}/drafts/${DRAFT_ID}/queue`, async (r) => {
    posted = JSON.parse(r.request().postData() || "{}");
    state.yourQueue = posted.queue;
    await r.fulfill({ json: { ok: true, queue: state.yourQueue } });
  });

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);

  const queuePanel = page.getByTestId("panel-queue");
  await expect(queuePanel.getByTestId("queue-row")).toHaveCount(3);

  const middle = queuePanel.getByTestId("queue-row").filter({ hasText: "Justin Jefferson" });
  await middle.getByTestId("queue-remove").click();

  // p1 and p3 survive, in order, with p2 gone -- not just "count dropped by
  // one", which a bug that removed the wrong entry would also satisfy.
  await expect.poll(() => posted?.queue).toEqual(["p1", "p3"]);
  await expect(queuePanel.getByTestId("queue-row")).toHaveCount(2);
});

// The decision the whole panel is built around: taken players are filtered
// on READ, never pruned by writing. Somebody else's pick landing must not
// touch this seat's stored queue at all -- proven here by counting POSTs to
// /queue across the pick, not merely by checking the row disappeared.
test("a player drafted by someone else disappears from the queue with no write", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0, yourQueue: ["p2", "p3"] });
  mockDraftApis(page, state);
  let queuePosts = 0;
  await page.route(`${API}/drafts/${DRAFT_ID}/queue`, async (r) => {
    queuePosts++;
    await r.fulfill({ json: { ok: true, queue: state.yourQueue } });
  });

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);

  const queuePanel = page.getByTestId("panel-queue");
  await expect(queuePanel.getByTestId("queue-row")).toHaveCount(2);
  await expect(queuePanel.getByText("Justin Jefferson")).toBeVisible();

  // Team 2 (a bot, per the default seats) drafts p2 -- the same way
  // draftphone.spec.js's "turn changing" test advances the draft under the
  // page: mutate what the next poll will serve, then wait past the 3s tick.
  // The page's poll only applies a response whose `version` has actually
  // moved (see refresh() in Draft.jsx) -- a real pick always bumps it, so
  // the fixture has to as well or this update is silently ignored, same as
  // the real page would ignore a stale poll response.
  state.picked = [...state.picked, "p2"];
  state.picks[0].playerId = "p2";
  state.picks[0].player = MOCK_PLAYERS.find((p) => p.id === "p2");
  state.currentIndex = 1;
  state.version = 2;

  await page.waitForTimeout(4000);

  await expect(queuePanel.getByText("Justin Jefferson")).toHaveCount(0);
  await expect(queuePanel.getByTestId("queue-row")).toHaveCount(1);
  await expect(queuePanel.getByText("CeeDee Lamb")).toBeVisible();

  // The absence of a write is the half that matters -- not one write, not a
  // write that happened to carry the same array, none at all.
  expect(queuePosts).toBe(0);
});

test("an empty queue renders its explanatory text, not a blank box", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0, yourQueue: [] });
  mockDraftApis(page, state);
  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);

  const queuePanel = page.getByTestId("panel-queue");
  await expect(queuePanel).toBeVisible();
  await expect(queuePanel.getByTestId("queue-empty")).toBeVisible();
  await expect(queuePanel.getByTestId("queue-row")).toHaveCount(0);
});

// The order IS the feature here -- it is what the expired clock drafts from
// -- so dragging is the one mutation in this panel that has to be proven
// against a real gesture, not just a click. `dragRow` mirrors board.spec.js's
// own helper: mouse down on the row body, move past a sibling, mouse up.
async function dragRow(page, locator, dy) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
}

test("dragging a queue row with the mouse reorders it and posts the whole array", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0, yourQueue: ["p1", "p2", "p3"] });
  mockDraftApis(page, state);
  let posted = null;
  await page.route(`${API}/drafts/${DRAFT_ID}/queue`, async (r) => {
    posted = JSON.parse(r.request().postData() || "{}");
    state.yourQueue = posted.queue;
    await r.fulfill({ json: { ok: true, queue: state.yourQueue } });
  });

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);

  const queuePanel = page.getByTestId("panel-queue");
  const rows = queuePanel.getByTestId("queue-row");
  await expect(rows).toHaveCount(3);
  const before = await rows.first().getAttribute("data-player-id");

  // A drop is one write, not a stream of them -- so this waits for the whole
  // gesture to land, then checks the single POST it produced.
  await dragRow(page, rows.first(), 140);

  await expect.poll(async () => rows.first().getAttribute("data-player-id")).not.toBe(before);
  // p1 dragged past p2 and p3 lands last, not merely "not first" -- a bug
  // that swapped it one slot instead of the full distance dragged would
  // satisfy a weaker assertion.
  await expect.poll(() => posted?.queue).toEqual(["p2", "p3", "p1"]);
});

// The constraint the whole panel is built around, proven at the one moment
// it could silently break: a drafted player is invisible here (filtered on
// read, see the top of this file) but must not be filtered OUT of what gets
// written. His stored slot has to survive a drag that never touched him.
test("a drop preserves an already-drafted player's stored position", async ({ page }) => {
  const state = makeDraftState({
    currentIndex: 1,
    completedPicks: [{ idx: 0, player: MOCK_PLAYERS.find((p) => p.id === "p2") }],
    yourQueue: ["p1", "p2", "p3"],
  });
  mockDraftApis(page, state);
  let posted = null;
  await page.route(`${API}/drafts/${DRAFT_ID}/queue`, async (r) => {
    posted = JSON.parse(r.request().postData() || "{}");
    state.yourQueue = posted.queue;
    await r.fulfill({ json: { ok: true, queue: state.yourQueue } });
  });

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);

  const queuePanel = page.getByTestId("panel-queue");
  const rows = queuePanel.getByTestId("queue-row");
  // p2 was drafted, so only p1 and p3 are visible to drag.
  await expect(rows).toHaveCount(2);

  await dragRow(page, rows.first(), 140);

  // p2 is still at index 1, exactly where it lived in storage before this
  // drag -- not dropped, not moved to the end, not duplicated.
  await expect.poll(() => posted?.queue).toEqual(["p3", "p2", "p1"]);
});

// A finger has only one gesture for "move the list" and "move this row", so
// the sensor tells them apart by time, not distance. These two are a pair on
// purpose, copying board.spec.js's own approach: Playwright has no swipe, and
// a synthetic PointerEvent never reaches a TouchSensor (it listens for
// touchstart), so CDP dispatches genuine touch events -- which is also what
// makes the browser's own scrolling happen, so the scroll assertion below
// means something. Chromium-only, which is the only project this suite runs.
test.describe("reordering the queue with a finger", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  async function fingerDrag(page, locator, { dy, holdMs }) {
    const box = await locator.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    if (holdMs) await page.waitForTimeout(holdMs);
    for (let i = 1; i <= 10; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + (dy * i) / 10 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  }

  const orderOf = (page) =>
    page.locator('[data-testid="queue-row"]').evaluateAll((els) => els.map((e) => e.dataset.playerId));

  // Below `lg` the queue is a tab, not a column -- open it the same way a
  // person on a phone would before either test touches a row.
  async function openQueueTab(page, ids) {
    const state = makeDraftState({ currentIndex: 0, yourQueue: ids });
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByTestId("tab-queue").click();
    await expect(page.getByTestId("queue-row").first()).toBeVisible();
    return state;
  }

  test("holding a queued row and then dragging reorders it", async ({ page }) => {
    // Long enough that a real fingertip's scroll would show something on
    // a 844px-tall screen -- not load-bearing for this test, but it keeps
    // the fixture identical to the swipe test beside it.
    const ids = MOCK_PLAYERS.slice(0, 15).map((p) => p.id);
    await openQueueTab(page, ids);

    const before = await orderOf(page);
    // Every row has to be identifiable by its own id for `moved` below to
    // mean anything -- without this, a row missing `data-player-id`
    // (undefined for all 15) would let the poll below pass on an accident
    // of `indexOf(undefined)` rather than on an actual reorder.
    expect(before.filter(Boolean)).toHaveLength(15);
    const moved = before[2];

    // Longer than the 250ms activation delay, so the drag is armed before
    // the finger moves at all.
    await fingerDrag(page, page.getByTestId("queue-row").nth(2), { dy: -120, holdMs: 400 });

    // Direction matters: "the order changed" would also accept a drag that
    // went the wrong way.
    await expect.poll(async () => (await orderOf(page)).indexOf(moved)).toBeLessThan(2);
  });

  test("swiping the queue list scrolls it and reorders nothing", async ({ page }) => {
    const ids = MOCK_PLAYERS.slice(0, 15).map((p) => p.id);
    await openQueueTab(page, ids);
    const before = await orderOf(page);

    await fingerDrag(page, page.getByTestId("queue-row").nth(2), { dy: -200, holdMs: 0 });

    expect(await orderOf(page)).toEqual(before);
    // "reorders nothing" is only half the claim -- a change that also
    // stopped the list scrolling would pass without this.
    const scrolled = await page.evaluate(
      () => document.querySelector('[data-testid="scroll-queue"]')?.scrollTop ?? 0
    );
    expect(scrolled).toBeGreaterThan(0);
  });
});
