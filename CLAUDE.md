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
- **Two QR types, different exposure rules.** The join QR is a bare URL and is safe anywhere.
  The re-link QR carries a racer's token and must never reach the big screen. They're
  separate components on purpose.
- **nginx needs `proxy_buffering off`** for `/race-tracker/`, or SSE silently never arrives.

## Deviating from the doc

If you find a reason the design is wrong, say so and update `DESIGN.md` in the same pass.
A stale spec is worse than no spec.
