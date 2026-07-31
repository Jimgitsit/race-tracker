import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { joinUrl, type PublicMatch, type StatePayload } from "../lib/api.ts";
import { matchById, racerById, roundsOf, sourceLabel, type RoundColumn } from "../lib/derive.ts";
import { useResultFlash } from "../lib/useRace.ts";
import { timeAgo, useNow } from "../lib/time.ts";
import { Avatar } from "../components/Avatar.tsx";
import { JoinQR } from "../components/QR.tsx";

/**
 * Which brackets are drawn. Orthogonal to detail — the two used to be one five-way
 * "mode" in which AUTO and EVERYTHING showed the *same* brackets and differed only
 * in density, which is the part nobody could hold in their head.
 */
type Filter = "all" | "main" | "losers" | "consolation";
/** How much of each round is drawn: collapse what's settled, or show all of it. */
type Detail = "auto" | "all";
type Density = "full" | "compact" | "collapsed";

/** Pan offset plus scale, where a null scale means "whatever fits". */
type View = { scale: number | null; x: number; y: number };

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "main", label: "Winners" },
  { key: "losers", label: "Losers" },
  { key: "consolation", label: "Consolation" },
];

const FIT: View = { scale: null, x: 0, y: 0 };

/** Long enough to cross the screen to a button, short enough that the room never
    notices the chrome was there. */
const CHROME_IDLE_MS = 2500;
const ZOOM_STEP = 1.15;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Zoom is bounded relative to fit, never absolutely. Fit for the full 62-match
 * bracket is around a third of life size, so an absolute floor of 0.4 would mean
 * pressing zoom-out made the bracket bigger. Generous on a big bracket, sane on a
 * small one: five times fit, but never so far in that one card fills the screen.
 */
function zoomCeiling(fit: number): number {
  return Math.max(fit, Math.min(fit * 5, 3));
}

export function DisplayView({
  state,
  onExit,
}: {
  state: StatePayload;
  onExit?: () => void;
}) {
  useWakeLock();

  const body =
    state.event.phase === "registration" ? (
      <Registration state={state} />
    ) : state.event.phase === "complete" ? (
      <Finished state={state} />
    ) : (
      <Racing state={state} />
    );

  return (
    <div className={onExit ? "disp-shell disp-shell-exit" : "disp-shell"}>
      {body}
      {onExit ? <ExitBar onExit={onExit} /> : null}
    </div>
  );
}

/**
 * Only rendered for a phone that flipped here from the spectator view. This
 * layout is 16:9 by design, so it says the one thing that fixes it on a phone
 * rather than pretending portrait is fine.
 */
function ExitBar({ onExit }: { onExit: () => void }) {
  return (
    <div className="disp-exit">
      <button type="button" className="disp-exit-btn" onClick={onExit}>
        ← Back
      </button>
      <span className="disp-exit-hint">Turn your phone sideways</span>
    </div>
  );
}

/**
 * TVs sleep. Browsers also drop the lock whenever the tab is backgrounded, so
 * re-request it on visibilitychange rather than assuming the first grant holds.
 */
function useWakeLock(): void {
  useEffect(() => {
    type Sentinel = { release: () => Promise<void> };
    const nav = navigator as Navigator & {
      wakeLock?: { request: (kind: "screen") => Promise<Sentinel> };
    };

    if (!nav.wakeLock) {
      return;
    }

    let sentinel: Sentinel | null = null;
    let live = true;

    const acquire = async () => {
      try {
        const next = await nav.wakeLock!.request("screen");
        if (live) {
          sentinel = next;
        } else {
          await next.release();
        }
      } catch {
        // A denied wake lock is not worth surfacing on a TV.
      }
    };

    void acquire();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void acquire();
      }
    };

    document.addEventListener("visibilitychange", onVisible);

    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release();
    };
  }, []);
}

// ---------------------------------------------------------------------------------
// Registration — the TV is idle, so it does the onboarding
// ---------------------------------------------------------------------------------

function Registration({ state }: { state: StatePayload }) {
  return (
    <main className="disp disp-join">
      <section className="disp-join-left">
        <p className="disp-eyebrow">{state.event.year}</p>
        <h1 className="disp-join-title">{state.event.name}</h1>
        <p className="disp-join-cta">Scan to get your car on the board</p>
        <JoinQR url={joinUrl()} size={420} label="" />
      </section>

      <section className="disp-join-right">
        <div className="disp-join-count">
          <span className="disp-count-num tabular">{state.event.racerCount}</span>
          <span className="disp-count-label">
            {state.event.racerCount === 1 ? "car" : "cars"} on the grid
          </span>
        </div>

        <div className="disp-grid">
          {state.racers.map((racer) => (
            <div className="disp-grid-car" key={racer.id}>
              <Avatar racer={racer} size="xl" />
              <p className="disp-grid-name racer-name">{racer.name}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------------
// Racing
// ---------------------------------------------------------------------------------

function Racing({ state }: { state: StatePayload }) {
  const flash = useResultFlash(state);
  const [filter, setFilter] = useState<Filter>("all");
  const [detail, setDetail] = useState<Detail>("auto");
  const [view, setView] = useState<View>(FIT);
  const [focus, setFocus] = useState<number | null>(null);
  const [fit, setFit] = useState(1);
  const [chrome, setChrome] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clock = useNow();

  const current = matchById(state, state.event.currentMatch);
  const flashed = matchById(state, flash);
  const banner = flashed ?? current;

  const filters = useMemo(
    () => FILTERS.filter((f) => f.key !== "consolation" || state.event.consolation),
    [state.event.consolation],
  );

  const columns = useMemo(
    () => roundsOf(state, bracketsFor(filter, state.event.consolation)),
    [state, filter],
  );

  /** Where the detail sits when nothing has been clicked: on the live heat. */
  const liveColumn = useMemo(() => {
    const found = columns.findIndex((c) => c.matches.some((m) => m.id === state.event.currentMatch));
    return found === -1 ? 0 : found;
  }, [columns, state.event.currentMatch]);

  const focusIndex = clamp(focus ?? liveColumn, 0, Math.max(0, columns.length - 1));

  const wake = useCallback(() => {
    setChrome(true);
    clearTimeout(idle.current);
    idle.current = setTimeout(() => setChrome(false), CHROME_IDLE_MS);
  }, []);

  useEffect(() => () => clearTimeout(idle.current), []);

  // Any mouse movement reveals the chrome, listened for on the window rather than
  // on the canvas: the toolbar floats over the footer, so a canvas-only listener
  // would hide it exactly as the pointer arrived at it.
  useEffect(() => {
    window.addEventListener("pointermove", wake);
    return () => window.removeEventListener("pointermove", wake);
  }, [wake]);

  const reset = useCallback(() => {
    setFilter("all");
    setDetail("auto");
    setView(FIT);
    setFocus(null);
  }, []);

  /** Changing what's on screen invalidates a column index, so hand focus back to
      the live heat rather than landing on whatever now sits in that position. */
  const pickFilter = useCallback((key: Filter) => {
    setFilter(key);
    setFocus(null);
    setView(FIT);
  }, []);

  const zoomBy = useCallback(
    (steps: number) =>
      setView((v) => {
        const next = (v.scale ?? fit) * ZOOM_STEP ** steps;
        // Zooming back out through fit returns to fit proper, which also recentres.
        // There is nothing below it to see — the whole bracket is already on screen.
        return next <= fit ? FIT : { ...v, scale: Math.min(next, zoomCeiling(fit)) };
      }),
    [fit],
  );

  // A laptop keyboard is right there, and the arrows still drive it from a remote
  // if this ever goes back on a TV. Left/Right does mean two things, but only one
  // of them is ever available: at fit the bracket cannot pan, because it fits.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowUp":
        case "+":
        case "=":
          zoomBy(1);
          break;
        case "ArrowDown":
        case "-":
          zoomBy(-1);
          break;
        case "ArrowLeft":
          if (view.scale === null) {
            setFocus(clamp(focusIndex - 1, 0, columns.length - 1));
          } else {
            setView((v) => ({ ...v, x: v.x + 120 }));
          }
          break;
        case "ArrowRight":
          if (view.scale === null) {
            setFocus(clamp(focusIndex + 1, 0, columns.length - 1));
          } else {
            setView((v) => ({ ...v, x: v.x - 120 }));
          }
          break;
        case "Enter":
          setFilter((f) => filters[(filters.findIndex((x) => x.key === f) + 1) % filters.length].key);
          setFocus(null);
          setView(FIT);
          break;
        case "d":
          setDetail((d) => (d === "all" ? "auto" : "all"));
          break;
        case "f":
          setView(FIT);
          break;
        case "Escape":
        case "Backspace":
        case "0":
          reset();
          break;
        default:
          return;
      }

      event.preventDefault();
      wake();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.scale, filters, columns.length, focusIndex, zoomBy, reset, wake]);

  const onDeck = state.queue
    .filter((id) => id !== state.event.currentMatch)
    .slice(0, 3)
    .map((id) => matchById(state, id))
    .filter((m): m is PublicMatch => m !== null);

  return (
    <main className={`disp disp-racing ${chrome ? "" : "disp-racing-idle"}`}>
      <Banner state={state} match={banner} flashed={flashed !== null} />

      {/* The toolbar is a sibling of the canvas, not a fixed overlay: floating it
          over the whole screen put it on top of the on-deck strip, which is the
          one thing the director is most likely to want while reaching for it.
          Being a sibling also keeps its clicks out of the canvas's drag handlers. */}
      <div className="disp-stage">
        <BracketCanvas
          state={state}
          columns={columns}
          detail={detail}
          view={view}
          focusIndex={focusIndex}
          flash={flash}
          onView={setView}
          onFocus={setFocus}
          onFit={setFit}
          onWake={wake}
        />

        <Controls
          shown={chrome}
          filters={filters}
          filter={filter}
          detail={detail}
          scale={view.scale}
          fit={fit}
          onFilter={pickFilter}
          onDetail={() => setDetail((d) => (d === "all" ? "auto" : "all"))}
          onZoom={zoomBy}
          onFit={() => setView(FIT)}
        />
      </div>

      <footer className="disp-foot">
        <div className="disp-ondeck">
          <span className="disp-eyebrow">On deck</span>
          {onDeck.length === 0 ? (
            <span className="disp-ondeck-empty">—</span>
          ) : (
            onDeck.map((match) => (
              <span className="disp-ondeck-item" key={match.id}>
                {racerById(state, match.a)?.name ?? "TBD"}
                <span className="disp-ondeck-vs">vs</span>
                {racerById(state, match.b)?.name ?? "TBD"}
              </span>
            ))
          )}
        </div>

        {state.announcements.length > 0 ? (
          <p className="disp-announce" key={state.announcements[0].id}>
            <span className="disp-announce-tag">Director</span>
            <span className="disp-announce-body">{state.announcements[0].body}</span>
            <span className="disp-announce-when">
              {timeAgo(state.announcements[0].at, clock)}
            </span>
          </p>
        ) : null}

        <div className="disp-foot-right">
          <span className="code disp-progress">
            {state.event.heatsDone}/{state.event.heatsTotal}
          </span>
          <JoinQR url={joinUrl()} size={92} label="" />
        </div>
      </footer>

    </main>
  );
}

function Banner({
  state,
  match,
  flashed,
}: {
  state: StatePayload;
  match: PublicMatch | null;
  flashed: boolean;
}) {
  if (!match) {
    return (
      <header className="disp-banner">
        <p className="disp-banner-idle">Waiting for the next heat</p>
      </header>
    );
  }

  const a = racerById(state, match.a);
  const b = racerById(state, match.b);
  const winner = match.winner;

  return (
    <header className={`disp-banner ${flashed ? "disp-banner-result" : ""}`}>
      <BannerCar
        racer={a}
        side="left"
        won={flashed && winner === match.a}
        lost={flashed && winner === match.b}
      />

      <div className="disp-banner-mid">
        <p className="disp-eyebrow">{flashed ? "Result" : "Now racing"}</p>
        <p className="disp-vs">VS</p>
        <p className="disp-banner-round code">{match.label}</p>
      </div>

      <BannerCar
        racer={b}
        side="right"
        won={flashed && winner === match.b}
        lost={flashed && winner === match.a}
      />
    </header>
  );
}

function BannerCar({
  racer,
  side,
  won,
  lost,
}: {
  racer: ReturnType<typeof racerById>;
  side: "left" | "right";
  won: boolean;
  lost: boolean;
}) {
  // Photo nearest the centre on both sides, so the pair reads as one head-to-head
  // rather than two things pinned to opposite edges of the screen.
  const photo = <Avatar racer={racer} size="xl" full key="photo" />;
  const name = (
    <p className="disp-banner-name racer-name" key="name">
      {racer?.name ?? "TBD"}
    </p>
  );

  return (
    <div
      className={`disp-banner-car disp-banner-${side} ${won ? "is-won" : ""} ${lost ? "is-lost" : ""}`}
    >
      {side === "left" ? [name, photo] : [photo, name]}
      {won ? <span className="disp-stamp">✓</span> : null}
    </div>
  );
}

/**
 * Kept mounted rather than conditionally rendered so it can fade rather than pop,
 * and stays out of the way until the pointer moves — this is a display first and
 * an operator surface second.
 */
function Controls({
  shown,
  filters,
  filter,
  detail,
  scale,
  fit,
  onFilter,
  onDetail,
  onZoom,
  onFit,
}: {
  shown: boolean;
  filters: { key: Filter; label: string }[];
  filter: Filter;
  detail: Detail;
  scale: number | null;
  fit: number;
  onFilter: (key: Filter) => void;
  onDetail: () => void;
  onZoom: (steps: number) => void;
  onFit: () => void;
}) {
  return (
    <div className={`disp-controls ${shown ? "" : "disp-controls-off"}`}>
      <div className="disp-ctl-set">
        {filters.map((entry) => (
          <button
            type="button"
            key={entry.key}
            className={`disp-ctl-btn ${filter === entry.key ? "is-on" : ""}`}
            onClick={() => onFilter(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <span className="disp-ctl-rule" />

      <button
        type="button"
        className={`disp-ctl-btn ${detail === "all" ? "is-on" : ""}`}
        onClick={onDetail}
        title="Draw every round at the same size instead of collapsing what's settled"
      >
        All rounds
      </button>

      <span className="disp-ctl-rule" />

      <div className="disp-ctl-set">
        <button type="button" className="disp-ctl-btn disp-ctl-step" onClick={() => onZoom(-1)}>
          −
        </button>
        <button type="button" className="disp-ctl-btn disp-ctl-zoom" onClick={onFit}>
          {scale === null ? "Fit" : `${Math.round((scale / fit) * 100)}%`}
        </button>
        <button type="button" className="disp-ctl-btn disp-ctl-step" onClick={() => onZoom(1)}>
          +
        </button>
      </div>

      <span className="disp-ctl-hint">scroll to zoom · drag to pan · click a round</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// The bracket, drawn as track
// ---------------------------------------------------------------------------------

function bracketsFor(filter: Filter, hasConsolation: boolean): string[] {
  switch (filter) {
    case "main":
      return ["W", "GF", "GFR"];
    case "losers":
      return ["L"];
    case "consolation":
      return hasConsolation ? ["C"] : ["W", "GF", "GFR"];
    default:
      return hasConsolation ? ["W", "L", "GF", "GFR", "C"] : ["W", "L", "GF", "GFR"];
  }
}

function BracketCanvas({
  state,
  columns,
  detail,
  view,
  focusIndex,
  flash,
  onView,
  onFocus,
  onFit,
  onWake,
}: {
  state: StatePayload;
  columns: RoundColumn[];
  detail: Detail;
  view: View;
  focusIndex: number;
  flash: number | null;
  onView: (view: View) => void;
  onFocus: (index: number) => void;
  onFit: (fit: number) => void;
  onWake: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const boxes = useRef<Map<number, HTMLElement>>(new Map());
  const drag = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);
  const dragged = useRef(false);

  const [fit, setFit] = useState(1);
  const [grabbing, setGrabbing] = useState(false);
  const [paths, setPaths] = useState<{ id: string; d: string; kind: string }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [frame, setFrame] = useState({ w: 0, h: 0 });

  const densities = useMemo(
    () => columns.map((column, index) => densityOf(column, index, focusIndex, detail)),
    [columns, focusIndex, detail],
  );

  /**
   * Density is computed on playing order (temporal adjacency), but the columns are
   * laid out grouped by bracket: all winners rounds, then all losers rounds, then
   * the finals. Playing order interleaves W and L, which sends every advancement
   * line crossing behind an unrelated round; grouping keeps them between adjacent
   * columns and leaves only the two grand-final feeds crossing.
   *
   * One row rather than two stacked ones, because the screen is 16:9 and a
   * two-row bracket is tall and narrow — it fits the space at half the scale.
   */
  const ordered = useMemo(() => {
    const rank: Record<string, number> = { W: 0, L: 1, GF: 2, GFR: 3, C: 4 };

    return columns
      .map((column, index) => ({ column, density: densities[index], index }))
      .sort((x, y) => {
        const xg = rank[x.column.matches[0]?.bracket ?? "W"] ?? 0;
        const yg = rank[y.column.matches[0]?.bracket ?? "W"] ?? 0;
        return xg - yg || (x.column.matches[0]?.round ?? 0) - (y.column.matches[0]?.round ?? 0);
      })
      .map((entry, position, all) => ({
        ...entry,
        startsGroup:
          position > 0 &&
          (all[position - 1].column.matches[0]?.bracket ?? "") !==
            (entry.column.matches[0]?.bracket ?? ""),
      }));
  }, [columns, densities]);

  // Measure in layout coordinates (offsetLeft/Top), which the scale transform on
  // the wrapper does not affect — so connectors stay correct at any zoom.
  useLayoutEffect(() => {
    const root = canvas.current;
    const frame = viewport.current;
    if (!root || !frame) {
      return;
    }

    const measure = () => {
      const next: { id: string; d: string; kind: string }[] = [];
      const bracketOf = new Map(state.matches.map((m) => [m.id, m.bracket]));

      for (const edge of state.edges) {
        // Only advancement is drawn. The winners-to-losers drops are sixteen lines
        // crossing from one row to the other, and every bracket ever printed omits
        // them for exactly that reason — where losers go is understood.
        if (edge.outcome === "L") {
          continue;
        }

        const from = boxes.current.get(edge.from);
        const to = boxes.current.get(edge.to);
        if (!from || !to) {
          continue;
        }

        const x1 = from.offsetLeft + from.offsetWidth;
        const y1 = from.offsetTop + from.offsetHeight / 2;
        const x2 = to.offsetLeft;
        const y2 = to.offsetTop + to.offsetHeight / 2;

        if (x2 <= x1) {
          continue;
        }

        // Colour follows the bracket the line runs through, not the outcome:
        // losers-bracket advancement is still an outcome of "W", and it has to
        // read cold so the two halves separate from across the room.
        const source = bracketOf.get(edge.from);

        next.push({
          id: `${edge.from}-${edge.outcome}`,
          d: elbow(x1, y1, x2, y2),
          kind: source === "L" ? "loser" : source === "C" ? "consolation" : "winner",
        });
      }

      setPaths(next);

      const w = root.scrollWidth;
      const h = root.scrollHeight;
      setSize({ w, h });
      setFrame({ w: frame.clientWidth, h: frame.clientHeight });

      if (w > 0 && h > 0) {
        setFit(Math.min(frame.clientWidth / w, frame.clientHeight / h, 1.8));
      }
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(root);

    return () => observer.disconnect();
  }, [state, columns, densities]);

  useEffect(() => {
    onFit(fit);
  }, [fit, onFit]);

  const scale = view.scale ?? fit;
  const travel = useMemo(() => {
    if (flash === null) {
      return null;
    }
    const edge = state.edges.find((e) => e.from === flash && e.outcome === "W");
    const path = edge ? paths.find((p) => p.id === `${flash}-W`) : null;
    const match = matchById(state, flash);
    return path && match ? { d: path.d, racer: racerById(state, match.winner) } : null;
  }, [flash, paths, state]);

  // transform-origin is top-left, so centre it by hand rather than letting the
  // bracket hug one corner with dead screen either side. Once it outgrows the
  // frame the pan takes over, clamped to the overflow so a flick of the mouse
  // can never throw the whole bracket off screen.
  const contentW = size.w * scale;
  const contentH = size.h * scale;
  const offsetX = contentW <= frame.w ? (frame.w - contentW) / 2 : clamp(view.x, frame.w - contentW, 0);
  const offsetY = contentH <= frame.h ? (frame.h - contentH) / 2 : clamp(view.y, frame.h - contentH, 0);
  const pannable = contentW > frame.w + 1 || contentH > frame.h + 1;

  // React registers wheel on its root as passive, so preventDefault() from an
  // onWheel prop is ignored and the page scrolls out from under the zoom. It has
  // to be a native listener asking for passive: false.
  useEffect(() => {
    const el = viewport.current;
    if (!el) {
      return;
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      onWake();

      const next = clamp(
        scale * ZOOM_STEP ** (event.deltaY > 0 ? -1 : 1),
        fit,
        zoomCeiling(fit),
      );

      if (next === scale) {
        return;
      }
      if (next <= fit) {
        onView(FIT);
        return;
      }

      // Hold whatever sits under the pointer still, so zooming reads as moving
      // towards the thing you're looking at rather than towards the centre.
      const rect = el.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const ratio = next / scale;

      onView({ scale: next, x: px - (px - offsetX) * ratio, y: py - (py - offsetY) * ratio });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scale, fit, offsetX, offsetY, onView, onWake]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragged.current = false;
    if (event.button !== 0 || !pannable) {
      return;
    }
    viewport.current?.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: offsetX, oy: offsetY };
    setGrabbing(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (!held || held.id !== event.pointerId) {
      return;
    }

    const dx = event.clientX - held.x;
    const dy = event.clientY - held.y;

    // A few pixels of slop, so a click that wobbles still counts as a click.
    if (!dragged.current && Math.abs(dx) < 4 && Math.abs(dy) < 4) {
      return;
    }

    dragged.current = true;
    onView({ scale, x: held.ox + dx, y: held.oy + dy });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) {
      return;
    }
    viewport.current?.releasePointerCapture(event.pointerId);
    drag.current = null;
    setGrabbing(false);
  };

  const classes = ["disp-canvas"];
  if (pannable) {
    classes.push(grabbing ? "disp-canvas-grabbing" : "disp-canvas-pan");
  }

  return (
    <div
      className={classes.join(" ")}
      ref={viewport}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onView(FIT)}
    >
      <div
        className={`disp-scale ${grabbing ? "disp-scale-held" : ""}`}
        ref={canvas}
        style={{ transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})` }}
      >
        <svg className="disp-track" width={size.w} height={size.h} aria-hidden="true">
          {/* Two strokes per edge: the wide rail colour underneath, then a narrower
              bed on top. What's left showing on each side reads as the raised rails
              of a real track, with no path-offsetting maths. */}
          {paths.map((path) => (
            <path key={`${path.id}-rail`} className={`trk-rail trk-${path.kind}`} d={path.d} />
          ))}
          {paths.map((path) => (
            <path key={`${path.id}-bed`} className={`trk-bed trk-${path.kind}`} d={path.d} />
          ))}
        </svg>

        <div className="disp-tree">
          {ordered.map(({ column, density, startsGroup, index }) => (
            <Column
              key={column.key}
              state={state}
              column={column}
              density={density}
              startsGroup={startsGroup}
              currentId={state.event.currentMatch}
              onPick={() => {
                // The click that ends a drag is still a click. Ignore it, or
                // panning across the bracket would re-focus wherever you let go.
                if (!dragged.current) {
                  onFocus(index);
                }
              }}
              register={(id, el) => {
                if (el) {
                  boxes.current.set(id, el);
                } else {
                  boxes.current.delete(id);
                }
              }}
            />
          ))}
        </div>

        {travel ? (
          <div className="trk-car" style={{ offsetPath: `path("${travel.d}")` }}>
            <Avatar racer={travel.racer} size="sm" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Rounded elbow: out, across, in. */
function elbow(x1: number, y1: number, x2: number, y2: number): string {
  const midX = x1 + (x2 - x1) / 2;
  const radius = Math.min(14, Math.abs(y2 - y1) / 2, Math.abs(midX - x1));

  if (radius < 2 || Math.abs(y2 - y1) < 2) {
    return `M ${x1} ${y1} H ${x2}`;
  }

  const down = y2 > y1;
  const c1 = down ? y1 + radius : y1 - radius;
  const c2 = down ? y2 - radius : y2 + radius;

  return [
    `M ${x1} ${y1}`,
    `H ${midX - radius}`,
    `Q ${midX} ${y1} ${midX} ${c1}`,
    `V ${c2}`,
    `Q ${midX} ${y2} ${midX + radius} ${y2}`,
    `H ${x2}`,
  ].join(" ");
}

function densityOf(column: RoundColumn, index: number, focus: number, detail: Detail): Density {
  if (detail === "all") {
    return "compact";
  }

  if (index === focus) {
    return "full";
  }

  // A finished round behind the focus is the single biggest waste of space on the
  // screen — winners round 1 is 16 matches tall and, once decided, tells you
  // nothing you can't read downstream. Collapse it and the whole bracket can be
  // drawn much larger.
  const settled = column.matches.every((m) => m.winner !== null);
  if (settled && index < focus) {
    return "collapsed";
  }

  // Same argument ahead of the focus: a round nobody has reached yet is a stub.
  const untouched = column.matches.every((m) => m.a === null && m.b === null);
  if (untouched && index > focus + 1) {
    return "collapsed";
  }

  return Math.abs(index - focus) === 1 ? "full" : "compact";
}

function Column({
  state,
  column,
  density,
  startsGroup,
  currentId,
  onPick,
  register,
}: {
  state: StatePayload;
  column: RoundColumn;
  density: Density;
  startsGroup: boolean;
  currentId: number | null;
  onPick: () => void;
  register: (id: number, el: HTMLElement | null) => void;
}) {
  const group = startsGroup ? " disp-col-group" : "";

  if (density === "collapsed") {
    const done = column.matches.filter((m) => m.winner !== null).length;
    return (
      <section className={`disp-col disp-col-collapsed${group}`} onClick={onPick}>
        <span className="disp-col-code">{column.short}</span>
        <span className="disp-col-tally code">
          {done > 0 ? `✓${done}` : `${column.matches.length}`}
        </span>
      </section>
    );
  }

  return (
    <section className={`disp-col disp-col-${density}${group}`} onClick={onPick}>
      <h2 className="disp-col-head">{column.label}</h2>
      <div className="disp-col-body">
        {column.matches.map((match) => (
          <DisplayMatch
            key={match.id}
            state={state}
            match={match}
            density={density}
            current={match.id === currentId}
            register={register}
          />
        ))}
      </div>
    </section>
  );
}

function DisplayMatch({
  state,
  match,
  density,
  current,
  register,
}: {
  state: StatePayload;
  match: PublicMatch;
  density: Density;
  current: boolean;
  register: (id: number, el: HTMLElement | null) => void;
}) {
  const a = racerById(state, match.a);
  const b = racerById(state, match.b);

  const classes = ["dm"];
  if (current) {
    classes.push("dm-current");
  }
  if (match.bracket === "L") {
    classes.push("dm-losers");
  }
  if (match.state === "bye") {
    classes.push("dm-bye");
  }

  return (
    <div className={classes.join(" ")} ref={(el) => register(match.id, el)}>
      <DisplaySide
        racer={a}
        source={sourceLabel(state, match, "a")}
        won={match.winner !== null && match.winner === match.a}
        lost={match.winner !== null && match.winner !== match.a && a !== null}
        density={density}
      />
      <DisplaySide
        racer={b}
        source={sourceLabel(state, match, "b")}
        won={match.winner !== null && match.winner === match.b}
        lost={match.winner !== null && match.winner !== match.b && b !== null}
        density={density}
      />
    </div>
  );
}

function DisplaySide({
  racer,
  source,
  won,
  lost,
  density,
}: {
  racer: ReturnType<typeof racerById>;
  source: string;
  won: boolean;
  lost: boolean;
  density: Density;
}) {
  const classes = ["dm-side"];
  if (won) {
    classes.push("dm-won");
  }
  if (lost) {
    classes.push("dm-lost");
  }

  return (
    <div className={classes.join(" ")}>
      {density === "full" ? <Avatar racer={racer} size="sm" /> : null}
      <span className="dm-name racer-name">{racer ? racer.name : source}</span>
      {won ? <span className="dm-check">Winner</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Finished
// ---------------------------------------------------------------------------------

function Finished({ state }: { state: StatePayload }) {
  const podium = [
    { place: "2nd", id: state.event.runnerUp, tone: "silver" },
    { place: "1st", id: state.event.champion, tone: "gold" },
    { place: "3rd", id: state.event.third, tone: "bronze" },
  ];

  return (
    <main className="disp disp-finished">
      <p className="disp-eyebrow">{state.event.name}</p>
      <h1 className="disp-finished-title">Winner</h1>

      <div className="disp-podium">
        {podium.map((row) => {
          const racer = racerById(state, row.id);
          return (
            <div className={`disp-pod disp-pod-${row.tone}`} key={row.place}>
              <Avatar racer={racer} size="xl" full />
              <p className="disp-pod-place">{row.place}</p>
              <p className="disp-pod-name racer-name">{racer?.name ?? "—"}</p>
            </div>
          );
        })}
      </div>

      {state.event.consolationChampion !== null ? (
        <p className="disp-consolation">
          Consolation winner:{" "}
          <strong>{racerById(state, state.event.consolationChampion)?.name}</strong>
        </p>
      ) : null}
    </main>
  );
}
