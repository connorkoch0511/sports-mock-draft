# Sleeper API — Verified Findings

**Date:** 2026-08-28
**Status:** Research notes. Input to the future Sleeper league-connection spec.
**Method:** Live calls against the real account `ck15` (user_id `865123803410374656`) and its three 2026 leagues.

Everything below was observed, not inferred from documentation. Where a claim is
unverified it says so explicitly.

---

## Authentication: none required

Every endpoint below returned `200` with complete data and no credentials of any kind —
no API key, no OAuth token, no session.

```
GET /v1/user/<username>                     → user object incl. user_id
GET /v1/user/<user_id>/leagues/nfl/<season> → array of leagues
GET /v1/league/<league_id>                  → settings, roster_positions, scoring_settings
GET /v1/league/<league_id>/rosters          → 12 items
GET /v1/league/<league_id>/users            → 12 items
GET /v1/league/<league_id>/drafts           → 1 item
GET /v1/draft/<draft_id>                    → type, settings, draft_order, slot_to_roster_id
```

`traded_picks`, `transactions/1`, and `matchups/1` returned `200` with empty arrays.
That reflects league state (`pre_draft`, no season played) — **not** permission gating.
Nothing is withheld from an anonymous caller.

### Signing in would add nothing

Sleeper publishes no OAuth provider and no "Sign in with Sleeper." The API is read-only
by design. The only route to an authenticated session is reverse-engineering the mobile
app's private tokens, which violates their terms and breaks without warning. It would
also buy nothing: the data is already fully readable, and Sleeper exposes **no public
write API to anyone**, authenticated or not — so pushing picks into a real Sleeper draft
is impossible by any route.

Two consequences worth carrying into the UI:

- **No identity verification.** Anyone can look up anyone's username. "Connect your
  league" overstates it; this is a username lookup. Say so plainly rather than implying
  an account link.
- **Read-only.** We can import a league's configuration. We cannot write to it.

Sleeper's guidance is to stay under roughly 1000 requests/minute. Irrelevant at this
scale, but cache league lookups rather than refetching per render.

---

## League object

Observed across the three real leagues:

| League | `total_rosters` | `roster_positions` | `scoring_settings.rec` | `settings.type` |
|---|---|---|---|---|
| Arcade League | 10 | QB, RB×2, WR×2, TE, FLEX×2, K, DEF, BN×5 (15) | 1.0 | 0 (redraft) |
| Average Joes 26' | 12 | QB, RB×2, WR×3, TE, FLEX, K, DEF, BN×6 (16) | 0.5 | 0 (redraft) |
| Designated Drinkers | 10 | QB, RB×2, WR×3, TE, FLEX×2, K, DEF, BN×22 (33) | 1.0 | 2 (dynasty) |

**`roster_positions` is a flat array of slot labels**, including `FLEX` and `BN`. This is
the field that drives roster modeling. None of the three leagues use SUPERFLEX — the
case that would invert QB valuation — but the model should not assume its absence.

**`scoring_settings` carries 43–132 keys.** Do not model them. The app's ADP data exists
only in `standard` / `half-ppr` / `ppr`, so the honest mapping is on `rec` alone:

```
rec >= 1.0  → ppr
rec == 0.5  → half-ppr
rec == 0    → standard   (or absent)
```

Modeling true custom scoring would require player projections the app does not have.

---

## Draft object

`GET /v1/draft/<draft_id>` for Average Joes 26':

| Field | Value | Note |
|---|---|---|
| `type` | `snake` | Matches the existing engine |
| `status` | `pre_draft` | |
| `settings.rounds` | **16** | Use this directly |
| `settings.teams` | 12 | |
| `settings.pick_timer` | **60** | Identical to the app's existing `PICK_SECONDS` |
| `draft_order` | present | maps user_id → draft slot |
| `slot_to_roster_id` | present | maps slot → roster |

**Trap: `settings.draft_rounds` on the *league* object is not the round count.** It read
3, 3, and 5 for leagues whose real drafts are 15, 16, and 33 rounds. Take rounds from the
**draft** object's `settings.rounds`, or fall back to `roster_positions.length`.

**`draft_order` lets us set the user's real draft slot** rather than asking them to pick
it — combined with `slot_to_roster_id`, the imported draft can start from their actual
position.

---

## Implications for the domain model

The change is smaller than originally feared, and concentrated in one place.

**Directly importable, no modeling needed:** teams (`total_rosters`), rounds
(`settings.rounds`), draft type (`type`), pick timer (`settings.pick_timer`), user's slot
(`draft_order`), scoring format (derived from `rec`).

**The actual work is roster modeling.** `drafts.js` `needScore()` currently targets a
hardcoded `{ QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 }` — nine slots, no FLEX, no bench,
unrelated to any real league. Supporting `roster_positions` means:

- Counting starter requirements per position from the array
- **Modeling FLEX**, which accepts RB/WR/TE and must be filled after dedicated slots
- **Modeling BN**, which accepts anything and should not drive early-round urgency
- Deriving `rounds` from the draft rather than a hand-entered number

**Unverified, flagged for the spec:** SUPERFLEX behavior (no sample league uses it),
auction drafts (`type` was `snake` in all three), and keeper/dynasty handling
(`settings.type: 2` on one league, but its effect on a mock draft is a product decision,
not an API one).
