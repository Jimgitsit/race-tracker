/**
 * Getting a distracted person's attention, using only what the platform actually
 * gives us.
 *
 * The honest situation, verified against caniuse and Apple's docs:
 *
 *  - `navigator.vibrate` is unsupported on **every** version of Safari, desktop
 *    and iOS. An iPhone cannot be made to buzz from a web page. Android can.
 *  - iOS web push exists only for sites the user has added to their Home Screen;
 *    a normal Safari tab has no access to `PushManager` at all.
 *  - Audio works everywhere, but only after a user gesture has unlocked an
 *    AudioContext. Registration gives us that gesture for free.
 *
 * So sound is the one channel that works on everyone's phone, and it's the one
 * this leans on. Vibration and notifications are strictly bonuses where present.
 * None of it survives the phone being locked in a pocket — the big screen and a
 * human shouting remain the real backstop, which the UI says out loud.
 */

import unmuteIosAudio from "unmute-ios-audio";

import honkUrl from "../assets/car-honk.mp3";
import idleUrl from "../assets/dragster-idle.mp3";

const ENABLED_KEY = "race-tracker.alerts";

let context: AudioContext | null = null;
let armed = false;

/**
 * Set when an alert tried to play and the browser wouldn't run the context —
 * after a lock, typically. The page shows it and any tap clears it, because a
 * tap is the one thing that reliably brings iOS audio back.
 */
let asleep: AudioContextState | "none" | null = null;
const asleepListeners = new Set<(state: typeof asleep) => void>();
/** The tone that couldn't play; the tap that wakes audio plays it late. */
let missed: Tone | null = null;

function setAsleep(next: typeof asleep): void {
  if (next === asleep) {
    return;
  }
  asleep = next;
  asleepListeners.forEach((listener) => listener(asleep));
}

export function onAudioAsleep(listener: (state: typeof asleep) => void): () => void {
  asleepListeners.add(listener);
  listener(asleep);
  return () => {
    asleepListeners.delete(listener);
  };
}

export function alertsEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === "on";
}

function ensureContext(): AudioContext | null {
  if (context) {
    return context;
  }
  try {
    const Ctor = window.AudioContext ?? (window as unknown as {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    context = Ctor ? new Ctor() : null;
  } catch {
    context = null;
  }
  return context;
}

/**
 * A running context is the only kind that makes sound, and iOS takes it away
 * constantly: it starts suspended, and a backgrounded tab, a phone call or a
 * lock puts it in Safari's own "interrupted" state, from which nothing resumes
 * it unless asked. `resume()` outside a gesture works once the page has had one.
 */
export async function wake(): Promise<AudioContext | null> {
  const audio = ensureContext();
  if (audio && audio.state !== "running") {
    try {
      await audio.resume();
    } catch {
      // Not in a gesture yet; the next tap will get it.
    }
  }
  if (audio) {
    void loadClips(audio);
  }
  return audio;
}

/**
 * Tones that are recordings rather than synthesis. Decoded once the context
 * exists (decoding doesn't need it running), so the first alert doesn't wait on
 * a fetch. A tone with no clip, or whose clip failed to decode, is synthesised.
 */
const CLIP_URLS: Partial<Record<Tone, string>> = {
  "up-now": idleUrl,
  message: honkUrl,
};
const clips = new Map<Tone, AudioBuffer>();
let clipsRequested = false;

async function loadClips(audio: AudioContext): Promise<void> {
  if (clipsRequested) {
    return;
  }
  clipsRequested = true;

  await Promise.all(
    (Object.entries(CLIP_URLS) as [Tone, string][]).map(async ([tone, url]) => {
      try {
        const response = await fetch(url);
        clips.set(tone, await audio.decodeAudioData(await response.arrayBuffer()));
      } catch {
        // Synth fallback for this tone.
      }
    }),
  );
}

/**
 * Called once per page load by anything that wants to make a sound — the racer
 * page when alerts are on, the big screen always. The context that "Turn on"
 * unlocked died with the page it was made in — every reload left the card
 * saying "Alerts are on" above a chime() that returned early on a null context.
 * So: build it on the first tap of the new page (any tap counts as the gesture),
 * bring it back when the tab does, and on iOS play the silent <audio> that moves
 * web audio off the ringer channel, so the mute switch doesn't swallow the chime
 * (WebKit bug 237322).
 */
export function armAudio(): void {
  if (armed || typeof window === "undefined") {
    return;
  }
  armed = true;

  // Safari 16.4+ lets a page ask for the "playback" audio session outright,
  // which is the category the ring/silent switch leaves alone. The silent
  // <audio> trick below is the fallback for older iOS.
  try {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) {
      session.type = "playback";
    }
  } catch {
    // Not supported; the fallback covers it.
  }

  unmuteIosAudio();

  const onGesture = () => {
    // After a lock, resume() on the old context has been seen to do nothing
    // even inside a tap. A fresh context made inside the gesture always starts,
    // so swap rather than plead. Cheap: only happens while it isn't running.
    const stale = context;
    if (stale && stale.state !== "running") {
      context = null;
      void stale.close().catch(() => {
        // Already closed or closing; nothing to do.
      });
    }
    void wake().then((audio) => {
      if (audio && audio.state === "running") {
        setAsleep(null);
        if (missed) {
          const tone = missed;
          missed = null;
          void chime(tone);
        }
      }
    });
  };
  for (const type of ["pointerdown", "touchend", "keydown"]) {
    window.addEventListener(type, onGesture, { capture: true, passive: true });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void wake();
    }
  });
}

export function canVibrate(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

export function notificationState(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") {
    return "unsupported";
  }
  return Notification.permission;
}

/**
 * Must be called from inside a real user gesture — that is the whole point of it.
 * Unlocks audio, asks for notification permission, and plays a short confirmation
 * so the person knows what the alert will sound like.
 */
export async function enableAlerts(): Promise<void> {
  localStorage.setItem(ENABLED_KEY, "on");
  armAudio();

  // Safari starts contexts suspended; resuming inside the gesture is what
  // makes later, gesture-less playback work.
  await wake();

  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      // A refused prompt is fine; sound still works.
    }
  }

  void chime("ready");
}

export function disableAlerts(): void {
  localStorage.setItem(ENABLED_KEY, "off");
}

type Tone = "ready" | "on-deck" | "up-now" | "message";

/** One note: when it starts (s), its pitches (a chord plays together), how long. */
type Note = { at: number; hz: number[]; len: number };

type Spec = {
  notes: Note[];
  wave: OscillatorType;
  /** Peak gain per voice. Square through the lowpass below is loud; sine is not. */
  level: number;
  /** Play the whole figure this many times, this far apart. */
  repeat: number;
  period: number;
};

/**
 * Tuned for a phone speaker in a noisy room, which is deaf below ~500 Hz and
 * loudest around 1–3 kHz — the first version's 520 Hz triangle was pretty and
 * inaudible. Square waves through a lowpass read as a buzzer, which is what a
 * race sounds like anyway.
 */
const TONES: Record<Tone, Spec> = {
  // Two quick notes: "yes, this works".
  ready: {
    notes: [
      { at: 0, hz: [880], len: 0.12 },
      { at: 0.14, hz: [1175], len: 0.22 },
    ],
    wave: "triangle",
    level: 0.6,
    repeat: 1,
    period: 0,
  },
  // A single bell-ish ding, twice, for a message.
  message: {
    notes: [{ at: 0, hz: [1319, 1319 * 2.4], len: 0.5 }],
    wave: "triangle",
    level: 0.5,
    repeat: 2,
    period: 0.7,
  },
  // Two-tone "heads up", three times.
  "on-deck": {
    notes: [
      { at: 0, hz: [1047], len: 0.16 },
      { at: 0.2, hz: [1319], len: 0.3 },
    ],
    wave: "square",
    level: 0.45,
    repeat: 3,
    period: 0.9,
  },
  // The drag-race tree: three ambers, then a long green chord. Twice, ~6 s in
  // all, because this is the one that has to cut through a party.
  "up-now": {
    notes: [
      { at: 0, hz: [740], len: 0.28 },
      { at: 0.5, hz: [740], len: 0.28 },
      { at: 1.0, hz: [740], len: 0.28 },
      { at: 1.5, hz: [1175, 1568], len: 1.1 },
    ],
    wave: "square",
    level: 0.5,
    repeat: 2,
    period: 3.0,
  },
};

/**
 * Synthesised so there's no audio asset to fetch on a bad wifi connection.
 * Resolves to what the browser let us do, so a Test button can say whether
 * silence is the browser refusing or the phone not letting it through.
 */
export async function chime(tone: Tone): Promise<AudioContextState | "none"> {
  // Resume first if iOS has interrupted the context; the notes are scheduled
  // from its clock, and a stopped clock plays them never.
  const audio = await wake();
  if (!audio) {
    return "none";
  }
  if (audio.state !== "running") {
    return audio.state;
  }

  const clip = clips.get(tone);
  if (clip) {
    const source = audio.createBufferSource();
    source.buffer = clip;
    source.connect(audio.destination);
    source.start(audio.currentTime);
    return "running";
  }

  const spec = TONES[tone];
  const now = audio.currentTime;

  // Everything goes through one lowpass (takes the fizz off the square waves)
  // and a compressor, so stacked voices get loud without clipping.
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 3200;
  const limiter = audio.createDynamicsCompressor();
  limiter.threshold.value = -12;
  limiter.ratio.value = 12;
  filter.connect(limiter).connect(audio.destination);

  let end = now;

  for (let pass = 0; pass < spec.repeat; pass += 1) {
    const base = now + pass * spec.period;

    for (const note of spec.notes) {
      const start = base + note.at;
      const stop = start + note.len;
      end = Math.max(end, stop);

      for (const hz of note.hz) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();

        osc.type = spec.wave;
        osc.frequency.value = hz;

        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(spec.level, start + 0.01);
        gain.gain.setValueAtTime(spec.level, stop - 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, stop);

        osc.connect(gain).connect(filter);
        osc.start(start);
        osc.stop(stop + 0.02);
      }
    }
  }

  // Let the graph go once the last note is done, rather than leaking a filter
  // and compressor per chime for the length of the event.
  window.setTimeout(() => {
    filter.disconnect();
    limiter.disconnect();
  }, (end - now) * 1000 + 200);

  return "running";
}

/** What Test should say after playing, given what chime() reported. */
export function describeChime(state: AudioContextState | "none"): string {
  if (state === "running") {
    return "Played. Heard nothing? Check the ring/silent switch, the volume, and that sound isn't going to headphones or a car.";
  }
  if (state === "none") {
    return "This browser has no web audio.";
  }
  return `The browser wouldn't start audio (${state}). Tap the page once and try again.`;
}

export function buzz(pattern: number[]): void {
  if (!canVibrate()) {
    return;
  }
  try {
    navigator.vibrate(pattern);
  } catch {
    // Some browsers throw when the page is backgrounded.
  }
}

function notify(title: string, body: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }
  try {
    new Notification(title, { body, tag: "race-tracker", renotify: true } as NotificationOptions);
  } catch {
    // Android requires a service worker for persistent notifications; the plain
    // constructor is best-effort and failing is not worth surfacing.
  }
}

export function fire(tone: Tone, title: string, body: string): void {
  if (!alertsEnabled()) {
    return;
  }

  void chime(tone).then((state) => {
    if (state !== "running") {
      missed = tone;
    }
    setAsleep(state === "running" ? null : state);
  });

  if (tone === "up-now") {
    buzz([260, 90, 260, 90, 420]);
  } else if (tone === "on-deck") {
    buzz([140, 90, 140]);
  } else {
    buzz([120]);
  }

  if (document.visibilityState !== "visible") {
    notify(title, body);
  }
}
