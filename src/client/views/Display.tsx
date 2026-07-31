import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { joinUrl, type PublicMatch, type StatePayload } from "../lib/api.ts";
import { matchById, racerById, roundsOf, sourceLabel, type RoundColumn } from "../lib/derive.ts";
import { useResultFlash } from "../lib/useRace.ts";
import { timeAgo, useNow } from "../lib/time.ts";
import { Avatar } from "../components/Avatar.tsx";
import { JoinQR } from "../components/QR.tsx";

type Mode = "AUTO" | "MAIN" | "LOSERS" | "CONSOLATION" | "EVERYTHING";
type Density = "full" | "compact" | "collapsed";

const MODES: Mode[] = ["AUTO", "MAIN", "LOSERS", "CONSOLATION", "EVERYTHING"];
const CONTROL_TIMEOUT_MS = 6000;

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
  const [mode, setMode] = useState<Mode>("AUTO");
  const [zoom, setZoom] = useState<number | null>(null);
  const [focusNudge, setFocusNudge] = useState(0);
  const [pan, setPan] = useState(0);
  const [controlsUntil, setControlsUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const clock = useNow();

  const current = matchById(state, state.event.currentMatch);
  const flashed = matchById(state, flash);
  const banner = flashed ?? current;

  const showControls = now < controlsUntil;

  useEffect(() => {
    if (!showControls) {
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), controlsUntil - now + 50);
    return () => clearTimeout(timer);
  }, [showControls, controlsUntil, now]);

  const wake = useCallback(() => {
    setNow(Date.now());
    setControlsUntil(Date.now() + CONTROL_TIMEOUT_MS);
  }, []);

  // Smart-TV browsers map the D-pad to arrows and OK to Enter; six keys is the
  // whole vocabulary this has to work with.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowUp":
        case "+":
          setZoom((z) => Math.min(2, (z ?? 1) + 0.15));
          break;
        case "ArrowDown":
        case "-":
          setZoom((z) => Math.max(0.6, (z ?? 1) - 0.15));
          break;
        case "ArrowLeft":
          if (zoom === null) {
            setFocusNudge((n) => n - 1);
          } else {
            setPan((p) => p + 120);
          }
          break;
        case "ArrowRight":
          if (zoom === null) {
            setFocusNudge((n) => n + 1);
          } else {
            setPan((p) => p - 120);
          }
          break;
        case "Enter":
          setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]);
          break;
        case "Escape":
        case "Backspace":
        case "0":
          setMode("AUTO");
          setZoom(null);
          setPan(0);
          setFocusNudge(0);
          break;
        default:
          return;
      }

      event.preventDefault();
      wake();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, wake]);

  const onDeck = state.queue
    .filter((id) => id !== state.event.currentMatch)
    .slice(0, 3)
    .map((id) => matchById(state, id))
    .filter((m): m is PublicMatch => m !== null);

  return (
    <main className="disp disp-racing">
      <Banner state={state} match={banner} flashed={flashed !== null} />

      <BracketCanvas
        state={state}
        mode={mode}
        zoom={zoom}
        pan={pan}
        focusNudge={focusNudge}
        flash={flash}
      />

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

      {showControls ? <ControlBar mode={mode} zoom={zoom} /> : null}
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

function ControlBar({ mode, zoom }: { mode: Mode; zoom: number | null }) {
  return (
    <div className="disp-controls">
      <span className="disp-control-mode">{mode}</span>
      <span className="disp-control-key">▲▼ zoom {zoom === null ? "fit" : `${Math.round(zoom * 100)}%`}</span>
      <span className="disp-control-key">◀▶ {zoom === null ? "round" : "pan"}</span>
      <span className="disp-control-key">OK mode</span>
      <span className="disp-control-key">BACK reset</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// The bracket, drawn as track
// ---------------------------------------------------------------------------------

function bracketsFor(mode: Mode, hasConsolation: boolean): string[] {
  switch (mode) {
    case "MAIN":
      return ["W", "GF", "GFR"];
    case "LOSERS":
      return ["L"];
    case "CONSOLATION":
      return hasConsolation ? ["C"] : ["W", "GF", "GFR"];
    default:
      return hasConsolation ? ["W", "L", "GF", "GFR", "C"] : ["W", "L", "GF", "GFR"];
  }
}

function BracketCanvas({
  state,
  mode,
  zoom,
  pan,
  focusNudge,
  flash,
}: {
  state: StatePayload;
  mode: Mode;
  zoom: number | null;
  pan: number;
  focusNudge: number;
  flash: number | null;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const boxes = useRef<Map<number, HTMLElement>>(new Map());

  const [fit, setFit] = useState(1);
  const [paths, setPaths] = useState<{ id: string; d: string; kind: string }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [frame, setFrame] = useState({ w: 0, h: 0 });

  const columns = useMemo(
    () => roundsOf(state, bracketsFor(mode, state.event.consolation)),
    [state, mode],
  );

  const focusIndex = useMemo(() => {
    const found = columns.findIndex((column) =>
      column.matches.some((m) => m.id === state.event.currentMatch),
    );
    const base = found === -1 ? 0 : found;
    return Math.max(0, Math.min(columns.length - 1, base + focusNudge));
  }, [columns, state.event.currentMatch, focusNudge]);

  const densities = useMemo(
    () => columns.map((column, index) => densityOf(column, index, focusIndex, mode)),
    [columns, focusIndex, mode],
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
  }, [state, columns, densities, mode]);

  const scale = zoom ?? fit;
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
  // bracket hug one corner with dead screen either side.
  const offsetX = pan + Math.max(0, (frame.w - size.w * scale) / 2);
  const offsetY = Math.max(0, (frame.h - size.h * scale) / 2);

  return (
    <div className="disp-canvas" ref={viewport}>
      <div
        className="disp-scale"
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
          {ordered.map(({ column, density, startsGroup }) => (
            <Column
              key={column.key}
              state={state}
              column={column}
              density={density}
              startsGroup={startsGroup}
              currentId={state.event.currentMatch}
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

function densityOf(column: RoundColumn, index: number, focus: number, mode: Mode): Density {
  if (mode === "EVERYTHING") {
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
  register,
}: {
  state: StatePayload;
  column: RoundColumn;
  density: Density;
  startsGroup: boolean;
  currentId: number | null;
  register: (id: number, el: HTMLElement | null) => void;
}) {
  const group = startsGroup ? " disp-col-group" : "";

  if (density === "collapsed") {
    const done = column.matches.filter((m) => m.winner !== null).length;
    return (
      <section className={`disp-col disp-col-collapsed${group}`}>
        <span className="disp-col-code">{column.short}</span>
        <span className="disp-col-tally code">
          {done > 0 ? `✓${done}` : `${column.matches.length}`}
        </span>
      </section>
    );
  }

  return (
    <section className={`disp-col disp-col-${density}${group}`}>
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
