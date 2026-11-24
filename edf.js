// Reduce an EDF to the channels the analysis needs. The source file is read in slices, so the
// recording is never held in memory, and the result is a plain EDF (no annotations channel)
// holding only the wanted signals, in the order they are listed. In its own module so that
// it can be tested without a page.

const ASCII = new TextDecoder('ascii');
const num = (bytes) => parseInt(ASCII.decode(bytes), 10);

// Write `str` into buf at off, padded with spaces to len
function put(buf, off, str, len) {
  for (let i = 0; i < len; i++) buf[off + i] = i < str.length ? str.charCodeAt(i) : 32;
}

/**
 * @param {Blob} file          the EDF
 * @param {string[]} wanted    signal labels to keep
 * @param {object} [options]
 * @param {(fraction: number) => void} [options.onProgress]  called after each slice, 0 to 1
 * @param {number} [options.chunkBytes]  size of each slice read from the file
 * @param {number} [options.maxBytes]    largest reduced file allowed
 * @returns {Promise<Uint8Array>}
 */
export async function extractChannels(file, wanted, options = {}) {
  const { onProgress = () => {}, chunkBytes = 32 * 1048576, maxBytes = 900 * 1048576 } = options;

  const head = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const ns = num(head.slice(252, 256));
  const sigHdr = new Uint8Array(await file.slice(256, 256 + ns * 256).arrayBuffer());

  // Per-signal header fields: label, transducer, physical dim, phys min/max,
  // digital min/max, prefilter, samples per record, reserved.
  const W = [16, 80, 8, 8, 8, 8, 8, 80, 8, 32];
  const start = [];
  for (let f = 0, acc = 0; f < W.length; f++) { start.push(acc); acc += W[f] * ns; }
  const field = (f, i) => sigHdr.subarray(start[f] + i * W[f], start[f] + (i + 1) * W[f]);

  const labels = Array.from({ length: ns }, (_, i) => ASCII.decode(field(0, i)).trim());
  const rec = Array.from({ length: ns }, (_, i) => num(field(8, i)) * 2);   // bytes per record
  const recOff = [];
  let recBytes = 0;
  for (const b of rec) { recOff.push(recBytes); recBytes += b; }

  const idx = wanted.map((l) => labels.indexOf(l)).filter((i) => i >= 0);
  const k = idx.length;
  if (k === 0) throw new Error('None of the requested channels are in this file.');

  const hdrBytes = 256 + ns * 256;
  let nRec = num(head.slice(236, 244));
  const fits = Math.floor((file.size - hdrBytes) / recBytes);
  if (!(nRec > 0) || nRec > fits) nRec = fits;      // an unknown or overstated record count

  const newHdrBytes = 256 + k * 256;
  const newRecBytes = idx.reduce((s, i) => s + rec[i], 0);
  const outSize = newHdrBytes + nRec * newRecBytes;
  if (outSize > maxBytes) {
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
  const perChunk = Math.max(1, Math.floor(chunkBytes / recBytes));
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
    onProgress((r0 + n) / nRec);
  }
  return out;
}
