// Build and read plain EDF files in memory, for tests. Digital values are written as they are
// (16-bit little endian); the physical range is -3276.8 to 3276.7, so physical = digital * 0.1.

const FIELD_WIDTHS = [16, 80, 8, 8, 8, 8, 8, 80, 8, 32];

function put(buf, off, str, len) {
  for (let i = 0; i < len; i++) buf[off + i] = i < str.length ? str.charCodeAt(i) : 32;
}

/**
 * @param {object} spec
 * @param {{label: string, rate: number, samples: ArrayLike<number> | ((i: number) => number)}[]} spec.signals
 *        `samples` is an array of digital values, or a function of the sample index; its length is
 *        rate * seconds.
 * @param {number} spec.seconds         recording length (a whole number of records)
 * @param {number} [spec.recordSeconds] data record duration
 * @param {number|string} [spec.recordsField] what to write in the number-of-records field
 *        (default: the true count; use -1 to mimic a writer that did not know it)
 * @param {boolean} [spec.edfPlus]      write an "EDF Annotations" signal and an EDF+C header
 * @returns {Uint8Array}
 */
export function buildEdf({ signals, seconds, recordSeconds = 1, recordsField, edfPlus = false }) {
  const sigs = [...signals];
  if (edfPlus) sigs.push({ label: 'EDF Annotations', rate: 15, samples: () => 0 });
  const ns = sigs.length;
  const nRec = Math.floor(seconds / recordSeconds);
  const perRec = sigs.map((s) => Math.round(s.rate * recordSeconds));
  const recSamples = perRec.reduce((a, b) => a + b, 0);
  const headerBytes = 256 + ns * 256;
  const out = new Uint8Array(headerBytes + nRec * recSamples * 2);

  put(out, 0, '0', 8);
  put(out, 8, 'X X X X', 80);
  put(out, 88, 'Startdate 01-JAN-2024 X X X', 80);
  put(out, 168, '01.01.24', 8);
  put(out, 176, '22.00.00', 8);
  put(out, 184, String(headerBytes), 8);
  put(out, 192, edfPlus ? 'EDF+C' : '', 44);
  put(out, 236, String(recordsField ?? nRec), 8);
  put(out, 244, String(recordSeconds), 8);
  put(out, 252, String(ns), 4);

  const values = ['', '', '', '-3276.8', '3276.7', '-32768', '32767', '', null, ''];
  FIELD_WIDTHS.forEach((w, f) => {
    let acc = 256;
    for (let g = 0; g < f; g++) acc += FIELD_WIDTHS[g] * ns;
    sigs.forEach((s, i) => {
      const text =
        f === 0 ? s.label :
        f === 1 ? 'AgAgCl electrode' :
        f === 2 ? (s.label === 'SpO2' ? '%' : 'uV') :
        f === 8 ? String(perRec[i]) :
        values[f];
      put(out, acc + i * w, text, w);
    });
  });

  const view = new DataView(out.buffer);
  let pos = headerBytes;
  for (let r = 0; r < nRec; r++) {
    sigs.forEach((s, i) => {
      for (let k = 0; k < perRec[i]; k++) {
        const idx = r * perRec[i] + k;
        const v = typeof s.samples === 'function' ? s.samples(idx) : (s.samples[idx] ?? 0);
        view.setInt16(pos, v, true);
        pos += 2;
      }
    });
  }
  return out;
}

/** Parse an EDF written by buildEdf (or by extractChannels) back into plain values. */
export function readEdf(bytes) {
  const dec = new TextDecoder('ascii');
  const text = (off, len) => dec.decode(bytes.subarray(off, off + len)).trim();
  const ns = parseInt(text(252, 4), 10);
  const out = {
    version: text(0, 8),
    reserved: text(192, 44),
    headerBytes: parseInt(text(184, 8), 10),
    nRecords: parseInt(text(236, 8), 10),
    recordSeconds: parseFloat(text(244, 8)),
    ns,
    labels: [], perRecord: [], rates: [], physMin: [], physMax: [], digMin: [], digMax: [], dimension: [],
    signals: [],
  };
  const start = [];
  FIELD_WIDTHS.reduce((acc, w) => { start.push(acc); return acc + w * ns; }, 256);
  for (let i = 0; i < ns; i++) {
    out.labels.push(text(start[0] + i * 16, 16));
    out.dimension.push(text(start[2] + i * 8, 8));
    out.physMin.push(parseFloat(text(start[3] + i * 8, 8)));
    out.physMax.push(parseFloat(text(start[4] + i * 8, 8)));
    out.digMin.push(parseInt(text(start[5] + i * 8, 8), 10));
    out.digMax.push(parseInt(text(start[6] + i * 8, 8), 10));
    const spr = parseInt(text(start[8] + i * 8, 8), 10);
    out.perRecord.push(spr);
    out.rates.push(spr / out.recordSeconds);
    out.signals.push(new Int16Array(spr * out.nRecords));
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = out.headerBytes;
  for (let r = 0; r < out.nRecords; r++) {
    for (let i = 0; i < ns; i++) {
      for (let k = 0; k < out.perRecord[i]; k++) {
        out.signals[i][r * out.perRecord[i] + k] = view.getInt16(pos, true);
        pos += 2;
      }
    }
  }
  out.bytesUsed = pos;
  return out;
}

/** A deterministic pseudo-random integer in [-amp, amp], a pure function of the index and seed. */
export function noise(seed, amp) {
  return (i) => {
    let x = (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(seed + 1, 0x85ebca6b)) >>> 0;
    x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d) >>> 0;
    x ^= x >>> 12; x = Math.imul(x, 0x297a2d39) >>> 0;
    x ^= x >>> 15;
    return Math.round(((x >>> 0) / 0xffffffff * 2 - 1) * amp);
  };
}
