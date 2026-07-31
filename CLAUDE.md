# race-tracker

**Read [`DESIGN.md`](DESIGN.md) before doing anything here.** It's the spec: scope, stack,
the three views, the double-elimination algorithm, schema, API, and build order.

Nothing is built yet. Follow the build order in DESIGN.md §9 — in particular, get bracket
generation (§4) right and tested standalone *before* building UI on top of it.

## Quick facts

- Port **58013**, mounted at `https://jimmcgowen.com/race-tracker/` (Vite `base` must match).
- Bun + SQLite (`bun:sqlite`, `data/race.db`) + React 19/Vite. No bracket library — see §2.
- Director password is one `const` in `src/config.ts`.
- `data/` is gitignored — the DB and uploaded photos never get committed.

## Deviating from the doc

If you find a reason the design is wrong, say so and update `DESIGN.md` in the same pass.
A stale spec is worse than no spec.
