// Confirms the on-phone mel spectrogram and the no-dropout network match classify.py.
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve("public/mosquito/model");
const refDir = path.resolve("tools/mosquito/phone-ref");

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const file = path.join(root, path.basename(String(input)));
  return new Response(readFileSync(file));
}) as typeof fetch;

async function main() {
const { nodropLogits, windowsOf } = await import("../src/lib/mosquito/phoneEar.ts");

const meta = JSON.parse(readFileSync(path.join(root, "meta.json"), "utf8"));
const mel = new Float32Array(readFileSync(path.join(root, "mel.bin")).buffer);

function pcm16(file: string) {
  const buf = readFileSync(file);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 12;
  let rate = 0;
  let dataStart = 0;
  let dataBytes = 0;
  while (offset + 8 <= buf.length) {
    const id = v.getUint32(offset, false);
    const size = v.getUint32(offset + 4, true);
    if (id === 0x666d7420) rate = v.getUint32(offset + 12, true);
    if (id === 0x64617461) {
      dataStart = offset + 8;
      dataBytes = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  const frames = dataBytes / 2;
  const y = new Float32Array(frames);
  for (let i = 0; i < frames; i++) y[i] = v.getInt16(dataStart + i * 2, true) / 32768;
  return { y, rate };
}

function maxDiff(a: Float32Array, b: Float32Array) {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return { d, lenA: a.length, lenB: b.length };
}

const clips = ["anopheles-arabiensis-ihi-tanzania", "culex-field-drc", "noise-bus-stop"];
let failed = false;
for (const name of clips) {
  const { y, rate } = pcm16(path.resolve(`tools/mosquito/samples/${name}.wav`));
  if (rate !== 8000) throw new Error(`${name} is ${rate} Hz`);
  const got = windowsOf(y, mel, meta);
  const want = new Float32Array(readFileSync(path.join(refDir, `${name}.x.bin`)).buffer);
  // Python X is (windows, 30, 128, 1); the extra 1 does not change the values.
  const feat = maxDiff(got, want);
  const ref = JSON.parse(readFileSync(path.join(refDir, `${name}.json`), "utf8"));
  const nWin = ref.xShape[0];
  const det = await nodropLogits("detect", got, nWin);
  const sp = await nodropLogits("species", got, nWin);
  const detWant = Float32Array.from(ref.detect.flat());
  const spWant = Float32Array.from(ref.species.flat());
  const dd = maxDiff(det, detWant);
  const sd = maxDiff(sp, spWant);
  const ok = feat.d < 1e-3 && feat.lenA === feat.lenB && dd.d < 1e-3 && sd.d < 1e-3;
  if (!ok) failed = true;
  console.log(
    `${name} features ${feat.d.toExponential(2)} (${feat.lenA} vs ${feat.lenB}) detect ${dd.d.toExponential(2)} species ${sd.d.toExponential(2)} ${ok ? "ok" : "MISMATCH"}`,
  );
}
if (failed) process.exit(1);
}

main();
