/* app.js — UI, microphone capture, smoothing, reference tones, SW registration. */

import { detectPitch, centsBetween, freqToNote, nearestString } from './pitch.js';

// --- tunings -----------------------------------------------------------------

const TUNINGS = {
  guitar: {
    label: 'Guitar',
    strings: [
      { label: 'E2', freq: 82.41 },
      { label: 'A2', freq: 110.0 },
      { label: 'D3', freq: 146.83 },
      { label: 'G3', freq: 196.0 },
      { label: 'B3', freq: 246.94 },
      { label: 'E4', freq: 329.63 },
    ],
  },
  ukulele: {
    label: 'Ukulele',
    strings: [
      { label: 'G4', freq: 392.0 },
      { label: 'C4', freq: 261.63 },
      { label: 'E4', freq: 329.63 },
      { label: 'A4', freq: 440.0 },
    ],
  },
  ukeLowG: {
    label: 'Uke low-G',
    strings: [
      { label: 'G3', freq: 196.0 },
      { label: 'C4', freq: 261.63 },
      { label: 'E4', freq: 329.63 },
      { label: 'A4', freq: 440.0 },
    ],
  },
  chromatic: { label: 'Chromatic', strings: null },
};

// --- constants -----------------------------------------------------------------

const FFT_SIZE = 4096;      // analysis window (85 ms @ 48 kHz)
const DETECT_MS = 35;       // pitch detection cadence
const HISTORY = 5;          // median window (raw readings)
const EMA_ALPHA = 0.4;      // exponential smoothing on the median
const IN_TUNE_CENTS = 5;
const METER_RANGE = 50;     // +/- cents shown on the meter
const DEG_PER_CENT = 1.1;   // 50 cents -> 55 degrees
const NULL_STREAK_IDLE = 10;

// --- dom -------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), modes: $('modes'), scale: $('scale'), zone: $('zone'),
  needleGroup: $('needle-group'), noteName: $('note-name'),
  noteOctave: $('note-octave'), cents: $('cents'), freq: $('freq'),
  strings: $('strings'), hint: $('hint'), overlay: $('overlay'),
  startBtn: $('start-btn'), startLabel: $('start-label'),
  overlayMsg: $('overlay-msg'),
};

// --- state ---------------------------------------------------------------------

let mode = localStorage.getItem('tuner-mode') || 'guitar';
if (!TUNINGS[mode]) mode = 'guitar';
let audioCtx = null;
let analyser = null;
let micStream = null;
let running = false;
const timeBuf = new Float32Array(FFT_SIZE);
let recent = [];            // last few raw detections (Hz)
let smoothed = null;        // EMA'd frequency (Hz)
let nullStreak = 0;
let lastDetect = 0;
let refTone = null;         // { osc: [], gain, chip, timer }
let wakeLock = null;

// --- meter construction -----------------------------------------------------------

const CX = 200, CY = 232, R_IN = 175, R_OUT = 190, R_LABEL = 208;
const polar = (deg, r) => {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.sin(rad), CY - r * Math.cos(rad)];
};

function buildMeter() {
  const NS = 'http://www.w3.org/2000/svg';
  const frag = document.createDocumentFragment();
  for (let c = -METER_RANGE; c <= METER_RANGE; c += 5) {
    const major = c % 25 === 0;
    const deg = c * DEG_PER_CENT;
    const [x1, y1] = polar(deg, major ? R_IN - 6 : R_IN);
    const [x2, y2] = polar(deg, R_OUT);
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', c === 0 ? '#3fd68f' : '#5d6f82');
    line.setAttribute('stroke-width', major ? 4 : 2);
    line.setAttribute('stroke-linecap', 'round');
    frag.appendChild(line);
    if (major) {
      const [tx, ty] = polar(deg, R_LABEL);
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('x', tx); text.setAttribute('y', ty);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.textContent = c === 0 ? '0' : (c > 0 ? `+${c}` : `${c}`);
      frag.appendChild(text);
    }
  }
  el.scale.appendChild(frag);

  // in-tune zone: annular wedge covering +/- IN_TUNE_CENTS
  const a = IN_TUNE_CENTS * DEG_PER_CENT;
  const [x1, y1] = polar(-a, R_IN);
  const [x2, y2] = polar(-a, R_OUT);
  const [x3, y3] = polar(a, R_OUT);
  const [x4, y4] = polar(a, R_IN);
  el.zone.setAttribute('d',
    `M ${x1} ${y1} L ${x2} ${y2} A ${R_OUT} ${R_OUT} 0 0 1 ${x3} ${y3} ` +
    `L ${x4} ${y4} A ${R_IN} ${R_IN} 0 0 0 ${x1} ${y1} Z`);
}

// --- mode selector -----------------------------------------------------------------

function buildModes() {
  el.modes.textContent = '';
  for (const key of Object.keys(TUNINGS)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.textContent = TUNINGS[key].label;
    btn.setAttribute('aria-selected', String(key === mode));
    btn.addEventListener('click', () => setMode(key));
    el.modes.appendChild(btn);
  }
}

function setMode(key) {
  mode = key;
  localStorage.setItem('tuner-mode', key);
  stopRefTone();
  for (let i = 0; i < el.modes.children.length; i++) {
    const b = el.modes.children[i];
    b.setAttribute('aria-selected', String(Object.keys(TUNINGS)[i] === key));
  }
  buildStrings();
  resetReadout();
}

// --- string chips ------------------------------------------------------------------

function buildStrings() {
  el.strings.textContent = '';
  const strings = TUNINGS[mode].strings;
  if (!strings) {
    el.hint.textContent = 'Chromatic — tunes to the nearest note';
    return;
  }
  el.hint.textContent = 'Tap a string to hear its reference tone';
  for (const s of strings) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.label = s.label;
    btn.textContent = s.label;
    const small = document.createElement('small');
    small.textContent = `${s.freq.toFixed(2)} Hz`;
    btn.appendChild(small);
    btn.addEventListener('click', () => toggleRefTone(s, btn));
    el.strings.appendChild(btn);
  }
}

function highlightString(label) {
  for (const btn of el.strings.children) {
    btn.classList.toggle('active', btn.dataset.label === label);
  }
}

// --- reference tones ----------------------------------------------------------------

function ensureCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function stopRefTone() {
  if (!refTone) return;
  clearTimeout(refTone.timer);
  const t = audioCtx.currentTime;
  try {
    refTone.gain.gain.cancelScheduledValues(t);
    refTone.gain.gain.setTargetAtTime(0.0001, t, 0.03);
    for (const o of refTone.osc) o.stop(t + 0.2);
  } catch { /* already stopped */ }
  refTone.chip.classList.remove('playing');
  refTone = null;
}

function toggleRefTone(s, chip) {
  if (refTone && refTone.chip === chip) { stopRefTone(); return; }
  stopRefTone();
  const ctx = ensureCtx();
  const t = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.5, t + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
  gain.connect(ctx.destination);
  // Slightly plucked timbre: fundamental + two soft harmonics.
  const partials = [[1, 1], [2, 0.25], [3, 0.1]];
  const osc = partials.map(([mult, amt]) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = s.freq * mult;
    const g = ctx.createGain();
    g.gain.value = amt;
    o.connect(g).connect(gain);
    o.start(t);
    o.stop(t + 2.4);
    return o;
  });
  chip.classList.add('playing');
  refTone = { osc, gain, chip, timer: setTimeout(stopRefTone, 2300) };
}

// --- microphone + detection loop ------------------------------------------------------

async function startMic() {
  el.startLabel.textContent = 'Starting…';
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
  } catch (err) {
    showMicError(err);
    return;
  }
  const ctx = ensureCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  const src = ctx.createMediaStreamSource(micStream);
  analyser = ctx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  src.connect(analyser);
  running = true;
  el.overlay.classList.add('hidden');
  resetReadout();
  requestWakeLock();
  requestAnimationFrame(loop);
}

function showMicError(err) {
  el.startLabel.textContent = 'Try again';
  el.overlayMsg.classList.add('error');
  if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.name === 'SecurityError')) {
    el.overlayMsg.textContent =
      'Microphone access was denied. Allow the microphone for this site in your browser settings, then tap Try again.';
  } else if (err && err.name === 'NotFoundError') {
    el.overlayMsg.textContent = 'No microphone was found on this device.';
  } else {
    el.overlayMsg.textContent = `Could not start the microphone (${err && err.name ? err.name : 'unknown error'}). Tap Try again.`;
  }
}

function loop(ts) {
  if (!running) return;
  if (ts - lastDetect >= DETECT_MS) {
    lastDetect = ts;
    analyser.getFloatTimeDomainData(timeBuf);
    const raw = detectPitch(timeBuf, audioCtx.sampleRate);
    if (raw !== null) {
      nullStreak = 0;
      recent.push(raw);
      if (recent.length > HISTORY) recent.shift();
      const med = median(recent);
      if (smoothed === null || Math.abs(centsBetween(med, smoothed)) > 150) {
        smoothed = med; // snap on note changes instead of gliding
      } else {
        smoothed += EMA_ALPHA * (med - smoothed);
      }
      render(smoothed);
    } else {
      nullStreak++;
      if (nullStreak === NULL_STREAK_IDLE) resetReadout();
    }
  }
  requestAnimationFrame(loop);
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// --- rendering --------------------------------------------------------------------------

function render(freq) {
  let name, octave, cents, targetLabel;
  const strings = TUNINGS[mode].strings;
  if (strings) {
    const r = nearestString(freq, strings);
    name = r.string.label.slice(0, -1);
    octave = r.string.label.slice(-1);
    cents = r.cents;
    targetLabel = r.string.label;
  } else {
    const n = freqToNote(freq);
    name = n.name;
    octave = String(n.octave);
    cents = n.cents;
    targetLabel = null;
  }
  el.app.classList.remove('idle');
  el.noteName.textContent = name;
  el.noteOctave.textContent = octave;
  const shown = Math.round(cents);
  el.cents.textContent = `${shown > 0 ? '+' : shown < 0 ? '−' : ''}${Math.abs(shown)}¢`;
  el.freq.textContent = `${freq.toFixed(1)} Hz`;
  const clamped = Math.max(-METER_RANGE, Math.min(METER_RANGE, cents));
  el.needleGroup.style.transform = `rotate(${(clamped * DEG_PER_CENT).toFixed(2)}deg)`;
  el.app.classList.toggle('in-tune', Math.abs(cents) <= IN_TUNE_CENTS);
  if (targetLabel) highlightString(targetLabel);
}

function resetReadout() {
  recent = [];
  smoothed = null;
  nullStreak = 0;
  el.app.classList.add('idle');
  el.app.classList.remove('in-tune');
  el.noteName.textContent = '–';
  el.noteOctave.textContent = '';
  el.cents.textContent = '';
  el.freq.textContent = running ? 'Listening…' : '';
  el.needleGroup.style.transform = 'rotate(0deg)';
  highlightString(null);
}

// --- wake lock (keep the screen on while tuning) --------------------------------------------

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not critical */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) {
    requestWakeLock(); // the lock is auto-released when the tab is hidden
  }
});

// --- boot -------------------------------------------------------------------------------------

buildMeter();
buildModes();
buildStrings();
resetReadout();
el.startBtn.addEventListener('click', startMic);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline-first is best effort */ });
  });
}
