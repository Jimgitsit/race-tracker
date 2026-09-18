# race-tracker

Double-elimination bracket tracker for an annual Hot Wheels race.

- **Read [`DESIGN.md`](DESIGN.md)** — it's the spec, and it's current.
- **Read [`wiki/projects/race-tracker.md`](../wiki/projects/race-tracker.md)** for
  status, decisions and how it runs (port, launchd agent, deploy).
- **Read [`wiki/notes/race-tracker-gotchas.md`](../wiki/notes/race-tracker-gotchas.md)**
  before touching the bracket engine, the display fit maths or the stylesheet — the
  traps there have each already cost a debugging session.

## Tripwires

- **The live event may be a race in progress.** Check `heatsDone` before assuming
  otherwise, and **never write to it to test a UI change** — drive the client over CDP
  instead. `undoLast()` deletes the *newest* results row, not the one you wrote, so a
  result landing between your POST and your undo means you delete theirs. This has
  happened: a real heat was wiped mid-event. A 409 from `/result` means someone beat
  you to it — **stop, do not undo.**
- **Never import `src/config.ts` from client code** — it holds the director password.
  `src/shared/config.ts` is the client-safe half.
- **Run `bun run test` after any change to `src/shared/bracket.ts`.** 116 of the tests
  are standalone and catch bracket regressions the UI won't show you. Tests run against
  `.test-data/`, not the live database.
- **No PRs on this project.** Merge to local `main`, `bun run build`, then
  `launchctl kickstart -k gui/501/com.jim.race-tracker`.

## Deviating from the doc

If you find a reason the design is wrong, say so and update `DESIGN.md` in the same
pass. A stale spec is worse than no spec.
