import { maskFor } from "./mask";
import {
  FEATHER_PX,
  type LockerRejection,
  type RgbaImage,
  type SmileLandmarks,
} from "./types";

const HALO_GAP = 32;

function reject(code: LockerRejection["code"], message: string) {
  return { ok: false as const, rejection: { code, message } };
}

function maskAt(mask: Uint8Array, width: number, x: number, y: number): number {
  return mask[y * width + x] ?? 0;
}

function pixelIndex(width: number, x: number, y: number): number {
  return (y * width + x) * 4;
}

function largestChannelGap(data: Uint8Array, a: number, b: number): number {
  let gap = 0;
  for (let channel = 0; channel < 4; channel++) {
    const delta = Math.abs(data[a + channel]! - data[b + channel]!);
    if (delta > gap) gap = delta;
  }
  return gap;
}

function firstSolidIndex(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
): number | undefined {
  for (let step = 1; step <= FEATHER_PX + 1; step++) {
    const nx = x + dx * step;
    const ny = y + dy * step;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
    if (maskAt(mask, width, nx, ny) === 255) return pixelIndex(width, nx, ny);
  }
  return;
}

export function compositePlate(
  smile: RgbaImage,
  landmarks: SmileLandmarks,
  aligned: RgbaImage,
  plate: "gaze" | "blink" | "curious" | "pain" | "nausea",
):
  | { ok: true; image: RgbaImage }
  | { ok: false; rejection: LockerRejection } {
  if (aligned.width !== smile.width || aligned.height !== smile.height) {
    return reject(
      "alignment-failed",
      "Aligned plate size does not match the smile.",
    );
  }

  const width = smile.width;
  const height = smile.height;
  const mask = maskFor(plate, landmarks, width);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (maskAt(mask, width, x, y) !== 0) continue;
      const index = pixelIndex(width, x, y);
      for (let channel = 0; channel < 4; channel++) {
        if (smile.data[index + channel] !== aligned.data[index + channel]) {
          return reject(
            "outside-mask",
            "Aligned pixels outside the mask differ from the smile.",
          );
        }
      }
    }
  }

  const data = new Uint8Array(smile.data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const coverage = maskAt(mask, width, x, y);
      if (coverage === 0) continue;
      const index = pixelIndex(width, x, y);
      if (coverage === 255) {
        data[index] = aligned.data[index]!;
        data[index + 1] = aligned.data[index + 1]!;
        data[index + 2] = aligned.data[index + 2]!;
        data[index + 3] = aligned.data[index + 3]!;
        continue;
      }
      const alpha = coverage / 255;
      const inverse = 1 - alpha;
      for (let channel = 0; channel < 4; channel++) {
        data[index + channel] = Math.round(
          smile.data[index + channel]! * inverse +
            aligned.data[index + channel]! * alpha,
        );
      }
    }
  }

  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (maskAt(mask, width, x, y) !== 0) continue;
      const here = pixelIndex(width, x, y);
      for (const [dx, dy] of directions) {
        const there = firstSolidIndex(mask, width, height, x, y, dx, dy);
        if (there === undefined) continue;
        const smileGap = largestChannelGap(smile.data, here, there);
        const pastedGap = largestChannelGap(data, here, there);
        if (pastedGap > smileGap + HALO_GAP) {
          return reject(
            "halo",
            "Composite grew an edge along the mask boundary.",
          );
        }
      }
    }
  }

  return { ok: true, image: { width, height, data } };
}
