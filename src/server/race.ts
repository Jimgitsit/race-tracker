/**
 * Domain logic: registration, locking, results, undo, consolation, archiving.
 *
 * The matches/edges tables carry stable ids, sources and playing order, and are
 * written back after every mutation so the DB is a truthful record. But the
 * authority for *outcomes* is `results_log` — every read replays it through the
 * pure engine (DESIGN §4.3). That is what makes undo a one-liner.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { PHOTOS_DIR } from "../config.ts";
import {
  ARCHIVE_SCHEMA_VERSION,
  BYE_ID,
  CONSOLATION_MIN_ELIMINATED,
  CONSOLATION_SIZE,
  MIN_RACERS,
} from "../shared/config.ts";
import {
  bracketSizeFor,
  buildConsolationStructure,
  buildStructure,
  matchRef,
  placementLabel,
  play,
  roundLabel,
  type BracketKind,
  type LiveMatch,
  type MatchState,
  type Result,
  type SlotName,
  type Structure,
} from "../shared/bracket.ts";
import {
  db,
  type ArchiveRow,
  type EdgeRow,
  type EventRow,
  type MatchRow,
  type MessageRow,
  type RacerRow,
  type ResultRow,
} from "./db.ts";

export type Phase = "registration" | "racing" | "complete";

export type PublicRacer = {
  id: number;
  name: string;
  photo: string | null;
  thumb: string | null;
  seed: number | null;
  wins: number;
  losses: number;
  status: "waiting" | "racing" | "one-loss" | "out" | "champion" | "runner-up";
  placement: string | null;
  beatenBy: number[];
  nextMatch: number | null;
  inConsolation: boolean;
  inspected: boolean;
  paid: boolean;
};

export type PublicMatch = {
  id: number;
  bracket: BracketKind;
  round: number;
  slot: number;
  code: string;
  label: string;
  a: number | null;
  b: number | null;
  aSource: string | null;
  bSource: string | null;
  winner: number | null;
  state: MatchState;
  orderIndex: number;
};

export type PublicEdge = {
  from: number;
  outcome: "W" | "L";
  to: number;
  toSlot: SlotName;
};

export type Announcement = {
  id: number;
  body: string;
  at: number;
};

export type PublicMessage = Announcement & { direct: boolean };

export type StatePayload = {
  /** Broadcasts only. Direct messages are fetched with a racer token. */
  announcements: Announcement[];
  /** Bumps on any message, including direct ones, so clients know to refetch. */
  messageEpoch: number;
  event: {
    name: string;
    year: number;
    phase: Phase;
    bracketSize: number | null;
    rounds: number | null;
    currentMatch: number | null;
    consolation: boolean;
    champion: number | null;
    runnerUp: number | null;
    third: number | null;
    consolationChampion: number | null;
    racerCount: number;
    byeCount: number;
    heatsTotal: number;
    heatsDone: number;
    canStartConsolation: boolean;
  };
  racers: PublicRacer[];
  matches: PublicMatch[];
  edges: PublicEdge[];
  queue: number[];
  canUndo: boolean;
};

// ---------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------

function eventRow(): EventRow {
  return db().query<EventRow, []>("SELECT * FROM event WHERE id = 1").get()!;
}

function racerRows(): RacerRow[] {
  return db()
    .query<RacerRow, [number]>("SELECT * FROM racers WHERE id != ? ORDER BY created_at, id")
    .all(BYE_ID);
}

function matchRows(): MatchRow[] {
  return db().query<MatchRow, []>("SELECT * FROM matches ORDER BY order_index").all();
}

function resultRows(): ResultRow[] {
  return db().query<ResultRow, []>("SELECT * FROM results_log ORDER BY id").all();
}

function refOf(row: { bracket: string; round: number; slot: number }): string {
  return matchRef(row.bracket as BracketKind, row.round, row.slot);
}

type Replay = {
  main: ReturnType<typeof play> | null;
  consolation: ReturnType<typeof play> | null;
  structure: Structure | null;
  consolationStructure: Structure | null;
  idByRef: Map<string, number>;
  refById: Map<number, string>;
};

/** Rebuild both brackets from the seeds and the result log. */
function replay(): Replay {
  const event = eventRow();
  const rows = matchRows();

  const idByRef = new Map<string, number>();
  const refById = new Map<number, string>();
  for (const row of rows) {
    const ref = refOf(row);
    idByRef.set(ref, row.id);
    refById.set(row.id, ref);
  }

  const empty: Replay = {
    main: null,
    consolation: null,
    structure: null,
    consolationStructure: null,
    idByRef,
    refById,
  };

  if (event.phase === "registration" || !event.bracket_size) {
    return empty;
  }

  const racers = racerRows();
  const bySeed = new Map<number, number>();
  for (const racer of racers) {
    if (racer.seed !== null) {
      bySeed.set(racer.seed, racer.id);
    }
  }

  const log = resultRows();
  const mainResults: Result[] = [];
  const consolationResults: Result[] = [];

  for (const entry of log) {
    const ref = refById.get(entry.match_id);
    if (!ref) {
      continue;
    }
    (ref.startsWith("C-") ? consolationResults : mainResults).push({
      ref,
      winner: entry.winner,
    });
  }

  const structure = buildStructure(event.bracket_size);
  const main = play(structure, (seed) => bySeed.get(seed) ?? BYE_ID, mainResults);

  let consolationStructure: Structure | null = null;
  let consolation: ReturnType<typeof play> | null = null;

  if (event.consolation) {
    const entrants = db()
      .query<{ seed: number; racer: number }, []>(
        "SELECT seed, racer FROM consolation_entrants ORDER BY seed",
      )
      .all();

    if (entrants.length > 0) {
      const entrantBySeed = new Map(entrants.map((e) => [e.seed, e.racer]));
      consolationStructure = buildConsolationStructure(entrants.length);
      consolation = play(
        consolationStructure,
        (seed) => entrantBySeed.get(seed) ?? BYE_ID,
        consolationResults,
      );
    }
  }

  return { main, consolation, structure, consolationStructure, idByRef, refById };
}

export function snapshot(): StatePayload {
  const event = eventRow();
  const racers = racerRows();
  const rows = matchRows();
  const state = replay();

  const live = new Map<string, LiveMatch>();
  for (const source of [state.main, state.consolation]) {
    if (!source) {
      continue;
    }
    for (const [ref, match] of source.matches) {
      live.set(ref, match);
    }
  }

  const rounds = event.bracket_size ? Math.log2(event.bracket_size) : null;

  const matches: PublicMatch[] = rows.map((row) => {
    const ref = refOf(row);
    const m = live.get(ref);
    const bracket = row.bracket as BracketKind;
    const consolationRounds = state.consolationStructure?.rounds ?? 0;

    return {
      id: row.id,
      bracket,
      round: row.round,
      slot: row.slot,
      code: row.bracket === "C" ? `C${row.round}M${row.slot + 1}` : (m?.code ?? ""),
      label: roundLabel(bracket, row.round, bracket === "C" ? consolationRounds : (rounds ?? 0)),
      a: m ? m.a : row.a_racer,
      b: m ? m.b : row.b_racer,
      aSource: row.a_source,
      bSource: row.b_source,
      winner: m ? m.winner : row.winner,
      state: (m ? m.state : row.state) as MatchState,
      orderIndex: row.order_index,
    };
  });

  // Records count raced heats only — a bye advances you but nobody raced it.
  const wins = new Map<number, number>();
  const losses = new Map<number, number>();
  const beatenBy = new Map<number, number[]>();
  const nextMatch = new Map<number, number>();

  for (const match of matches) {
    if (match.state === "done" && match.winner !== null) {
      const loser = match.a === match.winner ? match.b : match.a;
      wins.set(match.winner, (wins.get(match.winner) ?? 0) + 1);
      if (loser !== null && loser !== BYE_ID) {
        losses.set(loser, (losses.get(loser) ?? 0) + 1);
        beatenBy.set(loser, [...(beatenBy.get(loser) ?? []), match.winner]);
      }
    }

    if (match.winner === null && match.bracket !== "C") {
      for (const racer of [match.a, match.b]) {
        if (racer !== null && racer !== BYE_ID && !nextMatch.has(racer)) {
          nextMatch.set(racer, match.id);
        }
      }
    }
  }

  const placements = state.main?.placements ?? new Map();
  const champion = state.main?.champion ?? null;
  const runnerUp = state.main?.runnerUp ?? null;

  const consolationEntrants = new Set(
    db()
      .query<{ racer: number }, []>("SELECT racer FROM consolation_entrants")
      .all()
      .map((r) => r.racer),
  );

  const publicRacers: PublicRacer[] = racers.map((racer) => {
    const band = placements.get(racer.id);
    let status: PublicRacer["status"] = "racing";

    if (event.phase === "registration") {
      status = "waiting";
    } else if (racer.id === champion) {
      status = "champion";
    } else if (racer.id === runnerUp) {
      status = "runner-up";
    } else if (band) {
      status = "out";
    } else if ((losses.get(racer.id) ?? 0) >= 1) {
      status = "one-loss";
    }

    return {
      id: racer.id,
      name: racer.name,
      photo: racer.photo,
      thumb: racer.thumb,
      seed: racer.seed,
      wins: wins.get(racer.id) ?? 0,
      losses: losses.get(racer.id) ?? 0,
      status,
      placement: band ? placementLabel(band) : null,
      beatenBy: beatenBy.get(racer.id) ?? [],
      nextMatch: nextMatch.get(racer.id) ?? null,
      inConsolation: consolationEntrants.has(racer.id),
      inspected: racer.inspected_at !== null,
      paid: racer.paid_at !== null,
    };
  });

  const edges: PublicEdge[] = db()
    .query<EdgeRow, []>("SELECT * FROM edges")
    .all()
    .map((edge) => ({
      from: edge.from_match,
      outcome: edge.outcome as "W" | "L",
      to: edge.to_match,
      toSlot: edge.to_slot as SlotName,
    }));

  const queue = [...(state.main?.queue ?? []), ...(state.consolation?.queue ?? [])]
    .sort((x, y) => x.orderIndex - y.orderIndex)
    .map((m) => state.idByRef.get(m.ref))
    .filter((id): id is number => id !== undefined);

  const heatsDone = matches.filter((m) => m.state === "done").length;

  // Byes are never raced and the reset usually isn't played, so counting them
  // would give the big screen a total it can never reach. This can tick down by
  // one when a losers-bracket bye resolves mid-race, which is still more honest
  // than a permanently unreachable denominator.
  const heatsTotal = matches.filter(
    (m) => m.state !== "bye" && (m.bracket !== "GFR" || m.a !== null),
  ).length;
  const eliminated = publicRacers.filter((r) => r.status === "out").length;

  const announcements = db()
    .query<MessageRow, []>(
      "SELECT * FROM messages WHERE racer IS NULL ORDER BY id DESC LIMIT 5",
    )
    .all()
    .map((row) => ({ id: row.id, body: row.body, at: row.created_at }));

  const epoch =
    db().query<{ n: number | null }, []>("SELECT MAX(id) AS n FROM messages").get()?.n ?? 0;

  return {
    announcements,
    messageEpoch: epoch,
    event: {
      name: event.name,
      year: event.year,
      phase: event.phase,
      bracketSize: event.bracket_size,
      rounds,
      currentMatch: event.current_match,
      consolation: event.consolation === 1,
      champion,
      runnerUp,
      third: state.main?.third ?? null,
      consolationChampion: state.consolation?.champion ?? null,
      racerCount: racers.length,
      byeCount: event.bracket_size ? event.bracket_size - racers.length : 0,
      heatsTotal,
      heatsDone,
      canStartConsolation:
        event.consolation === 0 &&
        event.phase === "racing" &&
        eliminated >= CONSOLATION_MIN_ELIMINATED,
    },
    racers: publicRacers,
    matches,
    edges,
    queue,
    canUndo: resultRows().length > 0,
  };
}

// ---------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------

export class RaceError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function registerRacer(rawName: string): { token: string; racer: RacerRow } {
  const name = rawName.trim().replace(/\s+/g, " ");
  if (!name) {
    throw new RaceError("Enter a name.");
  }
  if (name.length > 24) {
    throw new RaceError("That name is too long — 24 characters max.");
  }
  if (eventRow().phase !== "registration") {
    throw new RaceError("Registration has closed for this race.", 409);
  }

  const key = name.toLowerCase();
  const clash = db()
    .query<RacerRow, [string]>("SELECT * FROM racers WHERE name_key = ?")
    .get(key);

  if (clash) {
    throw new RaceError(`${clash.name} is already racing. Try adding a last initial.`, 409);
  }

  const token = randomUUID();
  db()
    .query(
      "INSERT INTO racers (name, name_key, token, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(name, key, token, Date.now());

  const racer = db()
    .query<RacerRow, [string]>("SELECT * FROM racers WHERE token = ?")
    .get(token)!;

  return { token, racer };
}

export function racerByToken(token: string | null): RacerRow | null {
  if (!token) {
    return null;
  }
  return (
    db()
      .query<RacerRow, [string, number]>("SELECT * FROM racers WHERE token = ? AND id != ?")
      .get(token, BYE_ID) ?? null
  );
}

export function renameRacer(id: number, rawName: string): void {
  const name = rawName.trim().replace(/\s+/g, " ");
  if (!name) {
    throw new RaceError("Enter a name.");
  }
  if (eventRow().phase !== "registration") {
    throw new RaceError("Names are locked once the race starts.", 409);
  }

  const key = name.toLowerCase();
  const clash = db()
    .query<RacerRow, [string, number]>(
      "SELECT * FROM racers WHERE name_key = ? AND id != ?",
    )
    .get(key, id);

  if (clash) {
    throw new RaceError(`${clash.name} is already racing.`, 409);
  }

  db().query("UPDATE racers SET name = ?, name_key = ? WHERE id = ?").run(name, key, id);
}

export function setRacerPhoto(id: number, photo: string, thumb: string): void {
  db().query("UPDATE racers SET photo = ?, thumb = ? WHERE id = ?").run(photo, thumb, id);
}

export type RacerChecks = { inspected?: boolean; paid?: boolean };

/**
 * The director's sign-off on a car: inspected, and entry fee collected. Each
 * flag is a timestamp so the row says when, not just whether; unset is NULL.
 * Not phase-gated — a late payer mid-race is still a fee to collect.
 */
export function setRacerChecks(id: number, checks: RacerChecks): void {
  const exists = db()
    .query<{ id: number }, [number, number]>("SELECT id FROM racers WHERE id = ? AND id != ?")
    .get(id, BYE_ID);

  if (!exists) {
    throw new RaceError("No such racer.", 404);
  }

  const now = Date.now();
  if (checks.inspected !== undefined) {
    db()
      .query("UPDATE racers SET inspected_at = ? WHERE id = ?")
      .run(checks.inspected ? now : null, id);
  }
  if (checks.paid !== undefined) {
    db()
      .query("UPDATE racers SET paid_at = ? WHERE id = ?")
      .run(checks.paid ? now : null, id);
  }
}

export function removeRacer(id: number): void {
  if (eventRow().phase !== "registration") {
    throw new RaceError("Racers can only be removed before the race starts.", 409);
  }
  db().query("DELETE FROM racers WHERE id = ? AND id != ?").run(id, BYE_ID);
}

/** Shuffle, seed, build the bracket, and open registration's door behind us. */
export function lockRoster(): void {
  const event = eventRow();
  if (event.phase !== "registration") {
    throw new RaceError("The race has already started.", 409);
  }

  const racers = racerRows();
  if (racers.length < MIN_RACERS) {
    throw new RaceError(`Need at least ${MIN_RACERS} racers to build a bracket.`);
  }

  const bracketSize = bracketSizeFor(racers.length);
  const structure = buildStructure(bracketSize);

  // Seeding is a shuffle — there are no qualifying times (DESIGN §4.2).
  const shuffled = [...racers];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  db().transaction(() => {
    shuffled.forEach((racer, index) => {
      db().query("UPDATE racers SET seed = ? WHERE id = ?").run(index + 1, racer.id);
    });

    writeStructure(structure);

    db()
      .query("UPDATE event SET phase = 'racing', bracket_size = ? WHERE id = 1")
      .run(bracketSize);
  })();

  refreshDerived();
  advanceCurrent();
}

/** Persist a generated structure, then hand out the row ids its edges need. */
function writeStructure(structure: Structure): void {
  const ids = new Map<string, number>();

  for (const match of structure.matches) {
    db()
      .query(
        `INSERT INTO matches (bracket, round, slot, a_source, b_source, state, order_index)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        match.bracket,
        match.round,
        match.slot,
        match.aSource,
        match.bSource,
        match.orderIndex,
      );

    const row = db()
      .query<{ id: number }, [string, number, number]>(
        "SELECT id FROM matches WHERE bracket = ? AND round = ? AND slot = ?",
      )
      .get(match.bracket, match.round, match.slot)!;

    ids.set(match.ref, row.id);
  }

  for (const edge of structure.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    db()
      .query(
        "INSERT INTO edges (from_match, outcome, to_match, to_slot) VALUES (?, ?, ?, ?)",
      )
      .run(from, edge.outcome, to, edge.toSlot);
  }
}

/** Write the replayed slot/winner/state values back so the DB stays inspectable. */
function refreshDerived(): void {
  const state = replay();
  const live = new Map<string, LiveMatch>();

  for (const source of [state.main, state.consolation]) {
    if (!source) {
      continue;
    }
    for (const [ref, match] of source.matches) {
      live.set(ref, match);
    }
  }

  db().transaction(() => {
    for (const [ref, match] of live) {
      const id = state.idByRef.get(ref);
      if (id === undefined) {
        continue;
      }
      db()
        .query(
          "UPDATE matches SET a_racer = ?, b_racer = ?, winner = ?, state = ? WHERE id = ?",
        )
        .run(match.a, match.b, match.winner, match.state, id);
    }
  })();

  if (state.main?.complete) {
    db().query("UPDATE event SET phase = 'complete' WHERE id = 1").run();
  } else if (eventRow().phase === "complete") {
    // An undo can un-finish a finished race.
    db().query("UPDATE event SET phase = 'racing' WHERE id = 1").run();
  }
}

/** Point the director at the next raceable heat, preferring the one they're on. */
function advanceCurrent(): void {
  const state = snapshot();
  const current = state.event.currentMatch;
  const stillReady = current !== null && state.queue.includes(current);

  if (stillReady) {
    return;
  }

  db()
    .query("UPDATE event SET current_match = ? WHERE id = 1")
    .run(state.queue[0] ?? null);
}

export function recordResult(matchId: number, winnerId: number): void {
  const match = db()
    .query<MatchRow, [number]>("SELECT * FROM matches WHERE id = ?")
    .get(matchId);

  if (!match) {
    throw new RaceError("No such heat.", 404);
  }

  // Two director phones tapping the same heat would otherwise double-advance the
  // bracket — this is the desync failure mode that matters (DESIGN §6).
  if (match.state === "done") {
    throw new RaceError("That heat has already been recorded.", 409);
  }
  if (match.state === "bye") {
    throw new RaceError("That heat was a bye — there is nothing to record.", 409);
  }
  if (match.a_racer === null || match.b_racer === null) {
    throw new RaceError("That heat is still waiting on a racer.", 409);
  }
  if (winnerId !== match.a_racer && winnerId !== match.b_racer) {
    throw new RaceError("That racer is not in this heat.");
  }

  db()
    .query("INSERT INTO results_log (match_id, winner, created_at) VALUES (?, ?, ?)")
    .run(matchId, winnerId, Date.now());

  refreshDerived();
  advanceCurrent();
}

/** Undo is popping the log — the engine recomputes everything downstream. */
export function undoLast(): void {
  const last = db()
    .query<ResultRow, []>("SELECT * FROM results_log ORDER BY id DESC LIMIT 1")
    .get();

  if (!last) {
    throw new RaceError("Nothing to undo.", 409);
  }

  db().query("DELETE FROM results_log WHERE id = ?").run(last.id);

  refreshDerived();
  db().query("UPDATE event SET current_match = ? WHERE id = 1").run(last.match_id);
  advanceCurrent();
}

export function setCurrentMatch(matchId: number): void {
  const state = snapshot();
  if (!state.queue.includes(matchId)) {
    throw new RaceError("That heat isn't ready to run.", 409);
  }
  db().query("UPDATE event SET current_match = ? WHERE id = 1").run(matchId);
}

export function startConsolation(racerIds: number[]): void {
  const event = eventRow();
  if (event.phase !== "racing") {
    throw new RaceError("The consolation bracket runs during the race.", 409);
  }
  if (event.consolation === 1) {
    throw new RaceError("The consolation bracket has already been built.", 409);
  }

  const unique = [...new Set(racerIds)].slice(0, CONSOLATION_SIZE);
  if (unique.length < MIN_RACERS) {
    throw new RaceError(`Pick at least ${MIN_RACERS} racers.`);
  }

  const structure = buildConsolationStructure(unique.length);

  db().transaction(() => {
    unique.forEach((racerId, index) => {
      db()
        .query("INSERT INTO consolation_entrants (seed, racer) VALUES (?, ?)")
        .run(index + 1, racerId);
    });

    writeStructure(structure);
    db().query("UPDATE event SET consolation = 1 WHERE id = 1").run();
  })();

  refreshDerived();
  advanceCurrent();
}

/** Racers who are out and could be offered a third chance, most recently out first. */
export function consolationCandidates(): PublicRacer[] {
  return snapshot()
    .racers.filter((racer) => racer.status === "out")
    .sort((x, y) => y.wins - x.wins)
    .slice(0, CONSOLATION_SIZE);
}

export function archiveYear(): ArchiveRow {
  const event = eventRow();
  if (event.phase !== "complete") {
    throw new RaceError("Finish the race before archiving it.", 409);
  }

  const state = snapshot();
  const nameOf = (id: number | null) => state.racers.find((r) => r.id === id)?.name ?? null;

  const row: ArchiveRow = {
    year: event.year,
    name: event.name,
    archived_at: Date.now(),
    racer_count: state.racers.length,
    champion: nameOf(state.event.champion),
    runner_up: nameOf(state.event.runnerUp),
    third: nameOf(state.event.third),
    consolation_champion: nameOf(state.event.consolationChampion),
    schema_version: ARCHIVE_SCHEMA_VERSION,
    state: JSON.stringify(state),
  };

  db().transaction(() => {
    db()
      .query(
        `INSERT INTO archives
           (year, name, archived_at, racer_count, champion, runner_up, third,
            consolation_champion, schema_version, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (year) DO UPDATE SET
           archived_at = excluded.archived_at,
           state = excluded.state`,
      )
      .run(
        row.year,
        row.name,
        row.archived_at,
        row.racer_count,
        row.champion,
        row.runner_up,
        row.third,
        row.consolation_champion,
        row.schema_version,
        row.state,
      );

    clearEventTables();
    db()
      .query("UPDATE event SET year = ?, phase = 'registration' WHERE id = 1")
      .run(event.year + 1);
  })();

  mkdirSync(`${PHOTOS_DIR}/${event.year + 1}`, { recursive: true });
  return row;
}

/**
 * Wipe the event back to registration.
 *
 * `force` is the escape hatch, and it has to exist: reset is documented as the
 * way out of a false start, but a false start that reaches `complete` is exactly
 * what the archive guard below refuses — so without an override the one case
 * reset was written for is the one case it cannot do. The guard stays the
 * default, and the director has to ask a second time to get past it.
 */
/**
 * Back to registration. `keepRacers` drops only the bracket and its results and
 * leaves the roster — names, photos, sign-offs — in place with seeds cleared,
 * which is what a false start actually needs: the field is right, the race isn't.
 */
export function resetEvent(force = false, keepRacers = false): void {
  const event = eventRow();

  // Resetting a finished-but-unarchived race would eat a whole year.
  if (!force && event.phase === "complete") {
    const archived = db()
      .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM archives WHERE year = ?")
      .get(event.year)!;

    if (archived.n === 0) {
      throw new RaceError(
        "This race is finished but not archived. Archive it first — reset would delete it.",
        409,
      );
    }
  }

  db().transaction(() => {
    clearEventTables(keepRacers);
    db().query("UPDATE event SET phase = 'registration' WHERE id = 1").run();
  })();
}

function clearEventTables(keepRacers = false): void {
  db().query("DELETE FROM messages").run();
  db().query("DELETE FROM results_log").run();
  db().query("DELETE FROM edges").run();
  db().query("DELETE FROM matches").run();
  db().query("DELETE FROM consolation_entrants").run();
  if (keepRacers) {
    db().query("UPDATE racers SET seed = NULL WHERE id != ?").run(BYE_ID);
  } else {
    db().query("DELETE FROM racers WHERE id != ?").run(BYE_ID);
  }
  db()
    .query(
      "UPDATE event SET bracket_size = NULL, current_match = NULL, consolation = 0 WHERE id = 1",
    )
    .run();
}

/** `racerId` null broadcasts to everyone; otherwise it's a direct message. */
export function sendMessage(body: string, racerId: number | null): MessageRow {
  const text = body.trim().replace(/\s+/g, " ");
  if (!text) {
    throw new RaceError("Type a message first.");
  }
  if (text.length > 140) {
    throw new RaceError("Keep it under 140 characters.");
  }

  if (racerId !== null) {
    const exists = db()
      .query<{ id: number }, [number, number]>(
        "SELECT id FROM racers WHERE id = ? AND id != ?",
      )
      .get(racerId, BYE_ID);

    if (!exists) {
      throw new RaceError("No such racer.", 404);
    }
  }

  db()
    .query("INSERT INTO messages (racer, body, created_at) VALUES (?, ?, ?)")
    .run(racerId, text, Date.now());

  return db().query<MessageRow, []>("SELECT * FROM messages ORDER BY id DESC LIMIT 1").get()!;
}

/** Everything this racer should see: the broadcasts plus their own direct messages. */
export function messagesFor(racerId: number): PublicMessage[] {
  return db()
    .query<MessageRow, [number]>(
      "SELECT * FROM messages WHERE racer IS NULL OR racer = ? ORDER BY id DESC LIMIT 30",
    )
    .all(racerId)
    .map((row) => ({
      id: row.id,
      body: row.body,
      at: row.created_at,
      direct: row.racer !== null,
    }));
}

export function listArchives(): Omit<ArchiveRow, "state">[] {
  return db()
    .query<Omit<ArchiveRow, "state">, []>(
      `SELECT year, name, archived_at, racer_count, champion, runner_up, third,
              consolation_champion, schema_version
       FROM archives ORDER BY year DESC`,
    )
    .all();
}

export function getArchive(year: number): ArchiveRow | null {
  return (
    db()
      .query<ArchiveRow, [number]>("SELECT * FROM archives WHERE year = ?")
      .get(year) ?? null
  );
}

export function currentYear(): number {
  return eventRow().year;
}
