import { test, expect } from "@playwright/test";

const BOARD = { id: "brd-1", name: "My PPR Board", updatedAt: Date.now() };

async function seed(page) {
  await page.addInitScript((b) => {
    localStorage.setItem("perfectpick.myBoards", JSON.stringify([b]));
  }, BOARD);
}

// Deleting a board destroys hand-ranked work with no undo, and it sits one
// nav item away from My drafts, which has always confirmed. These mirror the
// draft delete tests so the two stay in step.
test.describe("deleting a board is confirmed", () => {
  test("accepting the confirmation deletes the board", async ({ page }) => {
    await seed(page);
    let deleted = false;
    await page.route(`**/boards/${BOARD.id}`, (route) => {
      if (route.request().method() === "DELETE") deleted = true;
      return route.fulfill({ json: { ok: true } });
    });
    page.on("dialog", (d) => d.accept());

    await page.goto("/boards");
    await page.getByRole("button", { name: `Delete ${BOARD.name}` }).click();

    await expect(page.getByTestId("board-list")).toHaveCount(0);
    expect(deleted).toBe(true);
  });

  // The load-bearing case. Asserting only the accept path would pass just as
  // green against no confirmation at all.
  test("dismissing the confirmation deletes nothing", async ({ page }) => {
    await seed(page);
    let called = false;
    await page.route(`**/boards/${BOARD.id}`, (route) => {
      if (route.request().method() === "DELETE") called = true;
      return route.fulfill({ json: { ok: true } });
    });
    page.on("dialog", (d) => d.dismiss());

    await page.goto("/boards");
    await page.getByRole("button", { name: `Delete ${BOARD.name}` }).click();

    await expect(page.getByRole("button", { name: BOARD.name, exact: true })).toBeVisible();
    expect(called, "no DELETE should be sent when the dialog is dismissed").toBe(false);
  });

  test("the confirmation names the board being deleted", async ({ page }) => {
    await seed(page);
    await page.route(`**/boards/${BOARD.id}`, (route) => route.fulfill({ json: { ok: true } }));
    let message = "";
    page.on("dialog", (d) => {
      message = d.message();
      d.dismiss();
    });

    await page.goto("/boards");
    await page.getByRole("button", { name: `Delete ${BOARD.name}` }).click();

    await expect.poll(() => message).toContain(BOARD.name);
  });
});
