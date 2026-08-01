import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ApiError,
  api,
  joinUrl,
  relinkUrl,
  type PublicMatch,
  type PublicRacer,
  type StatePayload,
} from "../lib/api.ts";
import { matchById, racerById, recordOf } from "../lib/derive.ts";
import { Avatar } from "../components/Avatar.tsx";
import {
  BracketColumns,
  GROUP_KEY,
  GroupTabs,
  activeGroup,
  bracketsOf,
} from "../components/Bracket.tsx";
import { MatchCard } from "../components/MatchCard.tsx";
import { JoinQR, RelinkQR } from "../components/QR.tsx";
import { ShareLink } from "../components/ShareLink.tsx";
import { Sheet } from "../components/Sheet.tsx";

/** One guard against a fat-finger, then the tap targets go dead for a beat. */
const TAP_LOCKOUT_MS = 1000;

/** Whether the director last picked a heat off the list or off the bracket. */
const PICK_KEY = "race-tracker.dir.pick";

export function DirectorView({ state }: { state: StatePayload }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    api.director
      .session()
      .then((result) => setSignedIn(result.signedIn))
      .catch(() => setSignedIn(false));
  }, []);

  if (signedIn === null) {
    return (
      <div className="boot">
        <div className="boot-track" aria-hidden="true" />
      </div>
    );
  }

  if (!signedIn) {
    return <Login onIn={() => setSignedIn(true)} />;
  }

  return (
    <div className="dir">
      {state.event.phase === "registration" ? <Roster state={state} /> : null}
      {state.event.phase === "racing" ? <Racing state={state} /> : null}
      {state.event.phase === "complete" ? <Complete state={state} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------

function Login({ onIn }: { onIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api.director.login(password);
      onIn();
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : "Couldn't sign in.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="dir-login">
      <div className="track-rule" aria-hidden="true" />
      <p className="eyebrow">Race control</p>
      <h1 className="dir-login-title">Director</h1>
      <form className="stack" onSubmit={submit}>
        <input
          className="field"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          enterKeyHint="go"
          autoFocus
        />
        {error ? <p className="error-msg">{error}</p> : null}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------------

/** One tap each, because the director is holding a phone next to a track. */
const PRESETS = [
  "You're up — get to the track!",
  "Where are you? You're holding up the race.",
  "Taking a short break. Back in 10.",
  "Last call to add a photo of your car.",
];

function MessageSheet({
  state,
  open,
  onClose,
  presetTo,
}: {
  state: StatePayload;
  open: boolean;
  onClose: () => void;
  presetTo?: number | null;
}) {
  const [to, setTo] = useState<number | null>(presetTo ?? null);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTo(presetTo ?? null);
      setBody("");
      setError(null);
      setSent(false);
    }
  }, [open, presetTo]);

  const send = async () => {
    setBusy(true);
    setError(null);

    try {
      await api.director.message(body, to);
      setSent(true);
      setBody("");
      setTimeout(onClose, 700);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : "Couldn't send that.");
    } finally {
      setBusy(false);
    }
  };

  const target = to === null ? null : racerById(state, to);

  return (
    <Sheet open={open} title="Send a message" onClose={onClose}>
      <div className="stack">
        <div className="dir-to">
          <button
            type="button"
            className={`dir-to-btn ${to === null ? "dir-to-on" : ""}`}
            onClick={() => setTo(null)}
          >
            Everyone
          </button>
          <span className="dir-to-or">or one racer:</span>
        </div>

        <ul className="dir-to-list">
          {state.racers.map((racer) => (
            <li key={racer.id}>
              <button
                type="button"
                className={`dir-to-racer ${to === racer.id ? "dir-to-on" : ""}`}
                onClick={() => setTo(racer.id)}
              >
                <Avatar racer={racer} size="sm" />
                <span className="dir-to-name racer-name">{racer.name}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="dir-presets">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="dir-preset"
              onClick={() => setBody(preset)}
            >
              {preset}
            </button>
          ))}
        </div>

        <textarea
          className="field dir-compose"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={to === null ? "Message to everyone…" : `Message to ${target?.name}…`}
          maxLength={140}
          rows={3}
        />

        {error ? <p className="error-msg">{error}</p> : null}

        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          disabled={busy || sent || !body.trim()}
          onClick={send}
        >
          {sent ? "Sent" : busy ? "Sending…" : to === null ? "Send to everyone" : `Send to ${target?.name}`}
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------

function Roster({ state }: { state: StatePayload }) {
  const [confirming, setConfirming] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [relink, setRelink] = useState<PublicRacer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const count = state.racers.length;
  const bracketSize = Math.max(4, 2 ** Math.ceil(Math.log2(Math.max(count, 4))));
  const byes = bracketSize - count;

  const lock = async () => {
    try {
      await api.director.lock();
      setConfirming(false);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : "Couldn't start the race.");
    }
  };

  return (
    <>
      <header className="dir-head">
        <div>
          <p className="eyebrow">Registration open</p>
          <p className="dir-count tabular">{count}</p>
          <p className="dir-count-label">{count === 1 ? "racer" : "racers"}</p>
        </div>
        <div className="dir-head-actions">
          <button type="button" className="btn btn-ghost dir-mini" onClick={() => setShowQR(true)}>
            Join QR
          </button>
          <button
            type="button"
            className="btn btn-ghost dir-mini"
            onClick={() => setShowMessage(true)}
          >
            Message
          </button>
        </div>
      </header>

      <main className="dir-roster">
        {count === 0 ? (
          <p className="empty-note">Nobody has registered yet.</p>
        ) : (
          <ul className="dir-list">
            {state.racers.map((racer) => (
              <RosterRow key={racer.id} racer={racer} onRelink={() => setRelink(racer)} />
            ))}
          </ul>
        )}
      </main>

      <footer className="dir-foot">
        {error ? <p className="error-msg">{error}</p> : null}
        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          disabled={count < 4}
          onClick={() => setConfirming(true)}
        >
          {count < 4 ? `Need ${4 - count} more` : "Lock roster & start race"}
        </button>
      </footer>

      <Sheet open={confirming} title="Start the race?" onClose={() => setConfirming(false)}>
        <p className="dir-confirm-line">
          {count} racers → {bracketSize}-slot bracket
          {byes > 0 ? `, ${byes} ${byes === 1 ? "bye" : "byes"}` : ""}. Registration closes.
        </p>
        <p className="dir-confirm-warn">
          Be sure to check all names for profanity first. They go on the big screen and there
          are kids around.
        </p>
        {/* Inside the sheet, not in the footer. A refused action leaves the sheet
            open, and the footer is behind it — so the message was invisible and
            the button looked dead. */}
        {error ? <p className="error-msg">{error}</p> : null}

        <div className="sheet-actions">
          <button type="button" className="btn" onClick={() => setConfirming(false)}>
            Back
          </button>
          <button type="button" className="btn btn-primary" onClick={lock}>
            Start race
          </button>
        </div>
      </Sheet>

      <Sheet open={showQR} title="Scan to join" onClose={() => setShowQR(false)}>
        <div className="stack">
          <JoinQR url={joinUrl()} size={260} label="Anyone can scan this" />
          <ShareLink
            url={joinUrl()}
            title={state.event.name}
            text={`Get your car in the ${state.event.name}.`}
          />
        </div>
      </Sheet>

      <Sheet
        open={relink !== null}
        title={relink ? `Sign ${relink.name} back in` : ""}
        onClose={() => setRelink(null)}
      >
        {relink ? <RelinkSheet racer={relink} /> : null}
      </Sheet>

      <MessageSheet state={state} open={showMessage} onClose={() => setShowMessage(false)} />
    </>
  );
}

function RosterRow({ racer, onRelink }: { racer: PublicRacer; onRelink: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(racer.name);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    try {
      await api.director.removeRacer(racer.id);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : "Couldn't remove them.");
    }
  };

  return (
    <li className="dir-row">
      <Avatar racer={racer} size="md" />

      {editing ? (
        <input
          className="field dir-rename"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setEditing(false)}
          maxLength={24}
          autoFocus
        />
      ) : (
        <button type="button" className="dir-row-name racer-name" onClick={() => setEditing(true)}>
          {racer.name}
        </button>
      )}

      <div className="dir-row-actions">
        <button type="button" className="btn btn-ghost dir-mini" onClick={onRelink}>
          Re-link
        </button>
        <button type="button" className="btn btn-danger dir-mini" onClick={remove}>
          Remove
        </button>
      </div>

      {error ? <p className="error-msg">{error}</p> : null}
    </li>
  );
}

function RelinkSheet({ racer }: { racer: PublicRacer }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.director
      .racerToken(racer.id)
      .then((result) => setToken(result.token))
      .catch(() => setError("Couldn't fetch their link."));
  }, [racer.id]);

  if (error) {
    return <p className="error-msg">{error}</p>;
  }
  if (!token) {
    return <p className="empty-note">Fetching…</p>;
  }
  return <RelinkQR url={relinkUrl(token)} name={racer.name} />;
}

// ---------------------------------------------------------------------------------
// Racing
// ---------------------------------------------------------------------------------

function Racing({ state }: { state: StatePayload }) {
  const [pending, setPending] = useState<number | null>(null);
  const [lockedOut, setLockedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showQueue, setShowQueue] = useState(false);
  const [showConsolation, setShowConsolation] = useState(false);
  const [showMessage, setShowMessage] = useState(false);

  const current = matchById(state, state.event.currentMatch);
  const a = racerById(state, current?.a ?? null);
  const b = racerById(state, current?.b ?? null);
  const pendingRacer = racerById(state, pending);

  const upNext = state.queue
    .filter((id) => id !== state.event.currentMatch)
    .map((id) => matchById(state, id))
    .filter((m): m is PublicMatch => m !== null);

  const confirm = async () => {
    if (!current || pending === null) {
      return;
    }

    try {
      await api.director.result(current.id, pending);
      setError(null);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : "Couldn't record that.");
    } finally {
      setPending(null);
      // Two 40%-viewport buttons plus a confirm sheet plus impaired motor control
      // means a double-tap would otherwise blow straight through the next heat.
      setLockedOut(true);
      setTimeout(() => setLockedOut(false), TAP_LOCKOUT_MS);
    }
  };

  const undo = async () => {
    try {
      await api.director.undo();
      setError(null);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : "Nothing to undo.");
    }
  };

  if (!current) {
    return (
      <main className="dir-idle">
        <p className="empty-note">
          No heat is ready. {state.queue.length === 0 ? "The bracket is waiting on results." : ""}
        </p>
        <button type="button" className="btn btn-block" onClick={() => setShowQueue(true)}>
          Pick a heat
        </button>
      </main>
    );
  }

  return (
    <>
      <header className="dir-racing-head">
        <p className="eyebrow">{current.label}</p>
        <p className="code">
          heat {state.event.heatsDone + 1} of {state.event.heatsTotal}
        </p>
      </header>

      <main className="dir-targets">
        <TapTarget racer={a} disabled={lockedOut} onPick={() => setPending(current.a)} />
        <div className="dir-vs">
          <span>VS</span>
        </div>
        <TapTarget racer={b} disabled={lockedOut} onPick={() => setPending(current.b)} />
      </main>

      <footer className="dir-racing-foot">
        {error ? <p className="error-msg">{error}</p> : null}
        <div className="dir-foot-row dir-foot-three">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={undo}
            disabled={!state.canUndo}
          >
            Undo last
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setShowMessage(true)}>
            Message
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setShowQueue(true)}>
            Up next ({upNext.length})
          </button>
        </div>
        {state.event.canStartConsolation ? (
          <button
            type="button"
            className="btn btn-block"
            onClick={() => setShowConsolation(true)}
          >
            Start consolation bracket
          </button>
        ) : null}
      </footer>

      <Sheet
        open={pending !== null}
        title={pendingRacer ? `${pendingRacer.name} wins?` : ""}
        onClose={() => setPending(null)}
      >
        <div className="dir-confirm-car">
          <Avatar racer={pendingRacer} size="xl" full />
        </div>
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={() => setPending(null)}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={confirm}>
            Confirm
          </button>
        </div>
      </Sheet>

      <Sheet open={showQueue} title="Next heat" onClose={() => setShowQueue(false)}>
        <HeatPicker state={state} upNext={upNext} onPicked={() => setShowQueue(false)} />
      </Sheet>

      <Sheet
        open={showConsolation}
        title="Consolation bracket"
        onClose={() => setShowConsolation(false)}
      >
        <ConsolationPicker onDone={() => setShowConsolation(false)} />
      </Sheet>

      <MessageSheet state={state} open={showMessage} onClose={() => setShowMessage(false)} />
    </>
  );
}

/**
 * Two ways to choose what races next, because they answer different questions.
 * The list is "what can I run right now" — short, ordered, no thinking. The
 * bracket is "where are we", which is the question that gets asked out loud, and
 * the director is the one person in the room without a view of the big screen.
 *
 * Only a ready heat is tappable in the bracket; everything else renders as a plain
 * card rather than a dead button, so there is nothing to press that does nothing.
 */
function HeatPicker({
  state,
  upNext,
  onPicked,
}: {
  state: StatePayload;
  upNext: PublicMatch[];
  onPicked: () => void;
}) {
  const [mode, setMode] = useState(() =>
    localStorage.getItem(PICK_KEY) === "bracket" ? "bracket" : "list",
  );
  const [group, setGroup] = useState(() => localStorage.getItem(GROUP_KEY) ?? "W");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(PICK_KEY, mode);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem(GROUP_KEY, group);
  }, [group]);

  const ready = useMemo(
    () => new Set(state.queue.filter((id) => id !== state.event.currentMatch)),
    [state.queue, state.event.currentMatch],
  );

  const pick = async (match: PublicMatch) => {
    try {
      await api.director.setCurrent(match.id);
      onPicked();
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : "Couldn't switch heats.");
    }
  };

  return (
    <div className="dir-next">
      <div className="rc-seg" role="tablist" aria-label="How to choose">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "list"}
          className={`rc-seg-btn ${mode === "list" ? "rc-seg-on" : ""}`}
          onClick={() => setMode("list")}
        >
          Ready ({upNext.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "bracket"}
          className={`rc-seg-btn ${mode === "bracket" ? "rc-seg-on" : ""}`}
          onClick={() => setMode("bracket")}
        >
          Bracket
        </button>
      </div>

      {error ? <p className="error-msg">{error}</p> : null}

      {mode === "list" ? (
        upNext.length === 0 ? (
          <p className="empty-note">Nothing else is ready yet.</p>
        ) : (
          <div className="stack">
            {upNext.map((match) => (
              <MatchCard key={match.id} state={state} match={match} onSelect={pick} />
            ))}
          </div>
        )
      ) : (
        <>
          <GroupTabs state={state} group={activeGroup(state, group)} onPick={setGroup} />
          <BracketColumns
            state={state}
            brackets={bracketsOf(state, activeGroup(state, group))}
            openOn={state.event.currentMatch}
            card={(match) => ({
              dim: !ready.has(match.id) && match.id !== state.event.currentMatch,
              onSelect: ready.has(match.id) ? pick : undefined,
            })}
          />
        </>
      )}
    </div>
  );
}

function TapTarget({
  racer,
  disabled,
  onPick,
}: {
  racer: PublicRacer | null;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button type="button" className="dir-target" onClick={onPick} disabled={disabled || !racer}>
      <Avatar racer={racer} size="xl" full />
      <span className="dir-target-name racer-name">{racer?.name ?? "TBD"}</span>
    </button>
  );
}

function ConsolationPicker({ onDone }: { onDone: () => void }) {
  const [candidates, setCandidates] = useState<PublicRacer[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.director
      .consolationCandidates()
      .then((rows) => {
        setCandidates(rows);
        setPicked(new Set(rows.map((r) => r.id)));
      })
      .catch(() => setError("Couldn't load the knocked-out racers."));
  }, []);

  const toggle = (id: number) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const start = async () => {
    try {
      await api.director.startConsolation([...picked]);
      onDone();
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : "Couldn't build it.");
    }
  };

  if (error) {
    return <p className="error-msg">{error}</p>;
  }
  if (!candidates) {
    return <p className="empty-note">Loading…</p>;
  }

  return (
    <div className="stack">
      <p className="dir-confirm-line">
        Everyone here is out of the main bracket. Untick anyone who's gone home.
      </p>
      <ul className="dir-pick-list">
        {candidates.map((racer) => (
          <li key={racer.id}>
            <label className="dir-pick">
              <input
                type="checkbox"
                checked={picked.has(racer.id)}
                onChange={() => toggle(racer.id)}
              />
              <Avatar racer={racer} size="sm" />
              <span className="dir-pick-name racer-name">{racer.name}</span>
              <span className="code tabular">{recordOf(racer)}</span>
            </label>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={picked.size < 4}
        onClick={start}
      >
        {picked.size < 4
          ? "Pick at least 4"
          : `Build a ${picked.size}-racer bracket (${picked.size - 1} heats)`}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------------

function Complete({ state }: { state: StatePayload }) {
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [override, setOverride] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const podium = useMemo(
    () =>
      [
        { place: "1st", id: state.event.champion, tone: "gold" },
        { place: "2nd", id: state.event.runnerUp, tone: "silver" },
        { place: "3rd", id: state.event.third, tone: "bronze" },
      ].filter((row) => row.id !== null),
    [state],
  );

  const run = async (work: () => Promise<unknown>, close: () => void) => {
    try {
      await work();
      close();
      setError(null);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : "That didn't work.");
    }
  };

  const closeReset = () => {
    setConfirmReset(false);
    setOverride(false);
    setError(null);
  };

  /**
   * A refused reset is the server asking whether this was really meant, not a
   * dead end — a false start that reached "complete" is exactly what the archive
   * guard blocks, and reset is the documented way out of a false start. So the
   * first refusal arms the override and says plainly what goes with it.
   */
  const wipe = async () => {
    try {
      await api.director.reset(override);
      closeReset();
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : "That didn't work.");
      setOverride(true);
    }
  };

  return (
    <>
      <header className="dir-head">
        <div>
          <p className="eyebrow">{state.event.name}</p>
          <h1 className="dir-login-title">Finished</h1>
        </div>
      </header>

      <main className="dir-podium">
        {podium.map((row) => {
          const racer = racerById(state, row.id);
          return (
            <div className={`dir-podium-row dir-podium-${row.tone}`} key={row.place}>
              <span className="dir-podium-place">{row.place}</span>
              <Avatar racer={racer} size="lg" />
              <span className="dir-podium-name racer-name">{racer?.name ?? "—"}</span>
            </div>
          );
        })}

        {state.event.consolationChampion !== null ? (
          <div className="dir-podium-row dir-podium-consolation">
            <span className="dir-podium-place">Consolation</span>
            <Avatar racer={racerById(state, state.event.consolationChampion)} size="lg" />
            <span className="dir-podium-name racer-name">
              {racerById(state, state.event.consolationChampion)?.name}
            </span>
          </div>
        ) : null}
      </main>

      <footer className="dir-foot">
        {error ? <p className="error-msg">{error}</p> : null}
        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          onClick={() => setConfirmArchive(true)}
        >
          Archive &amp; start next year
        </button>
        <button type="button" className="btn btn-danger btn-block" onClick={() => setConfirmReset(true)}>
          Reset event
        </button>
      </footer>

      <Sheet open={confirmArchive} title="Archive this year?" onClose={() => setConfirmArchive(false)}>
        <p className="dir-confirm-line">
          {state.event.year} gets saved to the history page — bracket, photos and all — and
          registration reopens for {state.event.year + 1}.
        </p>
        {error ? <p className="error-msg">{error}</p> : null}

        <div className="sheet-actions">
          <button type="button" className="btn" onClick={() => setConfirmArchive(false)}>
            Not yet
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => run(api.director.archive, () => setConfirmArchive(false))}
          >
            Archive
          </button>
        </div>
      </Sheet>

      <Sheet open={confirmReset} title="Delete this race?" onClose={closeReset}>
        <p className="dir-confirm-warn">
          This wipes {state.event.year} without saving it. Archive first unless this race was a
          false start.
        </p>
        {error ? <p className="error-msg">{error}</p> : null}

        {override ? (
          <p className="dir-confirm-warn">
            Deleting anyway loses {state.racers.length}{" "}
            {state.racers.length === 1 ? "racer" : "racers"}, {state.event.heatsDone} recorded{" "}
            {state.event.heatsDone === 1 ? "heat" : "heats"} and every uploaded photo. There is
            no undo.
          </p>
        ) : null}

        <div className="sheet-actions">
          <button type="button" className="btn" onClick={closeReset}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={wipe}>
            {override ? "Delete without archiving" : "Delete it"}
          </button>
        </div>
      </Sheet>
    </>
  );
}
