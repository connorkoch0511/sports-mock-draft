import { test, expect } from "@playwright/test";
import { BOARD_ID, makeBoardState } from "./fixtures.js";
import { signIn } from "./auth.js";
import { fileURLToPath } from "url";
import path from "path";
// eslint's config grants Node globals to playwright.config.js and scripts/**
// but not tests/**, so the Node global Buffer used below by the import tests
// needs an explicit import rather than tripping no-undef.
import { Buffer } from "node:buffer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");
const API = "http://localhost:9999";


async function mockBoard(page, state, { onSave } = {}) {
  await page.route(`**/boards/${BOARD_ID}`, async (route) => {
    if (route.request().method() === "PUT") {
      const body = JSON.parse(route.request().postData() || "{}");
      onSave?.(body);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, version: body.version + 1 }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(state),
    });
  });
}

// Reported from the deployed app as "I can't drag the names around". The drag
// worked -- but only from the dim six-dot grip, while the name beside it was a
// button that opened the player. These three pin the fix and the thing the fix
// could plausibly break.
async function dragRow(page, locator, dy) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
}

test("dragging the row body reorders the board", async ({ page }) => {
  let saved = null;
  await mockBoard(page, makeBoardState(), { onSave: (body) => { saved = body; } });
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  const rows = page.getByTestId("board-row");
  const before = await rows.first().getAttribute("data-player-id");
  // The rank number: not the grip, not the name -- ordinary row surface, which
  // is the whole point of the change.
  await dragRow(page, rows.first().locator("span").first(), 140);

  await expect.poll(async () => rows.first().getAttribute("data-player-id")).not.toBe(before);
  await expect.poll(() => saved).not.toBeNull();
});

// The deliberate exception. Everything else on the row drags; the name does
// not, so opening a player never competes with a drag on the same pixel.
test("the name is not a drag handle", async ({ page }) => {
  await mockBoard(page, makeBoardState());
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  const rows = page.getByTestId("board-row");
  const before = await rows.first().getAttribute("data-player-id");
  await dragRow(page, rows.first().getByTestId("open-player"), 140);

  expect(await rows.first().getAttribute("data-player-id")).toBe(before);
});

test("dragging by the grip still reorders", async ({ page }) => {
  await mockBoard(page, makeBoardState());
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  const rows = page.getByTestId("board-row");
  const before = await rows.first().getAttribute("data-player-id");
  await dragRow(page, rows.first().getByRole("button", { name: /^Reorder/ }), 140);

  await expect.poll(async () => rows.first().getAttribute("data-player-id")).not.toBe(before);
});

// The risk the row-wide drag introduces: a press on the name that does not
// move must still be a click, not a swallowed drag.
test("clicking the name still opens the player, and reorders nothing", async ({ page }) => {
  await mockBoard(page, makeBoardState());
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  const rows = page.getByTestId("board-row");
  const before = await rows.first().getAttribute("data-player-id");
  await rows.first().getByTestId("open-player").click();

  await expect(page.getByTestId("player-modal")).toBeVisible();
  expect(await rows.first().getAttribute("data-player-id")).toBe(before);
});

test("renaming the board saves the new name", async ({ page }) => {
  let saved = null;
  await mockBoard(page, makeBoardState(), { onSave: (body) => { saved = body; } });
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  await page.getByTestId("board-title").fill("Sleepers and busts");
  await page.getByTestId("board-title").press("Enter");

  await expect.poll(() => saved).not.toBeNull();
  expect(saved.name).toBe("Sleepers and busts");
  // A rename must not resend the order -- the whole point of making it
  // optional on the API is that renaming cannot disturb the ranking.
  expect(saved.order).toBeUndefined();
});

test("escape abandons a rename in progress", async ({ page }) => {
  let saved = null;
  await mockBoard(page, makeBoardState(), { onSave: (body) => { saved = body; } });
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  const title = page.getByTestId("board-title");
  const original = await title.inputValue();
  await title.fill("half-typed thing");
  await title.press("Escape");

  await expect(title).toHaveValue(original);
  expect(saved).toBeNull();
});

test("renaming to the same name saves nothing", async ({ page }) => {
  let saved = null;
  await mockBoard(page, makeBoardState(), { onSave: (body) => { saved = body; } });
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  const title = page.getByTestId("board-title");
  await title.click();
  await title.press("Enter");

  await page.waitForTimeout(300);
  expect(saved).toBeNull();
});

test("renders the board in saved order", async ({ page }) => {
  await mockBoard(page, makeBoardState());
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  const rows = page.getByTestId("board-row");
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toContainText("Christian McCaffrey");
});

test("shows the changelog when the pool has changed", async ({ page }) => {
  await mockBoard(page, makeBoardState({ added: 3, removed: 1 }));
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  await expect(page.getByTestId("changelog")).toContainText("3 added, 1 removed");
});

test("hides the changelog when nothing changed", async ({ page }) => {
  await mockBoard(page, makeBoardState());
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  await expect(page.getByTestId("changelog")).toHaveCount(0);
});

test("keyboard reorder saves the new order", async ({ page }) => {
  let saved = null;
  await mockBoard(page, makeBoardState(), { onSave: (body) => { saved = body; } });
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  await page.getByRole("button", { name: "Reorder Christian McCaffrey" }).focus();
  // dnd-kit's keyboard sensor needs a beat between events to register the
  // pickup / move / drop as distinct steps — back-to-back synchronous
  // key presses land before the sensor's internal state updates and the
  // drag never activates. See task-12-report.md for the debugging trail.
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");

  await expect(page.getByTestId("save-status")).toContainText("Saved", { timeout: 5000 });
  expect(saved.order[0]).toBe("p2");
  expect(saved.order[1]).toBe("p1");
});

// Boards.jsx used to read this list from localStorage, seeded here directly
// and reloaded. It now reads GET /me/boards from the server, and reloads
// that same endpoint after a delete -- so the mock below tracks `deleted`
// and answers accordingly, the way the real API would.
test("deleting a board removes it from the list", async ({ page }) => {
  let deleted = false;
  await signIn(page);
  await page.route("**/me/boards", (route) =>
    route.fulfill({
      json: { boards: deleted ? [] : [{ id: BOARD_ID, name: "My PPR Board", format: "ppr", season: 2026, updatedAt: Date.now() }] },
    })
  );
  await page.route(`**/boards/${BOARD_ID}`, async (route) => {
    if (route.request().method() === "DELETE") {
      deleted = true;
      return route.fulfill({
        status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }),
      });
    }
    return route.fallback();
  });

  await page.goto("/boards");
  await expect(page.getByTestId("board-list")).toContainText("My PPR Board");
  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete My PPR Board" }).click();

  await expect(page.getByTestId("board-list")).toHaveCount(0);
  expect(deleted).toBe(true);
});

test("surfaces a conflict when the board changed elsewhere", async ({ page }) => {
  await page.route(`**/boards/${BOARD_ID}`, async (route) => {
    if (route.request().method() === "PUT") {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Board changed since you loaded it", currentVersion: 7 }),
      });
    }
    // No artificial delay here: Board.jsx's conflict handler must keep the
    // "changed elsewhere" notice on screen through the reload it triggers,
    // even when the reload's GET resolves near-instantly.
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeBoardState()),
    });
  });
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  await page.getByRole("button", { name: "Reorder Christian McCaffrey" }).focus();
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");

  await expect(page.getByText("changed elsewhere")).toBeVisible({ timeout: 5000 });
});

test("a successful save clears a stale conflict notice", async ({ page }) => {
  let putCount = 0;
  await page.route(`**/boards/${BOARD_ID}`, async (route) => {
    if (route.request().method() === "PUT") {
      putCount += 1;
      if (putCount === 1) {
        // First save 409s, same as the conflict test above.
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "Board changed since you loaded it", currentVersion: 7 }),
        });
      }
      // Second save succeeds.
      const body = JSON.parse(route.request().postData() || "{}");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, version: body.version + 1 }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeBoardState()),
    });
  });
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  // First reorder: save 409s, "changed elsewhere" notice appears and the
  // board reloads (back to its original order).
  await page.getByRole("button", { name: "Reorder Christian McCaffrey" }).focus();
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");

  await expect(page.getByText("changed elsewhere")).toBeVisible({ timeout: 5000 });

  // Second reorder: save succeeds. The stale notice must be retired, not
  // left on screen alongside "Saved".
  await page.getByRole("button", { name: "Reorder Christian McCaffrey" }).focus();
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");

  await expect(page.getByTestId("save-status")).toContainText("Saved", { timeout: 5000 });
  await expect(page.getByText("changed elsewhere")).toHaveCount(0);
});

test("screenshot — board editor", async ({ page }) => {
  // The shell is h-dvh and the routes wrapper scrolls, so the document is
  // always viewport height and fullPage captures nothing extra. Grow the
  // viewport instead.
  await page.setViewportSize({ width: 1280, height: 920 });
  await mockBoard(page, makeBoardState());
  // Signed in: the shipped screenshot shows the normal, capable session, not
  // the "sign in to reorder" banner a signed-out visitor would see.
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);
  await expect(page.getByTestId("board-row").first()).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOTS}/board.png`, fullPage: false });
});

// Boards were auto-named "My PPR Board" from the format dropdown, with no way
// to say otherwise -- reported as "I can't name the big board I'm creating".
test("the name you type is the name the board gets", async ({ page }) => {
  let posted = null;
  await page.route("**/me/boards", (r) => r.fulfill({ json: { boards: [] } }));
  await page.route(`${API}/boards`, (r) => {
    posted = r.request().postDataJSON();
    return r.fulfill({ json: { boardId: "b-new" } });
  });
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("board-name").fill("Sleepers and busts");
  await page.getByTestId("create-board").click();

  await expect.poll(() => posted).not.toBeNull();
  expect(posted.name).toBe("Sleepers and busts");
});

test("leaving the name blank keeps the old format-derived default", async ({ page }) => {
  let posted = null;
  await page.route("**/me/boards", (r) => r.fulfill({ json: { boards: [] } }));
  await page.route(`${API}/boards`, (r) => {
    posted = r.request().postDataJSON();
    return r.fulfill({ json: { boardId: "b-new" } });
  });
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("create-board").click();

  await expect.poll(() => posted).not.toBeNull();
  expect(posted.name).toBe("My PPR Board");
});

test("screenshot — boards list", async ({ page }) => {
  // fullPage is inert here: the shell is h-dvh and the routes wrapper is the
  // scroller, so the document is always exactly viewport height. Size the
  // viewport to the page's own content instead, or the image is clipped.
  await page.setViewportSize({ width: 1280, height: 760 });
  await signIn(page);
  await page.route("**/me/boards", (route) =>
    route.fulfill({
      json: {
        boards: [
          { id: BOARD_ID, name: "My PPR Board", format: "ppr", season: 2026, updatedAt: Date.now() },
          { id: "b2", name: "Standard Sleepers", format: "standard", season: 2026, updatedAt: Date.now() - 90000 },
        ],
      },
    })
  );

  await page.goto("/boards");
  await expect(page.getByTestId("board-list")).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOTS}/boards.png`, fullPage: false });
});

// Deleting a board destroys hand-ranked work with no undo, and it sits one nav
// item away from My drafts, which has always confirmed. The accept case above
// passes just as green against no confirmation at all -- these are the ones
// that actually hold the gate in place.
test("dismissing the delete confirmation deletes nothing", async ({ page }) => {
  let called = false;
  await signIn(page);
  await page.route("**/me/boards", (route) =>
    route.fulfill({ json: { boards: [{ id: BOARD_ID, name: "My PPR Board", format: "ppr", season: 2026, updatedAt: Date.now() }] } })
  );
  await page.route(`**/boards/${BOARD_ID}`, (route) => {
    if (route.request().method() === "DELETE") called = true;
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto("/boards");
  await expect(page.getByTestId("board-list")).toContainText("My PPR Board");

  page.on("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Delete My PPR Board" }).click();

  await expect(page.getByTestId("board-list")).toContainText("My PPR Board");
  expect(called, "no DELETE should be sent when the dialog is dismissed").toBe(false);
});

test("the delete confirmation names the board", async ({ page }) => {
  await signIn(page);
  await page.route("**/me/boards", (route) =>
    route.fulfill({ json: { boards: [{ id: BOARD_ID, name: "My PPR Board", format: "ppr", season: 2026, updatedAt: Date.now() }] } })
  );
  await page.route(`**/boards/${BOARD_ID}`, (route) => route.fulfill({ json: { ok: true } }));

  await page.goto("/boards");
  await expect(page.getByTestId("board-list")).toContainText("My PPR Board");

  let message = "";
  page.on("dialog", (d) => {
    message = d.message();
    d.dismiss();
  });
  await page.getByRole("button", { name: "Delete My PPR Board" }).click();

  await expect.poll(() => message).toContain("My PPR Board");
});

async function readDownload(downloaded) {
  const stream = await downloaded.createReadStream();
  return new Promise((resolve, reject) => {
    let out = "";
    stream.on("data", (c) => { out += c; });
    stream.on("end", () => resolve(out));
    stream.on("error", reject);
  });
}

// Deliberately not in consensus-rank order. makeBoardState() with no argument
// gives a board whose myRank order and consensusRank order coincide, against
// which an export that ignored the board and sorted by rank would pass just as
// happily as a correct one -- and these are the only tests standing behind the
// promise that what is on screen is what leaves.
const SCRAMBLED = ["p5", "p1", "p9", "p3", "p7"];

test("exporting CSV downloads the board in the order on screen", async ({ page }) => {
  await mockBoard(page, makeBoardState({ order: SCRAMBLED }));
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  const [downloaded] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-csv").click(),
  ]);

  const lines = (await readDownload(downloaded)).trim().split("\n");
  expect(lines[0]).toContain("# PerfectPick board");
  expect(lines[1]).toBe("rank,player,position,team,playerId");

  // Every row in order, not just the first: a swap further down is exactly the
  // kind of regression a first-row check waves through. playerId is the last
  // field, and no name in this slice of the fixture contains a comma.
  const exported = lines.slice(2).map((l) => l.split(",").pop());
  const onScreen = await page
    .getByTestId("board-row")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-player-id")));
  expect(exported).toEqual(onScreen);
  expect(exported).toEqual(SCRAMBLED);
});

test("exporting JSON downloads a parseable board in the order on screen", async ({ page }) => {
  await mockBoard(page, makeBoardState({ order: SCRAMBLED }));
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  const [downloaded] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-json").click(),
  ]);

  expect(downloaded.suggestedFilename()).toMatch(/\.json$/);
  // Parsed, not just named: the filename tells you nothing about whether the
  // body is empty or malformed.
  const parsed = JSON.parse(await readDownload(downloaded));
  expect(parsed.players.map((pl) => pl.playerId)).toEqual(SCRAMBLED);
  expect(parsed.players[0].name).toBe("Ja'Marr Chase");
});

// Importing always creates a brand-new board: /boards -> POST /boards -> GET
// the created board's pool -> match -> PUT the order. `b-imported` stands in
// for whatever id the server hands back from the POST.
async function mockImport(page, { rows, onOrder, onDelete, failGet, failPut }) {
  await page.route("**/me/boards", (r) => r.fulfill({ json: { boards: [] } }));
  await page.route(`${API}/boards`, (r) =>
    r.fulfill({ json: { boardId: "b-imported" } })
  );
  await page.route(`${API}/boards/b-imported`, (r) => {
    const method = r.request().method();
    if (method === "PUT") {
      if (failPut) return r.fulfill({ status: 500, json: { message: "Save failed" } });
      onOrder?.(r.request().postDataJSON().order);
      return r.fulfill({ json: { ok: true, version: 2 } });
    }
    if (method === "DELETE") {
      onDelete?.();
      return r.fulfill({ json: { ok: true } });
    }
    if (failGet) return r.fulfill({ status: 500, json: { message: "Could not load that board" } });
    return r.fulfill({
      json: { boardId: "b-imported", name: "Imported", sport: "nfl", format: "ppr", season: 2026, version: 1, rows, changelog: [] },
    });
  });
}

const POOL_ROWS = [
  { playerId: "p1", name: "Christian McCaffrey", position: "RB", team: "SF", myRank: 1, consensusRank: 1, delta: 0 },
  { playerId: "p2", name: "Justin Jefferson", position: "WR", team: "MIN", myRank: 2, consensusRank: 2, delta: 0 },
];

test("importing a CSV creates a board in the file's order", async ({ page }) => {
  let sent = null;
  await mockImport(page, { rows: POOL_ROWS, onOrder: (o) => { sent = o; } });
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("import-file").setInputFiles({
    name: "board.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("rank,player,playerId\n1,Justin Jefferson,p2\n2,Christian McCaffrey,p1\n"),
  });

  await expect(page).toHaveURL(/\/board\/b-imported$/);
  expect(sent).toEqual(["p2", "p1"]);
});

test("a player who is not in the pool is named, not silently dropped", async ({ page }) => {
  await mockImport(page, { rows: POOL_ROWS });
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("import-file").setInputFiles({
    name: "board.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("rank,player\n1,Christian McCaffrey\n2,Rob Gronkowski\n"),
  });

  await expect(page.getByTestId("import-report")).toContainText("Imported 1 of 2");
  await expect(page.getByTestId("import-report")).toContainText("Rob Gronkowski");
});

test("a clean import shows no report at all", async ({ page }) => {
  await mockImport(page, { rows: POOL_ROWS });
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("import-file").setInputFiles({
    name: "board.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("rank,player,playerId\n1,Christian McCaffrey,p1\n2,Justin Jefferson,p2\n"),
  });

  await expect(page).toHaveURL(/\/board\/b-imported$/);
  await expect(page.getByTestId("import-report")).toHaveCount(0);
});

test("a file that is not a board says so and creates nothing", async ({ page }) => {
  let created = false;
  await page.route("**/me/boards", (r) => r.fulfill({ json: { boards: [] } }));
  await page.route(`${API}/boards`, (r) => { created = true; return r.fulfill({ json: { boardId: "x" } }); });
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("import-file").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("just some notes I wrote"),
  });

  await expect(page.getByText(/no player column/i)).toBeVisible();
  expect(created).toBe(false);
});

// The brief's flow would leave an orphan board here: it creates the board
// before it can know whether anything matched, so when nothing does, the
// board it just created must be deleted rather than left behind, empty, in
// the person's list.
test("an import matching nobody deletes the board it created", async ({ page }) => {
  let deleted = false;
  await mockImport(page, { rows: POOL_ROWS, onDelete: () => { deleted = true; } });
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("import-file").setInputFiles({
    name: "board.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("rank,player\n1,Le'Veon Bell\n2,Rob Gronkowski\n"),
  });

  await expect(page.getByText(/nothing to import/i)).toBeVisible();
  await expect.poll(() => deleted).toBe(true);
});

// The zero-match path was not the only way to strand a board. Every step after
// the POST can fail, and each one used to leave an empty "(imported)" board in
// the list with nothing to explain it.
const CSV_TWO_MATCHES = "rank,player,playerId\n1,Christian McCaffrey,p1\n2,Justin Jefferson,p2\n";

test("a board is not left behind when reading its pool fails", async ({ page }) => {
  let deleted = false;
  await mockImport(page, { rows: POOL_ROWS, failGet: true, onDelete: () => { deleted = true; } });
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("import-file").setInputFiles({
    name: "board.csv", mimeType: "text/csv", buffer: Buffer.from(CSV_TWO_MATCHES),
  });

  await expect.poll(() => deleted).toBe(true);
  // Still on the list, because there is no board worth sending anyone to.
  await expect(page).toHaveURL(/\/boards$/);
});

test("a board is not left behind when saving the order fails", async ({ page }) => {
  let deleted = false;
  await mockImport(page, { rows: POOL_ROWS, failPut: true, onDelete: () => { deleted = true; } });
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("import-file").setInputFiles({
    name: "board.csv", mimeType: "text/csv", buffer: Buffer.from(CSV_TWO_MATCHES),
  });

  await expect.poll(() => deleted).toBe(true);
  await expect(page).toHaveURL(/\/boards$/);
});
