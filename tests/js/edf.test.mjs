// The page reduces a recording to the channels it needs before R sees it. That step must not
// change the data: these tests check the reduced file sample by sample, and that R's own EDF
// reader (edfReader, the one mrpheus uses) reads it back as the same numbers.
// Run with: node --test tests/js/edf.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractChannels } from '../../edf.js';
import { buildEdf, readEdf, noise } from '../helpers/edf.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const asFile = (bytes) => new File([bytes], 'test.edf');

// A recording with distinct, recognisable samples in every channel
function recording(extra = {}) {
  return buildEdf({
    seconds: 60,
    signals: [
      { label: 'F3:A2', rate: 128, samples: noise(1, 900) },
      { label: 'C4:A1', rate: 128, samples: noise(2, 900) },
      { label: 'SpO2', rate: 1, samples: (i) => 950 + (i % 7) },          // 1 Hz
      { label: 'EOG1', rate: 64, samples: noise(3, 500) },               // different rate
      { label: 'EMG', rate: 128, samples: noise(4, 300) },
    ],
    ...extra,
  });
}

test('the reduced file holds exactly the chosen samples, in the order they were asked for', async () => {
  const src = recording();
  const original = readEdf(src);
  const reduced = readEdf(await extractChannels(asFile(src), ['C4:A1', 'EOG1', 'EMG']));

  assert.deepEqual(reduced.labels, ['C4:A1', 'EOG1', 'EMG']);
  assert.deepEqual(reduced.signals[0], original.signals[original.labels.indexOf('C4:A1')]);
  assert.deepEqual(reduced.signals[1], original.signals[original.labels.indexOf('EOG1')]);
  assert.deepEqual(reduced.signals[2], original.signals[original.labels.indexOf('EMG')]);

  const reordered = readEdf(await extractChannels(asFile(src), ['EMG', 'C4:A1']));
  assert.deepEqual(reordered.labels, ['EMG', 'C4:A1']);
  assert.deepEqual(reordered.signals[1], original.signals[original.labels.indexOf('C4:A1')]);
});

test('each channel keeps its own sampling rate, and the other header fields carry over', async () => {
  const src = recording();
  const original = readEdf(src);
  const reduced = readEdf(await extractChannels(asFile(src), ['C4:A1', 'EOG1']));

  assert.deepEqual(reduced.rates, [128, 64]);
  assert.equal(reduced.nRecords, original.nRecords);
  assert.equal(reduced.recordSeconds, original.recordSeconds);
  assert.deepEqual(reduced.physMin, [-3276.8, -3276.8]);
  assert.deepEqual(reduced.physMax, [3276.7, 3276.7]);
  assert.deepEqual(reduced.digMin, [-32768, -32768]);
  assert.deepEqual(reduced.digMax, [32767, 32767]);
  assert.deepEqual(reduced.dimension, ['uV', 'uV']);
});

test('the result is a self-consistent plain EDF with no bytes left over', async () => {
  const out = await extractChannels(asFile(recording()), ['C4:A1', 'EOG1', 'EMG']);
  const r = readEdf(out);
  assert.equal(r.version, '0');
  assert.equal(r.reserved, '', 'a plain EDF, not EDF+');
  assert.equal(r.ns, 3);
  assert.equal(r.headerBytes, 256 + 3 * 256);
  assert.equal(r.bytesUsed, out.length);
  assert.equal(out.length, r.headerBytes + r.nRecords * (128 + 64 + 128) * 2);
});

test('slicing the file in small pieces gives the same bytes as one piece', async () => {
  const src = recording();
  const whole = await extractChannels(asFile(src), ['C4:A1', 'EOG1', 'EMG']);
  const sliced = await extractChannels(asFile(src), ['C4:A1', 'EOG1', 'EMG'], { chunkBytes: 1000 });
  assert.deepEqual(sliced, whole);
});

test('progress is reported after each slice and finishes at 1', async () => {
  const seen = [];
  await extractChannels(asFile(recording()), ['C4:A1'], { chunkBytes: 2000, onProgress: (f) => seen.push(f) });
  assert.ok(seen.length > 3, 'several slices');
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'never goes backwards');
  assert.equal(seen.at(-1), 1);
  assert.ok(seen.every((f) => f > 0 && f <= 1));
});

test('an EDF+ file is rewritten as a plain EDF without its annotations channel', async () => {
  const src = recording({ edfPlus: true });
  const original = readEdf(src);
  assert.equal(original.labels.at(-1), 'EDF Annotations');
  assert.equal(original.reserved, 'EDF+C');

  const reduced = readEdf(await extractChannels(asFile(src), ['C4:A1', 'EDF Annotations']));
  // asking for the annotations channel keeps it as a signal; asking only for EEG does not carry it over
  assert.deepEqual(reduced.labels, ['C4:A1', 'EDF Annotations']);
  const eegOnly = readEdf(await extractChannels(asFile(src), ['C4:A1']));
  assert.deepEqual(eegOnly.labels, ['C4:A1']);
  assert.equal(eegOnly.reserved, '');
});

test('records longer than a second are handled', async () => {
  const src = buildEdf({ seconds: 60, recordSeconds: 4, signals: [
    { label: 'C3:A2', rate: 100, samples: noise(5, 800) },
    { label: 'EOG1', rate: 50, samples: noise(6, 800) },
  ] });
  const original = readEdf(src);
  const reduced = readEdf(await extractChannels(asFile(src), ['EOG1']));
  assert.equal(reduced.recordSeconds, 4);
  assert.deepEqual(reduced.signals[0], original.signals[1]);
});

test('an unknown record count (-1) is worked out from the file size', async () => {
  const src = recording({ recordsField: -1 });
  const reduced = readEdf(await extractChannels(asFile(src), ['C4:A1']));
  assert.equal(reduced.nRecords, 60);
  assert.deepEqual(reduced.signals[0], readEdf(recording()).signals[1]);
});

test('a truncated file keeps only the records that are all there', async () => {
  const src = recording();
  const recBytes = (128 + 128 + 1 + 64 + 128) * 2;
  const cut = src.slice(0, 256 + 5 * 256 + 10 * recBytes + 100);           // 10 whole records and a bit
  const reduced = readEdf(await extractChannels(asFile(cut), ['C4:A1']));
  assert.equal(reduced.nRecords, 10);
  assert.deepEqual(reduced.signals[0], readEdf(src).signals[1].slice(0, 10 * 128));
});

test('channels that are not in the file are skipped, and asking for none of them is an error', async () => {
  const src = recording();
  assert.deepEqual(readEdf(await extractChannels(asFile(src), ['C4:A1', 'NOPE'])).labels, ['C4:A1']);
  await assert.rejects(extractChannels(asFile(src), ['NOPE']), /None of the requested channels/);
});

test('a result that would be too large for the browser is refused, not attempted', async () => {
  await assert.rejects(extractChannels(asFile(recording()), ['C4:A1', 'EMG'], { maxBytes: 1000 }), /too large for the browser/);
});

// ── The same file, read by R ──────────────────────────────────────────────

function rscript(args) {
  return spawnSync('Rscript', args, { encoding: 'utf8', timeout: 60000 });
}
const hasEdfReader = (() => {
  const r = rscript(['-e', 'quit(status = !requireNamespace("edfReader", quietly = TRUE))']);
  return r.status === 0;
})();

test('R (edfReader) reads the reduced file as the original numbers', { skip: !hasEdfReader && 'Rscript with edfReader is not available' }, async () => {
  const src = recording();
  const original = readEdf(src);
  const dir = mkdtempSync(join(tmpdir(), 'hypnos-edf-'));
  try {
    const wanted = ['C4:A1', 'EOG1', 'EMG'];
    writeFileSync(join(dir, 'reduced.edf'), await extractChannels(asFile(src), wanted));
    const run = rscript([join(here, '..', 'helpers', 'read_edf_lines.R'), join(dir, 'reduced.edf')]);
    assert.equal(run.status, 0, run.stderr);

    const lines = run.stdout.trim().split('\n');
    assert.equal(lines.length, wanted.length);
    lines.forEach((line, k) => {
      const [label, ...values] = line.split(',');
      assert.equal(label, wanted[k]);
      const expected = original.signals[original.labels.indexOf(label)];
      assert.equal(values.length, expected.length, `${label}: number of samples`);
      for (let i = 0; i < expected.length; i++) {
        // edfReader returns physical units: digital * 0.1 here
        assert.ok(Math.abs(parseFloat(values[i]) - expected[i] * 0.1) < 1e-9, `${label}[${i}]`);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R reads a reduced file with a single channel too', { skip: !hasEdfReader && 'Rscript with edfReader is not available' }, async () => {
  const src = recording();
  const dir = mkdtempSync(join(tmpdir(), 'hypnos-edf-'));
  try {
    writeFileSync(join(dir, 'one.edf'), await extractChannels(asFile(src), ['C4:A1']));
    const run = rscript([join(here, '..', 'helpers', 'read_edf_lines.R'), join(dir, 'one.edf')]);
    assert.equal(run.status, 0, run.stderr);
    const [label, ...values] = run.stdout.trim().split(',');
    assert.equal(label, 'C4:A1');
    assert.equal(values.length, 60 * 128);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
