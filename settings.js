// Analysis settings pop-up: choose the EEG, EOG and EMG channels and the analysis window.
// The app supplies the current state (getContext) and receives the user's choice (apply).

import { isAnnotation, autoPick, resolveChannels } from './channels.js';

const fmtRate = (r) => (Number.isInteger(r) ? String(r) : r.toFixed(1));
const hoursText = (h) => h.toFixed(2);

export function initSettings({ getContext, apply }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('settings-overlay');
  if (!overlay) return {};
  const selects = { eeg: $('set-eeg'), eog: $('set-eog'), emg: $('set-emg') };
  const radioAuto = $('set-win-auto');
  const radioCustom = $('set-win-custom');
  const startIn = $('set-start');
  const endIn = $('set-end');
  const msg = $('set-msg');
  const applyBtn = $('set-apply');

  let ctx = null;

  function addOption(select, value, text) {
    select.appendChild(Object.assign(document.createElement('option'), { value, textContent: text }));
  }

  function fillSelect(key, { allowNone }) {
    const select = selects[key];
    select.innerHTML = '';
    if (!ctx.info) {
      addOption(select, 'auto', 'Select a file first');
      select.disabled = true;
      return;
    }
    select.disabled = ctx.busy;
    const auto = autoPick(ctx.info.labels)[key];
    addOption(select, 'auto', auto ? `Automatic (${auto})` : 'Automatic (none found)');
    if (allowNone) addOption(select, 'none', 'None');
    ctx.info.labels.forEach((label, i) => {
      if (isAnnotation(label)) return;
      const rate = ctx.info.rates[i];
      addOption(select, label, rate ? `${label} (${fmtRate(rate)} Hz)` : label);
    });
    const want = ctx.settings[key];
    select.value = [...select.options].some((o) => o.value === want) ? want : 'auto';
  }

  function windowHours(w, epochS) {
    return { start: ((w.first - 1) * epochS) / 3600, end: (w.last * epochS) / 3600 };
  }

  function fillWindow() {
    const r = ctx.result;
    const have = !!r;
    radioAuto.disabled = radioCustom.disabled = !have || ctx.busy;
    if (!have) {
      radioAuto.checked = true;
      startIn.value = endIn.value = '';
      $('set-win-info').textContent = ctx.info
        ? 'The analysis window is set once the recording has been analysed.'
        : 'Select a file to analyse it first.';
      startIn.disabled = endIn.disabled = true;
      return;
    }
    const total = (r.nEpochs * r.epochS) / 3600;
    const auto = windowHours({ first: r.window.auto_first, last: r.window.auto_last }, r.epochS);
    const cur = windowHours(r.window, r.epochS);
    $('set-win-info').textContent =
      `Automatic window: ${hoursText(auto.start)} to ${hoursText(auto.end)} h of ${hoursText(total)} h. ` +
      'It runs from the first epoch with an EEG signal to the first hour without one.';
    const custom = ctx.settings.window === 'custom';
    radioCustom.checked = custom;
    radioAuto.checked = !custom;
    startIn.max = endIn.max = total.toFixed(2);
    startIn.value = (custom ? ctx.settings.startH : cur.start).toFixed(2);
    endIn.value = (custom ? ctx.settings.endH : cur.end).toFixed(2);
    startIn.disabled = endIn.disabled = !custom || ctx.busy;
  }

  // The value the user has chosen, or the reason it cannot be applied yet.
  function read() {
    const chosen = {
      eeg: selects.eeg.value, eog: selects.eog.value, emg: selects.emg.value,
      window: radioCustom.checked ? 'custom' : 'auto',
      startH: parseFloat(startIn.value), endH: parseFloat(endIn.value),
    };
    if (!ctx.info) return { error: 'Select a file first.' };
    if (ctx.busy) return { error: 'An analysis is running. Try again when it has finished.' };

    const eff = resolveChannels(ctx.info, chosen);
    if (!eff.eeg) return { error: 'No EEG channel was found. Choose one from the list.' };
    const names = [eff.eeg, eff.eog, eff.emg].filter(Boolean);
    if (new Set(names).size !== names.length) {
      return { error: 'Each of EEG, EOG and EMG needs a different channel.' };
    }

    if (chosen.window === 'custom' && ctx.result) {
      const total = (ctx.result.nEpochs * ctx.result.epochS) / 3600;
      const min = ctx.result.epochS / 3600;
      if (!Number.isFinite(chosen.startH) || !Number.isFinite(chosen.endH)) {
        return { error: 'Enter a start and an end time in hours.' };
      }
      if (chosen.startH < 0 || chosen.endH > total + 1e-9) {
        return { error: `The window must lie within 0 to ${hoursText(total)} h.` };
      }
      if (chosen.endH - chosen.startH < min) {
        return { error: 'The end of the window must be after its start.' };
      }
    }
    return { value: chosen };
  }

  function refresh() {
    const r = read();
    msg.textContent = r.error ?? '';
    applyBtn.disabled = !!r.error;
  }

  function open() {
    ctx = getContext();
    $('set-file').textContent = ctx.fileName ?? 'No file selected';
    fillSelect('eeg', { allowNone: false });
    fillSelect('eog', { allowNone: true });
    fillSelect('emg', { allowNone: true });
    fillWindow();
    refresh();
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('open'));
    (ctx.info ? selects.eeg : $('set-cancel')).focus();
  }

  function close() {
    overlay.classList.remove('open');
    setTimeout(() => { overlay.hidden = true; }, 250);
  }

  // Window inputs follow the radio buttons
  for (const r of [radioAuto, radioCustom]) {
    r.addEventListener('change', () => {
      startIn.disabled = endIn.disabled = !radioCustom.checked || !ctx.result || ctx.busy;
      refresh();
    });
  }
  for (const el of [...Object.values(selects), startIn, endIn]) {
    el.addEventListener('input', refresh);
    el.addEventListener('change', refresh);
  }
  // Editing a time implies the window is now custom
  for (const el of [startIn, endIn]) {
    el.addEventListener('input', () => { if (ctx.result && !radioCustom.checked) { radioCustom.checked = true; startIn.disabled = endIn.disabled = false; refresh(); } });
  }

  $('set-reset').addEventListener('click', () => {
    for (const s of Object.values(selects)) s.value = 'auto';
    radioAuto.checked = true;
    startIn.disabled = endIn.disabled = true;
    if (ctx.result) {
      const cur = windowHours({ first: ctx.result.window.auto_first, last: ctx.result.window.auto_last }, ctx.result.epochS);
      startIn.value = cur.start.toFixed(2);
      endIn.value = cur.end.toFixed(2);
    }
    refresh();
  });
  $('set-cancel').addEventListener('click', close);
  $('set-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (!overlay.hidden && e.key === 'Escape') close(); });

  applyBtn.addEventListener('click', () => {
    const r = read();
    if (r.error) { refresh(); return; }
    close();
    apply(r.value);
  });

  $('open-settings')?.addEventListener('click', open);
  return { open, close };
}
