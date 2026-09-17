import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { joinUrl, type PublicMatch, type StatePayload } from "../lib/api.ts";
import { matchById, racerById, roundsOf, sourceLabel, type RoundColumn } from "../lib/derive.ts";
import { FLASH_MS, useResultFlash } from "../lib/useRace.ts";
import { playLaunch, unlockAudio } from "../lib/sound.ts";
import { timeAgo, useNow } from "../lib/time.ts";
import { Avatar } from "../components/Avatar.tsx";
import { JoinQR } from "../components/QR.tsx";
import posterUrl from "../assets/y-not-nationals-2026.jpg";

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
  { key: "main", label: "Winners bracket" },
  { key: "losers", label: "Losers bracket" },
  { key: "consolation", label: "Consolation bracket" },
];

const FIT: View = { scale: null, x: 0, y: 0 };

/**
 * The big screen survives a refresh with its settings intact — it runs unattended
 * for hours and a stray reload shouldn't drop it back to defaults mid-race.
 *
 * Zoom and pan are deliberately *not* kept. A pan is only meaningful against the
 * layout it was made in, and the layout changes with the window, the round and the
 * bracket — restoring one lands the view on empty space. Follow mode is the reason
 * to be zoomed in and it is persisted, so the useful case comes back on its own.
 */
const KEY = {
  filter: "race-tracker.disp.filter",
  detail: "race-tracker.disp.detail",
  follow: "race-tracker.disp.follow",
  sound: "race-tracker.disp.sound",
  dismissed: "race-tracker.disp.msgDismissed",
} as const;


const FILTER_KEYS: Filter[] = ["all", "main", "losers", "consolation"];
const DETAIL_KEYS: Detail[] = ["auto", "all"];

function stored<T extends string>(key: string, allowed: T[], fallback: T): T {
  const found = localStorage.getItem(key);
  return allowed.includes(found as T) ? (found as T) : fallback;
}

function storedNumber(key: string): number {
  return Number(localStorage.getItem(key) ?? 0) || 0;
}

/** Long enough to cross the screen to a button, short enough that the room never
    notices the chrome was there. */
const CHROME_IDLE_MS = 2500;
const ZOOM_STEP = 1.15;

/** Divisor on a trackpad pinch's `deltaY`. Bigger is gentler; this is about one
    doubling per full pinch across the pad. */
const PINCH_FEEL = 120;

/**
 * Follow mode sizes itself off the live heat's own card — the card is made this
 * tall a share of the frame — rather than off a multiple of fit.
 *
 * Fit is a moving target: it rises as rounds settle and collapse, as the filter
 * narrows to one bracket, as the window changes shape. A multiple of it meant the
 * heat kept growing through the evening, legible in winners round 1 and far too
 * close by the losers rounds.
 *
 * **Height, not width.** A card's width is set by the *longest label anywhere in
 * its column*, because the column is a flex stack and every card stretches to the
 * widest one. Losers columns carry source labels — "Loser of Wheelsy McWheelerson
 * Jr. vs Emma" — so a losers card lays out at 370px against a winners card's 249px
 * for the very same two names. Holding width constant on screen therefore *shrank
 * the text* by a third the moment the race reached the losers bracket. Height is
 * immune: names are single-line `nowrap` and the avatar is a fixed size, so the
 * card is 87px tall in both brackets, and holding that steady holds the text
 * steady — which is the thing anybody is actually reading.
 */
const FOLLOW_CARD_SHARE = 0.093;

/**
 * Where follow parks the live heat across the frame. Centred, so the round that
 * fed this heat and the round it feeds are both fully on screen — where a racer
 * came from and where they're going are the two questions the bracket is being
 * shown to answer, and at this zoom there is room for both either side.
 */
const FOLLOW_BIAS = 0.5;

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

/**
 * A TV has no scrollbar anyone is going to use, so the roster has to *fit* — the
 * whole point of the screen is that someone who just scanned the QR finds their car
 * on it. The card size therefore follows the roster, between two bounds: a floor so
 * the names stay readable, and a ceiling so the first three arrivals aren't
 * billboards.
 */
const CARD_MIN = 96;
const CARD_MAX = 200;

/**
 * Fewest columns — so the biggest cards — that still fit the box, given that every
 * card is a square photo plus a fixed label block. Fewer columns means wider cards
 * *and* taller rows, so the height is what actually binds.
 */
function rosterColumns(count: number, w: number, h: number, gap: number, label: number): number {
  const most = Math.max(1, Math.floor((w + gap) / (CARD_MIN + gap)));

  for (let cols = 1; cols <= most; cols++) {
    const card = (w - (cols - 1) * gap) / cols;
    if (card > CARD_MAX) {
      continue;
    }
    const rows = Math.ceil(count / cols);
    if (rows * (card + label) + (rows - 1) * gap <= h) {
      return cols;
    }
  }

  // Everyone can't fit even at the floor. Only a phone gets here, and a phone scrolls.
  return most;
}

function Registration({ state }: { state: StatePayload }) {
  const grid = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(0);
  const count = state.racers.length;

  useLayoutEffect(() => {
    const box = grid.current;
    if (!box || count === 0) {
      return;
    }

    const measure = () => {
      const card = box.firstElementChild as HTMLElement | null;
      const photo = card?.firstElementChild as HTMLElement | null;
      if (!card || !photo) {
        return;
      }

      // The label block is a constant: the name is clamped to a reserved two lines,
      // so this can't move when the cards resize and the fit can't chase itself.
      const label = card.offsetHeight - photo.offsetHeight;
      const gap = parseFloat(getComputedStyle(box).rowGap) || 0;
      setCols(rosterColumns(count, box.clientWidth, box.clientHeight, gap, label));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [count]);

  return (
    <main className="disp disp-join">
      <section className="disp-join-left">
        <img
          className="disp-join-poster"
          src={posterUrl}
          alt="The 3rd Annual Y-Not Nationals. Friday October 2: test and tune all day. Saturday October 3: live racing begins at noon."
        />
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

        <div
          className="disp-grid"
          ref={grid}
          style={cols > 0 ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}
        >
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
  const [filter, setFilter] = useState<Filter>(() => stored(KEY.filter, FILTER_KEYS, "all"));
  const [detail, setDetail] = useState<Detail>(() => stored(KEY.detail, DETAIL_KEYS, "auto"));
  const [view, setView] = useState<View>(FIT);
  const [focus, setFocus] = useState<number | null>(null);
  const [follow, setFollow] = useState(() => localStorage.getItem(KEY.follow) === "1");
  const [sound, setSound] = useState(() => localStorage.getItem(KEY.sound) !== "0");
  const [fit, setFit] = useState(1);
  const [dismissed, setDismissed] = useState(() => storedNumber(KEY.dismissed));
  const [chrome, setChrome] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clock = useNow();

  // Written from effects rather than from each handler, so every path that can
  // change a setting persists it — including Esc, which routes through the same
  // setters and so writes the defaults back rather than leaving a stale value to
  // come back on the next refresh.
  useEffect(() => localStorage.setItem(KEY.filter, filter), [filter]);
  useEffect(() => localStorage.setItem(KEY.detail, detail), [detail]);
  useEffect(() => localStorage.setItem(KEY.follow, follow ? "1" : "0"), [follow]);
  useEffect(() => localStorage.setItem(KEY.sound, sound ? "1" : "0"), [sound]);
  useEffect(() => localStorage.setItem(KEY.dismissed, String(dismissed)), [dismissed]);

  // Audio needs a real gesture before a browser will let it start — a click or a
  // keypress, and specifically not the mouse move that reveals the toolbar. Any
  // press anywhere counts, so the first time the operator touches anything the
  // sound is armed for the rest of the evening.
  useEffect(() => {
    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("keydown", unlockAudio);
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, []);

  // Fires on the result, which is when the winner's chip sets off up its
  // connector. Keyed on the flash rather than on `state`, so an unrelated push
  // mid-celebration can't retrigger it — and latched on the match id, so nor can
  // toggling the sound on part way through one.
  const sounded = useRef<number | null>(null);

  useEffect(() => {
    if (flash === null) {
      sounded.current = null;
      return;
    }
    if (sounded.current === flash) {
      return;
    }
    sounded.current = flash;
    if (sound) {
      playLaunch();
    }
  }, [flash, sound]);

  const current = matchById(state, state.event.currentMatch);
  const flashed = matchById(state, flash);
  const banner = flashed ?? current;

  const filters = useMemo(
    () => FILTERS.filter((f) => f.key !== "consolation" || state.event.consolation),
    [state.event.consolation],
  );

  // A stored filter can name a bracket that no longer exists — Consolation, saved
  // last year, before this year's is built. Fall back rather than leaving no
  // button lit and the bracket quietly showing something else.
  useEffect(() => {
    if (!filters.some((f) => f.key === filter)) {
      setFilter("all");
    }
  }, [filters, filter]);

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
    setFollow(false);
  }, []);

  /** Any hand on the controls drops follow. Auto-framing that fights the person
      driving is worse than no auto-framing. */
  const manual = useCallback(() => setFollow(false), []);

  /** Changing what's on screen invalidates a column index, so hand focus back to
      the live heat rather than landing on whatever now sits in that position. */
  const pickFilter = useCallback((key: Filter) => {
    setFilter(key);
    setFocus(null);
    setView(FIT);
    setFollow(false);
  }, []);

  const zoomBy = useCallback(
    (steps: number) => {
      setFollow(false);
      setView((v) => {
        const next = (v.scale ?? fit) * ZOOM_STEP ** steps;
        // Zooming back out through fit returns to fit proper, which also recentres.
        // There is nothing below it to see — the whole bracket is already on screen.
        return next <= fit ? FIT : { ...v, scale: Math.min(next, zoomCeiling(fit)) };
      });
    },
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
            manual();
            setView((v) => ({ ...v, x: v.x + 120 }));
          }
          break;
        case "ArrowRight":
          if (view.scale === null) {
            setFocus(clamp(focusIndex + 1, 0, columns.length - 1));
          } else {
            manual();
            setView((v) => ({ ...v, x: v.x - 120 }));
          }
          break;
        case "a":
          setFollow((f) => !f);
          break;
        case "s":
          setSound((s) => !s);
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
          manual();
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
  }, [view.scale, filters, columns.length, focusIndex, zoomBy, reset, manual, wake]);

  // A high-water mark, not an exact id: dismissing hides that message and anything
  // older, so a message being deleted server-side can't resurface one that was
  // already closed. Anything newer still gets through.
  const latest = state.announcements[0] ?? null;
  const announcement = latest !== null && latest.id > dismissed ? latest : null;

  const onDeck = state.queue
    .filter((id) => id !== state.event.currentMatch)
    .slice(0, 3)
    .map((id) => matchById(state, id))
    .filter((m): m is PublicMatch => m !== null);

  return (
    <main className={`disp disp-racing ${chrome ? "" : "disp-racing-idle"}`}>
      {/* On deck and the join QR live in the top band's outer corners, either side
          of the head-to-head. Both cars cluster toward the middle, so those corners
          were dead screen — and it puts what's coming next in the same glance as
          what's running now, rather than at the opposite edge of the room. */}
      <header className="disp-top">
        <div className="disp-ondeck">
          <span className="disp-eyebrow">On deck</span>
          {onDeck.length === 0 ? (
            <span className="disp-ondeck-empty">—</span>
          ) : (
            <div className="disp-ondeck-list">
              {onDeck.map((match) => (
                <span className="disp-ondeck-item" key={match.id}>
                  {racerById(state, match.a)?.name ?? "TBD"}
                  <span className="disp-ondeck-vs">vs</span>
                  {racerById(state, match.b)?.name ?? "TBD"}
                </span>
              ))}
            </div>
          )}
        </div>

        <Banner state={state} match={banner} flashed={flashed !== null} />

        {/* "Heats run", not "heat N of M": this is the count already raced, so the
            number is one behind the heat on the track. The director's own screen
            shows heatsDone + 1 for that, and the two should not read alike. */}
        <div className="disp-top-right">
          <span className="disp-progress">
            <span className="disp-eyebrow">Heats run</span>
            <span className="code tabular disp-progress-count">
              {state.event.heatsDone} / {state.event.heatsTotal}
            </span>
          </span>

          <div className="disp-top-qr">
            <JoinQR url={joinUrl()} size={92} label="" />
          </div>
        </div>
      </header>

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
          follow={follow}
          flash={flash}
          onView={setView}
          onFit={setFit}
          onManual={manual}
        />

        <Controls
          shown={chrome}
          filters={filters}
          filter={filter}
          detail={detail}
          follow={follow}
          sound={sound}
          scale={view.scale}
          fit={fit}
          onFilter={pickFilter}
          onDetail={() => setDetail((d) => (d === "all" ? "auto" : "all"))}
          onFollow={() => setFollow((f) => !f)}
          onSound={() => setSound((s) => !s)}
          onZoom={zoomBy}
          onFit={() => {
            manual();
            setView(FIT);
          }}
        />
      </div>

      {/* The footer is now only ever a director message, so it goes away entirely
          when there isn't one and the bracket takes the height back. Dismissal is
          local to this screen and keyed on the id, so clearing a stale message
          neither touches what racers see on their phones nor swallows the next
          one. The × only appears with the rest of the chrome — it is for whoever
          is driving, not for the room. */}
      {announcement !== null ? (
        <footer className="disp-foot">
          <p className="disp-announce" key={announcement.id}>
            <span className="disp-announce-tag">Director</span>
            <span className="disp-announce-body">{announcement.body}</span>
            <span className="disp-announce-when">{timeAgo(announcement.at, clock)}</span>
            <button
              type="button"
              className={`disp-announce-x ${chrome ? "" : "disp-announce-x-off"}`}
              onClick={() => setDismissed(announcement.id)}
              aria-label="Dismiss this message"
            >
              ×
            </button>
          </p>
        </footer>
      ) : null}
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
  // rather than two things pinned to opposite edges of the screen. The stamp and
  // the ring both belong to the photo, not to the block — same as the racer view,
  // where green on the photo means "this car won" and nothing else does.
  const photo = (
    <div className="disp-banner-photo" key="photo">
      <Avatar racer={racer} size="xl" full />
      {won ? <span className="disp-stamp">Winner!</span> : null}
    </div>
  );
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
  follow,
  sound,
  scale,
  fit,
  onFilter,
  onDetail,
  onFollow,
  onSound,
  onZoom,
  onFit,
}: {
  shown: boolean;
  filters: { key: Filter; label: string }[];
  filter: Filter;
  detail: Detail;
  follow: boolean;
  sound: boolean;
  scale: number | null;
  fit: number;
  onFilter: (key: Filter) => void;
  onDetail: () => void;
  onFollow: () => void;
  onSound: () => void;
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

      <div className="disp-ctl-set">
        <button
          type="button"
          className={`disp-ctl-btn ${detail === "all" ? "is-on" : ""}`}
          onClick={onDetail}
          title="Draw every round at the same size instead of collapsing what's settled"
        >
          All rounds
        </button>
        <button
          type="button"
          className={`disp-ctl-btn ${follow ? "is-on" : ""}`}
          onClick={onFollow}
          title="Zoom in on the current heat and track it as the race moves"
        >
          Follow
        </button>
        <button
          type="button"
          className={`disp-ctl-btn ${sound ? "is-on" : ""}`}
          onClick={onSound}
          title="Play a launch as the winner's car runs up the bracket"
        >
          Sound
        </button>
      </div>

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

      <span className="disp-ctl-hint">pinch to zoom · drag to pan</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// The bracket, drawn as track
// ---------------------------------------------------------------------------------

/**
 * Heading for a bracket. Always qualified — "Winners" on its own names the people
 * who have won, which nobody has yet; "Winners bracket" names the half of the draw
 * you are looking at. "Finals" is the exception and stays bare: those matches are
 * the conclusion of the draw, not a bracket of their own. GF and GFR are separate
 * brackets internally but one thing to anyone reading the screen.
 */
function bracketGroup(bracket: string): { key: string; label: string } {
  switch (bracket) {
    case "L":
      return { key: "L", label: "Losers bracket" };
    case "GF":
    case "GFR":
      return { key: "F", label: "Finals" };
    case "C":
      return { key: "C", label: "Consolation bracket" };
    default:
      return { key: "W", label: "Winners bracket" };
  }
}

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
  follow,
  flash,
  onView,
  onFit,
  onManual,
}: {
  state: StatePayload;
  columns: RoundColumn[];
  detail: Detail;
  view: View;
  focusIndex: number;
  follow: boolean;
  flash: number | null;
  onView: (view: View) => void;
  onFit: (fit: number) => void;
  onManual: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const boxes = useRef<Map<number, HTMLElement>>(new Map());
  const drag = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);
  const dragged = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number; ox: number; oy: number } | null>(null);

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

    const sorted = columns
      .map((column, index) => ({ column, density: densities[index], index }))
      .sort((x, y) => {
        const xg = rank[x.column.matches[0]?.bracket ?? "W"] ?? 0;
        const yg = rank[y.column.matches[0]?.bracket ?? "W"] ?? 0;
        return xg - yg || (x.column.matches[0]?.round ?? 0) - (y.column.matches[0]?.round ?? 0);
      });

    const focusPosition = sorted.findIndex((entry) => entry.index === focusIndex);

    return sorted.map((entry, position) => ({
      ...entry,
      /*
       * Follow only: whatever ends up *beside* the live round on screen has to be
       * readable, because those two are the round that fed this heat and the round
       * it feeds — where these racers came from and where the winner goes.
       *
       * Density is decided on playing order, which is temporal adjacency, but the
       * layout is grouped by bracket. Playing order interleaves W and L, so the
       * next winners round sits two or three steps away in time while being the
       * very next column on screen, and gets collapsed as "untouched". Promote it
       * back by its position in the laid-out order rather than in time.
       *
       * Not applied when fitting the whole bracket: a settled round is the biggest
       * waste of space on the screen (winners round 1 is sixteen matches tall), and
       * collapsing it is what lets everything else be drawn large. Follow doesn't
       * pay that cost, because its zoom comes from the card, not from fit.
       */
      density:
        follow && entry.density === "collapsed" && Math.abs(position - focusPosition) === 1
          ? ("compact" as Density)
          : entry.density,
    }));
  }, [columns, densities, focusIndex, follow]);

  /**
   * The same columns, gathered under their bracket so each one can carry a title.
   * The two grand-final columns share a heading — `GF` and `GFR` are separate
   * brackets internally but "Finals" to anyone reading the screen.
   */
  const groups = useMemo(() => {
    const out: { key: string; label: string; entries: typeof ordered }[] = [];

    for (const entry of ordered) {
      const { key, label } = bracketGroup(entry.column.matches[0]?.bracket ?? "W");
      const last = out[out.length - 1];

      if (last && last.key === key) {
        last.entries.push(entry);
      } else {
        out.push({ key, label, entries: [entry] });
      }
    }

    return out;
  }, [ordered]);

  // Measure in layout coordinates (offsetLeft/Top), which the scale transform on
  // the wrapper does not affect — so connectors stay correct at any zoom.
  useLayoutEffect(() => {
    const root = canvas.current;
    const content = tree.current;
    const frame = viewport.current;
    if (!root || !content || !frame) {
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

      // Measure the tree, never the wrapper. The wrapper also contains the
      // connector SVG, which is sized from *this* measurement — so measuring the
      // wrapper makes the size its own input. It ratchets: once the SVG is tall,
      // it props up the wrapper's scrollHeight and the measured height can never
      // shrink again, pinning the fit scale at whatever the tallest layout ever
      // needed. Collapsing rounds then bought space that fit never spent.
      const w = content.offsetWidth;
      const h = content.offsetHeight;
      setSize({ w, h });
      setFrame({ w: frame.clientWidth, h: frame.clientHeight });

      if (w > 0 && h > 0) {
        setFit(Math.min(frame.clientWidth / w, frame.clientHeight / h, 1.8));
      }
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(content);

    return () => observer.disconnect();
  }, [state, columns, ordered]);

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

  // A little headroom past the edges. Without it the clamp refuses to show any
  // background at all, and follow mode cannot honour its bias for a heat in the
  // first or last round — the live heat would drift between a third in and hard
  // against the edge depending on the round, which is exactly the predictability
  // follow mode exists to provide. Bounded, so the bracket can't be flung away.
  const slackX = frame.w * FOLLOW_BIAS;
  const slackY = frame.h * FOLLOW_BIAS;
  const offsetX =
    contentW <= frame.w
      ? (frame.w - contentW) / 2
      : clamp(view.x, frame.w - contentW - slackX, slackX);
  const offsetY =
    contentH <= frame.h
      ? (frame.h - contentH) / 2
      : clamp(view.y, frame.h - contentH - slackY, slackY);
  const pannable = contentW > frame.w + 1 || contentH > frame.h + 1;

  /**
   * What follow mode is pointed at. It deliberately *lags* the live heat by the
   * length of a result: `currentMatch` advances the instant the director saves,
   * which is the start of the celebration and not the end, so aiming straight at
   * it panned the screen out from under the winner's chip while that chip was
   * still travelling its connector. Lagging lands the move on the same beat as the
   * banner swapping to the next heat, and the whole screen turns at once.
   *
   * A timer rather than a read of `flash`, because effects run child-before-parent:
   * the flash is set in an effect up in Racing, so on the render where the result
   * arrives this component still sees the old value and would re-aim before any
   * guard could apply. The target is the thing that has to lag, not the reaction.
   */
  const [target, setTarget] = useState<number | null>(null);
  const live = state.event.currentMatch;

  // Wait only when the heat we are framed on has actually *finished* — that is a
  // result being celebrated, and there is something on screen worth watching. If
  // it is still ready then the director swapped the matchup by hand, which has no
  // animation attached, and pausing on the heat they just moved off is only slow.
  const finished =
    target !== null && state.matches.find((m) => m.id === target)?.state === "done";
  const celebrating = follow && target !== null && live !== target && finished;

  // Deps are all primitives, so an unrelated push — a message, a photo upload —
  // leaves them untouched and cannot restart the timer half way through a hold.
  useEffect(() => {
    if (live === target) {
      return;
    }

    if (!celebrating) {
      setTarget(live);
      return;
    }

    const timer = setTimeout(() => setTarget(live), FLASH_MS);
    return () => clearTimeout(timer);
  }, [live, target, celebrating]);

  /**
   * Aim. Left of centre rather than dead centre, because the bracket flows left to
   * right — the interesting half of the screen is the half that hasn't happened
   * yet. Runs on layout rather than a timer, so a collapsing round or a resized
   * window re-aims too, which also keeps the finished heat framed while it is
   * being celebrated.
   */
  useEffect(() => {
    if (!follow || target === null || size.w === 0 || frame.w === 0) {
      return;
    }

    const box = boxes.current.get(target);
    if (!box) {
      return;
    }

    // Frame height and card height are both stable; only the whole bracket's laid-out
    // size moves, which is why fit moves. Sizing between the two stable measurements
    // keeps the heat the same size on screen all evening. Floored at fit because
    // there is nothing to see below it, capped absolutely so a short card in a
    // one-column filter can't fill the screen.
    const next = clamp((frame.h * FOLLOW_CARD_SHARE) / box.offsetHeight, fit, 3);
    onView({
      scale: next,
      x: frame.w * FOLLOW_BIAS - (box.offsetLeft + box.offsetWidth / 2) * next,
      y: frame.h / 2 - (box.offsetTop + box.offsetHeight / 2) * next,
    });
  }, [follow, target, fit, size, frame, ordered, onView]);

  /**
   * Zoom to `next`, holding the content under (px, py) still. Anchored off the
   * scale and offset the gesture *started* at, not the live ones, so a long pinch
   * doesn't accumulate rounding drift and slide out from under the fingers.
   */
  const zoomAt = useCallback(
    (px: number, py: number, next: number, fromScale: number, fromX: number, fromY: number) => {
      if (next <= fit) {
        onView(FIT);
        return;
      }
      const ratio = next / fromScale;
      onView({ scale: next, x: px - (px - fromX) * ratio, y: py - (py - fromY) * ratio });
    },
    [fit, onView],
  );

  /**
   * Trackpad pinch. Both macOS and Windows report one as a wheel event with
   * `ctrlKey` set, which is why this can exist without bringing back scroll-to-
   * zoom: a plain wheel stays deliberately inert, because on a trackpad it fires
   * by accident constantly and this screen is in front of a room.
   *
   * Native and non-passive because React registers wheel on its root as passive,
   * so `preventDefault` from an `onWheel` prop is ignored — and without it the
   * browser zooms the whole page instead.
   */
  useEffect(() => {
    const el = viewport.current;
    if (!el) {
      return;
    }

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }

      event.preventDefault();
      onManual();

      const next = clamp(scale * Math.exp(-event.deltaY / PINCH_FEEL), fit, zoomCeiling(fit));
      if (next === scale) {
        return;
      }

      const rect = el.getBoundingClientRect();
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, next, scale, offsetX, offsetY);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scale, fit, offsetX, offsetY, zoomAt, onManual]);

  /** Midpoint and separation of the two active touches. */
  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragged.current = false;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.current?.setPointerCapture(event.pointerId);

    // A second finger turns a drag into a pinch.
    if (pointers.current.size === 2) {
      onManual();
      drag.current = null;
      setGrabbing(false);
      pinch.current = { dist: spread().dist, scale, ox: offsetX, oy: offsetY };
      return;
    }

    if (pointers.current.size === 1 && event.button === 0 && pannable) {
      onManual();
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: offsetX, oy: offsetY };
      setGrabbing(true);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) {
      return;
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const pinching = pinch.current;
    if (pinching && pointers.current.size >= 2) {
      const now = spread();
      const rect = viewport.current?.getBoundingClientRect();
      if (!rect || now.dist <= 0) {
        return;
      }

      const next = clamp(pinching.scale * (now.dist / pinching.dist), fit, zoomCeiling(fit));
      zoomAt(now.x - rect.left, now.y - rect.top, next, pinching.scale, pinching.ox, pinching.oy);
      return;
    }

    const held = drag.current;
    if (!held || held.id !== event.pointerId) {
      return;
    }

    const dx = event.clientX - held.x;
    const dy = event.clientY - held.y;

    // A few pixels of slop before the bracket starts moving, so resting a hand on
    // the trackpad doesn't nudge it. Latched, so once a drag is underway coming
    // back inside the threshold doesn't stall it.
    if (!dragged.current && Math.abs(dx) < 4 && Math.abs(dy) < 4) {
      return;
    }

    dragged.current = true;
    onView({ scale, x: held.ox + dx, y: held.oy + dy });
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);

    if (viewport.current?.hasPointerCapture(event.pointerId)) {
      viewport.current.releasePointerCapture(event.pointerId);
    }

    // Lifting one finger of a pinch must not resume a drag with the other — the
    // remaining finger has moved since it went down, and the bracket would jump.
    if (pointers.current.size < 2) {
      pinch.current = null;
    }

    if (drag.current?.id === event.pointerId) {
      drag.current = null;
      setGrabbing(false);
    }
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
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
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

        {/* The wrapping divs are all static, so match boxes still measure their
            offsets against .disp-scale and the connectors are unaffected. */}
        <div className="disp-tree" ref={tree}>
          {groups.map((group) => (
            <section className="disp-group" key={group.key}>
              <h2 className="disp-group-title">{group.label}</h2>
              <div className="disp-group-cols">
                {group.entries.map(({ column, density }) => (
                  <Column
                    key={column.key}
                    state={state}
                    column={column}
                    density={density}
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
            </section>
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
  currentId,
  register,
}: {
  state: StatePayload;
  column: RoundColumn;
  density: Density;
  currentId: number | null;
  register: (id: number, el: HTMLElement | null) => void;
}) {
  if (density === "collapsed") {
    const done = column.matches.filter((m) => m.winner !== null).length;
    return (
      <section className="disp-col disp-col-collapsed">
        <span className="disp-col-code">{column.short}</span>
        <span className="disp-col-tally code">
          {done > 0 ? `✓${done}` : `${column.matches.length}`}
        </span>
      </section>
    );
  }

  return (
    <section className={`disp-col disp-col-${density}`}>
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
  if (match.bracket === "C") {
    classes.push("dm-consolation");
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
