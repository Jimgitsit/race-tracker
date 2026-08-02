# race-tracker

Double-elimination bracket tracker for an annual Hot Wheels race.
**Read [`DESIGN.md`](DESIGN.md)** — it's the spec, and it's current.

## Quick facts

- Port **58013**, launchd agent `com.jim.race-tracker`, mounted at
  `https://jimmcgowen.com/race-tracker/`. Restart:
  `launchctl kickstart -k gui/501/com.jim.race-tracker`.
- Bun + SQLite (`bun:sqlite`, `data/race.db`, WAL) + React 19/Vite. No bracket library.
- Director password is one `const` in `src/config.ts` (server-only — never import it from
  client code; `src/shared/config.ts` is the client-safe half).
- `data/` is gitignored: the DB and uploaded photos never get committed.
- `bun run test` runs against `.test-data/`, not the live database.

## Architecture, in one paragraph

`src/shared/bracket.ts` is **pure** — no DB, no Bun APIs — and is the only place the
double-elimination rules live. Live state is `play(structure, seeds, resultsLog)`, recomputed
from scratch on every read. That is why **undo is just deleting the last `results_log` row**:
byes cascade (a bye dropping into the losers bracket hands a free pass to whoever arrives
later), and unwinding a cascade incrementally is where double-elim implementations go wrong.
`matches`/`edges` carry stable ids, source labels and playing order; `results_log` is the
authority for outcomes and gets written back into those tables after each mutation so the DB
stays inspectable.

## Things that will bite you

- **The bracket engine has a standalone test suite.** Change `src/shared/bracket.ts` and run
  `bun run test` before anything else — 116 of the tests never touch the DB or the UI.
- **The grand final is the one conditional edge** in the whole bracket and is special-cased
  in `play()`, not in the `edges` table. Don't try to move it there.
- **The display groups columns by bracket, not by playing order.** Playing order interleaves
  W and L rounds, which sends every advancement line crossing behind an unrelated column.
- **Display fit maths measures `clientHeight`**, which includes padding — so `.disp-canvas`
  must stay padding-free or the bracket clips at the bottom. Padding goes inside the scaled
  content.
- **A shrink-to-fit box can't tell you how much room you have.** The registration roster
  sizes its cards from `.disp-grid`'s own height, which is only the *available* height
  because the rule says `flex: 1`. Without it the box is as tall as its content, so three
  cars measure a short box, pick small cards, and stay small — the fit reads back its own
  output. Same family as the `.disp-tree` ratchet below.
- **Fit measures `.disp-tree`, never `.disp-scale`.** The wrapper also holds the connector
  SVG, which is sized *from* that measurement — measure the wrapper and the size becomes its
  own input. It ratchets (the SVG props up `scrollHeight`), the measured height can never
  shrink, and fit stays pinned at whatever the tallest layout ever needed. This shipped: a
  single-bracket filter rendered at half the scale it should have.
- **The big screen also renders on a phone** (spectators can flip to it), so it must survive
  portrait. Two rules keep it honest: clamp against **`vmin`, not `vh`** (identical on any
  landscape viewport, so the TV never changes), and use **`minmax(0, …)` grid tracks, never a
  bare `1fr`** — `1fr` floors at min-content and the banner blows past the screen width.
- **The big screen runs on a laptop in Chrome, HDMI'd to the TV — not in the TV's browser.**
  That was tried on an LG and abandoned: Vite 6 defaults to `build.target:
  baseline-widely-available` (Chrome 107+) and webOS browsers are well behind it, so the
  bundle doesn't run at all, before any question of layout. Don't spend effort making
  `/display` work in a TV browser, and don't downlevel the build target for one.
- **A React `onWheel` prop cannot `preventDefault()`.** React registers wheel on its root as
  passive, so the page scrolls out from under you. The canvas zoom is a native
  `addEventListener("wheel", …, { passive: false })` for exactly this reason.
- **`useResultFlash` is always one render late in a child.** Effects run child-before-parent,
  and the flash is set in an effect in `Racing` — so on the render where a result lands,
  `BracketCanvas` still sees the old value. A guard like `if (flash !== null) return;` in a
  child cannot work. Put the delay in the state being watched (follow mode lags its *target*
  by `FLASH_MS`), never in the reaction.
- **`background: linear-gradient(…, var(--surface) 60%)` is a card-killer.** `background` is
  the shorthand, so it resets `background-color` and the tinted end composites onto the page
  instead of the card. Always `linear-gradient(…, transparent 60%), var(--surface)`. Four
  rules have had this bug; grep before adding a fifth.
- **The bracket columns are one component** (`components/Bracket.tsx`), used by the racer
  view, the director's next-heat sheet and `/history`. Their CSS still carries the `rc-`
  prefix it was born with in the racer view but lives in `components.css`. Adding a fourth
  copy of `roundsOf(...).map(...)` is how the bracket names drift.
- **`.dir-pick` was already taken** by a consolation-picker row when the next-heat sheet
  wanted it, and CSS merges silently: the new rule won `display` and the old one kept
  `align-items: center`, so the sheet's controls shrank to their content and the columns
  overflowed instead of scrolling. Grep the stylesheet before naming a class.
- **The contrast ramp assumes a card lands on `--ground`.** `.mc` and `.sheet` are both
  `var(--surface)` — the same hex — so a match card put straight into a sheet has a 1px
  border and its left rail and nothing else. Any surface-coloured container that holds cards
  has to re-establish the ~12 ΔL* step with a `--ground` well of its own.
- **Colour lives in `tokens.css`.** Two hardcoded copies exist on purpose and drift silently
  when the ramp moves: `QR.tsx` (the encoder takes hex, not `var()`) and the `.disp` vignette
  in `display.css`, hand-tuned to sit ~2 L\* over `--ground`. Change a token, check both.
- **The launch clip is CC0.** `src/client/assets/dragster-launch.mp3` is cut from
  [freesound 637195](https://freesound.org/s/637195/) by *kyles*, public domain. If you ever
  swap it, keep it CC0 or a licence that permits redistribution — this repo is public, and
  ripping audio from a streaming site is not an option however private the event is.
- **Two QR types, different exposure rules.** The join QR is a bare URL and is safe anywhere.
  The re-link QR carries a racer's token and must never reach the big screen. They're
  separate components on purpose.
- **nginx needs `proxy_buffering off`** for `/race-tracker/`, or SSE silently never arrives.

## Testing against the running event

**The event at `jimmcgowen.com/race-tracker/` may be a race in progress.** Check
`heatsDone` before assuming otherwise, and never write to it to test a UI change.

- **`undoLast()` deletes the newest `results_log` row, whatever it is** — not the row you
  wrote. If a result lands between your POST and your undo, you delete *theirs*. This has
  happened: a real heat was wiped mid-event and had to be re-recorded. A 409 from
  `/result` ("that heat has already been recorded") means someone beat you to it —
  **stop, do not undo.**
- **Drive the UI from the client instead.** Wrap `window.EventSource` via
  `Page.addScriptToEvaluateOnNewDocument`, keep the last payload, and push a doctored copy
  to synthesise a result, a phase change or a full bracket. Set a freeze flag in the wrapper
  so real pushes can't overwrite the fixture mid-measurement. The server never hears from
  you. Working example: the flash/follow tests in this session.
- Uploaded photos and messages are equally live — `messages` rows written by a test show up
  on every racer's phone.

## Deviating from the doc

If you find a reason the design is wrong, say so and update `DESIGN.md` in the same pass.
A stale spec is worse than no spec.
