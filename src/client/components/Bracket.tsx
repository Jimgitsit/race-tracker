import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
  openOn = null,
}: {
  state: StatePayload;
  brackets: string[];
  card?: (match: PublicMatch) => {
    dim?: boolean;
    onSelect?: (match: PublicMatch) => void;
  };
  /**
   * Scroll this heat into view on open, so the bracket answers "where are we"
   * before it is touched. If it isn't in these columns — the live heat is in the
   * winners bracket, you're looking at the losers — the first heat that can be
   * picked stands in, and failing that it stays at the start.
   */
  openOn?: number | null;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [adrift, setAdrift] = useState(false);
  const columns = roundsOf(state, brackets);
  const key = brackets.join(",");

  // Read through a ref so the effect can depend on the bracket alone. It should
  // land in the right place when it opens and when the group is switched, and then
  // leave the scroll to whoever is holding the phone — a result landing mid-look
  // must not move the view under their finger.
  const target = useRef(openOn);
  target.current = openOn;

  const bringIntoView = useCallback((smooth = false) => {
    const box = strip.current;
    if (!box) {
      return;
    }

    const card =
      (target.current !== null
        ? box.querySelector<HTMLElement>(`[data-match="${target.current}"]`)
        : null) ??
      box.querySelector<HTMLElement>("button.mc") ??
      box.querySelector<HTMLElement>(".mc");
    const column = card?.closest<HTMLElement>(".rc-column");
    if (!card || !column) {
      return;
    }

    // Rect deltas rather than offsetTop: neither the strip nor the column is a
    // positioned ancestor, so offsets are measured against something further up.
    const strut = column.querySelector<HTMLElement>(".rc-column-head")?.offsetHeight ?? 0;
    const frame = box.getBoundingClientRect();
    const seen = card.getBoundingClientRect();

    box.scrollTo({
      left: box.scrollLeft + seen.left - frame.left,
      top: box.scrollTop + seen.top - frame.top - strut,
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  useLayoutEffect(() => {
    bringIntoView();
  }, [key, bringIntoView]);

  /**
   * Later rounds hold a quarter of the heats the first one does, but every column
   * is as tall as the tallest, so scrolled right *and* down lands on nothing at
   * all. Watch whether any card is in the box and offer the way back when none is.
   *
   * Left is always the way back: the scroll height is set by the *first* column,
   * so it is the one column with a card at every scroll position.
   */
  const cardKey = columns.flatMap((column) => column.matches.map((m) => m.id)).join(",");

  useEffect(() => {
    const box = strip.current;
    if (!box) {
      return;
    }

    const onScreen = new Set<Element>();
    const watch = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onScreen.add(entry.target);
          } else {
            onScreen.delete(entry.target);
          }
        }
        setAdrift(onScreen.size === 0);
      },
      { root: box },
    );

    for (const card of box.querySelectorAll(".mc")) {
      watch.observe(card);
    }
    return () => watch.disconnect();
  }, [cardKey]);

  return (
    <div className="rc-strip">
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

      {adrift ? (
        <button type="button" className="rc-adrift" onClick={() => bringIntoView(true)}>
          <span className="rc-adrift-arrow" aria-hidden="true">
            ←
          </span>
          Back to the heats
        </button>
      ) : null}
    </div>
  );
}
