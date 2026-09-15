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
