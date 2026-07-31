/**
 * End-to-end exercise of the domain layer against a scratch database: register,
 * lock, race, undo, run a consolation bracket, archive, and refuse a destructive
 * reset. Runs the real 30-racer field the event will actually have.
 *
 *   RACE_TRACKER_DATA_DIR=.test-data bun test
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { DATA_DIR } from "../src/config.ts";
import { closeDb } from "../src/server/db.ts";
import {
  RaceError,
  archiveYear,
  consolationCandidates,
  listArchives,
  lockRoster,
  recordResult,
  registerRacer,
  removeRacer,
  resetEvent,
  snapshot,
  startConsolation,
  undoLast,
} from "../src/server/race.ts";

const FIELD = 30;

const NAMES = Array.from({ length: FIELD }, (_, i) => `Racer ${i + 1}`);

beforeAll(() => {
  closeDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/** Run heats until the race is decided, returning how many were actually raced. */
function raceToCompletion(pick: (a: number, b: number) => number): number {
  let heats = 0;

  for (let guard = 0; guard < 200; guard += 1) {
    const state = snapshot();
    if (state.event.phase === "complete") {
      return heats;
    }

    const nextId = state.queue.find((id) => {
      const match = state.matches.find((m) => m.id === id)!;
      return match.bracket !== "C";
    });

    if (nextId === undefined) {
      return heats;
    }

    const match = state.matches.find((m) => m.id === nextId)!;
    recordResult(match.id, pick(match.a!, match.b!));
    heats += 1;
  }

  throw new Error("race did not finish");
}

describe("registration", () => {
  test("accepts a field and rejects duplicates", () => {
    for (const name of NAMES) {
      registerRacer(name);
    }

    const state = snapshot();
    expect(state.event.phase).toBe("registration");
    expect(state.event.racerCount).toBe(FIELD);
    expect(state.racers.every((r) => r.status === "waiting")).toBe(true);

    // Case-insensitive, whitespace-normalised.
    expect(() => registerRacer("racer 1")).toThrow(RaceError);
    expect(() => registerRacer("  Racer   1  ")).toThrow(RaceError);
    expect(() => registerRacer("   ")).toThrow(RaceError);
  });

  test("a removed racer frees their name", () => {
    const { racer } = registerRacer("Temporary");
    expect(snapshot().event.racerCount).toBe(FIELD + 1);

    removeRacer(racer.id);
    expect(snapshot().event.racerCount).toBe(FIELD);

    registerRacer("Temporary");
    removeRacer(snapshot().racers.find((r) => r.name === "Temporary")!.id);
    expect(snapshot().event.racerCount).toBe(FIELD);
  });
});

describe("locking", () => {
  test("builds a 32-slot bracket with byes already resolved", () => {
    lockRoster();
    const state = snapshot();

    expect(state.event.phase).toBe("racing");
    expect(state.event.bracketSize).toBe(32);
    expect(state.event.byeCount).toBe(2);
    expect(state.event.rounds).toBe(5);

    // 62 playable heats, minus the reset which has not been populated.
    expect(state.matches.filter((m) => m.bracket !== "GFR").length).toBe(62);

    const byes = state.matches.filter((m) => m.state === "bye");
    expect(byes.length).toBe(2);

    // Nothing raceable may contain a bye.
    for (const match of state.matches.filter((m) => m.state === "ready")) {
      expect(match.a).not.toBe(0);
      expect(match.b).not.toBe(0);
    }

    expect(state.queue.length).toBe(14);
    expect(state.event.currentMatch).toBe(state.queue[0]);
    expect(state.racers.every((r) => r.seed !== null)).toBe(true);
  });

  test("locking twice is refused", () => {
    expect(() => lockRoster()).toThrow(RaceError);
  });
});

describe("recording results", () => {
  test("a recorded heat advances the bracket and the current match", () => {
    const before = snapshot();
    const match = before.matches.find((m) => m.id === before.event.currentMatch)!;

    recordResult(match.id, match.a!);
    const after = snapshot();

    const updated = after.matches.find((m) => m.id === match.id)!;
    expect(updated.state).toBe("done");
    expect(updated.winner).toBe(match.a);
    expect(after.event.currentMatch).not.toBe(match.id);
    expect(after.canUndo).toBe(true);

    const winner = after.racers.find((r) => r.id === match.a)!;
    const loser = after.racers.find((r) => r.id === match.b)!;
    expect(winner.wins).toBe(1);
    expect(loser.losses).toBe(1);
    expect(loser.beatenBy).toEqual([match.a!]);
  });

  test("the same heat cannot be recorded twice", () => {
    const state = snapshot();
    const done = state.matches.find((m) => m.state === "done")!;

    // This is the guard that stops two director phones desyncing the bracket.
    expect(() => recordResult(done.id, done.winner!)).toThrow(RaceError);
  });

  test("a racer not in the heat cannot win it", () => {
    const state = snapshot();
    const ready = state.matches.find((m) => m.state === "ready")!;
    const outsider = state.racers.find((r) => r.id !== ready.a && r.id !== ready.b)!;

    expect(() => recordResult(ready.id, outsider.id)).toThrow(RaceError);
  });

  test("a bye cannot be recorded", () => {
    const state = snapshot();
    const bye = state.matches.find((m) => m.state === "bye");
    if (bye) {
      expect(() => recordResult(bye.id, bye.winner!)).toThrow(RaceError);
    }
  });

  test("undo rolls the bracket back", () => {
    const before = snapshot();
    const doneBefore = before.matches.filter((m) => m.state === "done").length;

    undoLast();
    const after = snapshot();

    expect(after.matches.filter((m) => m.state === "done").length).toBe(doneBefore - 1);
    expect(after.canUndo).toBe(false);

    // The undone heat is raceable again, and is what the director is pointed at.
    const restored = after.matches.find((m) => m.id === before.event.currentMatch);
    expect(after.queue.length).toBe(14);
    expect(restored).toBeDefined();
  });

  test("undo with an empty log is refused", () => {
    expect(() => undoLast()).toThrow(RaceError);
  });
});

describe("consolation bracket", () => {
  test("unlocks once enough racers are out, then interleaves into the queue", () => {
    // Race the winners side down far enough to knock people out.
    for (let guard = 0; guard < 60; guard += 1) {
      const state = snapshot();
      if (state.event.canStartConsolation) {
        break;
      }
      const nextId = state.queue[0];
      const match = state.matches.find((m) => m.id === nextId)!;
      recordResult(match.id, match.a!);
    }

    const ready = snapshot();
    expect(ready.event.canStartConsolation).toBe(true);

    const candidates = consolationCandidates();
    expect(candidates.length).toBeGreaterThanOrEqual(8);
    expect(candidates.every((r) => r.status === "out")).toBe(true);

    const entrants = candidates.slice(0, 16).map((r) => r.id);
    const queueBefore = snapshot().queue.length;
    startConsolation(entrants);

    const after = snapshot();
    expect(after.event.consolation).toBe(true);
    expect(after.event.canStartConsolation).toBe(false);

    const consolationMatches = after.matches.filter((m) => m.bracket === "C");
    expect(consolationMatches.length).toBe(entrants.length - 1);

    // Its heats join the same ready queue the director already picks from.
    expect(after.queue.length).toBeGreaterThan(queueBefore);
    expect(after.queue.some((id) => consolationMatches.some((m) => m.id === id))).toBe(true);
    expect(after.racers.filter((r) => r.inConsolation).length).toBe(entrants.length);
  });

  test("cannot be started twice", () => {
    expect(() => startConsolation([1, 2, 3, 4])).toThrow(RaceError);
  });

  test("runs to its own champion without touching the main bracket", () => {
    for (let guard = 0; guard < 40; guard += 1) {
      const state = snapshot();
      const nextId = state.queue.find((id) => {
        const match = state.matches.find((m) => m.id === id)!;
        return match.bracket === "C";
      });
      if (nextId === undefined) {
        break;
      }
      const match = state.matches.find((m) => m.id === nextId)!;
      recordResult(match.id, match.a!);
    }

    const state = snapshot();
    expect(state.event.consolationChampion).not.toBeNull();
    expect(state.event.phase).toBe("racing");
  });
});

describe("finishing", () => {
  test("the race completes with a full podium", () => {
    raceToCompletion((a) => a);
    const state = snapshot();

    expect(state.event.phase).toBe("complete");
    expect(state.event.champion).not.toBeNull();
    expect(state.event.runnerUp).not.toBeNull();
    expect(state.event.third).not.toBeNull();

    const champion = state.racers.find((r) => r.id === state.event.champion)!;
    expect(champion.status).toBe("champion");
    expect(champion.placement).toBe("1st");

    // Every racer gets a placement band, not a bare "Out".
    expect(state.racers.every((r) => r.placement !== null)).toBe(true);
    expect(state.racers.filter((r) => r.status === "out").length).toBe(FIELD - 2);
    expect(state.queue.length).toBe(0);
  });

  test("reset refuses to eat an unarchived year", () => {
    expect(() => resetEvent()).toThrow(RaceError);
    expect(snapshot().event.phase).toBe("complete");
  });

  test("archiving freezes the year and reopens registration", () => {
    const finished = snapshot();
    const year = finished.event.year;
    const championName = finished.racers.find((r) => r.id === finished.event.champion)!.name;

    const row = archiveYear();
    expect(row.year).toBe(year);
    expect(row.champion).toBe(championName);
    expect(row.racer_count).toBe(FIELD);

    const after = snapshot();
    expect(after.event.phase).toBe("registration");
    expect(after.event.year).toBe(year + 1);
    expect(after.event.racerCount).toBe(0);
    expect(after.matches.length).toBe(0);
    expect(after.event.consolation).toBe(false);

    const archives = listArchives();
    expect(archives.length).toBe(1);
    expect(archives[0].year).toBe(year);
    expect(archives[0].consolation_champion).not.toBeNull();

    // The frozen payload is exactly what the live client renders.
    const frozen = JSON.parse(row.state);
    expect(frozen.racers.length).toBe(FIELD);
    expect(frozen.matches.length).toBeGreaterThan(60);
    expect(frozen.event.champion).toBe(finished.event.champion);
  });

  test("a fresh year starts clean and can be reset freely", () => {
    registerRacer("Next Year Racer");
    expect(snapshot().event.racerCount).toBe(1);

    resetEvent();
    expect(snapshot().event.racerCount).toBe(0);
    expect(snapshot().event.phase).toBe("registration");
    expect(listArchives().length).toBe(1);
  });
});
