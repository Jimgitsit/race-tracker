import clipUrl from "../assets/dragster-launch.mp3";

/**
 * The one sound this app makes: a dragster launching as the winner's car runs up
 * its connector.
 *
 * The clip is a 1.7s cut from a **CC0 / public-domain** recording — "auto
 * performance dragster take off", freesound.org sound 637195 by kyles. CC0 carries
 * no attribution obligation; it's recorded here because knowing where an asset
 * came from is worth more than the licence requires. Trimmed to the launch itself
 * (3.0–4.7s of the source, where the power builds to its peak), gained, limited
 * and faded at both ends so it neither clicks nor outstays the animation. 24 KB.
 *
 * A synthesised engine sits behind it as a fallback for the case where the clip
 * fails to decode. It is not as good — that is rather the point of the clip — but
 * a screen that makes a noise beats one that has silently failed.
 */

let context: AudioContext | null = null;
let clip: AudioBuffer | null = null;
let fetched = false;
let noise: AudioBuffer | null = null;

/**
 * Browsers refuse to start audio until the page has had a real user gesture —
 * a click or a keypress, and specifically *not* a mouse move. Call this from one,
 * and call it as often as you like; it is cheap once the context is running.
 */
export function unlockAudio(): void {
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") {
      void context.resume();
    }
    void load();
  } catch {
    // No Web Audio, or the browser refused. The screen is no worse than silent.
  }
}

/** Decode once, on the first unlock, so the first result isn't the one that waits. */
async function load(): Promise<void> {
  if (fetched || !context) {
    return;
  }
  fetched = true;

  try {
    const response = await fetch(clipUrl);
    clip = await context.decodeAudioData(await response.arrayBuffer());
  } catch {
    // Falls through to the synthesised engine below.
  }
}

/**
 * A launch. Silent and harmless if audio was never unlocked, so callers never have
 * to check.
 */
export function playLaunch(volume = 0.75): void {
  const audio = context;
  if (!audio || audio.state !== "running") {
    return;
  }

  if (clip === null) {
    synthesise(audio, 1700, volume * 0.5);
    return;
  }

  const source = audio.createBufferSource();
  source.buffer = clip;

  const gain = audio.createGain();
  gain.gain.value = volume;

  source.connect(gain);
  gain.connect(audio.destination);
  source.start(audio.currentTime);
}

// ---------------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------------

/** White noise for the tyre chirp, built once and reused. */
function noiseBuffer(audio: AudioContext): AudioBuffer {
  if (noise === null) {
    noise = audio.createBuffer(1, audio.sampleRate * 0.5, audio.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.random() * 2 - 1;
    }
  }
  return noise;
}

/**
 * A standing-start pull, `ms` long: tyres chirp, then the engine winds out through
 * its rev range as the filter opens up. Only heard if the clip didn't decode.
 */
function synthesise(audio: AudioContext, ms: number, volume: number): void {
  const now = audio.currentTime;
  const length = ms / 1000;

  const out = audio.createGain();
  out.connect(audio.destination);
  // Ramps are exponential, which cannot touch zero — hence the near-silent floor
  // either side rather than a plain 0.
  out.gain.setValueAtTime(0.0001, now);
  out.gain.exponentialRampToValueAtTime(volume, now + 0.05);
  out.gain.setValueAtTime(volume, now + length * 0.72);
  out.gain.exponentialRampToValueAtTime(0.0001, now + length);

  // The engine's brightness climbs with the revs — a fixed filter reads as a hum
  // getting louder rather than a car pulling away.
  const tone = audio.createBiquadFilter();
  tone.type = "lowpass";
  tone.Q.value = 5;
  tone.frequency.setValueAtTime(420, now);
  tone.frequency.exponentialRampToValueAtTime(3400, now + length * 0.85);
  tone.connect(out);

  // Two saws a few cents apart. One alone is a test tone; detuned they beat
  // against each other and read as something mechanical.
  for (const detune of [-8, 9]) {
    const osc = audio.createOscillator();
    osc.type = "sawtooth";
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(68, now);
    osc.frequency.exponentialRampToValueAtTime(310, now + length * 0.92);
    osc.connect(tone);
    osc.start(now);
    osc.stop(now + length);
  }

  // Tyre chirp off the line: a short band-passed noise burst, gone in 180ms.
  const chirp = audio.createBufferSource();
  chirp.buffer = noiseBuffer(audio);

  const chirpTone = audio.createBiquadFilter();
  chirpTone.type = "bandpass";
  chirpTone.frequency.value = 1800;
  chirpTone.Q.value = 1.4;

  const chirpGain = audio.createGain();
  chirpGain.gain.setValueAtTime(volume * 0.55, now);
  chirpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

  chirp.connect(chirpTone);
  chirpTone.connect(chirpGain);
  chirpGain.connect(audio.destination);
  chirp.start(now);
  chirp.stop(now + 0.25);
}
