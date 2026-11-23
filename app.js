// hypnos — client-side PSG metrics via webR (R compiled to WebAssembly).
// The EDF file is mounted into webR's virtual filesystem and never uploaded.

import { WebR } from 'https://webr.r-wasm.org/latest/webr.mjs';

// ── Config ────────────────────────────────────────────────────────────────
const REPOS    = ['https://circadia-bio.r-universe.dev', 'https://repo.r-wasm.org'];
const PACKAGES = ['mrpheus', 'hypnoR', 'jsonlite'];
const EDF_PATH = '/tmp/recording.edf';

const STAGES = ['W', 'REM', 'N1', 'N2', 'N3'];            // hypnogram order, top to bottom
const STAGE_VAR = { W: '--st-w', REM: '--st-rem', N1: '--st-n1', N2: '--st-n2', N3: '--st-n3' };
const STAGE_NAME = { W: 'Wake', REM: 'REM', N1: 'N1', N2: 'N2', N3: 'N3' };
const PAD = { l: 46, r: 12, t: 10, b: 28 };               // shared so time axes line up
const CANVAS_H = 190;                                      // hypnogram and spectrogram height (px)

const METRICS = [
  ['tst_min',     'Total sleep time',       'min'],
  ['tib_min',     'Time in bed',            'min'],
  ['se_pct',      'Sleep efficiency',       '%'],
  ['sol_min',     'Sleep onset latency',    'min'],
  ['waso_min',    'Wake after sleep onset', 'min'],
  ['rem_lat_min', 'REM latency',            'min'],
  ['sws_lat_min', 'N3 latency',             'min'],
  ['pct_n1',      'N1',                     '% TST'],
  ['pct_n2',      'N2',                     '% TST'],
  ['pct_n3',      'N3',                     '% TST'],
  ['pct_rem',     'REM',                    '% TST'],
];

// ── DOM ───────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const dropzone   = $('#dropzone');
const fileInput  = $('#file-input');
const fileNote   = $('#file-note');
const statusCard = $('#status-card');
const statusText = $('#status-text');
const spinner    = $('#spinner');
const progressFill = $('#progress-fill');
const statusSub  = $('#status-sub');
const elapsedEl  = $('#elapsed');
const logEl      = $('#log');
const logDetails = $('#log-details');
const enginePill = $('#engine-pill');
const results    = $('#results');

let webR = null;
let last = null;          // last parsed result, for redraw and download
let busy = false;
let t0 = 0;
let timer = null;

// Pipeline stages, run one at a time so each can be timed and reported here
const PIPELINE = [
  ['Reading EDF header',          () => `hypnos_header("${EDF_PATH}")`],
  ['Loading channels',            () => `hypnos_read("${EDF_PATH}")`],
  ['Segmenting epochs',           () => 'hypnos_segment()'],
  // preprocess_psg() omitted: stage_epochs() applies its own 0.4-30 Hz bandpass and
  // 100 Hz resample, and the full-night filtfilt passes are very slow in WASM.
  // Re-add (ideally after downsampling) when band power or event detection is added.
  ['Extracting staging features', () => 'hypnos_features()'],
  ['Predicting stages',           () => 'hypnos_predict()'],
  ['Computing spectrogram',       () => 'hypnos_spectrogram()'],
  ['Computing sleep architecture', () => 'hypnos_metrics()'],
];
const STEP_TOTAL = PIPELINE.length + 1;   // +1 for channel extraction in JS

// ── Helpers ───────────────────────────────────────────────────────────────
function log(text, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  if (String(text).trim()) statusSub.textContent = String(text).trim().slice(0, 140);
}

function setProgress(frac) {
  progressFill.style.width = `${Math.max(0.03, Math.min(1, frac)) * 100}%`;
}

function startTimer() {
  stopTimer();
  t0 = Date.now();
  elapsedEl.textContent = '0:00';
  timer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    elapsedEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timer);
  timer = null;
}

function setStatus(text, { working = true } = {}) {
  statusCard.hidden = false;
  statusText.textContent = text;
  spinner.classList.toggle('done', !working);
  progressFill.classList.toggle('working', working);
  if (!working) stopTimer();
}

function setEngine(text, ok = false) {
  enginePill.textContent = `Engine: ${text}`;
  enginePill.classList.toggle('pill-ok', ok);
}

function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Number(v).toFixed(1);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

// ── Engine ────────────────────────────────────────────────────────────────
async function pumpOutput() {
  for (;;) {
    const msg = await webR.read();
    if (msg.type === 'closed') break;
    if (msg.type === 'stdout' || msg.type === 'stderr') log(msg.data);
  }
}

async function boot() {
  try {
    setEngine('starting R');
    setStatus('Preparing the R engine (first load downloads packages)');
    setProgress(0.03);
    startTimer();
    webR = new WebR();
    await webR.init();
    pumpOutput();

    setEngine('installing packages');
    await webR.installPackages(PACKAGES, { repos: REPOS, quiet: false });

    // Fail loudly if anything mrpheus needs has no WASM build
    await webR.evalRVoid(`
      need <- c("mrpheus", "hypnoR", "jsonlite", "Rcpp", "edfReader", "gsignal",
                "pracma", "lightgbm", "fastICA", "dplyr", "tibble", "cli", "rlang")
      miss <- need[!nzchar(vapply(need, function(p) system.file(package = p), character(1)))]
      if (length(miss)) stop("Not installed in webR: ", paste(miss, collapse = ", "))
    `);

    const src = await (await fetch('analysis.R', { cache: 'no-store' })).text();
    await webR.evalRVoid(src);

    setEngine('ready', true);
    if (!busy) {
      stopTimer();
      statusCard.hidden = true;
    }
  } catch (err) {
    setEngine('failed');
    setStatus('Engine failed to start', { working: false });
    log(String(err?.message ?? err), 'err');
    logDetails.open = true;
    throw err;
  }
}

const enginePromise = boot();
enginePromise.catch(() => {});

// ── Analysis ──────────────────────────────────────────────────────────────
// Read only the EDF header (a few KB) to pick the channels staging needs,
// so R never has to hold the whole recording in memory.
async function pickChannels(file) {
  const dec = new TextDecoder('ascii');
  const head = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const ns = parseInt(dec.decode(head.slice(252, 256)), 10);
  const sig = new Uint8Array(await file.slice(256, 256 + ns * 16).arrayBuffer());
  const labels = [];
  for (let i = 0; i < ns; i++) {
    labels.push(dec.decode(sig.slice(i * 16, (i + 1) * 16)).trim());
  }

  // Same patterns and precedence as mrpheus::prepare_psg()
  const rules = [
    ['EEG', /EEG|C3|C4|F3|F4|O1|O2|Fpz|Pz/],
    ['EOG', /EOG|ROC|LOC/],
    ['EMG', /EMG|chin|Chin/],
  ];
  const chosen = {};
  for (const label of labels) {
    if (label.includes('Annotations')) continue;
    const hit = rules.find(([, re]) => re.test(label));
    if (hit && !chosen[hit[0]]) chosen[hit[0]] = label;
  }
  log(`Channels (${ns} in file): loading ${Object.values(chosen).join(', ') || 'none matched'}`);
  return Object.values(chosen);
}
// Build a small EDF holding only the wanted channels. The source file is read
// in slices, so the full recording is never held in memory.
async function extractChannels(file, wanted) {
  const dec = new TextDecoder('ascii');
  const num = (bytes) => parseInt(dec.decode(bytes), 10);
  const put = (buf, off, str, len) => {
    for (let i = 0; i < len; i++) buf[off + i] = i < str.length ? str.charCodeAt(i) : 32;
  };

  const head = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const ns = num(head.slice(252, 256));
  const sigHdr = new Uint8Array(await file.slice(256, 256 + ns * 256).arrayBuffer());

  // Per-signal header fields: label, transducer, physical dim, phys min/max,
  // digital min/max, prefilter, samples per record, reserved.
  const W = [16, 80, 8, 8, 8, 8, 8, 80, 8, 32];
  const start = [];
  for (let f = 0, acc = 0; f < W.length; f++) { start.push(acc); acc += W[f] * ns; }
  const field = (f, i) => sigHdr.subarray(start[f] + i * W[f], start[f] + (i + 1) * W[f]);

  const labels = Array.from({ length: ns }, (_, i) => dec.decode(field(0, i)).trim());
  const rec = Array.from({ length: ns }, (_, i) => num(field(8, i)) * 2);   // bytes per record
  const recOff = [];
  let recBytes = 0;
  for (const b of rec) { recOff.push(recBytes); recBytes += b; }

  const idx = wanted.map((l) => labels.indexOf(l)).filter((i) => i >= 0);
  const k = idx.length;

  const hdrBytes = 256 + ns * 256;
  let nRec = num(head.slice(236, 244));
  const fits = Math.floor((file.size - hdrBytes) / recBytes);
  if (!(nRec > 0) || nRec > fits) nRec = fits;

  const newHdrBytes = 256 + k * 256;
  const newRecBytes = idx.reduce((s, i) => s + rec[i], 0);
  const outSize = newHdrBytes + nRec * newRecBytes;
  if (outSize > 900 * 1048576) {
    throw new Error(`Selected channels need ${(outSize / 1048576).toFixed(0)} MB, too large for the browser.`);
  }
  const out = new Uint8Array(outSize);

  // Fixed header, rewritten as a plain EDF with k signals
  out.set(head, 0);
  put(out, 0, '0', 8);
  put(out, 184, String(newHdrBytes), 8);
  put(out, 192, '', 44);
  put(out, 236, String(nRec), 8);
  put(out, 252, String(k), 4);

  // Signal header, selected signals only
  for (let f = 0, acc = 0; f < W.length; f++) {
    idx.forEach((src, j) => out.set(field(f, src), 256 + acc + j * W[f]));
    acc += W[f] * k;
  }

  // Data records
  const perChunk = Math.max(1, Math.floor((32 * 1048576) / recBytes));
  let pos = newHdrBytes;
  for (let r0 = 0; r0 < nRec; r0 += perChunk) {
    const n = Math.min(perChunk, nRec - r0);
    const from = hdrBytes + r0 * recBytes;
    const chunk = new Uint8Array(await file.slice(from, from + n * recBytes).arrayBuffer());
    for (let r = 0; r < n; r++) {
      const base = r * recBytes;
      for (const i of idx) {
        out.set(chunk.subarray(base + recOff[i], base + recOff[i] + rec[i]), pos);
        pos += rec[i];
      }
    }
    const pct = (r0 + n) / nRec;
    setStatus(`Step 1 of ${STEP_TOTAL}: Extracting channels ${Math.round(pct * 100)}%`);
    setProgress(pct / STEP_TOTAL);
  }
  return out;
}

// If the WASM build of mrpheus lacks the staging model, use a copy served beside
// the page (models/yasa_staging.txt) when one exists.
async function ensureModel(shelter) {
  const has = await shelter.evalR('nzchar(system.file("models", "yasa_staging.txt", package = "mrpheus"))');
  if ((await has.toJs()).values[0]) return;
  const r = await fetch('models/yasa_staging.txt', { cache: 'no-store' });
  if (!r.ok) {
    log('Staging model is not in the mrpheus package and models/yasa_staging.txt was not found.');
    return;
  }
  await webR.FS.writeFile('/tmp/yasa_staging.txt', new Uint8Array(await r.arrayBuffer()));
  log('Using models/yasa_staging.txt (not found in the mrpheus package).');
}

async function analyse(file) {
  if (busy) return;
  busy = true;
  startTimer();
  dropzone.classList.add('disabled');
  results.hidden = true;
  $('#markers-card').hidden = true;
  logEl.textContent = '';

  fileNote.textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB · processed locally`;

  try {
    setStatus('Waiting for the R engine');
    await enginePromise;

    setStatus('Analysing recording');
    const channels = await pickChannels(file);
    if (!channels.length) throw new Error('No EEG, EOG or EMG channel labels recognised in this file.');
    const reduced = await extractChannels(file, channels);
    log(`Reduced EDF: ${(reduced.length / 1048576).toFixed(0)} MB`);
    await webR.FS.writeFile(EDF_PATH, reduced);
    const shelter = await new webR.Shelter();
    try {
      await ensureModel(shelter);
      let out = null;
      for (const [i, [label, call]] of PIPELINE.entries()) {
        setStatus(`Step ${i + 2} of ${STEP_TOTAL}: ${label}`);
        setProgress((i + 1) / STEP_TOTAL);
        const t = performance.now();
        try {
          const res = await shelter.evalR(call());
          out = (await res.toJs()).values?.[0] ?? null;
        } catch (err) {
          throw new Error(`${label} failed: ${err?.message ?? err}`);
        }
        const secs = ((performance.now() - t) / 1000).toFixed(1);
        const detail = i < PIPELINE.length - 1 && out ? `${out} ` : '';
        log(`${label}: ${detail}[${secs} s]`);
      }
      last = JSON.parse(out);
    } finally {
      await shelter.purge();
      try { await webR.FS.unlink(EDF_PATH); } catch { /* already gone */ }
    }

    render(last);
    setStatus('Done', { working: false });
    setProgress(1);
  } catch (err) {
    setStatus('Analysis failed', { working: false });
    log(String(err?.message ?? err), 'err');
    logDetails.open = true;
  } finally {
    busy = false;
    dropzone.classList.remove('disabled');
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────
function render(data) {
  // Metric cards
  const grid = $('#metrics-grid');
  grid.innerHTML = '';
  for (const [key, label, unit] of METRICS) {
    const value = data.metrics[key];
    if (value === null || value === undefined) continue;   // e.g. coarse-only metrics
    const card = document.createElement('div');
    card.className = 'marker';
    card.innerHTML =
      `<p class="marker-label">${label}</p>` +
      `<p class="marker-value">${fmt(value)}<span class="marker-unit">${unit}</span></p>`;
    grid.appendChild(card);
  }

  // Stage composition
  const total = STAGES.reduce((s, k) => s + (data.stage_min[k] ?? 0), 0);
  const bar = $('#stagebar');
  const legend = $('#stage-legend');
  bar.innerHTML = '';
  legend.innerHTML = '';
  for (const s of ['W', 'N1', 'N2', 'N3', 'REM']) {
    const mins = data.stage_min[s] ?? 0;
    const seg = document.createElement('span');
    seg.style.width = `${total ? (mins / total) * 100 : 0}%`;
    seg.style.background = `var(${STAGE_VAR[s]})`;
    seg.title = `${STAGE_NAME[s]}: ${fmt(mins)} min`;
    bar.appendChild(seg);

    const item = document.createElement('span');
    item.innerHTML = `<i style="background:var(${STAGE_VAR[s]})"></i>${STAGE_NAME[s]} ${fmt(mins)} min`;
    legend.appendChild(item);
  }

  results.hidden = false;
  $('#markers-card').hidden = false;
  drawHypnogram(data);
  drawSpectrogram(data);
}

function drawHypnogram(data) {
  const canvas = $('#hypnogram');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = CANVAS_H;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = PAD;
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;
  const n = data.stages.length;
  const hours = (n * data.recording.epoch_s) / 3600;
  const xOf = (i) => pad.l + (i / n) * w;
  const yOf = (s) => pad.t + (STAGES.indexOf(s) + 0.5) * (h / STAGES.length);

  const soft = cssVar('--fg-soft');
  const rule = cssVar('--rule');
  ctx.font = '11px Alice, serif';
  ctx.textBaseline = 'middle';

  // Level guides and labels
  ctx.textAlign = 'right';
  for (const s of STAGES) {
    const y = yOf(s);
    ctx.strokeStyle = rule;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + w, y); ctx.stroke();
    ctx.fillStyle = soft;
    ctx.fillText(STAGE_NAME[s], pad.l - 8, y);
  }

  // Hour ticks
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let hr = 0; hr <= Math.floor(hours); hr++) {
    const x = pad.l + (hr / hours) * w;
    ctx.fillStyle = soft;
    ctx.fillText(`${hr} h`, x, pad.t + h + 8);
  }

  // Runs of identical stage, with vertical connectors
  let i = 0;
  let prev = null;
  while (i < n) {
    const s = data.stages[i];
    let j = i;
    while (j + 1 < n && data.stages[j + 1] === s) j++;
    if (s) {
      const y = yOf(s);
      if (prev && prev.y !== y) {
        ctx.strokeStyle = soft;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xOf(i), prev.y); ctx.lineTo(xOf(i), y); ctx.stroke();
      }
      ctx.strokeStyle = cssVar(STAGE_VAR[s]);
      ctx.lineWidth = 4;
      ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(xOf(i), y); ctx.lineTo(xOf(j + 1), y); ctx.stroke();
      prev = { y };
    } else {
      prev = null;     // unstaged (artefact) epochs leave a gap
    }
    i = j + 1;
  }
}

// ── Spectrogram ────────────────────────────────────────────────────────────────────────
// Colour ramp built from the Circadia palette, low to high power
const SPEC_STOPS = ['#014370', '#1b6799', '#9bdfe2', '#ffecd4', '#ffa75d', '#fc544a']
  .map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));

function specColor(t) {
  const x = Math.min(1, Math.max(0, t)) * (SPEC_STOPS.length - 1);
  const i = Math.min(SPEC_STOPS.length - 2, Math.floor(x));
  const f = x - i;
  return SPEC_STOPS[i].map((c, k) => Math.round(c + (SPEC_STOPS[i + 1][k] - c) * f));
}

function drawSpectrogram(data) {
  const card = $('#spec-card');
  const sp = data.spectrogram;
  if (!sp || !sp.power || !sp.power.length) { card.hidden = true; return; }
  card.hidden = false;

  const canvas = $('#spectrogram');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = CANVAS_H;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = PAD;
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;
  const n = sp.power.length;
  const F = sp.freqs.length;
  const hours = (n * data.recording.epoch_s) / 3600;

  // Robust colour limits (2nd to 98th percentile)
  const vals = sp.power.flat().filter(Number.isFinite).sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.02)];
  const hi = vals[Math.floor(vals.length * 0.98)];
  const span = hi - lo || 1;

  // Epochs on x, frequency on y (low at the bottom), drawn 1 px per cell then scaled
  const off = document.createElement('canvas');
  off.width = n;
  off.height = F;
  const octx = off.getContext('2d');
  const img = octx.createImageData(n, F);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < F; j++) {
      const v = sp.power[i][j];
      const p = ((F - 1 - j) * n + i) * 4;
      if (Number.isFinite(v)) {
        const [r, g, b] = specColor((v - lo) / span);
        img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
      }
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, pad.l, pad.t, w, h);

  // Axes
  const soft = cssVar('--fg-soft');
  ctx.font = '11px Alice, serif';
  ctx.fillStyle = soft;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const fmin = sp.freqs[0];
  const fmax = sp.freqs[F - 1];
  for (let f = Math.ceil(fmin / 10) * 10; f <= fmax; f += 10) {
    ctx.fillText(`${f} Hz`, pad.l - 8, pad.t + h * (1 - (f - fmin) / (fmax - fmin)));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let hr = 0; hr <= Math.floor(hours); hr++) {
    ctx.fillText(`${hr} h`, pad.l + (hr / hours) * w, pad.t + h + 8);
  }

  $('#spec-note').textContent =
    `${sp.channel}, power spectral density per epoch in dB. Colour range is the 2nd to 98th ` +
    `percentile (${lo.toFixed(0)} to ${hi.toFixed(0)} dB).`;
}

// ── Events ────────────────────────────────────────────────────────────────
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) analyse(f);
  fileInput.value = '';
});

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) analyse(f);
});

$('#dl-metrics').addEventListener('click', () => {
  if (!last) return;
  const keys = Object.keys(last.metrics);
  download('hypnos_metrics.csv', `${keys.join(',')}\n${keys.map((k) => last.metrics[k] ?? '').join(',')}\n`);
});

$('#dl-hypnogram').addEventListener('click', () => {
  if (!last) return;
  const { epoch_s } = last.recording;
  const rows = last.stages.map((s, i) => `${i + 1},${i * epoch_s},${s ?? ''}`);
  download('hypnos_hypnogram.csv', `epoch,onset_s,stage\n${rows.join('\n')}\n`);
});

function redraw() {
  if (!last) return;
  drawHypnogram(last);
  drawSpectrogram(last);
}
window.addEventListener('resize', redraw);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
