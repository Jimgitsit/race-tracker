import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";

import { ApiError, api, joinUrl, type PublicMatch, type StatePayload } from "../lib/api.ts";
import { clearToken, getToken, setToken } from "../lib/identity.ts";
import { preparePhoto } from "../lib/photo.ts";
import {
  matchById,
  pathOf,
  racerById,
  recordOf,
  roundsOf,
  statusChip,
  statusFor,
} from "../lib/derive.ts";
import { alertsEnabled, canVibrate, disableAlerts, enableAlerts } from "../lib/alerts.ts";
import { useMessages, useRaceAlerts, type Message } from "../lib/useAlerts.ts";
import { clockTime, timeAgo, useNow } from "../lib/time.ts";
import { Avatar } from "../components/Avatar.tsx";
import { MatchCard } from "../components/MatchCard.tsx";
import { JoinQR } from "../components/QR.tsx";
import { Sheet } from "../components/Sheet.tsx";

type Tab = "now" | "bracket" | "racers" | "rules";

const TABS: { id: Tab; label: string }[] = [
  { id: "now", label: "Now" },
  { id: "bracket", label: "Bracket" },
  { id: "racers", label: "Racers" },
  { id: "rules", label: "Rules" },
];

const ID_KEY = "race-tracker.id";

export function RacerView({ state }: { state: StatePayload }) {
  const [meId, setMeId] = useState<number | null>(() => {
    const stored = localStorage.getItem(ID_KEY);
    return stored ? Number(stored) : null;
  });
  const [resolving, setResolving] = useState(() => getToken() !== null && meId === null);

  // A re-link QR delivers a token with no id attached, so ask the server who we are.
  useEffect(() => {
    if (meId !== null || getToken() === null) {
      return;
    }

    let live = true;
    api
      .me()
      .then((racer) => {
        if (!live) {
          return;
        }
        localStorage.setItem(ID_KEY, String(racer.id));
        setMeId(racer.id);
      })
      .catch(() => clearToken())
      .finally(() => {
        if (live) {
          setResolving(false);
        }
      });

    return () => {
      live = false;
    };
  }, [meId]);

  const me = meId === null ? null : (state.racers.find((r) => r.id === meId) ?? null);

  // The director can remove a racer; if that happened, this phone is a stranger again.
  useEffect(() => {
    if (meId !== null && me === null && state.event.phase === "registration") {
      localStorage.removeItem(ID_KEY);
      clearToken();
      setMeId(null);
    }
  }, [meId, me, state.event.phase]);

  if (resolving) {
    return (
      <div className="boot">
        <div className="boot-track" aria-hidden="true" />
        <p className="eyebrow">Finding your car</p>
      </div>
    );
  }

  if (me === null) {
    return (
      <Join
        state={state}
        onJoined={(id) => {
          setMeId(id);
          setResolving(false);
        }}
      />
    );
  }

  return <Main state={state} meId={me.id} />;
}

// ---------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------

function Join({ state, onJoined }: { state: StatePayload; onJoined: (id: number) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const closed = state.event.phase !== "registration";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const result = await api.register(name);
      setToken(result.token);
      localStorage.setItem(ID_KEY, String(result.racer.id));
      onJoined(result.racer.id);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : "Couldn't sign you up.");
    } finally {
      setBusy(false);
    }
  };

  if (closed) {
    return (
      <main className="rc-join">
        <TrackRule />
        <h1 className="rc-join-title">{state.event.name}</h1>
        <p className="rc-join-sub">
          Registration has closed — {state.event.racerCount} cars are racing.
        </p>
        <a className="btn btn-primary btn-block" href="display">
          Watch the bracket
        </a>
      </main>
    );
  }

  return (
    <main className="rc-join">
      <TrackRule />
      <p className="eyebrow">{state.event.year}</p>
      <h1 className="rc-join-title">{state.event.name}</h1>
      <p className="rc-join-sub">
        {state.event.racerCount === 0
          ? "Be the first car on the grid."
          : `${state.event.racerCount} cars on the grid so far.`}
      </p>

      <form className="stack" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="racer-name">
          Your name
        </label>
        <input
          id="racer-name"
          className="field"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Your name"
          autoComplete="name"
          enterKeyHint="go"
          maxLength={24}
          autoFocus
        />
        {error ? <p className="error-msg">{error}</p> : null}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !name.trim()}>
          {busy ? "Signing you up…" : "I'm racing"}
        </button>
      </form>
    </main>
  );
}

function TrackRule() {
  return <div className="track-rule" aria-hidden="true" />;
}

// ---------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------

function Main({ state, meId }: { state: StatePayload; meId: number }) {
  const [tab, setTab] = useState<Tab>("now");
  const me = racerById(state, meId);
  const messages = useMessages(state, meId);

  useRaceAlerts(state, meId, messages);

  return (
    <div className="rc">
      <header className="rc-top">
        <div>
          <p className="eyebrow">{state.event.name}</p>
          <p className="rc-count code">
            {state.event.phase === "registration"
              ? `${state.event.racerCount} registered`
              : `Heat ${state.event.heatsDone} of ${state.event.heatsTotal}`}
          </p>
        </div>
        <ShareButton />
      </header>

      <main className="rc-body">
        {tab === "now" ? (
          <NowTab
            state={state}
            meId={meId}
            messages={messages}
            onExplain={() => setTab("rules")}
          />
        ) : null}
        {tab === "bracket" ? <BracketTab state={state} meId={meId} /> : null}
        {tab === "racers" ? <RacersTab state={state} meId={meId} /> : null}
        {tab === "rules" ? <RulesTab state={state} meId={meId} /> : null}
      </main>

      <nav className="rc-nav">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`rc-nav-btn ${tab === id ? "rc-nav-on" : ""}`}
            onClick={() => setTab(id)}
            aria-current={tab === id}
          >
            {label}
          </button>
        ))}
      </nav>

      {me ? null : <p className="offline-banner">Your registration wasn't found.</p>}
    </div>
  );
}

function ShareButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="btn btn-ghost rc-share" onClick={() => setOpen(true)}>
        Invite
      </button>
      <Sheet open={open} title="Get someone else racing" onClose={() => setOpen(false)}>
        <JoinQR url={joinUrl()} size={260} label="Point a phone camera at this" />
        <button className="btn btn-block" onClick={() => setOpen(false)} type="button">
          Done
        </button>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------------
// Now
// ---------------------------------------------------------------------------------

function NowTab({
  state,
  meId,
  messages,
  onExplain,
}: {
  state: StatePayload;
  meId: number;
  messages: Message[];
  onExplain: () => void;
}) {
  const me = racerById(state, meId);
  const status = statusFor(state, me);
  const current = matchById(state, state.event.currentMatch);
  const onDeck = state.queue
    .filter((id) => id !== state.event.currentMatch)
    .slice(0, 2)
    .map((id) => matchById(state, id))
    .filter((m): m is PublicMatch => m !== null);

  if (state.event.phase === "registration") {
    return (
      <div className="stack">
        <section className="rc-wait">
          <p className="eyebrow">On the grid</p>
          <p className="rc-wait-count">{state.event.racerCount}</p>
          <p className="rc-wait-note">Waiting for the race director to start.</p>
        </section>
        <MessageList messages={messages} />
        <AlertsCard />
        {me ? <PhotoCard racer={me} /> : null}
      </div>
    );
  }

  // When the viewer is in the heat on screen, the card above already says so in
  // letters an inch tall — repeating it underneath is the same sentence twice.
  const racingNow = current !== null && (current.a === meId || current.b === meId);

  return (
    <div className="stack">
      <MessageList messages={messages} />

      {current ? <NowCard state={state} match={current} meId={meId} /> : null}

      {status && !racingNow ? (
        <section className={`rc-status rc-status-${status.tone}`}>
          <p className="rc-status-line">{status.headline}</p>
          {status.detail ? <p className="rc-status-detail">{status.detail}</p> : null}
        </section>
      ) : null}

      <button type="button" className="rc-explain" onClick={onExplain}>
        {me && me.losses === 1 && me.status !== "out"
          ? "You lost one — you're still in. Here's how →"
          : "New here? How the racing works →"}
      </button>

      {onDeck.length > 0 ? (
        <section>
          <p className="eyebrow rc-section-head">On deck</p>
          <div className="stack rc-ondeck">
            {onDeck.map((match) => (
              <MatchCard key={match.id} state={state} match={match} />
            ))}
          </div>
        </section>
      ) : null}

      <AlertsCard />

      {me ? <PhotoCard racer={me} /> : null}
    </div>
  );
}

/**
 * Newest message only, with older ones behind a tap. A drunk person reading a
 * thread is not a thing that happens.
 */
function MessageList({ messages }: { messages: Message[] }) {
  const [open, setOpen] = useState(false);
  const now = useNow();

  if (messages.length === 0) {
    return null;
  }

  const [latest, ...older] = messages;

  return (
    <>
      <section className={`rc-msg ${latest.direct ? "rc-msg-direct" : ""}`}>
        <p className="eyebrow rc-msg-head">
          <span>{latest.direct ? "Message for you" : "From the race director"}</span>
          <span className="rc-msg-when">{timeAgo(latest.at, now)}</span>
        </p>
        <p className="rc-msg-body">{latest.body}</p>
        {older.length > 0 ? (
          <button type="button" className="rc-msg-more" onClick={() => setOpen(true)}>
            {older.length} earlier {older.length === 1 ? "message" : "messages"}
          </button>
        ) : null}
      </section>

      <Sheet open={open} title="Messages" onClose={() => setOpen(false)}>
        <div className="stack">
          {messages.map((message) => (
            <div className="rc-msg-old" key={message.id}>
              <p className="eyebrow rc-msg-head">
                <span>{message.direct ? "For you" : "Everyone"}</span>
                {/* Clock time in the log, where the question is when it was said. */}
                <span className="rc-msg-when">
                  {clockTime(message.at)} · {timeAgo(message.at, now)}
                </span>
              </p>
              <p>{message.body}</p>
            </div>
          ))}
        </div>
      </Sheet>
    </>
  );
}

/**
 * Opting in has to happen inside a real tap: that gesture is what unlocks audio
 * for the rest of the session. The copy is deliberately specific about what each
 * phone will actually do, because promising a buzz an iPhone can't deliver is
 * worse than promising nothing.
 */
function AlertsCard() {
  const [on, setOn] = useState(alertsEnabled);
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    try {
      await enableAlerts();
      setOn(true);
    } finally {
      setBusy(false);
    }
  };

  if (on) {
    return (
      <section className="rc-alerts rc-alerts-on">
        <div className="rc-alerts-text">
          <p className="rc-alerts-head">Alerts are on</p>
          <p className="rc-alerts-sub">
            {canVibrate()
              ? "You'll hear a chime and feel a buzz when you're up."
              : "You'll hear a chime when you're up. This phone can't vibrate from a web page."}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost rc-alerts-btn"
          onClick={() => {
            disableAlerts();
            setOn(false);
          }}
        >
          Turn off
        </button>
      </section>
    );
  }

  return (
    <section className="rc-alerts">
      <div className="rc-alerts-text">
        <p className="rc-alerts-head">Get alerted when you're up</p>
        <p className="rc-alerts-sub">
          Keep this page open and your phone will chime when it's your turn. Volume up.
        </p>
      </div>
      <button
        type="button"
        className="btn btn-primary rc-alerts-btn"
        onClick={enable}
        disabled={busy}
      >
        {busy ? "…" : "Turn on"}
      </button>
    </section>
  );
}

function NowCard({
  state,
  match,
  meId,
}: {
  state: StatePayload;
  match: PublicMatch;
  meId: number;
}) {
  const a = racerById(state, match.a);
  const b = racerById(state, match.b);
  const mine = match.a === meId || match.b === meId;

  return (
    <section className={`rc-now ${mine ? "rc-now-mine" : ""}`}>
      <div className="rc-now-head">
        <p className="eyebrow">Now racing</p>
        <p className="code">{match.label}</p>
      </div>

      <div className="rc-now-cars">
        <RacerBlock racer={a} highlight={match.a === meId} />
        <p className="rc-vs">VS</p>
        <RacerBlock racer={b} highlight={match.b === meId} />
      </div>

      {mine ? <p className="rc-thats-you">That's you — get to the track</p> : null}
    </section>
  );
}

function RacerBlock({
  racer,
  highlight,
}: {
  racer: ReturnType<typeof racerById>;
  highlight: boolean;
}) {
  return (
    <div className={`rc-car ${highlight ? "rc-car-mine" : ""}`}>
      <Avatar racer={racer} size="xl" full />
      <p className="rc-car-name racer-name">{racer?.name ?? "TBD"}</p>
    </div>
  );
}

function PhotoCard({ racer }: { racer: NonNullable<ReturnType<typeof racerById>> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const { full, thumb } = await preparePhoto(file);
      await api.uploadPhoto(full, thumb);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : "That photo didn't upload.");
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  };

  return (
    <section className="rc-photo">
      <Avatar racer={racer} size="md" />
      <div className="rc-photo-text">
        <p className="rc-photo-name racer-name">{racer.name}</p>
        <p className="rc-photo-hint">
          {racer.photo ? "Tap to replace your car photo" : "Add a photo of your car"}
        </p>
        {error ? <p className="error-msg">{error}</p> : null}
      </div>
      <label className="btn btn-ghost rc-photo-btn">
        {busy ? "Uploading…" : racer.photo ? "Change" : "Add"}
        <input
          className="visually-hidden"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={upload}
          disabled={busy}
        />
      </label>
    </section>
  );
}

// ---------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------

/**
 * Written to be understood by someone who has had a few, standing next to a
 * track, on a phone. Short sentences, one idea each, and the viewer's own state
 * up top — "one loss left" lands where "double elimination" does not, though the
 * term itself is named once for the people who already know it.
 */
function RulesTab({ state, meId }: { state: StatePayload; meId: number }) {
  const me = racerById(state, meId);
  const losses = me?.losses ?? 0;
  const out = me?.status === "out";

  // The bars count losses taken, not chances remaining — they start empty and
  // fill, in the losers-bracket blue, which is the colour that already means
  // "you've dropped a race" everywhere else in the app.
  const tally = out
    ? `You finished ${me?.placement ?? "—"} of ${state.event.racerCount}.`
    : losses === 0
      ? "None yet."
      : "One more and you're done.";

  return (
    <div className="rc-rules">
      <section className="rc-lives">
        <h1 className="rc-lives-head">
          Win and you keep racing, lose twice and you're out.
        </h1>

        <div className="rc-pips-block">
          <p className="eyebrow rc-pips-label">Losses</p>
          <div className="rc-pips" role="img" aria-label={`${losses} of 2 losses`}>
            <span className={`rc-pip ${losses >= 1 ? "rc-pip-taken" : ""}`} />
            <span className={`rc-pip ${losses >= 2 ? "rc-pip-taken" : ""}`} />
          </div>
          <p className="rc-lives-sub">{tally}</p>
        </div>
      </section>

      <p className="rc-rules-aside">
        Technically, it's a <strong>double-elimination</strong> bracket.
      </p>

      <section className="rc-rules-block">
        <h2 className="rc-rules-h">How it goes</h2>
        <ol className="rc-steps">
          <li>Everyone starts in the Winners bracket.</li>
          <li>
            Lose once and you drop to the Losers bracket. <strong>You're still in.</strong>
          </li>
          <li>Lose in the Losers bracket and you're out. We'll show you where you finished.</li>
        </ol>
        <p className="rc-rules-note">
          So everyone races at least twice. Nobody drives home after one heat.
        </p>
      </section>

      <section className="rc-rules-block">
        <h2 className="rc-rules-h">How it ends</h2>
        <p>
          The last racer standing in each bracket races for the win. One of them has never
          lost; the other has lost once.
        </p>
        <p>
          If the one who already lost wins that race, they're level — one loss each — so they
          run it one more time to settle it.
        </p>
      </section>

      {state.event.consolation ? (
        <section className="rc-rules-block">
          <h2 className="rc-rules-h">Consolation bracket</h2>
          <p>
            Knocked out of the main race and still here? You've been put in a second one. Same
            idea, except that one is single elimination — lose once and you're done.
          </p>
        </section>
      ) : null}

      <section className="rc-rules-block">
        <h2 className="rc-rules-h">Reading the screen</h2>
        <ul className="rc-key">
          <li>
            <span className="rc-key-swatch rc-key-w" /> Winners bracket
          </li>
          <li>
            <span className="rc-key-swatch rc-key-l" /> Losers bracket
          </li>
          <li>
            <span className="rc-key-mark">✓</span> won that race
          </li>
          <li>
            <span className="rc-key-mark rc-key-struck">Name</span> lost that race
          </li>
        </ul>
      </section>

      <section className="rc-rules-block">
        <h2 className="rc-rules-h">What you actually have to do</h2>
        <ul className="rc-do">
          <li>
            Keep the <strong>Now</strong> tab open. It says who you're racing and when you're
            up.
          </li>
          <li>Stay near the track. Wander off and they'll run someone else's heat first.</li>
          <li>That's it. Someone else is keeping score.</li>
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Bracket
// ---------------------------------------------------------------------------------

const GROUPS = [
  { key: "W", label: "Winners", brackets: ["W"] },
  { key: "L", label: "Losers", brackets: ["L"] },
  { key: "F", label: "Finals", brackets: ["GF", "GFR"] },
  { key: "C", label: "Consolation", brackets: ["C"] },
];

function BracketTab({ state, meId }: { state: StatePayload; meId: number }) {
  const [group, setGroup] = useState("W");
  const [myPath, setMyPath] = useState(true);
  const [detail, setDetail] = useState<PublicMatch | null>(null);

  const mine = useMemo(() => pathOf(state, meId), [state, meId]);
  const groups = GROUPS.filter(
    (g) => g.key !== "C" || state.event.consolation,
  );
  const columns = roundsOf(state, groups.find((g) => g.key === group)?.brackets ?? ["W"]);

  if (state.event.phase === "registration") {
    return <p className="empty-note">The bracket appears once the director starts the race.</p>;
  }

  return (
    <div className="rc-bracket">
      <div className="rc-seg" role="tablist">
        {groups.map((g) => (
          <button
            key={g.key}
            type="button"
            role="tab"
            aria-selected={group === g.key}
            className={`rc-seg-btn ${group === g.key ? "rc-seg-on" : ""}`}
            onClick={() => setGroup(g.key)}
          >
            {g.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className={`chip rc-mypath ${myPath ? "chip-live" : ""}`}
        onClick={() => setMyPath((on) => !on)}
        aria-pressed={myPath}
      >
        My path {myPath ? "on" : "off"}
      </button>

      <div className="rc-columns scroll-x">
        {columns.map((column) => (
          <section className="rc-column" key={column.key}>
            <h2 className="rc-column-head">{column.label}</h2>
            <div className="stack rc-column-body">
              {column.matches.map((match) => (
                <MatchCard
                  key={match.id}
                  state={state}
                  match={match}
                  dim={myPath && !mine.has(match.id)}
                  current={match.id === state.event.currentMatch}
                  onSelect={setDetail}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      <Sheet
        open={detail !== null}
        title={detail ? `${detail.label} · ${detail.code}` : ""}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <div className="rc-detail">
            <RacerBlock racer={racerById(state, detail.a)} highlight={detail.a === meId} />
            <p className="rc-vs">VS</p>
            <RacerBlock racer={racerById(state, detail.b)} highlight={detail.b === meId} />
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Racers
// ---------------------------------------------------------------------------------

function RacersTab({ state, meId }: { state: StatePayload; meId: number }) {
  const [detail, setDetail] = useState<number | null>(null);

  const ordered = useMemo(() => {
    const rest = state.racers.filter((r) => r.id !== meId);
    const me = state.racers.find((r) => r.id === meId);
    return me ? [me, ...rest] : rest;
  }, [state, meId]);

  const detailRacer = racerById(state, detail);
  const history = detail
    ? state.matches
        .filter((m) => m.state === "done" && (m.a === detail || m.b === detail))
        .sort((x, y) => x.orderIndex - y.orderIndex)
    : [];

  return (
    <div className="rc-racers">
      <div className="rc-grid">
        {ordered.map((racer) => {
          const chip = statusChip(racer);
          return (
            <button
              type="button"
              key={racer.id}
              className={`rc-racer ${racer.id === meId ? "rc-racer-me" : ""}`}
              onClick={() => setDetail(racer.id)}
            >
              <Avatar racer={racer} size="xl" />
              <p className="rc-racer-name racer-name">{racer.name}</p>
              <div className="rc-racer-meta">
                <span className="code tabular">{recordOf(racer)}</span>
                <span className={`chip chip-${chip.tone}`}>{chip.label}</span>
              </div>
            </button>
          );
        })}
      </div>

      <Sheet
        open={detail !== null}
        title={detailRacer?.name ?? ""}
        onClose={() => setDetail(null)}
      >
        {detailRacer ? (
          <div className="stack">
            <Avatar racer={detailRacer} size="xl" full />
            <div className="row">
              <span className="code tabular">{recordOf(detailRacer)}</span>
              <span className={`chip chip-${statusChip(detailRacer).tone}`}>
                {statusChip(detailRacer).label}
              </span>
            </div>
            {history.length === 0 ? (
              <p className="empty-note">No heats raced yet.</p>
            ) : (
              <div className="stack">
                {history.map((match) => (
                  <MatchCard key={match.id} state={state} match={match} />
                ))}
              </div>
            )}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
