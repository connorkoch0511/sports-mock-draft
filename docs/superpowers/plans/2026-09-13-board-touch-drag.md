# Board Touch-Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The big board can be reordered on a touchscreen, which today is impossible, without giving up the ability to scroll it.

**Architecture:** Replace dnd-kit's single `PointerSensor` with input-specific `MouseSensor` (unchanged 4px threshold) and `TouchSensor` (250ms hold). Mouse behaviour is byte-identical. On touch, `PointerSensor` currently loses the gesture to `pointercancel` the moment the browser claims it for scrolling; `TouchSensor` works at the touch-event level and `preventDefault`s after its delay, which is what beats that. One file.

**Corrected 13 September.** The first version of this plan described the bug backwards — as swiping *causing* a reorder — because the probe behind it dispatched synthetic `PointerEvent`s that skip the browser's scroll-versus-drag arbitration. The implementer's first run caught it. The code changes below are unchanged; Step 3's expected result is the part that was wrong.

**Tech Stack:** React 19, @dnd-kit/core 6.3, Playwright (Chromium only).

**Spec:** `docs/superpowers/specs/2026-09-13-board-touch-drag-design.md`

## Global Constraints

- **Mouse behaviour must not change.** The five existing drag tests in `board.spec.js` are the net. If one of them needs editing to pass, STOP and report — that means mouse behaviour changed, which the design forbids.
- The whole row stays the drag target on both inputs. Grip-only dragging on touch is explicitly rejected: the code's own comment records that the grip is "a dim six-dot glyph that is easy to miss entirely", which is worse for a thumb than for a cursor.
- Exact activation constraints: mouse `{ distance: 4 }`, touch `{ delay: 250, tolerance: 5 }`. These are the platform-conventional values; do not tune them.
- No visual change. No grip resizing, no hint text, no new affordance.
- `attributes` stay on the grip so keyboard reordering is untouched.
- Only `frontend/src/pages/Board.jsx` and `frontend/tests/board.spec.js` change. Nothing else imports dnd-kit.
- Playwright on this machine silently truncates when the laptop sleeps. The controller owns the full-suite run (`caffeinate -i npm test`, total compared against `npx playwright test --list`). Implementers run only the focused `-g` commands named below.

---

### Task 1: Sensors by input type, and the guard that follows them

The sensor swap and the name-guard fix are one task: doing either alone leaves the page broken. Swapping sensors without fixing the guard makes the player's name a drag handle; fixing the guard without swapping sensors changes nothing.

**Files:**
- Modify: `frontend/src/pages/Board.jsx` (imports ~line 3-10, `Row` name button ~line 97, `sensors` ~line 159)
- Test: `frontend/tests/board.spec.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Confirm the baseline is green before touching anything**

```bash
cd frontend && npx playwright test tests/board.spec.js -g "dragging the row body reorders|the name is not a drag handle|dragging by the grip still reorders|clicking the name still opens the player|keyboard reorder saves"
```

Expected: 5 passed. If any fails now, stop — something else is wrong and this plan's regression net is not trustworthy.

- [ ] **Step 2: Write the failing touch tests**

Append to `frontend/tests/board.spec.js`. The `test.describe` wrapper scopes `test.use` to these two tests only — do not put `test.use` at file scope, it would apply to every test in the file.

```js
// A finger has only one gesture for "move the list" and "move this row", so
// the sensor has to tell them apart by time rather than by distance. These
// two are a pair on purpose: the swipe test alone would also pass if touch
// dragging were disabled outright, which is why the long-press test sits
// beside it.
test.describe("reordering with a finger", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  // Playwright has no swipe, and synthetic PointerEvents would not reach a
  // TouchSensor -- it listens for touchstart. CDP dispatches genuine touch
  // events, which is also what makes the browser's own scrolling happen, so
  // the scroll assertion below means something. Chromium-only, which is the
  // only project this suite runs.
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
    page.locator('[data-testid="board-row"]').evaluateAll((els) => els.map((e) => e.dataset.playerId));

  async function openLongBoard(page) {
    // The default fixture is ten rows, which barely overflows a phone screen.
    // A full-length board gives the swipe somewhere to scroll to.
    await mockBoard(page, makeBoardState({ order: MOCK_PLAYERS.map((p) => p.id) }));
    await signIn(page);
    await page.goto(`/board/${BOARD_ID}`);
    await expect(page.getByTestId("board-row").first()).toBeVisible();
  }

  test("swiping the list scrolls it and changes nothing", async ({ page }) => {
    await openLongBoard(page);
    const before = await orderOf(page);

    await fingerDrag(page, page.getByTestId("board-row").nth(2), { dy: -200, holdMs: 0 });

    expect(await orderOf(page)).toEqual(before);
    const scrolled = await page.evaluate(
      () => document.querySelector('[class*="overflow-y-auto"]')?.scrollTop ?? window.scrollY
    );
    expect(scrolled).toBeGreaterThan(0);
  });

  test("holding a row and then dragging reorders it", async ({ page }) => {
    await openLongBoard(page);
    const before = await orderOf(page);

    // Longer than the 250ms activation delay, so the drag is armed before
    // the finger moves at all.
    await fingerDrag(page, page.getByTestId("board-row").nth(2), { dy: -120, holdMs: 400 });

    expect(await orderOf(page)).not.toEqual(before);
  });
});
```

Add `MOCK_PLAYERS` to the existing fixtures import at the top of the file:

```js
import { BOARD_ID, MOCK_PLAYERS, makeBoardState } from "./fixtures.js";
```

- [ ] **Step 3: Run them and watch the first fail**

```bash
cd frontend && npx playwright test tests/board.spec.js -g "swiping the list scrolls it|holding a row and then dragging"
```

Expected: **1 failed, 1 passed** — and it matters which is which.
- `holding a row and then dragging reorders it` **FAILS**, because the order never changes. This is the bug: the browser fires `pointercancel` as soon as it claims the gesture for scrolling, and `PointerSensor` abandons the drag there. Holding first does not help — there is no native long-press-to-drag.
- `swiping the list scrolls it and changes nothing` **PASSES** already. Scrolling is the one thing that does work on touch today. It is here to make sure the fix does not buy touch dragging at the cost of touch scrolling, so it passing now is correct and expected.

Confirmed against this exact working tree on 13 September: 1 failed (long-press), 1 passed (swipe).

If the **long-press** test passes at this step, stop and report — the fix is not needed or the test is not reaching the sensor.

- [ ] **Step 4: Swap the sensors**

In `frontend/src/pages/Board.jsx`, change the `@dnd-kit/core` import — `MouseSensor` and `TouchSensor` replace `PointerSensor`:

```jsx
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
```

Then replace the `sensors` block:

```jsx
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
```

with:

```jsx
  // One pointer sensor could not serve both inputs. A mouse scrolls with a
  // wheel, so four pixels of movement is unambiguously a drag; a finger has
  // no other way to scroll, so the same four pixels is how you read the list.
  // dnd-kit picks the sensor by input type, so the mouse keeps exactly the
  // threshold it had and touch gets a hold instead of a distance: move first
  // and the browser scrolls, hold still for 250ms and the row lifts.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
```

- [ ] **Step 5: Make the name's guard follow the sensors**

In the `Row` component, the player-name button stops `pointerdown` to keep itself out of the drag. `MouseSensor` and `TouchSensor` do not listen for `pointerdown`, so that guard now stops nothing. Replace:

```jsx
          onPointerDown={(e) => e.stopPropagation()}
```

with:

```jsx
          // The sensors listen for mousedown and touchstart, not pointerdown,
          // so stopping only the latter would quietly turn the name back into
          // a drag handle. All three stay: pointerdown keeps the guard honest
          // if the sensors ever change again.
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
```

- [ ] **Step 6: Run the touch tests and watch both pass**

```bash
cd frontend && npx playwright test tests/board.spec.js -g "swiping the list scrolls it|holding a row and then dragging"
```

Expected: 2 passed.

- [ ] **Step 7: Run the desktop regression net**

```bash
cd frontend && npx playwright test tests/board.spec.js -g "dragging the row body reorders|the name is not a drag handle|dragging by the grip still reorders|clicking the name still opens the player|keyboard reorder saves"
```

Expected: 5 passed, with **no edits to those tests**. If any fails, do not adjust the test — report it. A failure here means mouse behaviour changed, which this design forbids, and the plan is wrong rather than the test.

- [ ] **Step 8: Prove the constraints are load-bearing**

House rule: a guard is only covered if removing it turns a test red.

**Corrected after implementation.** This step originally predicted that
setting `delay` to 0 would fail the swipe test. It does not — verified three
times. dnd-kit's `AbstractPointerSensor` never activates synchronously even at
`delay: 0`; it always schedules a timer, and the swipe's first 20px move
exceeds `tolerance: 5` and cancels before that timer fires. **`tolerance` is
what pins the swipe test, not `delay`**, which is why a third test exists.

Run each mutation, then restore:

| Mutation | Expected |
| --- | --- |
| `tolerance: 5` → `1000` | `swiping the list scrolls it` FAILS |
| `delay: 250` → `0` | `a brief hesitation before scrolling` FAILS |
| restored | 3 passed |

The third test is the one that makes `delay` load-bearing. Without it the
delay could be deleted and the suite would stay green, while a real finger
that lands, hesitates and scrolls would reorder the board.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/pages/Board.jsx frontend/tests/board.spec.js
git commit -m "fix: the big board can be reordered with a finger"
```

---

## After the task

The controller runs the full suite (`caffeinate -i npm test`, total compared against `npx playwright test --list`) and checks whether any screenshot changed. None should: this change has no visual effect, and every screenshot is taken with a mouse at desktop width.
