# Header alignment and a platform dropdown for imports

**Status:** approved design, not yet implemented
**Depends on:** nothing. Two independent UI changes shipped together because both are about reclaiming space on the same screens.

## Problem

**The header packs everything into its left third.** `NavBar` renders, in DOM
order: the menu toggle, the nav links, the auth controls, and *then* the
brand. So a signed-in user sees `☰  you@example.com  Sign out  ● PerfectPick`
crowded against the left edge while the right half of a 1280px header is
empty. The brand landing to the right of a Sign out button also reads as an
accident, because it is one — it is simply last in the markup.

**New Draft spends its first 330 pixels on two import cards.** "Import from
Sleeper" and "Import from Yahoo" are stacked, always both expanded, and
together they push Teams and Rounds — the fields every draft needs, including
the ones nobody imports — to the vertical middle of the page. Only one of the
two can ever be in use at a time, and in production one of them cannot be used
at all: the build ships without a Yahoo client id, so that card exists only to
say it is not configured.

## Decisions

1. **The import section defaults to Sleeper, expanded** — with one exception,
   a return from the Yahoo callback, described under State. Not a placeholder
   "choose a platform" and not collapsed behind a toggle. Sleeper needs no
   login, so it is the path most people take, and having it ready costs one
   less click. The cost is accepted: it does keep some of the height, and it
   implies Sleeper is the default platform, which today it effectively is.
2. **The dropdown lists Sleeper and Yahoo, always, in every build.** Not
   "only platforms this build can use" — in production that would render a
   dropdown with exactly one option, which is worse than no dropdown, and it
   would make the control's shape depend on deploy configuration.
3. **Yahoo explains itself when it is switched off.** Selecting Yahoo in a
   build with no `VITE_YAHOO_CLIENT_ID` shows the line it shows today —
   "This build is not configured for Yahoo" — rather than a sign-in button
   that leads nowhere. This is the same rule the landing page follows.
4. **ESPN is not listed, not even disabled.** It has no league API, the usual
   route is undocumented endpoints driven by session cookies, and listing it
   greyed out would promise a roadmap item that may never be buildable.

## The header

`NavBar`'s root is `<header className="relative flex items-center gap-3 py-4">`
with four children in this order: the menu toggle, the nav links, the
`auth-controls` block, and the brand `<Link>`.

Two changes, both to layout only:

- Move the brand `<Link>` from last child to immediately after the menu
  toggle. Reading order becomes brand, then navigation, then account — which
  is both the conventional arrangement and the right one for a screen reader.
- Add `ml-auto` to the existing `auth-controls` container so it is pushed to
  the far right of the flex row.

Nothing else changes. Specifically:

- The email keeps `max-w-[10rem] truncate`, so a long address still cannot
  push the button off-screen.
- `data-testid="auth-controls"`, `auth-user`, `sign-in` and `sign-out` all
  keep their hooks and their behaviour. Existing tests should need no edit
  beyond any that assert on position.
- The signed-out state (a `Sign in` button) and the unconfigured state
  (renders nothing at all) move with the block, and the unconfigured case
  must still render nothing — an empty right-hand side, not an empty box.

**Watch the draft page.** `NavBar` is shared, and the draft page's own header
row was fixed once already for wrapping onto a third line (`b31dbed`). Adding
`ml-auto` should not affect it, but the check is cheap and the regression is
one this project has already had.

## The import section

The two cards become one card with the same outer classes the existing panels
use (`mb-6 max-w-2xl rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-5`),
laid out as:

```
Import from  [ Sleeper ▾ ]

Enter a Sleeper username to pull a league's teams, rounds, scoring,
roster slots, and your draft slot. Nothing is stored and no Sleeper
sign-in is needed.

[ Sleeper username              ]  [ Find my leagues ]
```

The heading text "Import from Sleeper" / "Import from Yahoo" is replaced by
the label and the dropdown, so the platform name is said once rather than
twice. Below the dropdown, exactly one platform's body renders:

- **Sleeper** — the existing blurb, username input, "Find my leagues" button,
  the league list once found, and the Sleeper error line.
- **Yahoo** — the existing blurb, and either the "Sign in to Yahoo" button or
  the not-configured line, plus the Yahoo error line and the league list
  carried back from the OAuth callback.

Everything inside those bodies keeps its current markup, copy, test ids and
behaviour. This is a rearrangement, not a redesign of either flow.

Expected saving: roughly 170px, which puts Teams and Rounds near the top of
the page instead of at its vertical middle.

### State

One new piece of state: the selected platform, defaulting to `"sleeper"`.

- `sleeperErr` and `yahooErr` stay separate. Switching platform must not show
  Yahoo an error Sleeper produced.
- Switching platform clears the *other* platform's league list, so a set of
  leagues fetched from one service can never be applied while the other is
  selected. The form fields the import populates (teams, rounds, roster
  slots) are deliberately left alone — someone who imported and then switched
  platform has not asked to discard what they imported.
- A Yahoo callback returns to this page with leagues in router state
  (`location.state?.yahooLeagues`). When it does, the platform must start on
  **Yahoo**, not Sleeper, or the leagues the user just authorised would be
  invisible behind a dropdown set to something else.

### Accessibility

The dropdown is a native `<select>` with a visible "Import from" label bound
to it. No custom listbox. Keyboard and screen-reader behaviour then come for
free, which matters more here than matching the styling of the surrounding
custom controls.

## Testing

- `frontend/tests/sleeper.spec.js` needs **no change**: Sleeper is the
  default and its username field is visible on load, which is one practical
  benefit of decision 1. `frontend/tests/yahoo.spec.js` must select Yahoo in
  the dropdown before reaching `yahoo-import`. Adjust its setup only; do not
  rewrite assertions — if an assertion needs changing, the rearrangement
  changed behaviour it should not have.
- New: selecting Yahoo swaps the panel, and selecting back returns to
  Sleeper's.
- **Not testable, and accepted as such:** "choosing Yahoo in a build with no
  client id shows the not-configured line". Playwright's dev server always
  sets `VITE_YAHOO_CLIENT_ID` (`playwright.config.js`), so that branch has no
  test today and cannot get one without a second dev-server project — which
  is disproportionate for one line of copy. The branch is unchanged by this
  work; it simply moves. Recorded here so nobody reads its absence as an
  oversight.
- New: a Yahoo callback carrying leagues lands with the dropdown on Yahoo and
  those leagues listed.
- Existing: the whole suite must stay green, including the draft page's
  header-wrap assertions.
- Regenerate screenshots. `newdraft.png` obviously — but the header appears
  on **every** page, so most of the nine images in `screenshots/` will change
  when the auth controls move right. Run the full suite and commit whatever
  it rewrites; do not hand-pick.

## Out of scope

- ESPN import, in any form.
- The page's content column and the empty right half of every screen. The
  content sits in a narrow left-aligned column; that is a wider layout
  question than this change, and mixing it in would make both harder to
  review.
- Any change to what an import actually does, to the Sleeper season logic, or
  to the Yahoo OAuth flow.
- Mobile-specific behaviour beyond what the existing responsive classes
  already do.
