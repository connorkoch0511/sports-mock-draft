import { test, expect } from "@playwright/test";
import { BOARD_ID, makeBoardState } from "./fixtures.js";

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

test("renders the board in saved order", async ({ page }) => {
  await mockBoard(page, makeBoardState());
  await page.goto(`/board/${BOARD_ID}`);

  const rows = page.getByTestId("board-row");
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toContainText("Christian McCaffrey");
});

test("shows the changelog when the pool has changed", async ({ page }) => {
  await mockBoard(page, makeBoardState({ added: 3, removed: 1 }));
  await page.goto(`/board/${BOARD_ID}`);

  await expect(page.getByTestId("changelog")).toContainText("3 added, 1 removed");
});

test("hides the changelog when nothing changed", async ({ page }) => {
  await mockBoard(page, makeBoardState());
  await page.goto(`/board/${BOARD_ID}`);

  await expect(page.getByTestId("changelog")).toHaveCount(0);
});

test("keyboard reorder saves the new order", async ({ page }) => {
  let saved = null;
  await mockBoard(page, makeBoardState(), { onSave: (body) => { saved = body; } });
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

test("deleting a board removes it from the list", async ({ page }) => {
  let deleted = false;
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
  await page.evaluate((id) => {
    localStorage.setItem(
      "perfectpick.myBoards",
      JSON.stringify([{ id, name: "My PPR Board", updatedAt: Date.now() }])
    );
  }, BOARD_ID);
  await page.reload();

  await expect(page.getByTestId("board-list")).toContainText("My PPR Board");
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
