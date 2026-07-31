# race-tracker

A dead-simple double-elimination bracket tracker for a Hot Wheels race. No times, no
scores — each heat has one winner and one loser.

Three views:

- **`/`** — racers, on their phones. Enter your name to register, optionally upload a photo
  of your car, then watch the bracket.
- **`/director`** — the race director, on a phone. Password-gated. Shows who's up; tap the
  car that won.
- **`/display`** — the whole bracket on a big screen. No interaction, auto-updating.

**Not built yet.** See [`DESIGN.md`](DESIGN.md) for the full design.

## Stack

Bun + SQLite + React/Vite. Runs on port 58013, served at `https://jimmcgowen.com/race-tracker/`.
