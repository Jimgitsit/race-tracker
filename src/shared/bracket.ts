/**
 * Double-elimination bracket generation and replay (DESIGN §4).
 *
 * Pure: no DB, no Bun APIs, no I/O. Everything here is a function of
 * (bracket size, seed→racer mapping, ordered result log), which is what makes it
 * testable standalone and makes undo provably correct — see `play()`.
 */

import { BYE_ID } from "./config.ts";

export type BracketKind = "W" | "L" | "GF" | "GFR" | "C";
export type Outcome = "W" | "L";
export type SlotName = "a" | "b";
export type MatchState = "pending" | "ready" | "done" | "bye";

/** Stable identity for a match inside a structure. The DB maps these to row ids. */
export type MatchRef = string;

export function matchRef(bracket: BracketKind, round: number, slot: number): MatchRef {
  return `${bracket}-${round}-${slot}`;
}

/**
 * The winners bracket is called the **Main** bracket everywhere a person can see
 * it. Internally it stays `W` — in the DB, the edges and the engine — because
 * renaming that would be a migration for a wording change.
 */
const DISPLAY_LETTER: Record<BracketKind, string> = {
  W: "M",
  L: "L",
  GF: "GF",
  GFR: "GFR",
  C: "C",
};

/** Short display code, 1-based match number: `M1M3`, `L4M2`, `GF`, `GFR`, `C2M1`. */
export function matchCode(bracket: BracketKind, round: number, slot: number): string {
  if (bracket === "GF" || bracket === "GFR") {
    return bracket;
  }
  return `${DISPLAY_LETTER[bracket]}${round}M${slot + 1}`;
}

export function roundLabel(bracket: BracketKind, round: number, rounds: number): string {
  switch (bracket) {
    case "W":
      if (round === rounds) {
        return "Main Final";
      }
      return `Main Round ${round}`;
    case "L":
      if (round === rounds * 2 - 2) {
        return "Losers Final";
      }
      return `Losers Round ${round}`;
    case "GF":
      return "Grand Final";
    case "GFR":
      return "Bracket Reset";
    case "C":
      return `Consolation Round ${round}`;
  }
}

export type StructureMatch = {
  ref: MatchRef;
  bracket: BracketKind;
  round: number;
  slot: number;
  orderIndex: number;
  code: string;
  aSource: string | null;
  bSource: string | null;
};

export type StructureEdge = {
  from: MatchRef;
  outcome: Outcome;
  to: MatchRef;
  toSlot: SlotName;
};

export type Structure = {
  /** Double elimination decides on a grand final; single ends at its last round. */
  kind: "double" | "single";
  bracketSize: number;
  rounds: number;
  matches: StructureMatch[];
  edges: StructureEdge[];
  /** Seed numbers (1-based) placed into winners round 1. */
  seeds: { ref: MatchRef; a: number; b: number }[];
};

/** Smallest power of two >= n, floored at 4 (below that the bracket degenerates). */
export function bracketSizeFor(n: number): number {
  let size = 4;
  while (size < n) {
    size *= 2;
  }
  return size;
}

/**
 * Standard bracket seeding order. order(2) = [1,2];
 * order(2n) = interleave(order(n), (2n+1) − order(n)).
 * Spreads byes out, since byes are always the highest seed numbers.
 */
export function seedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2;
    const next: number[] = [];
    for (const seed of order) {
      next.push(seed, n + 1 - seed);
    }
    order = next;
  }
  return order;
}

/** Matches in losers round r, given bracket size B. Minor and major pair up. */
function losersRoundSize(bracketSize: number, round: number): number {
  const j = Math.ceil(round / 2);
  return bracketSize / 2 ** (j + 1);
}

/** Round playing order (DESIGN §4.4). Every dependency is satisfied by construction. */
function roundSequence(rounds: number): { bracket: BracketKind; round: number }[] {
  const lbRounds = rounds * 2 - 2;
  const seq: { bracket: BracketKind; round: number }[] = [{ bracket: "W", round: 1 }];

  if (lbRounds >= 1) {
    seq.push({ bracket: "L", round: 1 });
  }

  for (let j = 2; j <= rounds; j += 1) {
    seq.push({ bracket: "W", round: j });

    const major = 2 * j - 2;
    if (major <= lbRounds) {
      seq.push({ bracket: "L", round: major });
    }

    const minor = 2 * j - 1;
    if (minor <= lbRounds) {
      seq.push({ bracket: "L", round: minor });
    }
  }

  seq.push({ bracket: "GF", round: 1 });
  seq.push({ bracket: "GFR", round: 1 });

  return seq;
}

/**
 * Build the full double-elimination structure for a bracket size. Deterministic —
 * depends on nothing but the size, which is what lets the whole live state be
 * recomputed from (structure + result log).
 */
export function buildStructure(bracketSize: number): Structure {
  const rounds = Math.log2(bracketSize);
  if (!Number.isInteger(rounds) || bracketSize < 4) {
    throw new Error(`bracket size must be a power of two >= 4, got ${bracketSize}`);
  }

  const lbRounds = rounds * 2 - 2;
  const edges: StructureEdge[] = [];
  const counts = new Map<string, number>();

  // ---- match counts per round -------------------------------------------------
  for (let k = 1; k <= rounds; k += 1) {
    counts.set(`W-${k}`, bracketSize / 2 ** k);
  }
  for (let r = 1; r <= lbRounds; r += 1) {
    counts.set(`L-${r}`, losersRoundSize(bracketSize, r));
  }
  counts.set("GF-1", 1);
  counts.set("GFR-1", 1);

  // ---- winners bracket: advancement, and the winners final into the grand final
  for (let k = 1; k <= rounds; k += 1) {
    const count = counts.get(`W-${k}`)!;
    for (let s = 0; s < count; s += 1) {
      const from = matchRef("W", k, s);
      if (k < rounds) {
        edges.push({
          from,
          outcome: "W",
          to: matchRef("W", k + 1, Math.floor(s / 2)),
          toSlot: s % 2 === 0 ? "a" : "b",
        });
      } else {
        edges.push({ from, outcome: "W", to: matchRef("GF", 1, 0), toSlot: "a" });
      }
    }
  }

  // ---- winners losers dropping into the losers bracket -------------------------
  // W1 losers seed L1, two per match.
  for (let s = 0; s < counts.get("W-1")!; s += 1) {
    edges.push({
      from: matchRef("W", 1, s),
      outcome: "L",
      to: matchRef("L", 1, Math.floor(s / 2)),
      toSlot: s % 2 === 0 ? "a" : "b",
    });
  }

  // W(j+1) losers feed major round L(2j), one per match, order reversed against the
  // LB slot order as a cheap rematch-avoidance heuristic (DESIGN §4.3).
  for (let j = 1; j <= rounds - 1; j += 1) {
    const count = counts.get(`W-${j + 1}`)!;
    for (let s = 0; s < count; s += 1) {
      edges.push({
        from: matchRef("W", j + 1, s),
        outcome: "L",
        to: matchRef("L", 2 * j, count - 1 - s),
        toSlot: "b",
      });
    }
  }

  // ---- losers bracket internals ------------------------------------------------
  for (let j = 1; j <= rounds - 1; j += 1) {
    const minor = 2 * j - 1;
    const major = 2 * j;
    const count = counts.get(`L-${minor}`)!;

    // Minor survivors meet the fresh droppers in the major round, one to one.
    for (let s = 0; s < count; s += 1) {
      edges.push({
        from: matchRef("L", minor, s),
        outcome: "W",
        to: matchRef("L", major, s),
        toSlot: "a",
      });
    }

    const nextMinor = 2 * j + 1;
    for (let s = 0; s < count; s += 1) {
      if (nextMinor <= lbRounds) {
        edges.push({
          from: matchRef("L", major, s),
          outcome: "W",
          to: matchRef("L", nextMinor, Math.floor(s / 2)),
          toSlot: s % 2 === 0 ? "a" : "b",
        });
      } else {
        edges.push({
          from: matchRef("L", major, s),
          outcome: "W",
          to: matchRef("GF", 1, 0),
          toSlot: "b",
        });
      }
    }
  }

  // ---- materialise matches in playing order ------------------------------------
  const matches: StructureMatch[] = [];
  let orderIndex = 0;

  for (const { bracket, round } of roundSequence(rounds)) {
    const count = counts.get(`${bracket}-${round}`)!;
    for (let slot = 0; slot < count; slot += 1) {
      matches.push({
        ref: matchRef(bracket, round, slot),
        bracket,
        round,
        slot,
        orderIndex,
        code: matchCode(bracket, round, slot),
        aSource: null,
        bSource: null,
      });
      orderIndex += 1;
    }
  }

  applySourceLabels(matches, edges);

  // ---- winners round 1 seeding --------------------------------------------------
  const order = seedOrder(bracketSize);
  const seeds = [];
  for (let s = 0; s < counts.get("W-1")!; s += 1) {
    seeds.push({ ref: matchRef("W", 1, s), a: order[2 * s], b: order[2 * s + 1] });
  }

  return { kind: "double", bracketSize, rounds, matches, edges, seeds };
}

/** Fill in "Winner of W1M3" / "Loser of W2M1" labels from the edge list. */
function applySourceLabels(matches: StructureMatch[], edges: StructureEdge[]): void {
  const byRef = new Map(matches.map((m) => [m.ref, m]));

  for (const edge of edges) {
    const target = byRef.get(edge.to);
    const source = byRef.get(edge.from);
    if (!target || !source) {
      continue;
    }

    const label = `${edge.outcome === "W" ? "Winner" : "Loser"} of ${source.code}`;
    if (edge.toSlot === "a") {
      target.aSource = label;
    } else {
      target.bSource = label;
    }
  }
}

/** A single-elimination side bracket for racers already knocked out (DESIGN §4.6). */
export function buildConsolationStructure(entrantCount: number): Structure {
  const bracketSize = bracketSizeFor(entrantCount);
  const rounds = Math.log2(bracketSize);
  const edges: StructureEdge[] = [];
  const matches: StructureMatch[] = [];
  let orderIndex = 0;

  for (let k = 1; k <= rounds; k += 1) {
    const count = bracketSize / 2 ** k;
    for (let slot = 0; slot < count; slot += 1) {
      matches.push({
        ref: matchRef("C", k, slot),
        bracket: "C",
        round: k,
        slot,
        orderIndex,
        code: matchCode("C", k, slot),
        aSource: null,
        bSource: null,
      });
      orderIndex += 1;

      // Single elimination: winners advance, losers are simply done.
      if (k < rounds) {
        edges.push({
          from: matchRef("C", k, slot),
          outcome: "W",
          to: matchRef("C", k + 1, Math.floor(slot / 2)),
          toSlot: slot % 2 === 0 ? "a" : "b",
        });
      }
    }
  }

  applySourceLabels(matches, edges);

  const order = seedOrder(bracketSize);
  const seeds = [];
  for (let s = 0; s < bracketSize / 2; s += 1) {
    seeds.push({ ref: matchRef("C", 1, s), a: order[2 * s], b: order[2 * s + 1] });
  }

  return { kind: "single", bracketSize, rounds, matches, edges, seeds };
}

// ---------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------

export type LiveMatch = {
  ref: MatchRef;
  bracket: BracketKind;
  round: number;
  slot: number;
  orderIndex: number;
  code: string;
  aSource: string | null;
  bSource: string | null;
  a: number | null;
  b: number | null;
  winner: number | null;
  state: MatchState;
};

export type Result = { ref: MatchRef; winner: number };

export type PlayOutcome = {
  matches: Map<MatchRef, LiveMatch>;
  /** Ready matches in playing order — the race queue. */
  queue: LiveMatch[];
  complete: boolean;
  champion: number | null;
  runnerUp: number | null;
  third: number | null;
  /** racer id → inclusive placement range, best first. */
  placements: Map<number, { from: number; to: number }>;
};

type EdgeIndex = Map<MatchRef, Partial<Record<Outcome, { to: MatchRef; toSlot: SlotName }>>>;

function indexEdges(edges: StructureEdge[]): EdgeIndex {
  const index: EdgeIndex = new Map();

  for (const edge of edges) {
    let entry = index.get(edge.from);
    if (!entry) {
      entry = {};
      index.set(edge.from, entry);
    }
    entry[edge.outcome] = { to: edge.to, toSlot: edge.toSlot };
  }

  return index;
}

/**
 * Recompute the entire live bracket from the structure plus an ordered result log.
 *
 * This is a deliberate deviation from "undo is the exact inverse of the edge walk":
 * byes cascade (a BYE dropping into the losers bracket hands a free pass to whoever
 * arrives later), so an incremental undo has to unwind cascades it didn't directly
 * cause. Replaying 62 matches costs microseconds and is correct by construction, so
 * undo is just "drop the last log entry and recompute".
 */
export function play(
  structure: Structure,
  seedToRacer: (seed: number) => number,
  results: Result[],
): PlayOutcome {
  const matches = new Map<MatchRef, LiveMatch>();
  for (const m of structure.matches) {
    matches.set(m.ref, { ...m, a: null, b: null, winner: null, state: "pending" });
  }

  const edgeIndex = indexEdges(structure.edges);

  const setSlot = (ref: MatchRef, slot: SlotName, racer: number): void => {
    const match = matches.get(ref);
    if (!match) {
      return;
    }
    if (slot === "a") {
      match.a = racer;
    } else {
      match.b = racer;
    }
  };

  const propagate = (match: LiveMatch, winner: number): void => {
    const loser = match.a === winner ? match.b : match.a;
    const outgoing = edgeIndex.get(match.ref);
    if (!outgoing) {
      return;
    }
    if (outgoing.W) {
      setSlot(outgoing.W.to, outgoing.W.toSlot, winner);
    }
    if (outgoing.L && loser !== null) {
      setSlot(outgoing.L.to, outgoing.L.toSlot, loser);
    }
  };

  // Byes resolve as a fixpoint, and must re-run after every recorded result: a BYE
  // sitting in a losers-bracket slot only becomes resolvable once the real racer
  // arrives from the winners bracket, which happens mid-race.
  const resolveByes = (): void => {
    let changed = true;
    while (changed) {
      changed = false;

      for (const match of matches.values()) {
        if (match.winner !== null || match.a === null || match.b === null) {
          continue;
        }
        if (match.a !== BYE_ID && match.b !== BYE_ID) {
          continue;
        }

        const winner = match.a === BYE_ID ? match.b : match.a;
        match.winner = winner;
        match.state = "bye";
        propagate(match, winner);
        changed = true;
      }
    }
  };

  // Seed winners round 1 (or consolation round 1).
  for (const seed of structure.seeds) {
    setSlot(seed.ref, "a", seedToRacer(seed.a));
    setSlot(seed.ref, "b", seedToRacer(seed.b));
  }
  resolveByes();

  const eliminationOrder: { round: number; racers: number[] }[] = [];

  for (const result of results) {
    const match = matches.get(result.ref);
    if (!match || match.winner !== null || match.a === null || match.b === null) {
      continue;
    }

    match.winner = result.winner;
    match.state = "done";
    propagate(match, result.winner);

    // The grand final is the one genuinely conditional edge in the bracket: the
    // losers champion beating the winners champion levels them at one loss each,
    // so the reset is played with the same two racers. Forcing this into the edge
    // table would be worse than special-casing it here.
    if (match.bracket === "GF" && result.winner === match.b) {
      setSlot(matchRef("GFR", 1, 0), "a", match.a);
      setSlot(matchRef("GFR", 1, 0), "b", match.b);
    }

    // Record who this knocked out, for placement bands.
    const loser = match.a === result.winner ? match.b : match.a;
    if (loser !== null && loser !== BYE_ID && match.bracket === "L") {
      const bucket = eliminationOrder.find((e) => e.round === match.round);
      if (bucket) {
        bucket.racers.push(loser);
      } else {
        eliminationOrder.push({ round: match.round, racers: [loser] });
      }
    }

    resolveByes();
  }

  // Final pass: anything with both slots filled and no winner is raceable.
  for (const match of matches.values()) {
    if (match.winner === null && match.a !== null && match.b !== null) {
      match.state = "ready";
    }
  }

  let complete = false;
  let champion: number | null = null;
  let runnerUp: number | null = null;

  if (structure.kind === "double") {
    const gf = matches.get(matchRef("GF", 1, 0))!;
    const gfr = matches.get(matchRef("GFR", 1, 0))!;
    const decider = gfr.winner !== null ? gfr : gf;

    // The winners champion only needs to win once; the losers champion has to win
    // twice, because the first win only levels them at one loss each.
    complete = (gf.winner !== null && gf.winner === gf.a) || gfr.winner !== null;

    if (complete) {
      champion = decider.winner;
      runnerUp = decider.a === decider.winner ? decider.b : decider.a;
    }
  } else {
    const final = matches.get(matchRef("C", structure.rounds, 0));
    if (final && final.winner !== null && final.winner !== BYE_ID) {
      complete = true;
      champion = final.winner;
      runnerUp = final.a === final.winner ? final.b : final.a;
    }
  }

  const placements = computePlacements(
    eliminationOrder,
    structure,
    matches,
    champion,
    runnerUp,
  );

  // Read third off the placement bands rather than the losers final. With a small
  // field that final can resolve as a bye — nobody raced it — while a real racer
  // still holds third from the round before.
  let third: number | null = null;
  if (complete) {
    for (const [racer, band] of placements) {
      if (band.from === 3 && band.to === 3) {
        third = racer;
        break;
      }
    }
  }

  return {
    matches,
    queue: [...matches.values()]
      .filter((m) => m.state === "ready")
      .sort((x, y) => x.orderIndex - y.orderIndex),
    complete,
    champion,
    runnerUp,
    third,
    placements,
  };
}

/**
 * Placement bands (DESIGN §4.5). Everyone knocked out in the same losers round ties,
 * so a band falls straight out of counting how many racers were still alive when that
 * round resolved. Deriving it from the live count rather than a static table means
 * byes need no special handling.
 */
function computePlacements(
  eliminationOrder: { round: number; racers: number[] }[],
  structure: Structure,
  matches: Map<MatchRef, LiveMatch>,
  champion: number | null,
  runnerUp: number | null,
): Map<number, { from: number; to: number }> {
  const placements = new Map<number, { from: number; to: number }>();

  const entrants = new Set<number>();
  for (const seed of structure.seeds) {
    const match = matches.get(seed.ref);
    if (!match) {
      continue;
    }
    for (const racer of [match.a, match.b]) {
      if (racer !== null && racer !== BYE_ID) {
        entrants.add(racer);
      }
    }
  }

  let alive = entrants.size;
  const byRound = [...eliminationOrder].sort((x, y) => x.round - y.round);

  for (const { racers } of byRound) {
    const out = racers.filter((r) => r !== BYE_ID);
    if (out.length === 0) {
      continue;
    }
    const from = alive - out.length + 1;
    for (const racer of out) {
      placements.set(racer, { from, to: alive });
    }
    alive -= out.length;
  }

  if (champion !== null) {
    placements.set(champion, { from: 1, to: 1 });
  }
  if (runnerUp !== null && runnerUp !== BYE_ID) {
    placements.set(runnerUp, { from: 2, to: 2 });
  }

  return placements;
}

/** `4th`, `9th–12th`. */
export function placementLabel(band: { from: number; to: number }): string {
  return band.from === band.to ? ordinal(band.from) : `${ordinal(band.from)}–${ordinal(band.to)}`;
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) {
    return `${n}th`;
  }
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
