/*
 * pitch.js — pure pitch-detection module. No DOM, no Web Audio types.
 *
 * Algorithm: McLeod Pitch Method (MPM).
 *   1. Normalized Square Difference Function (NSDF) computed in the time
 *      domain over the candidate lag range.
 *   2. Key-maximum picking: skip the zero-lag lobe, collect one maximum per
 *      positive lobe (between positive-going zero crossings).
 *   3. Octave-error guard: among all key maxima, take the FIRST (smallest
 *      lag = highest candidate pitch) whose interpolated height is within
 *      `peakRatio` (default 0.90) of the global maximum. Because the NSDF of
 *      a signal containing any fundamental energy is markedly lower at half
 *      the true period than at the true period, this prefers the true
 *      fundamental over both the octave-low (2x period) and octave-high
 *      (period/2) ghosts — the classic low-E failure.
 *   4. Parabolic interpolation around the chosen integer lag for sub-sample
 *      period resolution (needed for cent-level accuracy at low E).
 *   5. Gates: RMS gate so silence returns null; clarity gate (NSDF height)
 *      so noise/unpitched input returns null.
 */

export const DEFAULTS = {
  fMin: 60,          // Hz — below guitar low E (82.41)
  fMax: 1400,        // Hz
  rmsGate: 0.004,    // below this RMS => "no signal"
  clarity: 0.80,     // min NSDF peak height to accept as pitched
  peakRatio: 0.90,   // first key maximum within this fraction of the best wins
};

/**
 * Detect the fundamental frequency of a mono audio buffer.
 * @param {Float32Array|number[]} samples  time-domain samples, roughly in [-1, 1]
 * @param {number} sampleRate              in Hz
 * @param {object} [options]               overrides for DEFAULTS
 * @returns {number|null} frequency in Hz, or null when too weak / unpitched
 */
export function detectPitch(samples, sampleRate, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const n = samples.length | 0;
  if (n < 64 || !(sampleRate > 0)) return null;

  // --- Remove DC, gate on RMS ---------------------------------------------
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;

  const x = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i] - mean;
    x[i] = v;
    energy += v * v;
  }
  if (Math.sqrt(energy / n) < opt.rmsGate) return null;

  // --- Lag range ------------------------------------------------------------
  const tauMin = Math.max(2, Math.floor(sampleRate / opt.fMax));
  const tauMax = Math.min(n - 3, Math.ceil(sampleRate / opt.fMin) + 4);
  if (tauMax - tauMin < 4) return null;

  // --- NSDF -------------------------------------------------------------
  // nsdf[tau] = 2 * sum(x[i] x[i+tau]) / sum(x[i]^2 + x[i+tau]^2)
  // Computed from lag 1 so the zero-lag lobe boundary is always visible.
  const hi = Math.min(n - 2, tauMax + 1);
  const nsdf = new Float32Array(hi + 1);
  for (let tau = 1; tau <= hi; tau++) {
    let acf = 0;
    let norm = 0;
    const lim = n - tau;
    for (let i = 0; i < lim; i++) {
      const a = x[i];
      const b = x[i + tau];
      acf += a * b;
      norm += a * a + b * b;
    }
    nsdf[tau] = norm > 0 ? (2 * acf) / norm : 0;
  }

  // --- Key maxima: one per positive lobe after the zero-lag lobe -----------
  let tau = 1;
  while (tau <= hi && nsdf[tau] > 0) tau++; // skip the zero-lag lobe
  const maxima = []; // { tau: interpolated lag, val: interpolated height }
  while (tau <= hi) {
    while (tau <= hi && nsdf[tau] <= 0) tau++; // find lobe start
    if (tau > hi) break;
    let bestTau = tau;
    while (tau <= hi && nsdf[tau] > 0) {       // walk the lobe
      if (nsdf[tau] > nsdf[bestTau]) bestTau = tau;
      tau++;
    }
    if (bestTau > 1 && bestTau < hi) {
      const [pt, pv] = parabolic(nsdf, bestTau);
      if (pt >= tauMin - 0.5 && pt <= tauMax + 0.5) maxima.push({ tau: pt, val: pv });
    }
  }
  if (maxima.length === 0) return null;

  // --- Pick: first maximum within peakRatio of the global best -------------
  let best = 0;
  for (const m of maxima) if (m.val > best) best = m.val;
  if (best < opt.clarity) return null;
  const threshold = best * opt.peakRatio;
  let chosen = null;
  for (const m of maxima) {
    if (m.val >= threshold) { chosen = m; break; } // maxima are in ascending tau
  }
  if (!chosen || chosen.tau <= 0) return null;

  const freq = sampleRate / chosen.tau;
  if (freq < opt.fMin * 0.94 || freq > opt.fMax * 1.06) return null;
  return freq;
}

/** Parabolic interpolation around index k of array y → [refined x, refined y]. */
function parabolic(y, k) {
  const a = y[k - 1];
  const b = y[k];
  const c = y[k + 1];
  const denom = a - 2 * b + c;
  if (denom === 0) return [k, b];
  const d = (0.5 * (a - c)) / denom;
  // Clamp: a genuine peak's vertex lies within +/-1 sample of the maximum bin.
  const delta = Math.max(-1, Math.min(1, d));
  return [k + delta, b - 0.25 * (a - c) * delta];
}

// --- Pure music-math helpers (also used by the UI) --------------------------

export const A4 = 440;
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** Signed cents from `ref` Hz to `f` Hz. */
export function centsBetween(f, ref) {
  return 1200 * Math.log2(f / ref);
}

/** Nearest equal-tempered note to a frequency. */
export function freqToNote(f, a4 = A4) {
  const semis = Math.round(12 * Math.log2(f / a4));
  const noteFreq = a4 * Math.pow(2, semis / 12);
  const midi = semis + 69;
  return {
    name: NOTE_NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    freq: noteFreq,
    midi,
    cents: centsBetween(f, noteFreq),
  };
}

/** Nearest string (by absolute cents) in a tuning: [{ label, freq }, ...]. */
export function nearestString(f, strings) {
  let bestI = 0;
  let bestAbs = Infinity;
  for (let i = 0; i < strings.length; i++) {
    const c = Math.abs(centsBetween(f, strings[i].freq));
    if (c < bestAbs) { bestAbs = c; bestI = i; }
  }
  const s = strings[bestI];
  return { index: bestI, string: s, cents: centsBetween(f, s.freq) };
}
