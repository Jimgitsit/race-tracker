/**
 * End-to-end exercise of the domain layer against a scratch database: register,
 * lock, race, undo, run a consolation bracket, and reset — which archives a
 * finished race on the way out. Runs the real 30-racer field the event will
 * actually have.
 *
 *   RACE_TRACKER_DATA_DIR=.test-data bun test
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

import { DATA_DIR, PHOTOS_DIR } from "../src/config.ts";
import { BYE_ID } from "../src/shared/config.ts";
import { closeDb } from "../src/server/db.ts";
import {
  RaceError,
  clearRacerPhoto,
  consolationCandidates,
  listArchives,
  lockRoster,
  messagesFor,
  racerByToken,
  recordResult,
  registerRacer,
  removeRacer,
  sendMessage,
  setRacerChecks,
  setRacerPhoto,
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

  test("inspection and entry fee are separate sign-offs that toggle both ways", () => {
    const racer = snapshot().racers[0]!;
    expect(racer.inspected).toBe(false);
    expect(racer.paid).toBe(false);

    setRacerChecks(racer.id, { inspected: true });
    let after = snapshot().racers.find((r) => r.id === racer.id)!;
    expect(after.inspected).toBe(true);
    expect(after.paid).toBe(false);

    setRacerChecks(racer.id, { paid: true, inspected: false });
    after = snapshot().racers.find((r) => r.id === racer.id)!;
    expect(after.inspected).toBe(false);
    expect(after.paid).toBe(true);

    // An empty patch is a no-op, not an error; a missing racer is.
    setRacerChecks(racer.id, {});
    expect(snapshot().racers.find((r) => r.id === racer.id)!.paid).toBe(true);
    expect(() => setRacerChecks(999_999, { paid: true })).toThrow(RaceError);
    expect(() => setRacerChecks(BYE_ID, { paid: true })).toThrow(RaceError);

    setRacerChecks(racer.id, { paid: false });
  });

  test("clearing a photo NULLs the columns and deletes the files", () => {
    const racer = snapshot().racers[1]!;
    const year = new Date().getFullYear();
    mkdirSync(`${PHOTOS_DIR}/${year}`, { recursive: true });
    writeFileSync(`${PHOTOS_DIR}/${year}/${racer.id}.jpg`, "full");
    writeFileSync(`${PHOTOS_DIR}/${year}/${racer.id}-t.jpg`, "thumb");
    setRacerPhoto(racer.id, `photos/${year}/${racer.id}.jpg?v=1`, `photos/${year}/${racer.id}-t.jpg?v=1`);
    expect(snapshot().racers.find((r) => r.id === racer.id)!.photo).toContain(`${racer.id}.jpg`);

    clearRacerPhoto(racer.id);
    const after = snapshot().racers.find((r) => r.id === racer.id)!;
    expect(after.photo).toBeNull();
    expect(after.thumb).toBeNull();
    expect(existsSync(`${PHOTOS_DIR}/${year}/${racer.id}.jpg`)).toBe(false);
    expect(existsSync(`${PHOTOS_DIR}/${year}/${racer.id}-t.jpg`)).toBe(false);

    // Clearing again is a no-op; a missing racer is an error.
    clearRacerPhoto(racer.id);
    expect(() => clearRacerPhoto(999_999)).toThrow(RaceError);
    expect(() => clearRacerPhoto(BYE_ID)).toThrow(RaceError);
  });
});

describe("token identity", () => {
  // Every token-authenticated endpoint goes through this — /api/me, the rename,
  // and the photo upload. It shipped broken once because the SQL had two
  // placeholders and bound one value, which the type parameter happily hid.
  test("resolves a real racer and refuses anything else", () => {
    const { token, racer } = registerRacer("Token Holder");

    const found = racerByToken(token);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(racer.id);
    expect(found!.name).toBe("Token Holder");

    expect(racerByToken("not-a-real-token")).toBeNull();
    expect(racerByToken(null)).toBeNull();
    expect(racerByToken("")).toBeNull();

    removeRacer(racer.id);
    expect(racerByToken(token)).toBeNull();
  });

  test("the bye sentinel is not reachable by token", () => {
    // Its row exists so that a bye is never NULL, but it must never authenticate.
    expect(racerByToken(" bye-token")).toBeNull();
  });
});

describe("director messages", () => {
  test("broadcasts are public, direct messages are not", () => {
    const alice = snapshot().racers[0];
    const bob = snapshot().racers[1];

    sendMessage("Track is open.", null);
    sendMessage("Where are you?", alice.id);

    const state = snapshot();

    // The state payload is served without auth, so a direct message must never
    // appear anywhere in it — not even as metadata about who was messaged.
    expect(state.announcements.map((a) => a.body)).toEqual(["Track is open."]);
    expect(JSON.stringify(state)).not.toContain("Where are you?");
    expect(state.messageEpoch).toBeGreaterThan(0);

    const forAlice = messagesFor(alice.id);
    expect(forAlice.map((m) => m.body).sort()).toEqual(["Track is open.", "Where are you?"]);
    expect(forAlice.find((m) => m.body === "Where are you?")!.direct).toBe(true);

    const forBob = messagesFor(bob.id);
    expect(forBob.map((m) => m.body)).toEqual(["Track is open."]);
  });

  test("the epoch moves on every message so clients know to refetch", () => {
    const before = snapshot().messageEpoch;
    sendMessage("Another one.", null);
    expect(snapshot().messageEpoch).toBeGreaterThan(before);
  });

  test("rejects empty, overlong, and unknown recipients", () => {
    expect(() => sendMessage("   ", null)).toThrow(RaceError);
    expect(() => sendMessage("x".repeat(141), null)).toThrow(RaceError);
    expect(() => sendMessage("hello", 99999)).toThrow(RaceError);
    expect(() => sendMessage("hello", BYE_ID)).toThrow(RaceError);
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

  test("the queue runs the winners bracket first, shuffled but stable", () => {
    // Play winners heats until a losers heat becomes ready (its two feeders are
    // whichever winners heats the shuffle put together, so this takes a few).
    let played = 0;
    const losersReady = () => {
      const s = snapshot();
      return s.queue.some((id) => s.matches.find((m) => m.id === id)!.bracket === "L");
    };
    while (!losersReady()) {
      const state = snapshot();
      const match = state.matches.find((m) => m.id === state.event.currentMatch)!;
      recordResult(match.id, match.a!);
      played += 1;
    }

    const state = snapshot();
    const byId = new Map(state.matches.map((m) => [m.id, m]));
    const brackets = state.queue.map((id) => byId.get(id)!.bracket);
    expect(brackets).toContain("L");
    expect(brackets.lastIndexOf("W")).toBeLessThan(brackets.indexOf("L"));

    // Not slot order within the bracket, but the same order on every read.
    const winners = state.queue.filter((id) => byId.get(id)!.bracket === "W");
    const slots = winners.map((id) => byId.get(id)!.orderIndex);
    expect(slots).not.toEqual([...slots].sort((x, y) => x - y));
    expect(snapshot().queue).toEqual(state.queue);

    // Leave the log as the next tests expect it: one result.
    for (let i = 0; i < played; i += 1) {
      undoLast();
    }
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

  test("reset archives a finished race under its year and reopens registration", () => {
    const finished = snapshot();
    const year = finished.event.year;
    const championName = finished.racers.find((r) => r.id === finished.event.champion)!.name;

    // Give the champion a car so the archive has a photo to freeze.
    const champ = finished.event.champion!;
    mkdirSync(`${PHOTOS_DIR}/${year}`, { recursive: true });
    writeFileSync(`${PHOTOS_DIR}/${year}/${champ}.jpg`, "full");
    writeFileSync(`${PHOTOS_DIR}/${year}/${champ}-t.jpg`, "thumb");
    setRacerPhoto(champ, `photos/${year}/${champ}.jpg?v=1`, `photos/${year}/${champ}-t.jpg?v=1`);

    const row = resetEvent()!;
    expect(row).not.toBeNull();
    expect(row.year).toBe(year);
    expect(row.champion).toBe(championName);
    expect(row.racer_count).toBe(FIELD);

    const after = snapshot();
    expect(after.event.phase).toBe("registration");
    expect(after.event.year).toBe(new Date().getFullYear());
    expect(after.event.racerCount).toBe(0);
    expect(after.matches.length).toBe(0);
    expect(after.event.consolation).toBe(false);

    const archives = listArchives();
    expect(archives.length).toBe(1);
    expect(archives[0].year).toBe(year);
    expect(archives[0].consolation_champion).not.toBeNull();

    // The frozen payload is exactly what the live client renders — except the
    // photos, which point at the archive's own copies so later uploads can't
    // overwrite them.
    const frozen = JSON.parse(row.state);
    expect(frozen.racers.length).toBe(FIELD);
    expect(frozen.matches.length).toBeGreaterThan(60);
    expect(frozen.event.champion).toBe(finished.event.champion);
    const frozenChamp = frozen.racers.find((r: { id: number }) => r.id === champ);
    expect(frozenChamp.photo).toBe(`photos/archive/${year}/${champ}.jpg?v=1`);
    expect(frozenChamp.thumb).toBe(`photos/archive/${year}/${champ}-t.jpg?v=1`);
    expect(existsSync(`${PHOTOS_DIR}/archive/${year}/${champ}.jpg`)).toBe(true);
    expect(existsSync(`${PHOTOS_DIR}/archive/${year}/${champ}-t.jpg`)).toBe(true);
  });

  test("saving again in the same year replaces the earlier race entirely", () => {
    const before = listArchives()[0]!;
    for (const name of ["Rerun A", "Rerun B", "Rerun C", "Rerun D"]) {
      registerRacer(name);
    }
    lockRoster();
    // Play every heat in order until the bracket is done.
    for (let guard = 0; guard < 20 && snapshot().event.phase === "racing"; guard++) {
      const heat = snapshot().matches.find((m) => m.state === "ready")!;
      recordResult(heat.id, heat.a!);
    }
    const rerun = snapshot();
    expect(rerun.event.phase).toBe("complete");
    const rerunChampion = rerun.racers.find((r) => r.id === rerun.event.champion)!.name;

    const row = resetEvent({ keepRacers: false })!;
    expect(row.year).toBe(before.year);
    const archives = listArchives();
    expect(archives.length).toBe(1);
    expect(archives[0].racer_count).toBe(4);
    expect(archives[0].champion).toBe(rerunChampion);
    expect(archives[0].champion).not.toBe(before.champion);
  });

  test("a test run can be reset without saving", () => {
    for (const name of ["Test A", "Test B", "Test C", "Test D"]) {
      registerRacer(name);
    }
    lockRoster();
    for (let guard = 0; guard < 20 && snapshot().event.phase === "racing"; guard++) {
      const heat = snapshot().matches.find((m) => m.state === "ready")!;
      recordResult(heat.id, heat.b!);
    }
    expect(snapshot().event.phase).toBe("complete");

    const saved = listArchives()[0]!;
    expect(resetEvent({ save: false })).toBeNull();
    expect(listArchives()[0]).toEqual(saved);
    expect(snapshot().event.racerCount).toBe(0);
  });

  test("resetting from registration archives nothing", () => {
    registerRacer("Next Year Racer");
    expect(snapshot().event.racerCount).toBe(1);

    expect(resetEvent()).toBeNull();
    expect(snapshot().event.racerCount).toBe(0);
    expect(snapshot().event.phase).toBe("registration");
    expect(listArchives().length).toBe(1);
  });

  test("reset can keep the roster and only drop the bracket", () => {
    for (const name of ["Keep A", "Keep B", "Keep C", "Keep D"]) {
      registerRacer(name);
    }
    const kept = snapshot().racers[0]!;
    setRacerChecks(kept.id, { inspected: true, paid: true });
    lockRoster();

    const racing = snapshot();
    expect(racing.event.phase).toBe("racing");
    const heat = racing.matches.find((m) => m.state === "ready")!;
    recordResult(heat.id, heat.a!);

    resetEvent({ keepRacers: true });
    const after = snapshot();
    expect(after.event.phase).toBe("registration");
    expect(after.matches.length).toBe(0);
    expect(after.event.heatsDone).toBe(0);
    expect(after.event.racerCount).toBe(4);
    expect(after.racers.every((r) => r.seed === null)).toBe(true);
    expect(after.racers.find((r) => r.id === kept.id)).toMatchObject({
      inspected: true,
      paid: true,
    });

    resetEvent();
    expect(snapshot().event.racerCount).toBe(0);
  });
});
