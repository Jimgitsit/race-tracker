# race-tracker — Design Doc

**Status:** design, not built · **Written:** 2026-07-30

A dead-simple double-elimination bracket tracker for a Hot Wheels race. No times, no
scores — every heat has exactly one winner and one loser. Three views: racers on their
phones, the race director on a phone, and the full bracket on a big screen.

---

## 1. Scope

**In:**
- Open self-registration: a racer enters a name and is entered in the race. Optional photo
  of their car.
- Double-elimination bracket, generated when the director locks the roster.
- Racer view (mobile): who's racing now, the bracket, the roster.
- Director view (mobile, password-gated): who's up, tap the winner, undo.
- Big-screen view: the whole bracket at once, auto-updating, no interaction.

**Out:** times, lane assignments, heats of >2 cars, accounts/passwords for racers,
multiple concurrent events, persistence beyond this one race.

**Scale:** designed for 4–32 racers. Test at 8 and 16.

---

## 2. Stack

| Piece | Choice | Why |
|---|---|---|
| Runtime | Bun | House default. |
| Server | single `server.ts` using `Bun.serve` | One file is enough; matches `bandsaw-tensioner`, `or-name`. |
| DB | SQLite via `bun:sqlite`, file `data/race.db` | Single-box, single-event, tiny. **Not Neon** — a shared autosuspending compute is the wrong tool for something this small and this latency-sensitive on race day. |
| Frontend | React 19 + Vite → `dist/`, served static by `server.ts` | Real interactive state across three views. |
| Live updates | SSE (`EventSource`) | One-way server→client, auto-reconnects for free, no polling. |
| Photos | files on disk under `data/photos/`, resized **client-side** | No server-side image library needed. |
| Port | **58013** | Next free (58000–58012 taken — see `wiki/notes/serving-infra.md`). |
| Route | `https://jimmcgowen.com/race-tracker/` | Path-prefix mount, per house convention. |

**Do not** reach for a bracket library. Both credible options are a poor fit here:
[`brackets-viewer.js`](https://github.com/Drarig29/brackets-viewer.js/) is vanilla-DOM
(awkward inside React) and pulls in the `brackets-manager` data model;
[`react-tournament-brackets`](https://github.com/g-loot/react-tournament-brackets) is
LGPL-2.1 (a wrinkle for a public repo) and you'd override its match card anyway, since car
photos are the whole point of ours. The genuinely hard part is loser-bracket routing, and
§4 specifies that outright — it's ~100 lines. Build the view with CSS grid.

---

## 3. Views

Everything is **mobile-first** except `/display`, which is **big-screen only** (assume
landscape 1080p+, viewed from across the room, no mouse or keyboard).

Routing is path-based with a catch-all → `index.html` fallback in `server.ts`, so the TV
URL stays typeable (`jimmcgowen.com/race-tracker/display`). All in-app links must be
**relative** — the app is mounted under a prefix (Vite `base: '/race-tracker/'`).

### 3.1 Racer view — `/` (mobile)

**First visit** (no token in `localStorage`):
1. Name entry. Single field, big button. Reject empty and duplicate names (case-insensitive)
   with an inline message.
2. "You're in!" → optional "Add a photo of your car" (camera or library). Skippable, and
   addable later from the Racers tab.
3. Store the returned token in `localStorage`. That token is the racer's identity forever
   after — no password.

**Returning visit:** straight to the main screen. Three tabs, sticky bottom nav:

**`Now`** — the default tab, and the one people will actually stare at.
- Big card: **NOW RACING**, the two cars side by side (photo, name), a `VS` between them.
- If the viewer is in this match, the card gets a loud accent border and a "**That's you!**"
  label.
- Below: **On deck** — the next two matches, compact.
- Below that: **Your status** — one line, always answerable:
  - `Your next race: vs Emma — Winners Round 2`
  - `Your next race: vs TBD — Losers Round 1`
  - `You're up next!`
  - `Knocked out — finished 5th` (with the two racers who beat you)
  - `🏆 You won!`
- Before the roster is locked, this tab shows the waiting state instead: racer count,
  "Waiting for the race director to start."

**`Bracket`** — the mobile bracket. **Do not attempt the classic connector-line tree here**;
it is unreadable on a phone. Instead:
- A `Winners / Losers / Finals` segmented toggle at the top.
- Rounds as horizontally scrollable columns, snap-scrolling, round name in a sticky header
  (`Winners R2`). Each column is a vertical list of match cards.
- A match card: two rows (photo thumb, name), winner in bold with a ✓, loser dimmed and
  struck through. Unfilled slots read `Winner of W1M3` / `TBD`.
- A **"My path"** chip that dims every match the viewer isn't in — this is what makes the
  bracket usable on a phone. Default it **on** for a registered racer.
- Tapping a match opens a detail sheet: both cars full-size, round, result.

**`Racers`** — grid of cards, 2-up: car photo, name, `2–0` record, and status
(`Racing` / `1 loss` / `Out — 5th`). Tap for a detail sheet with that racer's match history.
The viewer's own card is first and has an `Edit` affordance (change name / add or replace
photo) — name edits only allowed before the roster locks.

### 3.2 Director view — `/director` (mobile)

Password screen first (§6). One password, hard-coded, no username.

**Registration phase:**
- Live roster list: photo, name, joined-at. Swipe or tap to remove a racer (mis-entries,
  duplicates). Inline rename.
- Racer count, big and obvious.
- **`Lock roster & start race`** — confirm sheet first, stating what's about to happen:
  *"11 racers → 16-slot bracket, 5 byes. Registration closes. This can't be undone without
  a full reset."*

**Racing phase** — this is the screen that matters. The director is standing at a track
holding a phone, so it has to work with one thumb and no reading.
- Top: round label (`Winners Round 2 · Match 3`).
- The body is **two giant tap targets**, stacked, each ~40% of the viewport: car photo as
  the background, name across it. Tapping one means *this car won*.
- Tap → confirmation sheet (`Maya wins?` / `Cancel` / `Confirm`) — one guard against a
  fat-finger, no more. On confirm: record, advance, auto-select the next ready match.
- Persistent **`Undo last result`** button. Undo is a first-class feature, not a nicety —
  the director *will* tap the wrong car at some point.
- Below the fold: **Up next** queue. Any ready match is tappable to make it current, for
  when a racer has wandered off and you want to run a different heat.
- A collapsed link to the full bracket.

**Complete phase:** podium — 1st, 2nd, 3rd with photos, plus a `Reset event` button
(double-confirm, wipes everything back to registration).

### 3.3 Big screen — `/display`

Landscape, zero interaction, designed to be glanced at from 15 feet.

- **Top banner (~25% height): NOW RACING.** Two cars, photos as large as the row allows,
  names in a very large weight, `VS` between. When a result lands, the winner's half flashes
  and a ✓ stamps on — then after ~3s the banner swaps to the next match. This animation is
  the thing that makes a room look up.
- **Body: the entire bracket, no scrolling.** Winners bracket on top, losers bracket below,
  grand final on the right. This is the one place the classic connector-line tree belongs —
  draw the elbow connectors (SVG or CSS borders).
- **Auto-fit, don't guess at breakpoints.** Render the bracket at its natural pixel size
  into a wrapper, measure it, then apply
  `transform: scale(min(vw / w, vh / h)); transform-origin: top left`
  and re-measure on resize. This is what makes it work on an unknown TV at an unknown
  resolution, which is the actual situation.
- Show car photo thumbs in the match cards when the bracket size is ≤16; drop to name-only
  above that, or the cards get too small to read anyway.
- Completed matches: winner bold, loser dimmed and struck. The current match pulses.
- Request a `navigator.wakeLock` so the TV doesn't sleep, and re-request it on
  `visibilitychange` (browsers drop the lock when the tab is backgrounded).
- No auth. Anyone who can reach the URL can watch — that's the point.

---

## 4. Double-elimination logic

This is the only part with real complexity. Specified concretely so it doesn't have to be
rediscovered.

### 4.1 Shape

Let `N` = racer count, `B` = 2^⌈log₂ N⌉ (bracket size), `R` = log₂ B (winners rounds).

- **Winners round `k`** (k = 1..R) has `B / 2^k` matches.
- **Losers bracket has `2R − 2` rounds**, alternating:
  - **Minor** round `L(2j−1)` — losers-vs-losers, survivors of the previous LB round.
  - **Major** round `L(2j)` — LB survivors vs. fresh droppers from winners round `W(j+1)`.
  - Both `L(2j−1)` and `L(2j)` have `B / 2^(j+1)` matches.
  - `L1` takes the losers of `W1`.
- **Grand final:** winners champion (0 losses) vs. losers champion (1 loss).
  - WB champion wins → done.
  - LB champion wins → both have one loss → play **`GFR`, the bracket reset**, and its
    winner takes it.
- Total matches: `2B − 2`, plus 1 if the reset is played.

Worked example, `B = 16` (`R = 4`): WB `8, 4, 2, 1`; LB `L1:4, L2:4, L3:2, L4:2, L5:1, L6:1`;
`L2←W2`, `L4←W3`, `L6←W4`. 15 + 14 + GF = 30 = 2·16 − 2. ✓

### 4.2 Seeding and byes

There are no qualifying times, so **seeding is a shuffle**. Shuffle the racers, assign seeds
`1..N`, and fill seeds `N+1..B` with a `BYE` participant.

Place seeds into WB round 1 using the **standard bracket seeding order** (for B=8:
`1,8,4,5,2,7,3,6`) — built recursively: `order(2) = [1,2]`,
`order(2n) = interleave(order(n), (2n+1) − order(n))`. This spreads the byes out, since byes
are always the highest seed numbers.

**Resolve byes as a fixpoint:** after building the bracket, repeatedly scan for any pending
match with at least one `BYE` side and resolve it (real racer advances; if both sides are
`BYE`, the match resolves to `BYE`), propagating winners *and* losers along the edges, until
a full pass changes nothing. This handles byes in the losers bracket for free — a `BYE`
dropping down just hands its LB opponent a free pass — and needs no special cases anywhere
else. Bye-resolved matches are flagged and never appear in the race queue or on screen.

### 4.3 Advancement — use explicit edges, not recomputation

Build the routing **once**, at lock time, as rows in an `edges` table:

```
edges(from_match_id, outcome /* 'W' | 'L' */, to_match_id, to_slot /* 'a' | 'b' */)
```

Recording a result is then: write `winner_id`, follow the two outgoing edges, write the
racer into each target slot, mark newly-full matches `ready`. Undo is the exact inverse.
Deriving routing on the fly at every result is where double-elim implementations go wrong;
edges make the whole thing a graph walk and make undo trivially correct.

**Rematch avoidance:** when feeding a major round `L(2j)`, reverse the order of the incoming
WB losers relative to the LB slot order. This is a heuristic, not a guarantee — real
tournaments do fancier cross-placement. For a Hot Wheels race it's plenty; don't gold-plate it.

### 4.4 Race order

Matches get an `order_index` at build time, by round, in this sequence:

```
W1, L1, then for j = 2..R:  W(j), L(2j−2), and L(2j−1) if 2j−1 ≤ 2R−2
finally: GF (and GFR if needed)
```

For `B=16`: `W1, L1, W2, L2, L3, W3, L4, L5, W4, L6, GF`. Within a round, order by slot.
Every dependency is satisfied by construction. The director can override the current match
at any time, so this is a default, not a constraint.

### 4.5 Placements

- 1st: grand final winner.
- 2nd: grand final loser.
- 3rd: loser of the final losers-bracket round (`L(2R−2)`) — eliminated by the LB champion.

Lower placements aren't worth computing; show `Out` and the round they went out in.

---

## 5. Data model

```sql
CREATE TABLE event (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  name           TEXT    NOT NULL DEFAULT 'Hot Wheels Race',
  phase          TEXT    NOT NULL DEFAULT 'registration',  -- registration | racing | complete
  bracket_size   INTEGER,
  current_match  INTEGER REFERENCES matches(id)
);

CREATE TABLE racers (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  name_key    TEXT    NOT NULL UNIQUE,   -- lower(trim(name)), for dupe rejection
  token       TEXT    NOT NULL UNIQUE,   -- crypto.randomUUID(), lives in localStorage
  photo       TEXT,                      -- 'data/photos/<id>.jpg', nullable
  thumb       TEXT,                      -- 'data/photos/<id>-t.jpg', nullable
  seed        INTEGER,                   -- assigned at lock
  created_at  INTEGER NOT NULL
);

CREATE TABLE matches (
  id           INTEGER PRIMARY KEY,
  bracket      TEXT    NOT NULL,         -- 'W' | 'L' | 'GF' | 'GFR'
  round        INTEGER NOT NULL,
  slot         INTEGER NOT NULL,         -- 0-based within round
  a_racer      INTEGER REFERENCES racers(id),
  b_racer      INTEGER REFERENCES racers(id),
  a_source     TEXT,                     -- display label when empty: 'Winner of W1M3'
  b_source     TEXT,
  winner       INTEGER REFERENCES racers(id),
  state        TEXT    NOT NULL,         -- pending | ready | done | bye
  order_index  INTEGER NOT NULL,
  UNIQUE (bracket, round, slot)
);

CREATE TABLE edges (
  from_match  INTEGER NOT NULL REFERENCES matches(id),
  outcome     TEXT    NOT NULL,          -- 'W' | 'L'
  to_match    INTEGER NOT NULL REFERENCES matches(id),
  to_slot     TEXT    NOT NULL,          -- 'a' | 'b'
  PRIMARY KEY (from_match, outcome)
);

CREATE TABLE results_log (              -- the undo stack
  id          INTEGER PRIMARY KEY,
  match_id    INTEGER NOT NULL REFERENCES matches(id),
  winner      INTEGER NOT NULL REFERENCES racers(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE sessions (                 -- director sessions; in SQLite so a mid-event
  token       TEXT PRIMARY KEY,         -- server restart doesn't lock the director out
  created_at  INTEGER NOT NULL
);
```

`BYE` is represented as `racer_id = 0` (a reserved sentinel row), not `NULL` — `NULL` means
"not yet determined," and conflating the two is a bug factory.

---

## 6. API

```
GET   /api/state                     → { event, racers, matches, edges }  (full snapshot)
GET   /api/stream                    → SSE; pushes the same payload on every change

POST  /api/register        {name}                  → { token, racer }
POST  /api/me/photo        multipart: full, thumb  → { photo, thumb }     (token header)
PATCH /api/me              {name}                  → { racer }            (token header)

POST  /api/director/login  {password}              → sets HttpOnly cookie
POST  /api/director/lock                           → shuffle, build bracket, phase=racing
POST  /api/director/result {matchId, winnerId}
POST  /api/director/undo
POST  /api/director/current {matchId}
DELETE /api/director/racer/:id                     → registration phase only
POST  /api/director/reset                          → wipe back to registration
```

Racer identity is the token, sent as an `X-Racer-Token` header. Director auth is a
`HttpOnly; SameSite=Strict` cookie holding a random session token.

**SSE:** one global channel. Push the whole state payload on every mutation rather than a
delta plus a refetch — 32 racers and 62 matches is a few KB, and it removes an entire class
of "client got a nudge but raced the refetch" bugs. Send a heartbeat comment every 20s so
proxies don't reap the connection, and make sure the nginx route sets
`proxy_buffering off;` — buffered SSE just silently doesn't arrive.

---

## 7. Director password

```ts
// src/config.ts
export const DIRECTOR_PASSWORD = "hotwheels";  // ← change me
```

One `const`, top of a tiny config file, no env var, no hashing. This gates *entering race
results at a kids' race*; treating it as a real credential would be theater. It is worth
saying plainly what this is not: anyone who reads the public repo can read the password.
That is an accepted tradeoff for this event — but **don't reuse a real password here**, and
if the event ever matters more than this one does, move it to an env var.

Compare with a timing-safe equality check anyway (`crypto.timingSafeEqual`) — it's one line.

---

## 8. Photos

- Capture with `<input type="file" accept="image/*" capture="environment">`.
- **Resize client-side** before upload, via canvas: a `full` at max 800px on the long edge
  and a `thumb` at max 200px, both JPEG q0.82. Upload both blobs in one multipart POST.
  A raw phone photo is 3–5 MB; this makes it ~80 KB and ~10 KB, which matters when a big
  screen is loading 32 of them and when 20 people are on the same wifi.
- Server writes `data/photos/<racerId>.jpg` and `<racerId>-t.jpg`, serves them under
  `/race-tracker/photos/`, and appends `?v=<mtime>` to bust caches on re-upload.
- No photo → render a generated placeholder (first initial on a color derived from the
  racer id). The bracket must never have a ragged hole where a photo isn't.
- Cap the upload at 2 MB server-side and reject non-image content types.

---

## 9. Build order

1. `server.ts` skeleton + SQLite schema + `/api/state` + SSE. Vite scaffold, three routes.
2. Registration: racer view name entry, token, roster. Director login + roster management.
3. **Bracket generation** (§4) with a standalone test script — verify at N = 4, 5, 8, 11, 16,
   17, 32 that match counts equal `2B − 2`, that every non-bye racer appears, and that byes
   resolve to a valid ready state. Get this right before building any UI on top of it.
4. Director racing screen: tap-to-win, advance, undo.
5. Racer `Now` tab, then `Bracket`, then `Racers`.
6. `/display` big screen + auto-fit scaling.
7. Photos end to end.
8. Deploy: launchd user agent `com.jim.race-tracker` on **58013** (`bun` lives at
   `/Users/doug/.bun/bin/bun`, *not* Homebrew's), nginx route
   `/race-tracker/` → `127.0.0.1:58013` with `proxy_buffering off`, apple-touch-icon via
   `tools/gen-icon.ts`.

**Test the whole thing with two phones and a TV before race day.** A double-elim bracket
that desyncs mid-event in front of a room of kids is the failure mode that matters, and it
won't show up on localhost.

---

## 10. Open questions

- **How many racers?** Changes almost nothing structurally, but drives the big-screen
  photo threshold. Assume ≤32 until told otherwise.
- **Is the race director also racing?** If so, they need both views open — works fine, just
  worth knowing.
- **Consolation for early exits?** Double elim knocks a third of the field out fast. Not
  designing for it; flagging it because it's a real experience problem at a kids' event.
- **Does this need to survive more than one day?** Current design has exactly one event and
  a `reset` button. Multi-event would be a real schema change — worth knowing before build,
  cheap now, expensive later.

---

## References

- [Double-elimination tournament — Wikipedia](https://en.wikipedia.org/wiki/Double-elimination_tournament) — bracket structure, minor/major rounds, bracket reset.
- [DerbyNet](https://derbynet.org/) — the closest prior art: a pinewood-derby race-management web server with separate check-in, on-deck, big-screen, and race-crew views. Its multi-display-from-one-tablet model is the shape being copied here.
- [brackets-viewer.js](https://github.com/Drarig29/brackets-viewer.js/) (MIT) and [brackets-manager.js](https://github.com/Drarig29/brackets-manager.js/) — considered and rejected; see §2.
- [react-tournament-brackets](https://github.com/g-loot/react-tournament-brackets) (LGPL-2.1) — considered and rejected; see §2.
