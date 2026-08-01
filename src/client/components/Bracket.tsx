import { useLayoutEffect, useRef } from "react";

import { roundsOf } from "../lib/derive.ts";
import type { PublicMatch, StatePayload } from "../lib/api.ts";
import { MatchCard } from "./MatchCard.tsx";

/**
 * The bracket, as columns of round. Shared because two views draw it for different
 * reasons — a racer reading where they are, a director choosing what races next —
 * and the one thing that must not drift between them is what the brackets are
 * called. Every label is qualified ("Winners bracket", never "Winners").
 */
/** Which bracket was last looked at. Shared by both views on purpose — same person. */
export const GROUP_KEY = "race-tracker.bracketGroup";

export const GROUPS: { key: string; label: string; brackets: string[] }[] = [
  { key: "W", label: "Winners bracket", brackets: ["W"] },
  { key: "L", label: "Losers bracket", brackets: ["L"] },
  { key: "F", label: "Finals", brackets: ["GF", "GFR"] },
  { key: "C", label: "Consolation bracket", brackets: ["C"] },
];

/** Consolation only exists once the director starts it. */
export function groupsIn(state: StatePayload) {
  return GROUPS.filter((group) => group.key !== "C" || state.event.consolation);
}

/**
 * A stored group can name a bracket that doesn't exist yet — Consolation, saved
 * last year, before this year's is started. Fall back for display without
 * discarding the choice, so it comes back if that bracket appears.
 */
export function activeGroup(state: StatePayload, group: string): string {
  return groupsIn(state).some((g) => g.key === group) ? group : "W";
}

export function bracketsOf(state: StatePayload, group: string): string[] {
  return groupsIn(state).find((g) => g.key === group)?.brackets ?? ["W"];
}

export function GroupTabs({
  state,
  group,
  onPick,
  labelledBy,
}: {
  state: StatePayload;
  group: string;
  onPick: (key: string) => void;
  labelledBy?: string;
}) {
  return (
    <div className="rc-seg" role="tablist" aria-labelledby={labelledBy}>
      {groupsIn(state).map((g) => (
        <button
          key={g.key}
          type="button"
          role="tab"
          aria-selected={group === g.key}
          className={`rc-seg-btn ${group === g.key ? "rc-seg-on" : ""}`}
          onClick={() => onPick(g.key)}
        >
          {g.label}
        </button>
      ))}
    </div>
  );
}

/**
 * `card` decides per match how it is drawn and whether it can be tapped. A match
 * with no `onSelect` renders as a plain div rather than a button, so "can't pick
 * this one" needs no separate disabled state.
 */
export function BracketColumns({
  state,
  brackets,
  card = () => ({}),
  startAtSelectable = false,
}: {
  state: StatePayload;
  brackets: string[];
  card?: (match: PublicMatch) => {
    dim?: boolean;
    onSelect?: (match: PublicMatch) => void;
  };
  /** Open on the round that can be acted on rather than on round one. */
  startAtSelectable?: boolean;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const columns = roundsOf(state, brackets);
  const key = brackets.join(",");

  // Deliberately keyed on the bracket alone, not on the results: it should land in
  // the right place when it opens and when the group is switched, and then leave
  // the scroll to whoever is holding the phone.
  useLayoutEffect(() => {
    const box = strip.current;
    const first = box?.querySelector<HTMLElement>("button.mc")?.closest<HTMLElement>(".rc-column");
    if (box && first && startAtSelectable) {
      box.scrollLeft = first.offsetLeft;
    }
  }, [key, startAtSelectable]);

  return (
    <div className="rc-columns scroll-x" ref={strip}>
      {columns.map((column) => (
        <section className="rc-column" key={column.key}>
          <h2 className="rc-column-head">{column.label}</h2>
          <div className="stack rc-column-body">
            {column.matches.map((match) => (
              <MatchCard
                key={match.id}
                state={state}
                match={match}
                // Gated on the phase as well as the id: an archived year can still
                // name a current match, and history has no heat that is racing.
                current={state.event.phase === "racing" && match.id === state.event.currentMatch}
                showRound={false}
                {...card(match)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
