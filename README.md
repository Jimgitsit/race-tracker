# race-tracker

A double-elimination bracket tracker for a Hot Wheels race. No times, no scores — each heat
has one winner and one loser.

**Live:** <https://jimmcgowen.com/race-tracker/>

Four views:

- **`/`** — racers, on their phones. Enter your name to register, optionally upload a photo
  of your car, then watch the bracket and your own status line.
- **`/director`** — the race director, on a phone. Password-gated. Two giant tap targets;
  tap the car that won.
- **`/display`** — the big screen. A giant join QR during registration, the live bracket
  during the race, the podium at the end. Drivable with a TV remote.
- **`/history`** — past years.

## How it works

The whole event is `(seeded racers) + (an ordered log of results)`. Every read replays that
log through a pure bracket engine, so **undo is just popping the log** — no incremental
unwinding, and no way for the bracket and the results to disagree. `matches` and `edges` hold
stable ids and playing order; `results_log` is the authority for outcomes.

Live updates are SSE, pushing the entire state payload on every change. That same payload is
what gets frozen into `archives` at the end of a year, so `/history` renders past races with
the same components and no duplicate code.

See [`DESIGN.md`](DESIGN.md) for the full spec — the double-elimination algorithm, the
schema, the API, and why each of those calls was made.

## Running it

```sh
bun install
bun run fonts     # one-off: self-host the three typefaces
bun run icon      # one-off: generate the home-screen icon
bun run build     # build the client into dist/
bun run start     # serve everything on :58013
bun run test      # bracket engine + full domain suite
```

For UI work, `bun run dev` runs Vite on :58014 and proxies the API to the Bun server, which
still needs to be running.

The server tolerates the `/race-tracker` prefix being present or absent, so the same
relative URLs work behind nginx, on the Vite dev server, and hitting `:58013` directly.

## Race day

- **Director password** is one `const` in `src/config.ts`. Anyone who reads this repo can
  read it; that's an accepted tradeoff for a backyard race.
- **Multiple director devices are supported** — one person tapping winners, another
  marshalling racers. Recording an already-decided heat is rejected, so they can't desync.
- **Put the join QR on the big screen** before anyone arrives. It's the whole onboarding
  story; nobody is going to type the URL.
- **Review names before locking the roster.** They go six feet tall on a TV.
- ~30 racers is a 32-slot bracket, 62 heats, roughly two hours on one track. The optional
  16-racer consolation bracket adds 15 more and can be interleaved once people are out.

## Deployment

launchd user agent `com.jim.race-tracker` on port **58013**, nginx route `/race-tracker/`
with `proxy_buffering off` (SSE silently doesn't arrive through a buffering proxy).

```sh
launchctl kickstart -k gui/501/com.jim.race-tracker   # restart after a change
```

Finished years are archived locally and pushed to `s3://jimmcgowen-race-tracker/`, off the
critical path. `data/` is gitignored — the database and uploaded photos never get committed.
