import { describe, expect, it } from "vitest";
import { maskFor } from "./mask";
import { compositePlate } from "./composite";
import type { RgbaImage, SmileLandmarks } from "./types";

const SIZE = 48;

type Rgba = [number, number, number, number];

function landmarks(): SmileLandmarks {
  const leftEye = { x: 16, y: 16, width: 8, height: 6 };
  const rightEye = { x: 30, y: 16, width: 8, height: 6 };
  const leftEyeCenter = { x: 20, y: 19 };
  const rightEyeCenter = { x: 34, y: 19 };
  return {
    leftEye,
    rightEye,
    leftEyeCenter,
    rightEyeCenter,
    betweenPupils: { x: 27, y: 19 },
    mouthCenter: { x: 27, y: 36 },
    noseBridge: { x: 27, y: 28 },
    leftPupil: leftEyeCenter,
    rightPupil: rightEyeCenter,
    leftOuterCorner: { x: 16, y: 19 },
    rightOuterCorner: { x: 38, y: 19 },
  };
}

function rgbaImage(width: number, height: number, pixel: Rgba): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = pixel[0];
    data[i + 1] = pixel[1];
    data[i + 2] = pixel[2];
    data[i + 3] = pixel[3];
  }
  return { width, height, data };
}

function writePixel(image: RgbaImage, x: number, y: number, pixel: Rgba) {
  const i = (y * image.width + x) * 4;
  image.data[i] = pixel[0];
  image.data[i + 1] = pixel[1];
  image.data[i + 2] = pixel[2];
  image.data[i + 3] = pixel[3];
}

function readPixel(image: RgbaImage, x: number, y: number): Rgba {
  const i = (y * image.width + x) * 4;
  return [
    image.data[i]!,
    image.data[i + 1]!,
    image.data[i + 2]!,
    image.data[i + 3]!,
  ];
}

function rejectionCode(result: {
  ok: boolean;
  rejection?: { code: string };
}): string | undefined {
  return result.ok ? undefined : result.rejection?.code;
}

function cloneImage(image: RgbaImage): RgbaImage {
  return {
    width: image.width,
    height: image.height,
    data: Uint8Array.from(image.data),
  };
}

function paintMaskValue(
  image: RgbaImage,
  mask: Uint8Array,
  value: number,
  pixel: Rgba,
) {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (mask[y * image.width + x] !== value) continue;
      writePixel(image, x, y, pixel);
    }
  }
}

describe("compositePlate", () => {
  const eyes = landmarks();

  it("returns outside-mask when a mask-0 pixel differs from the smile", () => {
    const smile = rgbaImage(SIZE, SIZE, [10, 20, 30, 255]);
    const aligned = rgbaImage(SIZE, SIZE, [10, 20, 30, 255]);
    expect(maskFor("gaze", eyes, SIZE)[0]).toBe(0);
    writePixel(aligned, 0, 0, [10, 20, 30, 254]);

    const result = compositePlate(smile, eyes, aligned, "gaze");

    expect(rejectionCode(result)).toBe("outside-mask");
  });

  it("keeps the smile pixel outside the mask and copies an opaque aligned pixel", () => {
    const smile = rgbaImage(SIZE, SIZE, [10, 20, 30, 255]);
    const aligned = rgbaImage(SIZE, SIZE, [10, 20, 30, 255]);
    const smileBefore = Uint8Array.from(smile.data);
    expect(maskFor("gaze", eyes, SIZE)[19 * SIZE + 20]).toBe(255);
    writePixel(aligned, 20, 19, [1, 2, 3, 4]);

    const result = compositePlate(smile, eyes, aligned, "gaze");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(SIZE);
    expect(result.image.height).toBe(SIZE);
    expect(readPixel(result.image, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(readPixel(result.image, 20, 19)).toEqual([1, 2, 3, 4]);
    expect(Array.from(smile.data)).toEqual(Array.from(smileBefore));
  });

  it("blends a feather pixel and does not reject it for differing from the smile", () => {
    const smile = rgbaImage(SIZE, SIZE, [0, 40, 40, 255]);
    const aligned = rgbaImage(SIZE, SIZE, [0, 40, 40, 255]);
    const mask = maskFor("gaze", eyes, SIZE);
    expect(mask[6 * SIZE + 7]).toBe(205);
    writePixel(aligned, 7, 6, [255, 40, 40, 0]);

    const result = compositePlate(smile, eyes, aligned, "gaze");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPixel(result.image, 7, 6)).toEqual([205, 40, 40, 50]);
  });

  it("pastes the curious mouth region and leaves a curious mask-0 pixel on the smile", () => {
    const smile = rgbaImage(SIZE, SIZE, [8, 8, 8, 255]);
    const aligned = rgbaImage(SIZE, SIZE, [8, 8, 8, 255]);
    const mask = maskFor("curious", eyes, SIZE);
    expect(mask[33 * SIZE + 0]).toBe(0);
    expect(mask[eyes.mouthCenter.y * SIZE + eyes.mouthCenter.x]).toBe(255);
    writePixel(aligned, eyes.mouthCenter.x, eyes.mouthCenter.y, [
      70, 80, 90, 255,
    ]);

    const result = compositePlate(smile, eyes, aligned, "curious");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPixel(result.image, 0, 33)).toEqual([8, 8, 8, 255]);
    expect(readPixel(result.image, eyes.mouthCenter.x, eyes.mouthCenter.y)).toEqual([
      70, 80, 90, 255,
    ]);
  });

  it("returns alignment-failed when the aligned plate size differs", () => {
    const smile = rgbaImage(SIZE, SIZE, [10, 20, 30, 255]);
    const wider = rgbaImage(SIZE + 1, SIZE, [0, 0, 0, 0]);
    const taller = rgbaImage(SIZE, SIZE + 1, [0, 0, 0, 0]);

    expect(rejectionCode(compositePlate(smile, eyes, wider, "gaze"))).toBe(
      "alignment-failed",
    );
    expect(rejectionCode(compositePlate(smile, eyes, taller, "pain"))).toBe(
      "alignment-failed",
    );
  });

  it("returns halo when the pasted gap exceeds the smile gap by more than 32", () => {
    const smile = rgbaImage(SIZE, SIZE, [0, 0, 0, 255]);
    const mask = maskFor("gaze", eyes, SIZE);
    expect(mask[38 * SIZE + 20]).toBe(0);
    expect(mask[37 * SIZE + 20]).not.toBe(255);
    expect(mask[29 * SIZE + 20]).toBe(255);
    paintMaskValue(smile, mask, 255, [40, 0, 0, 255]);
    const aligned = cloneImage(smile);
    paintMaskValue(aligned, mask, 255, [73, 0, 0, 255]);

    const result = compositePlate(smile, eyes, aligned, "gaze");

    expect(rejectionCode(result)).toBe("halo");
  });

  it("does not return halo when the pasted gap exceeds the smile gap by exactly 32", () => {
    const smile = rgbaImage(SIZE, SIZE, [0, 0, 0, 255]);
    const mask = maskFor("blink", eyes, SIZE);
    expect(mask[38 * SIZE + 20]).toBe(0);
    expect(mask[37 * SIZE + 20]).not.toBe(255);
    expect(mask[29 * SIZE + 20]).toBe(255);
    paintMaskValue(smile, mask, 255, [40, 0, 0, 255]);
    const aligned = cloneImage(smile);
    paintMaskValue(aligned, mask, 255, [72, 0, 0, 255]);

    const result = compositePlate(smile, eyes, aligned, "blink");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPixel(result.image, 20, 29)).toEqual([72, 0, 0, 255]);
    expect(readPixel(result.image, 20, 38)).toEqual([0, 0, 0, 255]);
  });

  it("uses the largest channel gap, so two channels of 32 do not sum into a halo", () => {
    const smile = rgbaImage(SIZE, SIZE, [0, 0, 0, 255]);
    const mask = maskFor("nausea", eyes, SIZE);
    expect(mask[37 * SIZE + 3]).toBe(0);
    expect(mask[37 * SIZE + 12]).toBe(255);
    const aligned = cloneImage(smile);
    paintMaskValue(aligned, mask, 255, [32, 32, 0, 255]);

    const result = compositePlate(smile, eyes, aligned, "nausea");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPixel(result.image, 12, 37)).toEqual([32, 32, 0, 255]);
    expect(readPixel(result.image, 3, 37)).toEqual([0, 0, 0, 255]);
  });

  it("returns outside-mask before halo when a mask-0 pixel differs", () => {
    const smile = rgbaImage(SIZE, SIZE, [10, 10, 10, 255]);
    const mask = maskFor("pain", eyes, SIZE);
    expect(mask[37 * SIZE + 3]).toBe(0);
    expect(mask[37 * SIZE + 12]).toBe(255);
    const aligned = cloneImage(smile);
    paintMaskValue(aligned, mask, 255, [255, 10, 10, 255]);
    writePixel(aligned, 3, 37, [0, 10, 10, 255]);

    const result = compositePlate(smile, eyes, aligned, "pain");

    expect(rejectionCode(result)).toBe("outside-mask");
  });
});
