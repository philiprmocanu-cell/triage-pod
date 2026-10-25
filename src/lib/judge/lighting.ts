// Is the face evenly lit? A window on one side puts half the face in shadow, and a shadowed mouth
// corner reads as a "droop" to any picture model. Measured on the face close-up the pod already
// sends (a square crop around the face), as plain pixel brightness: nothing clever.

import sharp from "sharp";

export type Lighting = { left: number; right: number; asym: number }; // 0..255 means; asym = |L-R| / brighter side, 0..1

export const LIGHT_ASYM_MAX = 0.3; // beyond this the two halves differ too much to compare sides of the face

export async function faceLighting(faceB64: string): Promise<Lighting | null> {
  try {
    const { data } = await sharp(Buffer.from(faceB64, "base64")).resize(64, 64, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
    // Central band only (rows 16-48): the cheeks and mouth, not hair or background.
    const mean = (x0: number, x1: number) => {
      let s = 0, n = 0;
      for (let y = 16; y < 48; y++) for (let x = x0; x < x1; x++) { s += data[y * 64 + x]; n++; }
      return s / n;
    };
    const left = mean(10, 28), right = mean(36, 54);
    const hi = Math.max(left, right, 1);
    return { left: Math.round(left), right: Math.round(right), asym: Math.round((Math.abs(left - right) / hi) * 100) / 100 };
  } catch {
    return null;
  }
}
