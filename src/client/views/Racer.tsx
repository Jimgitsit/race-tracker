import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";

import { ApiError, api, joinUrl, type PublicMatch, type StatePayload } from "../lib/api.ts";
import { clearToken, getToken, setToken } from "../lib/identity.ts";
import { preparePhoto } from "../lib/photo.ts";
import {
  matchById,
  pathOf,
  racerById,
  recordOf,
  statusChip,
  statusFor,
} from "../lib/derive.ts";
import { alertsEnabled, canVibrate, disableAlerts, enableAlerts } from "../lib/alerts.ts";
import { useMessages, useRaceAlerts, type Message } from "../lib/useAlerts.ts";
import { useResultFlash } from "../lib/useRace.ts";
import { clockTime, timeAgo, useNow } from "../lib/time.ts";
import { Avatar } from "../components/Avatar.tsx";
import {
  BracketColumns,
  GROUP_KEY,
  GroupTabs,
  activeGroup,
  bracketsOf,
} from "../components/Bracket.tsx";
import { MatchCard } from "../components/MatchCard.tsx";
import { JoinQR } from "../components/QR.tsx";
import { ShareLink } from "../components/ShareLink.tsx";
import { Sheet } from "../components/Sheet.tsx";

type Tab = "now" | "bracket" | "racers" | "rules";

const TABS: { id: Tab; label: string }[] = [
  { id: "now", label: "Now" },
  { id: "bracket", label: "Bracket" },
  { id: "racers", label: "Racers" },
  { id: "rules", label: "Rules" },
];

const ID_KEY = "race-tracker.id";
const TAB_KEY = "race-tracker.tab";
const WATCH_KEY = "race-tracker.watching";
const READ_KEY = "race-tracker.msgRead";
const PATH_KEY = "race-tracker.myPath";

/** Validated against the known tabs, so a stale stored value can't blank the view. */
function storedTab(): Tab {
  const stored = localStorage.getItem(TAB_KEY);
  return TABS.some((t) => t.id === stored) ? (stored as Tab) : "now";
}

function storedNumber(key: string): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) ? value : 0;
}

export function RacerView({
  state,
  onOpenDisplay,
}: {
  state: StatePayload;
  onOpenDisplay: () => void;
}) {
  const [meId, setMeId] = useState<number | null>(() => {
    const stored = localStorage.getItem(ID_KEY);
    return stored ? Number(stored) : null;
  });
  const [resolving, setResolving] = useState(() => getToken() !== null && meId === null);
  // Someone who chose to watch during registration stays a spectator across a
  // refresh, rather than being dropped back on the sign-up form every time.
  const [watching, setWatching] = useState(() => localStorage.getItem(WATCH_KEY) === "1");

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

  const startWatching = () => {
    localStorage.setItem(WATCH_KEY, "1");
    setWatching(true);
  };

  const stopWatching = () => {
    localStorage.removeItem(WATCH_KEY);
    setWatching(false);
  };

  // Sign-up is only worth showing while it can still be acted on. Once the roster
  // locks, everyone without a car is a spectator, and the whole app is the
  // spectator view — the same tabs a racer gets, minus the parts that are theirs.
  if (me === null && !watching && state.event.phase === "registration") {
    return (
      <Join
        state={state}
        onWatch={startWatching}
        onJoined={(id) => {
          setMeId(id);
          setResolving(false);
        }}
      />
    );
  }

  return (
    <Main
      state={state}
      meId={me?.id ?? null}
      onOpenDisplay={onOpenDisplay}
      onJoin={me === null && state.event.phase === "registration" ? stopWatching : undefined}
    />
  );
}

// ---------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------

function Join({
  state,
  onJoined,
  onWatch,
}: {
  state: StatePayload;
  onJoined: (id: number) => void;
  onWatch: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

      <button type="button" className="rc-watch" onClick={onWatch}>
        Just watching →
      </button>
    </main>
  );
}

function TrackRule() {
  return <div className="track-rule" aria-hidden="true" />;
}

// ---------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------

/**
 * The same four tabs whether you're racing or watching. A spectator is not a
 * lesser user with a cut-down app — they're at the same party looking at the same
 * bracket, so `meId: null` only removes the parts that are personally yours (your
 * status line, your photo, your alerts, your path through the bracket).
 */
function Main({
  state,
  meId,
  onOpenDisplay,
  onJoin,
}: {
  state: StatePayload;
  meId: number | null;
  onOpenDisplay: () => void;
  onJoin?: () => void;
}) {
  const [tab, setTab] = useState<Tab>(storedTab);
  const [inbox, setInbox] = useState(false);
  const messages = useMessages(state, meId);
  const { unread, markRead } = useUnread(messages);

  useRaceAlerts(state, meId, messages);

  useEffect(() => {
    localStorage.setItem(TAB_KEY, tab);
  }, [tab]);

  // Reading the list is the same acknowledgement as dismissing the card: after
  // this there is nothing left to interrupt anyone with.
  const openInbox = () => {
    markRead();
    setInbox(true);
  };

  return (
    <div className="rc">
      <header className="rc-top">
        <div className="rc-top-id">
          <p className="eyebrow">{state.event.name}</p>
          <p className="rc-count code">
            {state.event.phase === "registration"
              ? `${state.event.racerCount} registered`
              : `Heat ${state.event.heatsDone} of ${state.event.heatsTotal}`}
          </p>
        </div>
        <div className="rc-top-actions">
          {meId === null ? (
            <button type="button" className="btn btn-ghost rc-share" onClick={onOpenDisplay}>
              Big screen
            </button>
          ) : null}
          <ShareButton state={state} />
        </div>
      </header>

      {/* On the Now tab the message has a card of its own; anywhere else it has to
          come to you, because the alert chime doesn't say what was said. */}
      {unread && tab !== "now" ? (
        <MessageToast message={unread} onOpen={openInbox} onDismiss={markRead} />
      ) : null}

      <main className="rc-body">
        {tab === "now" ? (
          <NowTab
            state={state}
            meId={meId}
            messages={messages}
            unread={unread}
            onOpenInbox={openInbox}
            onDismissMessage={markRead}
            onExplain={() => setTab("rules")}
            onJoin={onJoin}
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

      <Inbox open={inbox} messages={messages} onClose={() => setInbox(false)} />

      {/* An id with no racer behind it means the director removed them after the
          roster locked — distinct from a spectator, who never had one. */}
      {meId !== null && racerById(state, meId) === null ? (
        <p className="offline-banner">Your registration wasn't found.</p>
      ) : null}
    </div>
  );
}

/**
 * The newest message, until it's acknowledged. "Read" is one id in localStorage
 * rather than a per-message set: messages arrive in order and are read in order,
 * so a high-water mark is the whole of the state and survives a refresh.
 */
function useUnread(messages: Message[]) {
  const [read, setRead] = useState(() => storedNumber(READ_KEY));

  const latest = messages[0] ?? null;
  const unread = latest !== null && latest.id > read ? latest : null;

  const markRead = () => {
    const top = messages[0]?.id ?? 0;
    localStorage.setItem(READ_KEY, String(top));
    setRead(top);
  };

  return { unread, markRead };
}

function ShareButton({ state }: { state: StatePayload }) {
  const [open, setOpen] = useState(false);

  // Once the roster locks the code stops being an invitation and starts being
  // how a spectator gets in — the screen it lands on already handles that.
  const racing = state.event.phase !== "registration";

  return (
    <>
      <button type="button" className="btn btn-ghost rc-share" onClick={() => setOpen(true)}>
        {racing ? "Share" : "Invite"}
      </button>
      <Sheet
        open={open}
        title={racing ? "Share the race" : "Get someone else racing"}
        onClose={() => setOpen(false)}
      >
        <div className="stack">
          <JoinQR
            url={joinUrl()}
            size={240}
            label={racing ? "Scan to follow along" : "Point a phone camera at this"}
          />
          <ShareLink
            url={joinUrl()}
            title={state.event.name}
            text={
              racing
                ? `Watch the ${state.event.name} bracket live.`
                : `Get your car in the ${state.event.name}.`
            }
          />
        </div>
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
  unread,
  onOpenInbox,
  onDismissMessage,
  onExplain,
  onJoin,
}: {
  state: StatePayload;
  meId: number | null;
  messages: Message[];
  unread: Message | null;
  onOpenInbox: () => void;
  onDismissMessage: () => void;
  onExplain: () => void;
  onJoin?: () => void;
}) {
  const messageSlot = (
    <MessageSlot
      messages={messages}
      unread={unread}
      onOpenInbox={onOpenInbox}
      onDismiss={onDismissMessage}
    />
  );

  const me = racerById(state, meId);
  const status = statusFor(state, me);
  const current = matchById(state, state.event.currentMatch);

  // A result holds the card for three seconds before the next heat takes it, so
  // whoever just won gets their moment on every phone in the room — not only on
  // the big screen.
  const flash = useResultFlash(state);
  const flashed = matchById(state, flash);
  const headline = flashed ?? current;

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
          {onJoin ? (
            <button type="button" className="btn btn-ghost rc-wait-join" onClick={onJoin}>
              Changed my mind — I'm racing
            </button>
          ) : null}
        </section>
        {messageSlot}
        {me ? <AlertsCard /> : null}
        {me ? <PhotoCard racer={me} /> : null}
      </div>
    );
  }

  // When the viewer is in the heat on screen, the card above already says so in
  // letters an inch tall — repeating it underneath is the same sentence twice.
  // The null check is load-bearing: an empty slot is also null, so a spectator
  // would otherwise match every heat with a slot still to be filled.
  const racingNow =
    meId !== null && current !== null && (current.a === meId || current.b === meId);

  return (
    <div className="stack">
      {messageSlot}

      {headline ? (
        // Keyed on the match, so swapping to the next heat re-mounts the card and
        // it fades in rather than the names simply changing underneath you.
        <NowCard
          key={headline.id}
          state={state}
          match={headline}
          meId={meId}
          result={flashed !== null}
        />
      ) : null}

      {status && !racingNow ? (
        <section className={`rc-status rc-status-${status.tone}`}>
          <p className="rc-status-line">{status.headline}</p>
          {status.detail ? <p className="rc-status-detail">{status.detail}</p> : null}
        </section>
      ) : null}

      {/* Sits where a racer's own status line goes: this is the spectator's
          answer to the same question, "what am I looking at?" */}
      {me === null ? <WatchingNote /> : null}

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

      {me ? <AlertsCard /> : null}

      {me ? <PhotoCard racer={me} /> : null}
    </div>
  );
}

/**
 * Says out loud why there's no "you're up next" card here, so a spectator doesn't
 * spend the evening assuming the page is broken.
 */
function WatchingNote() {
  return (
    <section className="rc-watching">
      <p className="rc-watching-head">You're spectating</p>
      <p className="rc-watching-sub">
        Everything updates on its own. Tap <strong>Big screen</strong> up top to put the whole
        bracket on a TV.
      </p>
    </section>
  );
}

/**
 * The message slot on the Now tab: the newest message until it's acknowledged,
 * then a way back to the full list. One message at a time — a drunk person
 * reading a thread is not a thing that happens — but never a dead end, because
 * "what did they just say?" is asked constantly and the answer has to be findable.
 */
function MessageSlot({
  messages,
  unread,
  onOpenInbox,
  onDismiss,
}: {
  messages: Message[];
  unread: Message | null;
  onOpenInbox: () => void;
  onDismiss: () => void;
}) {
  if (unread) {
    return <MessageCard message={unread} onOpen={onOpenInbox} onDismiss={onDismiss} />;
  }

  if (messages.length === 0) {
    return null;
  }

  return (
    <button type="button" className="rc-inbox-link" onClick={onOpenInbox}>
      All messages ({messages.length}) →
    </button>
  );
}

function MessageHead({ message }: { message: Message }) {
  const now = useNow();

  return (
    <span className="eyebrow rc-msg-head">
      <span>{message.direct ? "Message for you" : "From the race director"}</span>
      <span className="rc-msg-when">{timeAgo(message.at, now)}</span>
    </span>
  );
}

function MessageCard({
  message,
  onOpen,
  onDismiss,
}: {
  message: Message;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <section className={`rc-msg ${message.direct ? "rc-msg-direct" : ""}`}>
      <button type="button" className="rc-msg-tap" onClick={onOpen}>
        <MessageHead message={message} />
        <span className="rc-msg-body">{message.body}</span>
        <span className="rc-msg-more">All messages →</span>
      </button>
      <button type="button" className="rc-x" onClick={onDismiss} aria-label="Dismiss message">
        ×
      </button>
    </section>
  );
}

/** Same message, but it has to arrive over whatever tab you're on. */
function MessageToast({
  message,
  onOpen,
  onDismiss,
}: {
  message: Message;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={`rc-toast ${message.direct ? "rc-toast-direct" : ""}`} role="status">
      <button type="button" className="rc-toast-tap" onClick={onOpen}>
        <MessageHead message={message} />
        <span className="rc-toast-text">{message.body}</span>
      </button>
      <button type="button" className="rc-x" onClick={onDismiss} aria-label="Dismiss message">
        ×
      </button>
    </div>
  );
}

function Inbox({
  open,
  messages,
  onClose,
}: {
  open: boolean;
  messages: Message[];
  onClose: () => void;
}) {
  const now = useNow();

  return (
    <Sheet open={open} title="Messages" onClose={onClose}>
      {messages.length === 0 ? (
        <p className="empty-note">Nothing from the race director yet.</p>
      ) : (
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
      )}
    </Sheet>
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
  result = false,
}: {
  state: StatePayload;
  match: PublicMatch;
  meId: number | null;
  /** Holding this heat's result rather than showing a race in progress. */
  result?: boolean;
}) {
  const a = racerById(state, match.a);
  const b = racerById(state, match.b);
  const mine = meId !== null && (match.a === meId || match.b === meId);
  const decided = result && match.winner !== null;

  return (
    <section className={`rc-now ${mine ? "rc-now-mine" : ""}`}>
      <div className="rc-now-head">
        <p className="eyebrow">{decided ? "Result" : "Now racing"}</p>
        <p className="code">{match.label}</p>
      </div>

      <div className="rc-now-cars">
        <RacerBlock
          racer={a}
          highlight={mine && match.a === meId}
          won={decided && match.winner === match.a}
          lost={decided && match.winner !== match.a}
        />
        <p className="rc-vs">VS</p>
        <RacerBlock
          racer={b}
          highlight={mine && match.b === meId}
          won={decided && match.winner === match.b}
          lost={decided && match.winner !== match.b}
        />
      </div>

      {/* "Get to the track" stops being true the moment the heat is decided. */}
      {mine && !decided ? <p className="rc-thats-you">That's you — get to the track</p> : null}
    </section>
  );
}

function RacerBlock({
  racer,
  highlight,
  won = false,
  lost = false,
}: {
  racer: ReturnType<typeof racerById>;
  highlight: boolean;
  won?: boolean;
  lost?: boolean;
}) {
  const classes = ["rc-car"];
  if (highlight) {
    classes.push("rc-car-mine");
  }
  if (won) {
    classes.push("rc-car-won");
  }
  if (lost) {
    classes.push("rc-car-lost");
  }

  return (
    <div className={classes.join(" ")}>
      <div className="rc-car-photo">
        <Avatar racer={racer} size="xl" full />
        {won ? <span className="rc-car-stamp">Winner!</span> : null}
      </div>
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
function RulesTab({ state, meId }: { state: StatePayload; meId: number | null }) {
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

        {me ? (
          <div className="rc-pips-block">
            <p className="eyebrow rc-pips-label">Losses</p>
            <div className="rc-pips" role="img" aria-label={`${losses} of 2 losses`}>
              <span className={`rc-pip ${losses >= 1 ? "rc-pip-taken" : ""}`} />
              <span className={`rc-pip ${losses >= 2 ? "rc-pip-taken" : ""}`} />
            </div>
            <p className="rc-lives-sub">{tally}</p>
          </div>
        ) : null}
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
            <span className="rc-key-swatch rc-key-c" /> Consolation bracket
          </li>
          <li>
            <span className="rc-key-mark">Winner</span> won that race
          </li>
          <li>
            <span className="rc-key-mark rc-key-struck">Name</span> lost that race
          </li>
        </ul>
      </section>

      <section className="rc-rules-block">
        <h2 className="rc-rules-h">What you actually have to do</h2>
        {me ? (
          <ul className="rc-do">
            <li>
              Keep the <strong>Now</strong> tab open. It says who you're racing and when you're
              up.
            </li>
            <li>Stay near the track. Wander off and they'll run someone else's heat first.</li>
            <li>That's it. Someone else is keeping score.</li>
          </ul>
        ) : (
          <ul className="rc-do">
            <li>
              Nothing. You're watching — the <strong>Now</strong> tab always has the heat
              that's running.
            </li>
            <li>Pick a favourite off the Racers tab and follow them down the bracket.</li>
            <li>Heckle responsibly.</li>
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Bracket
// ---------------------------------------------------------------------------------

function BracketTab({ state, meId }: { state: StatePayload; meId: number | null }) {
  const [group, setGroup] = useState(() => localStorage.getItem(GROUP_KEY) ?? "W");
  const [myPath, setMyPath] = useState(() => localStorage.getItem(PATH_KEY) !== "0");
  const [detail, setDetail] = useState<PublicMatch | null>(null);

  useEffect(() => {
    localStorage.setItem(GROUP_KEY, group);
  }, [group]);

  useEffect(() => {
    localStorage.setItem(PATH_KEY, myPath ? "1" : "0");
  }, [myPath]);

  const mine = useMemo(
    () => (meId === null ? new Set<number>() : pathOf(state, meId)),
    [state, meId],
  );
  const active = activeGroup(state, group);

  if (state.event.phase === "registration") {
    return <p className="empty-note">The bracket appears once the director starts the race.</p>;
  }

  return (
    <div className="rc-bracket">
      <p className="eyebrow rc-seg-label" id="rc-seg-label">
        Bracket
      </p>
      <GroupTabs state={state} group={active} onPick={setGroup} labelledBy="rc-seg-label" />

      {meId === null ? null : (
        <button
          type="button"
          className={`chip rc-mypath ${myPath ? "chip-live" : ""}`}
          onClick={() => setMyPath((on) => !on)}
          aria-pressed={myPath}
        >
          My path {myPath ? "on" : "off"}
        </button>
      )}

      <BracketColumns
        state={state}
        brackets={bracketsOf(state, active)}
        card={(match) => ({
          dim: meId !== null && myPath && !mine.has(match.id),
          onSelect: setDetail,
        })}
      />

      <Sheet
        open={detail !== null}
        title={detail ? `${detail.label} · ${detail.code}` : ""}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <div className="rc-detail">
            <RacerBlock
              racer={racerById(state, detail.a)}
              highlight={meId !== null && detail.a === meId}
            />
            <p className="rc-vs">VS</p>
            <RacerBlock
              racer={racerById(state, detail.b)}
              highlight={meId !== null && detail.b === meId}
            />
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Racers
// ---------------------------------------------------------------------------------

function RacersTab({ state, meId }: { state: StatePayload; meId: number | null }) {
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
