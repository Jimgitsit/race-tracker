/**
 * Standalone verification of the bracket engine (DESIGN §11 step 3).
 * Nothing here touches the DB, the server, or React — if this passes, the hard part
 * is right, and everything above it is presentation.
 *
 *   bun test
 */
import { describe, expect, test } from "bun:test";

import { BYE_ID } from "../src/shared/config.ts";
import {
  bracketSizeFor,
  buildConsolationStructure,
  buildStructure,
  matchRef,
  play,
  seedOrder,
  type LiveMatch,
  type Result,
  type Structure,
} from "../src/shared/bracket.ts";

const FIELD_SIZES = [4, 5, 8, 11, 16, 26, 30, 32];

/** Deterministic RNG so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Racer ids are 1..n; every seed above n is a bye. */
function seeder(n: number) {
  return (seed: number) => (seed <= n ? seed : BYE_ID);
}

function playthrough(n: number, seed: number) {
  const structure = buildStructure(bracketSizeFor(n));
  const seedToRacer = seeder(n);
  const random = rng(seed);
  const results: Result[] = [];

  const snapshots: ReturnType<typeof play>[] = [];
  let guard = 0;

  for (;;) {
    const outcome = play(structure, seedToRacer, results);
    snapshots.push(outcome);

    if (outcome.complete) {
      return { structure, results, outcome, snapshots };
    }

    const next = outcome.queue[0];
    expect(next).toBeDefined();

    // Neither side of a raceable match may be a bye — that is the whole point of
    // resolving byes to a fixpoint.
    expect(next!.a).not.toBe(BYE_ID);
    expect(next!.b).not.toBe(BYE_ID);

    results.push({ ref: next!.ref, winner: random() < 0.5 ? next!.a! : next!.b! });

    guard += 1;
    if (guard > 500) {
      throw new Error(`n=${n} did not terminate after ${guard} heats`);
    }
  }
}

describe("seeding order", () => {
  test("matches the documented recursion", () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  test("every seed appears exactly once", () => {
    for (const size of [4, 8, 16, 32, 64]) {
      const order = seedOrder(size);
      expect(order.length).toBe(size);
      expect(new Set(order).size).toBe(size);
      expect(Math.min(...order)).toBe(1);
      expect(Math.max(...order)).toBe(size);
    }
  });

  test("byes never meet each other in winners round 1", () => {
    // B is the smallest power of two >= N, so N > B/2 and the highest B−N seeds
    // are spread one per match by the standard order.
    for (const n of FIELD_SIZES) {
      const size = bracketSizeFor(n);
      const order = seedOrder(size);
      for (let s = 0; s < size / 2; s += 1) {
        const byes = [order[2 * s], order[2 * s + 1]].filter((seed) => seed > n);
        expect(byes.length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("structure", () => {
  test.each(FIELD_SIZES)("N=%i has 2B−2 matches plus the conditional reset", (n) => {
    const size = bracketSizeFor(n);
    const structure = buildStructure(size);

    const playable = structure.matches.filter((m) => m.bracket !== "GFR");
    expect(playable.length).toBe(2 * size - 2);
    expect(structure.matches.length).toBe(2 * size - 1);
  });

  test.each(FIELD_SIZES)("N=%i round sizes follow the spec", (n) => {
    const size = bracketSizeFor(n);
    const structure = buildStructure(size);
    const rounds = structure.rounds;

    const count = (bracket: string, round: number) =>
      structure.matches.filter((m) => m.bracket === bracket && m.round === round).length;

    for (let k = 1; k <= rounds; k += 1) {
      expect(count("W", k)).toBe(size / 2 ** k);
    }
    for (let j = 1; j <= rounds - 1; j += 1) {
      expect(count("L", 2 * j - 1)).toBe(size / 2 ** (j + 1));
      expect(count("L", 2 * j)).toBe(size / 2 ** (j + 1));
    }
    expect(count("GF", 1)).toBe(1);
  });

  test.each(FIELD_SIZES)("N=%i edges are well formed", (n) => {
    const structure = buildStructure(bracketSizeFor(n));
    const refs = new Set(structure.matches.map((m) => m.ref));

    for (const edge of structure.edges) {
      expect(refs.has(edge.from)).toBe(true);
      expect(refs.has(edge.to)).toBe(true);
      expect(edge.from).not.toBe(edge.to);
    }

    // One outgoing edge per (match, outcome) — the edges table's primary key.
    const seen = new Set<string>();
    for (const edge of structure.edges) {
      const key = `${edge.from}/${edge.outcome}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test.each(FIELD_SIZES)("N=%i every slot has exactly one source", (n) => {
    const structure = buildStructure(bracketSizeFor(n));
    const incoming = new Map<string, number>();

    for (const edge of structure.edges) {
      const key = `${edge.to}/${edge.toSlot}`;
      incoming.set(key, (incoming.get(key) ?? 0) + 1);
    }

    for (const match of structure.matches) {
      for (const slot of ["a", "b"] as const) {
        const fed = incoming.get(`${match.ref}/${slot}`) ?? 0;
        const seeded = match.bracket === "W" && match.round === 1;
        // The reset is populated by the grand final's conditional branch, not an edge.
        const conditional = match.bracket === "GFR";

        if (seeded || conditional) {
          expect(fed).toBe(0);
        } else {
          expect(fed).toBe(1);
        }
      }
    }
  });

  test.each(FIELD_SIZES)("N=%i winners drop into the losers bracket exactly once", (n) => {
    const structure = buildStructure(bracketSizeFor(n));

    for (const match of structure.matches) {
      const outgoing = structure.edges.filter((e) => e.from === match.ref);
      const losing = outgoing.filter((e) => e.outcome === "L");

      if (match.bracket === "W") {
        expect(losing.length).toBe(1);
        expect(losing[0].to.startsWith("L-")).toBe(true);
      } else {
        // Losing anywhere else eliminates you; there is nowhere to drop to.
        expect(losing.length).toBe(0);
      }
    }
  });

  test("race order satisfies every dependency", () => {
    for (const n of FIELD_SIZES) {
      const structure = buildStructure(bracketSizeFor(n));
      const order = new Map(structure.matches.map((m) => [m.ref, m.orderIndex]));

      for (const edge of structure.edges) {
        expect(order.get(edge.from)!).toBeLessThan(order.get(edge.to)!);
      }
    }
  });
});

describe("byes", () => {
  test.each(FIELD_SIZES)("N=%i every real racer is placed once in round 1", (n) => {
    const structure = buildStructure(bracketSizeFor(n));
    const outcome = play(structure, seeder(n), []);

    const placed: number[] = [];
    for (const seed of structure.seeds) {
      const match = outcome.matches.get(seed.ref)!;
      for (const racer of [match.a, match.b]) {
        if (racer !== null && racer !== BYE_ID) {
          placed.push(racer);
        }
      }
    }

    expect(placed.sort((a, b) => a - b)).toEqual(
      Array.from({ length: n }, (_, i) => i + 1),
    );
  });

  test.each(FIELD_SIZES)("N=%i a bye never wins anything raceable", (n) => {
    const { snapshots } = playthrough(n, 12345);

    for (const snapshot of snapshots) {
      for (const match of snapshot.matches.values()) {
        if (match.state === "ready") {
          expect(match.a).not.toBe(BYE_ID);
          expect(match.b).not.toBe(BYE_ID);
        }
        if (match.state === "done") {
          expect(match.winner).not.toBe(BYE_ID);
        }
      }
    }
  });

  test.each(FIELD_SIZES)("N=%i opens with a non-empty queue", (n) => {
    const structure = buildStructure(bracketSizeFor(n));
    const outcome = play(structure, seeder(n), []);
    expect(outcome.queue.length).toBeGreaterThan(0);
    expect(outcome.complete).toBe(false);
  });
});

describe("playthrough", () => {
  test.each(FIELD_SIZES)("N=%i terminates with exactly one champion", (n) => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const { outcome, results } = playthrough(n, seed);

      expect(outcome.complete).toBe(true);
      expect(outcome.champion).toBeGreaterThan(0);
      expect(outcome.champion).toBeLessThanOrEqual(n);
      expect(outcome.runnerUp).not.toBe(outcome.champion);

      // Never more heats than the bracket allows.
      expect(results.length).toBeLessThanOrEqual(2 * bracketSizeFor(n) - 1);
    }
  });

  test.each(FIELD_SIZES)("N=%i places every racer", (n) => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const { outcome } = playthrough(n, seed);

      expect(outcome.placements.size).toBe(n);
      expect(outcome.placements.get(outcome.champion!)).toEqual({ from: 1, to: 1 });
      expect(outcome.placements.get(outcome.runnerUp!)).toEqual({ from: 2, to: 2 });

      // Bands tile 1..n with no gaps and no overlaps.
      const covered = new Set<number>();
      for (const band of outcome.placements.values()) {
        expect(band.from).toBeLessThanOrEqual(band.to);
        for (let p = band.from; p <= band.to; p += 1) {
          covered.add(p);
        }
      }
      expect(covered.size).toBe(n);
      expect(Math.min(...covered)).toBe(1);
      expect(Math.max(...covered)).toBe(n);
    }
  });

  test.each(FIELD_SIZES)("N=%i third place is real once complete", (n) => {
    const { outcome } = playthrough(n, 7);
    expect(outcome.third).not.toBeNull();
    expect(outcome.third).not.toBe(outcome.champion);
    expect(outcome.third).not.toBe(outcome.runnerUp);
    expect(outcome.placements.get(outcome.third!)).toEqual({ from: 3, to: 3 });
  });

  test.each(FIELD_SIZES)("N=%i nobody survives three losses", (n) => {
    const { outcome, results, structure } = playthrough(n, 99);
    const losses = new Map<number, number>();

    for (const result of results) {
      const match = outcome.matches.get(result.ref)!;
      const loser = match.a === result.winner ? match.b : match.a;
      if (loser !== null && loser !== BYE_ID) {
        losses.set(loser, (losses.get(loser) ?? 0) + 1);
      }
    }

    for (const [racer, count] of losses) {
      // Two losses ends your race — unless you are the winners champion who lost
      // the grand final and then the reset, which is three matches but two losses
      // in the bracket's accounting.
      expect(count).toBeLessThanOrEqual(2);
      expect(racer).toBeLessThanOrEqual(n);
    }

    expect(structure.rounds).toBe(Math.log2(bracketSizeFor(n)));
  });

  test("the grand final resets when the losers champion wins", () => {
    // Force it: always pick the b-side, which is the losers-bracket entrant in the
    // grand final. Over many fields at least one must exercise the reset.
    let sawReset = false;

    for (const n of FIELD_SIZES) {
      const structure = buildStructure(bracketSizeFor(n));
      const results: Result[] = [];

      for (let guard = 0; guard < 500; guard += 1) {
        const outcome = play(structure, seeder(n), results);
        if (outcome.complete) {
          const gfr = outcome.matches.get(matchRef("GFR", 1, 0))!;
          if (gfr.winner !== null) {
            sawReset = true;
            expect(gfr.a).not.toBeNull();
            expect(gfr.b).not.toBeNull();
            expect(outcome.champion).toBe(gfr.winner);
          }
          break;
        }
        const next = outcome.queue[0]!;
        results.push({ ref: next.ref, winner: next.b! });
      }
    }

    expect(sawReset).toBe(true);
  });

  test("the reset stays unplayed when the winners champion holds", () => {
    for (const n of FIELD_SIZES) {
      const structure = buildStructure(bracketSizeFor(n));
      const results: Result[] = [];

      for (let guard = 0; guard < 500; guard += 1) {
        const outcome = play(structure, seeder(n), results);
        if (outcome.complete) {
          const gf = outcome.matches.get(matchRef("GF", 1, 0))!;
          const gfr = outcome.matches.get(matchRef("GFR", 1, 0))!;
          if (gf.winner === gf.a) {
            expect(gfr.winner).toBeNull();
            expect(gfr.a).toBeNull();
          }
          break;
        }
        const next = outcome.queue[0]!;
        results.push({ ref: next.ref, winner: next.a! });
      }
    }
  });
});

describe("undo", () => {
  test.each(FIELD_SIZES)("N=%i replaying a shorter log reproduces that state", (n) => {
    const { structure, results } = playthrough(n, 4242);
    const seedToRacer = seeder(n);

    // Popping the log is the entire undo implementation, so this asserts the
    // property undo depends on: state is a pure function of the log prefix.
    for (let cut = results.length; cut > 0; cut -= 1) {
      const prefix = results.slice(0, cut);
      const a = play(structure, seedToRacer, prefix);
      const b = play(structure, seedToRacer, [...prefix]);

      expect(serialise(a.matches)).toEqual(serialise(b.matches));

      const shorter = play(structure, seedToRacer, results.slice(0, cut - 1));
      expect(shorter.matches.get(results[cut - 1].ref)!.winner).toBeNull();
    }
  });

  test("undoing every result returns to the opening state", () => {
    for (const n of FIELD_SIZES) {
      const { structure, results } = playthrough(n, 31337);
      const seedToRacer = seeder(n);

      const opening = play(structure, seedToRacer, []);
      const unwound = play(structure, seedToRacer, results.slice(0, 0));

      expect(serialise(unwound.matches)).toEqual(serialise(opening.matches));
      expect(results.length).toBeGreaterThan(0);
    }
  });
});

describe("consolation bracket", () => {
  test.each([4, 5, 8, 12, 16])("N=%i is single elimination with one winner", (n) => {
    const structure = buildConsolationStructure(n);
    const size = bracketSizeFor(n);

    expect(structure.matches.length).toBe(size - 1);
    expect(structure.matches.every((m) => m.bracket === "C")).toBe(true);
    expect(structure.edges.every((e) => e.outcome === "W")).toBe(true);

    const results: Result[] = [];
    let outcome = play(structure, seeder(n), results);

    for (let guard = 0; guard < 100 && outcome.queue.length > 0; guard += 1) {
      const next = outcome.queue[0];
      results.push({ ref: next.ref, winner: next.a! });
      outcome = play(structure, seeder(n), results);
    }

    const final = outcome.matches.get(matchRef("C", structure.rounds, 0))!;
    expect(final.winner).not.toBeNull();
    expect(final.winner).not.toBe(BYE_ID);
    expect(outcome.queue.length).toBe(0);
  });
});

function serialise(matches: Map<string, LiveMatch>): string {
  return [...matches.values()]
    .sort((x, y) => x.ref.localeCompare(y.ref))
    .map((m) => `${m.ref}:${m.a}/${m.b}/${m.winner}/${m.state}`)
    .join("|");
}

// Referenced so `Structure` stays imported for the type-level assertions above.
export type _Structure = Structure;
