import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { roundsOf } from "../lib/derive.ts";
import type { PublicMatch, StatePayload } from "../lib/api.ts";
import { MatchCard } from "./MatchCard.tsx";

/**
 * The bracket, as columns of round. Shared because two views draw it for different
 * reasons — a racer reading where they are, a director choosing what races next —
 * and the one thing that must not drift between them is what the brackets are
 * called.
 *
 * These are the one place the names go bare. Everywhere else it is "Winners
 * bracket", never "Winners", but this control always sits directly under a label
 * that says Bracket — so the tab would be reading it back to you. The tablist is
 * pointed at that label, so it is still qualified for anyone who can't see it.
 */
/** Which bracket was last looked at. Shared by both views on purpose — same person. */
export const GROUP_KEY = "race-tracker.bracketGroup";

export const GROUPS: { key: string; label: string; brackets: string[] }[] = [
  { key: "W", label: "Winners", brackets: ["W"] },
  { key: "L", label: "Losers", brackets: ["L"] },
  { key: "F", label: "Finals", brackets: ["GF", "GFR"] },
  { key: "C", label: "Consolation", brackets: ["C"] },
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
  /** The visible "Bracket" label, where there is one to point at. */
  labelledBy?: string;
}) {
  return (
    <div
      className="rc-seg"
      role="tablist"
      aria-label={labelledBy ? undefined : "Bracket"}
      aria-labelledby={labelledBy}
    >
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
  const frame = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [adrift, setAdrift] = useState(false);
  const [pillTop, setPillTop] = useState(0);
  const columns = roundsOf(state, brackets);
  const key = brackets.join(",");

  // Read through a ref so the effect can depend on the bracket alone. It should
  // land in the right place when it opens and when the group is switched, and then
  // leave the scroll to whoever is holding the phone — a result landing mid-look
  // must not move the view under their finger.
  const target = useRef(openOn);
  target.current = openOn;

  const bringIntoView = useCallback((andThePage = false) => {
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
    const port = box.getBoundingClientRect();
    const seen = card.getBoundingClientRect();

    box.scrollTo({
      left: box.scrollLeft + seen.left - port.left,
      top: box.scrollTop + seen.top - port.top - strut,
      behavior: "auto",
    });

    // The strip is only the scroller in the director's sheet. On the racer's tab
    // the page is what scrolled away from the cards, so the way back has to move
    // it too — instantly above, so the card's rect is final by the time this reads
    // it, and "nearest" so the strip it just placed is left alone.
    if (andThePage) {
      card.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }
  }, []);

  useLayoutEffect(() => {
    bringIntoView();
  }, [key, bringIntoView]);

  /**
   * Later rounds hold a quarter of the heats the first one does, but every column
   * is as tall as the tallest, so a short one runs out well before the strip does
   * and you can end up looking at nothing at all. Both views get there, by
   * different routes: the director scrolls their own box right and down, the racer
   * scrolls the *page* past a short column. So the question is simply "is any card
   * on screen" — the viewport is the root, and a card clipped away by the
   * director's inner box doesn't count either.
   *
   * Left is always the way back: the strip is as wide as the first column is tall,
   * so it is the one column with a card at every scroll position.
   */
  const cardKey = columns.flatMap((column) => column.matches.map((m) => m.id)).join(",");

  useEffect(() => {
    const box = strip.current;
    if (!box) {
      return;
    }

    const onScreen = new Set<Element>();
    const watch = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          onScreen.add(entry.target);
        } else {
          onScreen.delete(entry.target);
        }
      }
      setAdrift(onScreen.size === 0);
    });

    for (const card of box.querySelectorAll(".mc")) {
      watch.observe(card);
    }
    return () => watch.disconnect();
  }, [cardKey]);

  // The pill hangs off the strip, which on the racer's tab is taller than the
  // screen — pinned to the strip's middle it would sit off screen in the very case
  // it exists for. Park it in the middle of whatever part of the strip is showing.
  useEffect(() => {
    const wrap = frame.current;
    if (!adrift || !wrap) {
      return;
    }

    const place = () => {
      const rect = wrap.getBoundingClientRect();
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, window.innerHeight);
      if (bottom > top) {
        setPillTop((top + bottom) / 2 - rect.top);
      }
    };

    place();
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);

    return () => {
      window.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [adrift]);

  return (
    <div className="rc-strip" ref={frame}>
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
        <button
          type="button"
          className="rc-adrift"
          style={{ top: pillTop }}
          onClick={() => bringIntoView(true)}
        >
          <span className="rc-adrift-arrow" aria-hidden="true">
            ←
          </span>
          Back to the heats
        </button>
      ) : null}
    </div>
  );
}
