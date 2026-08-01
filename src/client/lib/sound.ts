/**
 * The one sound this app makes: a launch as the winner's car runs up its connector.
 *
 * Synthesised rather than shipped as a file. A recording would be a few hundred KB
 * to download on race day over a domestic uplink, would need a licence, and could
 * not be re-tuned without re-encoding. This is an oscillator sweep and a noise
 * burst — a few dozen lines, no asset, no network, and the length is a parameter
 * so it can be matched to the animation it accompanies.
 */

let context: AudioContext | null = null;
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
  } catch {
    // No Web Audio, or the browser refused. The screen is no worse than silent.
  }
}

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
 * its rev range as the filter opens up. Silent and harmless if audio was never
 * unlocked, so callers never have to check.
 */
export function playLaunch(ms: number, volume = 0.38): void {
  const audio = context;
  if (!audio || audio.state !== "running") {
    return;
  }

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
