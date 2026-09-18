# Plan: the phone chrome at the reader's font

Spec: `docs/superpowers/specs/2026-09-18-phone-chrome-honesty-design.md`
Branch: `fix/phone-chrome-honesty`

Two files — `StatusStrip.jsx` and `TabBar.jsx` — and one spec file,
`draftphone.spec.js`, which already owns everything phone-shaped.

Ordered so the **larger** defect goes first. The 24px breakage is the one that
makes the page unusable; the touch targets are the one that was asked for. Doing
the big one first means the target work is measured against a strip that already
behaves.

**Every new test must be seen to fail before its fix is written**, and the
failure must be the predicted one. Two tests in this repo have recently passed
for the wrong reason — an assertion that retried past the state it meant to
catch, and one comparing two identical glyphs — so a green-on-first-run test is
treated as broken, not as done.

---

## Task 1 — the strip survives the reader's font

**Test first**, in `draftphone.spec.js`, at 390x844 with the root font forced to
24px:

1. **The label is one line.** `strip-status` height must be under ~2 lines of
   its own text (assert against its computed `lineHeight`, not a magic number,
   so the test scales with the font it is testing). **Red today at 150px.**
2. **The strip stays proportionate.** `status-strip` height must be a small
   fraction of the viewport — under a quarter of 844. **Red today at 176px.**

Run both. Expected failures are those two numbers; anything else — the draft not
loading at a forced root size, the testid missing — means the test is measuring
the wrong thing and gets fixed before any source change.

**Then implement**, in `StatusStrip.jsx`:

- `whitespace-nowrap` on the `strip-status` button, so the clock can never break
  mid-phrase.
- `min-w-0` where the flex row needs it, so the label is allowed to be the thing
  that shrinks rather than the thing that wraps.
- Hide the `Team {myTeam}` span once space is tight. It is the only element
  already duplicated directly below (the Big Board panel header reads "You are
  on the clock (Team 1)"). Prefer a CSS mechanism over a JS width query — a
  media/container rule has no state to get wrong and no re-render cost on a page
  that already ticks once a second.

**Verify:**
1. Both new tests green at 24px.
2. **The existing strip tests still green** — `:184` (Pause visible on all four
   tabs) and `:291` (contains "your pick", tapping goes to the board). If hiding
   `Team N` or adding nowrap breaks either, the fix is wrong, not the test.
3. Re-measure at 16 / 20 / 24 and record the strip height at each.
4. **Mutation:** remove `whitespace-nowrap` → the one-line test must go red.

---

## Task 2 — targets that scale with the text

**Test first**, at all three roots (16 control, 20, 24):

- `strip-status`, Pause, `⋯` and the four tab buttons must each measure at least
  `2.75rem` **in the units of the root being tested** — i.e. compute the
  expected pixel value from the root size rather than hard-coding 44, otherwise
  the test repeats the bug it is guarding against.
- **Red today at 16px** on all six (20, 34, 34, 36×4). Green already at 20px for
  all but `⋯` — which is itself worth asserting, since it proves the test is
  reading the font and not a constant.

**Then implement:** `min-h-11` on those six controls, and reduce the containers'
vertical padding (`py-2` on the strip, `p-1` on the tab bar) so the taller
targets are absorbed by padding that is currently doing nothing. The strip holds
18px of unused padding against a 10px deficit; the tab bar 10px against 8px.

**Verify:**
1. New target tests green at all three roots.
2. **Re-measure the chrome height and the scroller slack.** The spec's claim is
   that this nets to roughly zero. If the strip or tab bar grows, record the
   number — a 6px growth accepted knowingly is fine; one discovered later is not.
3. **The page must still fit at 16px** — `scrollHeight <= clientHeight + 8`, the
   assertion `:30` already makes. It had 0px of slack before this change.
4. **Mutation:** remove `min-h-11` → the 16px target test must go red.
5. **The utility must actually emit.** Build, then grep the built CSS for the
   `min-h-11` rule. This repo has shipped a height cap whose utility never
   compiled; the class looking right in the JSX is not evidence.

---

## Task 3 — render it, then the screenshot

1. Render at 390x844 at **16 and 24** and look at both. The 24px case is the one
   to judge: is the strip legible and proportionate, is the clock on one line,
   is the panel beneath it intact (at 24px today the search box collapses to an
   empty blob and the scoring select overflows its panel — some of that is the
   panel's own problem, but I need to know which part this change fixed and
   which it did not).
2. Check **landscape 844x390**, where the chrome is sticky and the pane scrolls.
   Unchanged is the expected result; confirm rather than assume.
3. Regenerate `screenshots/draft-phone.png` — `draftphone.spec.js:387` owns it,
   and this change alters the chrome it shows. **Back it up before running any
   spec that writes it**, which is the lesson from last branch.

`screenshots/analysis.png` is modified in the working tree from before this
branch and is not mine. Leave it; do not stage it.

---

## Task 4 — full gates

    cd frontend && npm run lint
    cd frontend && npm run test:unit
    cd frontend && caffeinate -i npx playwright test
    cd backend/src && npm test

Check the Playwright total against `npx playwright test --list` — the baseline is
353 plus whatever this branch adds. A run reporting fewer, or taking far longer
than ~9 minutes, spanned a sleep and is lying; re-run rather than debug it.

Backend is run despite touching no backend file, because it is cheap and it
proves the branch is what it claims to be.

---

## Out of scope

The control sheet's missing focus trap. It is a behavioural fix over a dynamic
focusable set and needs its own spec; it stays on the accepted list until then.
