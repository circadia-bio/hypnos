// Which channels does the page choose by default, and does a header read back correctly?
// Run with: node --test tests/js/channels.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readHeaderInfo, autoPick, resolveChannels, isAnnotation } from '../../channels.js';
import { buildEdf } from '../helpers/edf.mjs';

const asFile = (bytes) => new File([bytes], 'test.edf');
const flat = () => 0;

// ── Header ────────────────────────────────────────────────────────────────

test('readHeaderInfo returns every label with its sampling rate', async () => {
  const bytes = buildEdf({
    seconds: 10,
    signals: [
      { label: 'C4:A1', rate: 256, samples: flat },
      { label: 'EOG1', rate: 128, samples: flat },
      { label: 'SpO2', rate: 1, samples: flat },
    ],
  });
  const info = await readHeaderInfo(asFile(bytes));
  assert.equal(info.ns, 3);
  assert.deepEqual(info.labels, ['C4:A1', 'EOG1', 'SpO2']);
  assert.deepEqual(info.rates, [256, 128, 1]);
});

test('sampling rates are per second even when a record is longer than a second', async () => {
  const bytes = buildEdf({ seconds: 20, recordSeconds: 2, signals: [{ label: 'C3:A2', rate: 100, samples: flat }] });
  const info = await readHeaderInfo(asFile(bytes));
  assert.deepEqual(info.rates, [100]);
});

test('an EDF+ annotations channel is listed, and recognised as one', async () => {
  const bytes = buildEdf({ seconds: 5, edfPlus: true, signals: [{ label: 'C4:A1', rate: 64, samples: flat }] });
  const info = await readHeaderInfo(asFile(bytes));
  assert.deepEqual(info.labels, ['C4:A1', 'EDF Annotations']);
  assert.equal(isAnnotation('EDF Annotations'), true);
  assert.equal(isAnnotation('C4:A1'), false);
  assert.deepEqual(autoPick(info.labels), { eeg: 'C4:A1', eog: null, emg: null });
});

test('something that is not an EDF is refused with a clear message', async () => {
  await assert.rejects(
    readHeaderInfo(new File([new Uint8Array(600)], 'junk.bin')),
    /does not look like an EDF/,
  );
  await assert.rejects(readHeaderInfo(new File([new Uint8Array(10)], 'tiny.bin')), /does not look like an EDF/);
});

// ── Default channels ──────────────────────────────────────────────────────

const cases = [
  // [description, labels, expected]
  ['prefers C4 over earlier frontal channels (the DLBP33N3 layout)',
    ['F3:A2', 'F4:A1', 'C3:A2', 'C4:A1', 'O1:A2', 'EOG1', 'EOG2', 'EMG', 'ECG 2', 'SpO2'],
    { eeg: 'C4:A1', eog: 'EOG1', emg: 'EMG' }],
  ['falls back to C3 when there is no C4', ['F3-M2', 'C3-M2', 'O1-M2', 'EOG-L', 'Chin EMG'],
    { eeg: 'C3-M2', eog: 'EOG-L', emg: 'Chin EMG' }],
  ['falls back to Cz after C3 and C4', ['Fp1', 'Cz', 'Pz'], { eeg: 'Cz', eog: null, emg: null }],
  ['takes the first EEG-like label when no central channel exists', ['F3-M2', 'F4-M1', 'EOG-L', 'Chin EMG'],
    { eeg: 'F3-M2', eog: 'EOG-L', emg: 'Chin EMG' }],
  ['Sleep-EDF labels', ['EEG Fpz-Cz', 'EEG Pz-Oz', 'EOG horizontal', 'EMG submental', 'Resp oro-nasal'],
    { eeg: 'EEG Fpz-Cz', eog: 'EOG horizontal', emg: 'EMG submental' }],
  ['never takes oximetry for EEG, even listed first (SpO2 contains O2)', ['SpO2', 'EEG Fpz-Cz', 'EOG horizontal', 'EMG submental'],
    { eeg: 'EEG Fpz-Cz', eog: 'EOG horizontal', emg: 'EMG submental' }],
  ['an oximetry channel alone is not EEG', ['SpO2', 'SaO2', 'Pleth'], { eeg: null, emg: null, eog: null }],
  ['O2 as an EEG site is still EEG', ['O2:A1', 'SpO2'], { eeg: 'O2:A1', eog: null, emg: null }],
  ['FC4 and C45 are not C4', ['FC4', 'C45', 'Fp1'], { eeg: null, eog: null, emg: null }],
  ['matching ignores case', ['eeg c4-a1', 'eog left'], { eeg: 'eeg c4-a1', eog: null, emg: null }],
  ['no EEG at all', ['ECG', 'Flow', 'Thorax'], { eeg: null, eog: null, emg: null }],
  ['EOG and EMG are not mistaken for the EEG channel', ['EOG1', 'EMG', 'C3:A2'],
    { eeg: 'C3:A2', eog: 'EOG1', emg: 'EMG' }],
];
for (const [what, labels, expected] of cases) {
  test(`autoPick: ${what}`, () => {
    assert.deepEqual(autoPick(labels), expected);
  });
}

test('autoPick ignores the annotations channel', () => {
  assert.deepEqual(autoPick(['EDF Annotations', 'C4:A1']), { eeg: 'C4:A1', eog: null, emg: null });
});

test('the default never picks one label for two roles', () => {
  for (const [, labels] of cases) {
    const a = autoPick(labels);
    const chosen = Object.values(a).filter(Boolean);
    assert.equal(new Set(chosen).size, chosen.length, `duplicate in ${JSON.stringify(a)}`);
  }
});

// ── The user's choice ─────────────────────────────────────────────────────

const info = { labels: ['F3:A2', 'C3:A2', 'C4:A1', 'EOG1', 'EMG'], rates: [256, 256, 256, 256, 256] };

test('resolveChannels: automatic means the default', () => {
  assert.deepEqual(resolveChannels(info, { eeg: 'auto', eog: 'auto', emg: 'auto' }),
    { eeg: 'C4:A1', eog: 'EOG1', emg: 'EMG' });
});

test('resolveChannels: an explicit channel wins, and none leaves EOG or EMG out', () => {
  assert.deepEqual(resolveChannels(info, { eeg: 'F3:A2', eog: 'none', emg: 'auto' }),
    { eeg: 'F3:A2', eog: null, emg: 'EMG' });
});

test('resolveChannels: a label that is not in this file falls back to the default', () => {
  assert.deepEqual(resolveChannels(info, { eeg: 'GONE', eog: 'GONE', emg: 'GONE' }),
    { eeg: 'C4:A1', eog: 'EOG1', emg: 'EMG' });
});

test("resolveChannels: 'none' for EEG gives no EEG (the pop-up does not offer it; a run then stops with a message)", () => {
  assert.equal(resolveChannels(info, { eeg: 'none', eog: 'auto', emg: 'auto' }).eeg, null);
});
