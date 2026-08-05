import { describe, test, expect } from 'bun:test';
import { detectPitch, centsBetween, freqToNote, nearestString } from '../pitch.js';

const SR = 48000;
const N = 4096; // same analysis window the app uses (AnalyserNode fftSize)

// Deterministic PRNG (mulberry32) so noise tests never flake.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand) {
  // Box–Muller
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Synthesize a tone: fundamental + harmonics, optional exponential time decay
 * (like a plucked string) and additive gaussian noise. Peak-normalized to amp.
 */
function synth(freq, {
  sr = SR, n = N, harmonics = [1], amp = 0.3, decay = 0, noiseSigma = 0, seed = 42,
} = {}) {
  const rand = rng(seed);
  const phases = harmonics.map((_, k) => (k * 1.7) % (2 * Math.PI)); // fixed, non-zero
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    for (let k = 0; k < harmonics.length; k++) {
      v += harmonics[k] * Math.sin(2 * Math.PI * freq * (k + 1) * t + phases[k]);
    }
    v *= Math.exp(-decay * t);
    out[i] = v;
    const av = Math.abs(v);
    if (av > peak) peak = av;
  }
  const scale = peak > 0 ? amp / peak : 0;
  for (let i = 0; i < n; i++) {
    out[i] = out[i] * scale + (noiseSigma ? noiseSigma * gaussian(rand) : 0);
  }
  return out;
}

const centsErr = (detected, truth) => Math.abs(centsBetween(detected, truth));

// A realistic plucked-string spectrum: strong fundamental, decaying harmonics.
const RICH = [1, 0.62, 0.4, 0.27, 0.18, 0.12, 0.07];

const GUITAR = [
  ['E2', 82.41], ['A2', 110.0], ['D3', 146.83],
  ['G3', 196.0], ['B3', 246.94], ['E4', 329.63],
];
const UKE = [['G4', 392.0], ['C4', 261.63], ['E4', 329.63], ['A4', 440.0]];
const UKE_LOW_G = [['G3', 196.0], ['C4', 261.63], ['E4', 329.63], ['A4', 440.0]];

describe('pure sine tones', () => {
  for (const [label, f] of [...GUITAR, ...UKE, ...UKE_LOW_G]) {
    test(`${label} ${f} Hz detected within 1 cent`, () => {
      const det = detectPitch(synth(f), SR);
      expect(det).not.toBeNull();
      expect(centsErr(det, f)).toBeLessThan(1);
    });
  }

  test('works at 44100 Hz sample rate too', () => {
    for (const f of [82.41, 440]) {
      const det = detectPitch(synth(f, { sr: 44100 }), 44100);
      expect(det).not.toBeNull();
      expect(centsErr(det, f)).toBeLessThan(1);
    }
  });
});

describe('harmonically rich (plucked-string-like) tones', () => {
  for (const [label, f] of [...GUITAR, ...UKE]) {
    test(`${label} ${f} Hz with 7 decaying harmonics within 1 cent`, () => {
      const det = detectPitch(synth(f, { harmonics: RICH, decay: 1.5 }), SR);
      expect(det).not.toBeNull();
      expect(centsErr(det, f)).toBeLessThan(1);
    });
  }
});

describe('octave-error guards on low guitar strings', () => {
  // Second harmonic LOUDER than the fundamental — very common on a plucked
  // low E. A naive peak-picker reports E3 (164.8 Hz) here.
  const DOMINANT_2ND = [0.5, 1.0, 0.55, 0.35, 0.22, 0.12];

  for (const [label, f] of [['E2', 82.41], ['A2', 110.0], ['D3', 146.83]]) {
    test(`${label}: 2nd harmonic 2x the fundamental → still ${label}, no octave error`, () => {
      const det = detectPitch(synth(f, { harmonics: DOMINANT_2ND, decay: 1.5 }), SR);
      expect(det).not.toBeNull();
      // No octave error: nowhere near f*2 or f/2 (>= 1200 cents away would be
      // the octave; require the answer inside +/-50 cents of the truth).
      expect(centsErr(det, f)).toBeLessThan(50);
      expect(centsErr(det, 2 * f)).toBeGreaterThan(600);
      // And still accurate:
      expect(centsErr(det, f)).toBeLessThan(1);
    });
  }

  test('E2 with an even stronger 2nd harmonic (3x) still locks to E2', () => {
    const det = detectPitch(synth(82.41, { harmonics: [0.33, 1.0, 0.4, 0.25] }), SR);
    expect(det).not.toBeNull();
    expect(centsErr(det, 82.41)).toBeLessThan(1);
  });

  test('A2 rich tone is not reported an octave LOW (55 Hz)', () => {
    const det = detectPitch(synth(110, { harmonics: RICH }), SR);
    expect(det).not.toBeNull();
    expect(centsErr(det, 55)).toBeGreaterThan(600);
    expect(centsErr(det, 110)).toBeLessThan(1);
  });
});

describe('sweep 60–1400 Hz', () => {
  // 40 geometric steps across the full supported range, rich waveform.
  const steps = 40;
  const freqs = Array.from({ length: steps + 1 }, (_, i) =>
    60 * Math.pow(1400 / 60, i / steps));

  test('every step detected within 1 cent (pure sine)', () => {
    for (const f of freqs) {
      const det = detectPitch(synth(f), SR);
      expect(det).not.toBeNull();
      expect(centsErr(det, f)).toBeLessThan(1);
    }
  });

  test('every step detected within 1 cent (rich waveform, capped below Nyquist)', () => {
    for (const f of freqs) {
      // keep all partials below Nyquist
      const nHarm = Math.max(1, Math.min(RICH.length, Math.floor(SR / 2 / f) - 1));
      const det = detectPitch(synth(f, { harmonics: RICH.slice(0, nHarm) }), SR);
      expect(det).not.toBeNull();
      expect(centsErr(det, f)).toBeLessThan(1);
    }
  });
});

describe('silence and noise rejection', () => {
  test('digital silence returns null', () => {
    expect(detectPitch(new Float32Array(N), SR)).toBeNull();
  });

  test('near-silence (tiny DC + dither) returns null', () => {
    const buf = new Float32Array(N);
    const rand = rng(7);
    for (let i = 0; i < N; i++) buf[i] = 0.002 + 0.001 * (rand() - 0.5);
    expect(detectPitch(buf, SR)).toBeNull();
  });

  test('low-level white noise returns null (RMS gate)', () => {
    const rand = rng(11);
    const buf = new Float32Array(N);
    for (let i = 0; i < N; i++) buf[i] = 0.003 * gaussian(rand) * 0.5;
    expect(detectPitch(buf, SR)).toBeNull();
  });

  test('loud white noise returns null (clarity gate)', () => {
    const rand = rng(13);
    const buf = new Float32Array(N);
    for (let i = 0; i < N; i++) buf[i] = 0.3 * gaussian(rand);
    expect(detectPitch(buf, SR)).toBeNull();
  });
});

describe('noisy but realistic signals', () => {
  test('E2 rich tone at ~15 dB SNR detected within 3 cents', () => {
    // signal peak 0.3 (rms ~0.11), noise sigma 0.02 → SNR ≈ 15 dB
    const det = detectPitch(
      synth(82.41, { harmonics: RICH, decay: 1.5, noiseSigma: 0.02, seed: 101 }), SR);
    expect(det).not.toBeNull();
    expect(centsErr(det, 82.41)).toBeLessThan(3);
  });

  test('A4 rich tone at ~15 dB SNR detected within 3 cents', () => {
    const det = detectPitch(
      synth(440, { harmonics: RICH, noiseSigma: 0.02, seed: 202 }), SR);
    expect(det).not.toBeNull();
    expect(centsErr(det, 440)).toBeLessThan(3);
  });

  test('slightly flat E2 (-20 cents) reads flat, not sharp', () => {
    const f = 82.41 * Math.pow(2, -20 / 1200);
    const det = detectPitch(synth(f, { harmonics: RICH }), SR);
    expect(det).not.toBeNull();
    const cents = centsBetween(det, 82.41);
    expect(cents).toBeLessThan(-18);
    expect(cents).toBeGreaterThan(-22);
  });
});

describe('music-math helpers', () => {
  test('freqToNote maps open strings to the right names', () => {
    expect(freqToNote(82.41)).toMatchObject({ name: 'E', octave: 2 });
    expect(freqToNote(440)).toMatchObject({ name: 'A', octave: 4 });
    expect(freqToNote(261.63)).toMatchObject({ name: 'C', octave: 4 });
  });

  test('nearestString picks the closest string and signs the cents', () => {
    const strings = GUITAR.map(([label, freq]) => ({ label, freq }));
    const r = nearestString(84, strings); // a bit sharp of E2
    expect(r.string.label).toBe('E2');
    expect(r.cents).toBeGreaterThan(0);
  });

  test('centsBetween is symmetric around zero', () => {
    expect(centsBetween(440, 440)).toBeCloseTo(0, 10);
    expect(centsBetween(440 * Math.pow(2, 5 / 1200), 440)).toBeCloseTo(5, 6);
  });
});
