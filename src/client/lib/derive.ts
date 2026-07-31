import type { PublicMatch, PublicRacer, StatePayload } from "./api.ts";

export const BYE = 0;

export function racerById(state: StatePayload, id: number | null): PublicRacer | null {
  if (id === null || id === BYE) {
    return null;
  }
  return state.racers.find((r) => r.id === id) ?? null;
}

export function matchById(state: StatePayload, id: number | null): PublicMatch | null {
  if (id === null) {
    return null;
  }
  return state.matches.find((m) => m.id === id) ?? null;
}

/** Heats a racer is in that haven't been decided yet, soonest first. */
export function upcomingFor(state: StatePayload, racerId: number): PublicMatch[] {
  return state.matches
    .filter((m) => m.winner === null && (m.a === racerId || m.b === racerId))
    .sort((x, y) => x.orderIndex - y.orderIndex);
}

export function opponentIn(match: PublicMatch, racerId: number): number | null {
  if (match.a === racerId) {
    return match.b;
  }
  if (match.b === racerId) {
    return match.a;
  }
  return null;
}

/** The heats a racer is in, decided or not — their path through the bracket. */
export function pathOf(state: StatePayload, racerId: number): Set<number> {
  return new Set(
    state.matches.filter((m) => m.a === racerId || m.b === racerId).map((m) => m.id),
  );
}

export type Status = {
  headline: string;
  detail: string | null;
  tone: "up-next" | "waiting" | "out" | "won" | "idle";
};

/**
 * The one line a racer should always be able to get an answer from (DESIGN §3.1).
 * Written from their side of the screen — "your next race", not "match state".
 */
export function statusFor(state: StatePayload, me: PublicRacer | null): Status | null {
  if (!me) {
    return null;
  }

  if (state.event.phase === "registration") {
    return {
      headline: "You're in",
      detail: "Waiting for the race director to start.",
      tone: "waiting",
    };
  }

  if (me.status === "champion") {
    return { headline: "You won the whole thing", detail: null, tone: "won" };
  }

  if (me.status === "runner-up") {
    return { headline: "2nd place", detail: "Beaten in the grand final.", tone: "out" };
  }

  if (me.status === "out") {
    const beaters = me.beatenBy
      .map((id) => racerById(state, id)?.name)
      .filter((name): name is string => Boolean(name));

    return {
      headline: `Knocked out — ${me.placement ?? "out"} of ${state.event.racerCount}`,
      detail: beaters.length > 0 ? `Beaten by ${beaters.join(" and ")}.` : null,
      tone: "out",
    };
  }

  const next = upcomingFor(state, me.id)[0];
  if (!next) {
    return { headline: "Waiting on the bracket", detail: "Your next heat isn't set yet.", tone: "idle" };
  }

  if (next.id === state.event.currentMatch) {
    return { headline: "You're up — get to the track", detail: next.label, tone: "up-next" };
  }

  const opponentId = opponentIn(next, me.id);
  const opponent = racerById(state, opponentId);
  const versus = opponent ? opponent.name : "TBD";
  const queuePosition = state.queue.indexOf(next.id);

  return {
    headline: `Next race: vs ${versus}`,
    detail:
      queuePosition === 1
        ? `${next.label} — you're on deck`
        : `${next.label}${queuePosition > 1 ? ` — ${queuePosition} heats away` : ""}`,
    tone: queuePosition === 1 ? "up-next" : "idle",
  };
}

export type RoundColumn = {
  key: string;
  label: string;
  short: string;
  matches: PublicMatch[];
};

/** Group a bracket's matches into round columns, in playing order. */
export function roundsOf(state: StatePayload, brackets: string[]): RoundColumn[] {
  const columns = new Map<string, RoundColumn>();

  for (const match of state.matches) {
    if (!brackets.includes(match.bracket)) {
      continue;
    }
    // The reset only exists if it gets played.
    if (match.bracket === "GFR" && match.a === null) {
      continue;
    }

    const key = `${match.bracket}-${match.round}`;
    let column = columns.get(key);

    if (!column) {
      column = {
        key,
        label: match.label,
        short:
          match.bracket === "GF" || match.bracket === "GFR"
            ? match.bracket
            : `${match.bracket}${match.round}`,
        matches: [],
      };
      columns.set(key, column);
    }

    column.matches.push(match);
  }

  for (const column of columns.values()) {
    column.matches.sort((x, y) => x.slot - y.slot);
  }

  return [...columns.values()].sort(
    (x, y) => (x.matches[0]?.orderIndex ?? 0) - (y.matches[0]?.orderIndex ?? 0),
  );
}

/**
 * What fills an empty slot, in words rather than a code. "Winner of W1M5" makes
 * a person cross-reference a chart; "Winner of Ada vs Jim" tells them who they
 * might be racing. Falls back to the round when the feeding heat's racers aren't
 * themselves decided yet, which is the deepest anything useful can be said.
 */
export function sourceLabel(
  state: StatePayload,
  match: PublicMatch,
  side: "a" | "b",
): string {
  const edge = state.edges.find((e) => e.to === match.id && e.toSlot === side);
  const from = edge ? state.matches.find((m) => m.id === edge.from) : undefined;

  if (!edge || !from) {
    return "TBD";
  }

  const verb = edge.outcome === "W" ? "Winner" : "Loser";
  const a = racerById(state, from.a);
  const b = racerById(state, from.b);

  return a && b ? `${verb} of ${a.name} vs ${b.name}` : `${verb} of ${from.label}`;
}

export function recordOf(racer: PublicRacer): string {
  return `${racer.wins}–${racer.losses}`;
}

export function statusChip(racer: PublicRacer): { label: string; tone: string } {
  switch (racer.status) {
    case "waiting":
      return { label: "Registered", tone: "idle" };
    case "champion":
      return { label: "Winner", tone: "gold" };
    case "runner-up":
      return { label: "2nd", tone: "silver" };
    case "out":
      return { label: racer.placement ?? "Out", tone: "out" };
    case "one-loss":
      return { label: "1 loss", tone: "warn" };
    default:
      return { label: "Racing", tone: "live" };
  }
}
