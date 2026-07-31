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

const ENABLED_KEY = "race-tracker.alerts";

let context: AudioContext | null = null;

export function alertsEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === "on";
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

  try {
    const Ctor = window.AudioContext ?? (window as unknown as {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;

    if (Ctor && !context) {
      context = new Ctor();
    }
    // Safari starts contexts suspended; resuming inside the gesture is what
    // makes later, gesture-less playback work.
    await context?.resume();
  } catch {
    context = null;
  }

  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      // A refused prompt is fine; sound still works.
    }
  }

  chime("ready");
}

export function disableAlerts(): void {
  localStorage.setItem(ENABLED_KEY, "off");
}

type Tone = "ready" | "on-deck" | "up-now" | "message";

const TONES: Record<Tone, { notes: number[]; gap: number; length: number }> = {
  ready: { notes: [660, 880], gap: 0.1, length: 0.12 },
  "on-deck": { notes: [520, 660], gap: 0.14, length: 0.16 },
  // Deliberately the most insistent: five rising notes, like a start-line tree.
  "up-now": { notes: [520, 660, 880, 660, 880], gap: 0.13, length: 0.18 },
  message: { notes: [740], gap: 0, length: 0.16 },
};

/** Synthesised so there's no audio asset to fetch on a bad wifi connection. */
export function chime(tone: Tone): void {
  if (!context) {
    return;
  }

  const spec = TONES[tone];
  const now = context.currentTime;

  spec.notes.forEach((frequency, index) => {
    const osc = context!.createOscillator();
    const gain = context!.createGain();

    osc.type = "triangle";
    osc.frequency.value = frequency;

    const start = now + index * spec.gap;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.28, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.length);

    osc.connect(gain).connect(context!.destination);
    osc.start(start);
    osc.stop(start + spec.length + 0.02);
  });
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

  chime(tone);

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
