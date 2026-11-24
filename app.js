// hypnos — client-side PSG metrics via webR (R compiled to WebAssembly).
// The EDF file is mounted into webR's virtual filesystem and never uploaded.

import { initWelcome } from './welcome.js';
import { initSettings } from './settings.js';
import { initTheme } from './theme.js';
import { readHeaderInfo, resolveChannels } from './channels.js';

// ── Config ────────────────────────────────────────────────────────────────
const WEBR_URL = 'https://webr.r-wasm.org/v0.6.0/webr.mjs';   // loaded in boot(), so the page works if it cannot be reached
const REPOS    = ['https://circadia-bio.r-universe.dev', 'https://repo.r-wasm.org'];
const PACKAGES = ['mrpheus', 'jsonlite'];
const EDF_PATH = '/tmp/recording.edf';
const EPOCH_S  = 30;

const STAGES = ['W', 'REM', 'N1', 'N2', 'N3'];            // hypnogram order, top to bottom
const STAGE_VAR = { W: '--st-w', REM: '--st-rem', N1: '--st-n1', N2: '--st-n2', N3: '--st-n3' };
const STAGE_NAME = { W: 'Wake', REM: 'REM', N1: 'N1', N2: 'N2', N3: 'N3' };

const PLOT_H = 200;                                        // hypnogram and spectrogram height (px)
const PLOT_MARGIN = { l: 56, r: 76, t: 8, b: 34 };         // identical in both plots so time axes line up
const PLOT_CONFIG = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d'],
};
// Colour ramp built from the Circadia palette, low to high power
const SPEC_COLORSCALE = [
  [0, '#014370'], [0.2, '#1b6799'], [0.4, '#9bdfe2'],
  [0.6, '#ffecd4'], [0.8, '#ffa75d'], [1, '#fc544a'],
];

const METRICS = [
  // key, label, unit, icon, stage (stage-coloured dot for the stage percentages)
  ['tst_min',     'Total sleep time',       'min',   'bi-moon-stars-fill'],
  ['tib_min',     'Time in bed',            'min',   'bi-clock-fill'],
  ['se_pct',      'Sleep efficiency',       '%',     'bi-speedometer2'],
  ['sol_min',     'Sleep onset latency',    'min',   'bi-hourglass-top'],
  ['waso_min',    'Wake after sleep onset', 'min',   'bi-sun-fill'],
  ['rem_lat_min', 'REM latency',            'min',   'bi-eye-fill'],
  ['sws_lat_min', 'N3 latency',             'min',   'bi-moon-fill'],
  ['pct_n1',      'N1',                     '% TST', 'bi-circle-fill', 'N1'],
  ['pct_n2',      'N2',                     '% TST', 'bi-circle-fill', 'N2'],
  ['pct_n3',      'N3',                     '% TST', 'bi-circle-fill', 'N3'],
  ['pct_rem',     'REM',                    '% TST', 'bi-circle-fill', 'REM'],
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
const engineText = $('#engine-text');
const results    = $('#results');

let webR = null;
let last = null;          // last parsed result, for redraw and download
let busy = false;
let t0 = 0;
let timer = null;

let currentFile = null;   // the recording being analysed
let fileInfo = null;      // its header: labels and sample rates
let usedChannels = null;  // the channels the last run staged with
const defaultSettings = () => ({ eeg: 'auto', eog: 'auto', emg: 'auto', window: 'auto', startH: null, endH: null });
let settings = defaultSettings();

// R string literal for a channel label, or NA when there is none
const rStr = (v) => (v ? JSON.stringify(v) : 'NA_character_');

// An analysis window the user set, as epoch numbers for R; empty means the automatic one
function windowArgs() {
  if (settings.window !== 'custom' || !Number.isFinite(settings.startH) || !Number.isFinite(settings.endH)) return '';
  const first = Math.floor((settings.startH * 3600) / EPOCH_S + 1e-9) + 1;
  const last = Math.floor((settings.endH * 3600) / EPOCH_S + 1e-9);
  return `first = ${first}L, last = ${Math.max(first, last)}L`;
}

// Pipeline stages, run one at a time so each can be timed and reported here
const PIPELINE = [
  ['Reading EDF header',          () => `hypnos_header("${EDF_PATH}")`],
  ['Loading channels',            () => `hypnos_read("${EDF_PATH}")`],
  ['Segmenting epochs',           (c) => `hypnos_segment(${rStr(c.eeg)}, ${rStr(c.eog)}, ${rStr(c.emg)})`],
  ['Checking signal validity',    () => 'hypnos_validity()'],
  // preprocess_psg() omitted: stage_epochs() applies its own 0.4-30 Hz bandpass and
  // 100 Hz resample, and the full-night filtfilt passes are very slow in WASM.
  // Re-add (ideally after downsampling) when band power or event detection is added.
  ['Extracting staging features', () => 'hypnos_features()'],
  ['Predicting stages',           () => 'hypnos_predict()'],
  ['Computing spectrogram',       () => 'hypnos_spectrogram()'],
  ['Computing sleep summary',     () => `hypnos_metrics(${windowArgs()})`],
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
  engineText.textContent = `Engine: ${text}`;
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

// Run R code in a shelter and return the first string it gives back
async function rcall(shelter, code) {
  const res = await shelter.evalR(code);
  return (await res.toJs()).values?.[0] ?? null;
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
    const { WebR } = await import(WEBR_URL);
    webR = new WebR();
    await webR.init();
    pumpOutput();

    setEngine('installing packages');
    await webR.installPackages(PACKAGES, { repos: REPOS, quiet: false });

    // Fail loudly if anything mrpheus needs has no WASM build
    await webR.evalRVoid(`
      need <- c("mrpheus", "jsonlite", "Rcpp", "edfReader", "gsignal",
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

// If the WASM build of mrpheus ships no YASA models, use the full EEG + EOG + EMG model
// served beside the page (models/yasa_staging.txt) when one exists.
async function ensureModel(shelter) {
  const has = await shelter.evalR(
    'length(list.files(system.file("models", package = "mrpheus"), pattern = "^yasa_.*[.]txt[.]gz$")) > 0'
  );
  if ((await has.toJs()).values[0]) return;
  const r = await fetch('models/yasa_staging.txt', { cache: 'no-store' });
  if (!r.ok) {
    log('mrpheus ships no YASA models here and models/yasa_staging.txt was not found.');
    return;
  }
  await webR.FS.writeFile('/tmp/yasa_staging.txt', new Uint8Array(await r.arrayBuffer()));
  log('mrpheus ships no YASA models here; using models/yasa_staging.txt (EEG + EOG + EMG only).');
}

// Run a task with the page marked busy; report a failure in the status card and the log
async function withBusy(task) {
  if (busy) return;
  busy = true;
  startTimer();
  dropzone.classList.add('disabled');
  try {
    await task();
  } catch (err) {
    setStatus('Analysis failed', { working: false });
    log(String(err?.message ?? err), 'err');
    logDetails.open = true;
  } finally {
    busy = false;
    dropzone.classList.remove('disabled');
  }
}

// A new recording: read its header, reset the settings, and analyse it
function analyse(file) {
  return withBusy(async () => {
    results.hidden = true;
    $('#markers-card').hidden = true;
    last = null;
    logEl.textContent = '';
    setStatus('Reading the file header');

    try {
      fileInfo = await readHeaderInfo(file);
    } catch (err) {
      currentFile = null;
      fileInfo = null;
      throw err;
    }
    currentFile = file;
    settings = defaultSettings();
    fileNote.textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB · processed locally`;
    await runPipeline();
  });
}

// The full analysis of the current recording with the current channel and window settings
async function runPipeline() {
  results.hidden = true;
  $('#markers-card').hidden = true;
  logEl.textContent = '';

  setStatus('Waiting for the R engine');
  await enginePromise;

  setStatus('Analysing recording');
  const ch = resolveChannels(fileInfo, settings);
  if (!ch.eeg) throw new Error('No EEG channel was recognised in this file. Choose one in Analysis settings.');
  log(`Channels (${fileInfo.ns} in file): EEG ${ch.eeg}, EOG ${ch.eog ?? 'none'}, EMG ${ch.emg ?? 'none'}`);

  const wanted = [...new Set([ch.eeg, ch.eog, ch.emg].filter(Boolean))];
  const reduced = await extractChannels(currentFile, wanted);
  log(`Reduced EDF: ${(reduced.length / 1048576).toFixed(0)} MB`);
  await webR.FS.writeFile(EDF_PATH, reduced);

  const shelter = await new webR.Shelter();
  try {
    await rcall(shelter, 'hypnos_reset()');           // free the previous run's data
    await ensureModel(shelter);
    let out = null;
    for (const [i, [label, call]] of PIPELINE.entries()) {
      setStatus(`Step ${i + 2} of ${STEP_TOTAL}: ${label}`);
      setProgress((i + 1) / STEP_TOTAL);
      const t = performance.now();
      try {
        out = await rcall(shelter, call(ch));
      } catch (err) {
        throw new Error(`${label} failed: ${err?.message ?? err}`);
      }
      const secs = ((performance.now() - t) / 1000).toFixed(1);
      const detail = i < PIPELINE.length - 1 && out ? `${out} ` : '';
      log(`${label}: ${detail}[${secs} s]`);
    }
    last = JSON.parse(out);
    usedChannels = ch;
    await rcall(shelter, 'hypnos_trim()');            // keep only what a new window needs
  } finally {
    await shelter.purge();
    try { await webR.FS.unlink(EDF_PATH); } catch { /* already gone */ }
  }

  render(last);
  setStatus('Done', { working: false });
  setProgress(1);
}

// A new analysis window needs no new staging: recompute the markers from the stored stages
function applyWindow(previous) {
  return withBusy(async () => {
    setStatus('Recomputing the markers for the new window');
    setProgress(0.5);
    const shelter = await new webR.Shelter();
    try {
      last = JSON.parse(await rcall(shelter, `hypnos_metrics(${windowArgs()})`));
    } catch (err) {
      settings = previous;                              // keep the window that works
      throw new Error(`The window could not be applied: ${err?.message ?? err}`);
    } finally {
      await shelter.purge();
    }
    render(last, false);
    setStatus('Done', { working: false });
    setProgress(1);
  });
}

// What the Analysis settings pop-up chose: a channel change runs the analysis again,
// a window change only recomputes the markers
async function applySettings(next) {
  if (busy || !currentFile) return;
  const previous = settings;
  settings = { ...settings, ...next };
  const channelsChanged = ['eeg', 'eog', 'emg'].some((k) => previous[k] !== settings[k]);
  if (channelsChanged || !last) {
    await withBusy(runPipeline);
  } else {
    await applyWindow(previous);
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────
function windowHours(data) {
  const epochH = data.recording.epoch_s / 3600;
  return { start: (data.window.first - 1) * epochH, end: data.window.last * epochH };
}

function render(data, fresh = true) {
  // Metric cards
  const grid = $('#metrics-grid');
  grid.innerHTML = '';
  for (const [key, label, unit, icon, stage] of METRICS) {
    const value = data.metrics[key];
    if (value === null || value === undefined) continue;   // e.g. coarse-only metrics
    const card = document.createElement('div');
    card.className = 'marker';
    const tint = stage ? ` style="color:var(${STAGE_VAR[stage]})"` : '';
    card.innerHTML =
      `<p class="marker-label"><i class="bi ${icon}"${tint}></i>${label}</p>` +
      `<p class="marker-value">${fmt(value)}<span class="marker-unit">${unit}</span></p>`;
    grid.appendChild(card);
  }

  // Which window and channel the numbers describe
  const win = windowHours(data);
  const totalH = data.recording.n_epochs * (data.recording.epoch_s / 3600);
  const outside = totalH - (win.end - win.start);
  const noSignal = data.no_signal_min ?? 0;
  $('#window-note').textContent =
    `${usedChannels?.eeg ? `Staged on ${usedChannels.eeg}. ` : ''}` +
    `Analysis window ${win.start.toFixed(2)} to ${win.end.toFixed(2)} h ` +
    `(${data.window.manual ? 'set manually' : 'automatic'}).` +
    (outside > 0.005 ? ` ${outside.toFixed(2)} h outside it are left out.` : '') +
    (noSignal > 0 ? ` ${Math.round(noSignal)} min inside it have no valid EEG and are not staged.` : '');

  // Stage composition, over the analysis window
  const total = STAGES.reduce((s, k) => s + (data.stage_min[k] ?? 0), 0) + noSignal;
  const bar = $('#stagebar');
  const legend = $('#stage-legend');
  bar.innerHTML = '';
  legend.innerHTML = '';
  const addSegment = (color, mins, name) => {
    const seg = document.createElement('span');
    seg.style.width = `${total ? (mins / total) * 100 : 0}%`;
    seg.style.background = color;
    seg.title = `${name}: ${fmt(mins)} min`;
    bar.appendChild(seg);

    const item = document.createElement('span');
    item.innerHTML = `<i style="background:${color}"></i>${name} ${fmt(mins)} min`;
    legend.appendChild(item);
  };
  for (const s of ['W', 'N1', 'N2', 'N3', 'REM']) {
    addSegment(`var(${STAGE_VAR[s]})`, data.stage_min[s] ?? 0, STAGE_NAME[s]);
  }
  if (noSignal > 0) addSegment('var(--st-none)', noSignal, 'No valid EEG');

  results.hidden = false;
  $('#markers-card').hidden = false;
  drawPlots(data, fresh).catch((err) => log(`Plot failed: ${err?.message ?? err}`, 'err'));
}

// ── Plots (Plotly) ────────────────────────────────────────────────────────
// Shade what lies outside the analysis window
function windowShapes(data) {
  const win = windowHours(data);
  const total = data.stages.length * (data.recording.epoch_s / 3600);
  const base = { type: 'rect', xref: 'x', yref: 'paper', y0: 0, y1: 1, layer: 'above',
                 fillcolor: 'rgba(120,120,120,0.3)', line: { width: 0 } };
  const shapes = [];
  if (win.start > 0) shapes.push({ ...base, x0: 0, x1: win.start });
  if (win.end < total) shapes.push({ ...base, x0: win.end, x1: total });
  return shapes;
}

function baseLayout(total, data) {
  const soft = cssVar('--plot-text');           // a plain rgba value: Plotly cannot parse color-mix()
  const rule = cssVar('--rule');
  return {
    height: PLOT_H,
    margin: PLOT_MARGIN,
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'Alice, serif', size: 11, color: soft },
    dragmode: 'zoom',
    uirevision: 'keep',                        // keeps the user's zoom when only the theme redraws
    modebar: { bgcolor: 'rgba(0,0,0,0)', color: soft, activecolor: cssVar('--accent') },
    hoverlabel: {
      bgcolor: cssVar('--bg'),
      bordercolor: rule,
      font: { family: 'Alice, serif', size: 11, color: cssVar('--fg') },
    },
    shapes: windowShapes(data),
    xaxis: { range: [0, total], ticksuffix: ' h', gridcolor: rule, zeroline: false },
  };
}

function drawHypnogram(data) {
  const epochS = data.recording.epoch_s;
  const epochH = epochS / 3600;
  const n = data.stages.length;
  const level = Object.fromEntries(STAGES.map((s, i) => [s, i]));
  const rule = cssVar('--rule');

  // Thin stepped line joining the stages (gaps where an epoch is unstaged) ...
  const sx = [];
  const sy = [];
  data.stages.forEach((s, i) => { sx.push(i * epochH); sy.push(s ? level[s] : null); });
  const traces = [{
    x: sx, y: sy, mode: 'lines', connectgaps: false, hoverinfo: 'skip', showlegend: false,
    line: { shape: 'hv', width: 1, color: cssVar('--plot-text') },
  }];

  // ... then one thick, coloured trace per stage, made of runs of identical stage
  const runs = Object.fromEntries(STAGES.map((s) => [s, { x: [], y: [], d: [] }]));
  for (let i = 0; i < n;) {
    const s = data.stages[i];
    let j = i;
    while (j + 1 < n && data.stages[j + 1] === s) j++;
    if (s) {
      const a = i * epochH;
      const b = (j + 1) * epochH;
      const mins = ((j + 1 - i) * epochS) / 60;
      runs[s].x.push(a, (a + b) / 2, b, null);      // midpoint gives a hover target
      runs[s].y.push(level[s], level[s], level[s], null);
      runs[s].d.push(mins, mins, mins, null);
    }
    i = j + 1;
  }
  for (const s of STAGES) {
    traces.push({
      x: runs[s].x, y: runs[s].y, customdata: runs[s].d,
      mode: 'lines', connectgaps: false, showlegend: false, name: STAGE_NAME[s],
      line: { width: 5, color: cssVar(STAGE_VAR[s]) },
      hovertemplate: `${STAGE_NAME[s]}, %{customdata:.0f} min<br>%{x:.2f} h<extra></extra>`,
    });
  }

  const layout = baseLayout(n * epochH, data);
  layout.yaxis = {
    tickmode: 'array',
    tickvals: STAGES.map((_, i) => i),
    ticktext: STAGES.map((s) => STAGE_NAME[s]),
    range: [STAGES.length - 0.5, -0.5],           // Wake at the top
    fixedrange: true,
    gridcolor: rule,
    zeroline: false,
  };
  return window.Plotly.react('hypnogram', traces, layout, PLOT_CONFIG);
}

function drawSpectrogram(data) {
  const card = $('#spec-card');
  const sp = data.spectrogram;
  const vals = sp?.power?.length ? sp.power.flat().filter(Number.isFinite).sort((a, b) => a - b) : [];
  if (!vals.length) {
    card.hidden = true;
    return Promise.resolve();
  }
  card.hidden = false;

  const n = sp.power.length;
  const F = sp.freqs.length;
  const epochH = data.recording.epoch_s / 3600;

  // Robust colour limits (2nd to 98th percentile of the epochs that have a signal)
  const zmin = vals[Math.floor(vals.length * 0.02)];
  const zmax = vals[Math.floor(vals.length * 0.98)];

  // Plotly wants z[row = frequency][column = epoch]; x holds epoch centres
  const z = Array.from({ length: F }, (_, j) => sp.power.map((row) => row[j]));
  const x = Array.from({ length: n }, (_, i) => (i + 0.5) * epochH);

  const soft = cssVar('--plot-text');
  const trace = {
    type: 'heatmap', x, y: sp.freqs, z, zmin, zmax,
    colorscale: SPEC_COLORSCALE, zsmooth: false,
    hovertemplate: 'Time %{x:.2f} h<br>%{y:.1f} Hz<br>%{z:.1f} dB<extra></extra>',
    colorbar: {
      thickness: 10, len: 0.95, outlinewidth: 0, xpad: 6,
      title: { text: 'dB', side: 'top' },
      tickfont: { size: 10, color: soft },
    },
  };

  const layout = baseLayout(n * epochH, data);
  layout.yaxis = {
    range: [sp.freqs[0], sp.freqs[F - 1]],
    ticksuffix: ' Hz',
    gridcolor: cssVar('--rule'),
    zeroline: false,
  };

  $('#spec-note').textContent =
    `${sp.channel}, power spectral density per epoch in dB. Colour range is the 2nd to 98th ` +
    `percentile (${zmin.toFixed(0)} to ${zmax.toFixed(0)} dB). Blank epochs have no valid EEG signal.`;
  return window.Plotly.react('spectrogram', [trace], layout, PLOT_CONFIG);
}

// Zooming or panning one plot's time axis moves the other's, so they stay aligned
function linkTimeZoom(ids, total) {
  const divs = ids.map((id) => document.getElementById(id)).filter((d) => d && d.on);
  if (divs.length < 2) return;
  let lock = false;
  for (const src of divs) {
    if (src._hypnosLinked) continue;
    src._hypnosLinked = true;
    src.on('plotly_relayout', (ev) => {
      if (lock) return;
      let update;
      if (ev['xaxis.range[0]'] !== undefined) {
        update = { 'xaxis.range': [ev['xaxis.range[0]'], ev['xaxis.range[1]']] };
      } else if (ev['xaxis.range'] !== undefined) {
        update = { 'xaxis.range': ev['xaxis.range'] };
      } else if (ev['xaxis.autorange']) {
        update = { 'xaxis.range': [0, total] };     // double-click reset
      } else {
        return;
      }
      lock = true;
      Promise.all(divs.filter((d) => d !== src).map((d) => window.Plotly.relayout(d, update)))
        .finally(() => { lock = false; });
    });
  }
}

async function drawPlots(data, fresh) {
  if (!window.Plotly) {
    log('Plotly did not load, so the plots are unavailable.', 'err');
    return;
  }
  const ids = ['hypnogram', 'spectrogram'];
  if (fresh) {
    for (const id of ids) {
      window.Plotly.purge(id);             // new recording: drop old zoom and listeners
      document.getElementById(id)._hypnosLinked = false;
    }
  }
  await Promise.all([drawHypnogram(data), drawSpectrogram(data)]);
  linkTimeZoom(ids, data.stages.length * (data.recording.epoch_s / 3600));
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
  const win = windowHours(last);
  const row = {
    ...last.metrics,
    eeg_channel: usedChannels?.eeg ?? '',
    window_start_h: win.start.toFixed(4),
    window_end_h: win.end.toFixed(4),
  };
  const keys = Object.keys(row);
  download('hypnos_metrics.csv', `${keys.join(',')}\n${keys.map((k) => row[k] ?? '').join(',')}\n`);
});

$('#dl-hypnogram').addEventListener('click', () => {
  if (!last) return;
  const { epoch_s } = last.recording;
  const { first, last: lastEpoch } = last.window;
  const rows = last.stages.map((s, i) =>
    `${i + 1},${i * epoch_s},${s ?? ''},${last.signal?.[i] ?? ''},${i + 1 >= first && i + 1 <= lastEpoch}`);
  download('hypnos_hypnogram.csv', `epoch,onset_s,stage,signal,in_window\n${rows.join('\n')}\n`);
});

// Plotly resizes itself (responsive); only a theme change needs a redraw. The theme module
// calls this when the visitor uses the toggle or, before they have chosen, the system changes.
initTheme(() => {
  if (last && !results.hidden) {
    drawPlots(last, false).catch((err) => log(`Plot failed: ${err?.message ?? err}`, 'err'));
  }
});

// What the Analysis settings pop-up needs to know
initSettings({
  getContext: () => ({
    busy,
    fileName: currentFile?.name ?? null,
    info: fileInfo,
    settings: { ...settings },
    result: last
      ? { nEpochs: last.recording.n_epochs, epochS: last.recording.epoch_s, window: last.window }
      : null,
  }),
  apply: applySettings,
});

initWelcome();
