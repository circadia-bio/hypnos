// Channel handling for hypnos: read the labels and sample rates from an EDF header, and
// choose default EEG, EOG and EMG channels. Pure functions, no DOM, so they can be tested
// outside the browser. Reads only the header (a few KB), never the recording.

export const isAnnotation = (label) => /annotations/i.test(label);

// Labels that are oximetry, not EEG, although they contain EEG-like letters ("SpO2" has "O2").
const NOT_EEG = /spo2|sao2|oxim|pleth|\bsat\b/i;

// Is `t` a whole token in the label? "C4:A1" and "EEG C4-A1" have C4; "FC4" and "C45" do not.
const hasToken = (label, t) => new RegExp(`(^|[^A-Za-z0-9])${t}([^A-Za-z0-9]|$)`, 'i').test(label);

const CENTRAL = ['C4', 'C3', 'Cz'];                              // YASA was trained on central derivations
const OTHER_EEG = ['F4', 'F3', 'Fz', 'O2', 'O1', 'Fpz', 'Pz'];

export async function readHeaderInfo(file) {
  const dec = new TextDecoder('ascii');
  const head = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const ns = parseInt(dec.decode(head.slice(252, 256)), 10);
  if (!(ns > 0)) throw new Error('This does not look like an EDF file: no signals were found in its header.');
  const recDur = parseFloat(dec.decode(head.slice(244, 252)));
  const sig = new Uint8Array(await file.slice(256, 256 + ns * 256).arrayBuffer());

  const labels = [];
  const rates = [];
  for (let i = 0; i < ns; i++) {
    labels.push(dec.decode(sig.slice(i * 16, (i + 1) * 16)).trim());
    // samples per record sit after the first eight per-signal fields: ns * 216 bytes in
    const perRecord = parseInt(dec.decode(sig.slice(ns * 216 + i * 8, ns * 216 + (i + 1) * 8)), 10);
    rates.push(recDur > 0 && perRecord > 0 ? perRecord / recDur : null);
  }
  return { ns, labels, rates };
}

// Default channels. EEG: a central derivation if there is one (C4, then C3, then Cz), otherwise
// the first label that looks like EEG, never an oximetry channel. EOG and EMG use the same
// patterns as mrpheus::prepare_psg(), first match in file order.
export function autoPick(labels) {
  const usable = labels.filter((l) => !isAnnotation(l) && !NOT_EEG.test(l));
  const eegLike = usable.filter(
    (l) => /EEG/i.test(l) || [...CENTRAL, ...OTHER_EEG].some((t) => hasToken(l, t))
  );

  let eeg = null;
  for (const t of CENTRAL) {
    eeg = eegLike.find((l) => hasToken(l, t));
    if (eeg) break;
  }
  eeg = eeg ?? eegLike[0] ?? null;

  const others = labels.filter((l) => !isAnnotation(l) && l !== eeg);
  const eog = others.find((l) => /EOG|ROC|LOC/.test(l)) ?? null;
  const emg = others.find((l) => l !== eog && /EMG|chin|Chin/.test(l)) ?? null;
  return { eeg, eog, emg };
}

// The channels to load: the user's choice where there is one, otherwise the default.
// A setting of 'auto' means the default; for EOG and EMG, 'none' means leave it out.
export function resolveChannels(info, settings) {
  const auto = autoPick(info.labels);
  const pick = (key) => {
    const v = settings[key];
    if (v === 'none') return null;
    if (v && v !== 'auto' && info.labels.includes(v)) return v;
    return auto[key];
  };
  return { eeg: pick('eeg'), eog: pick('eog'), emg: pick('emg') };
}
