import { describe, expect, it } from "vitest";
import { CANVAS_SIZE, FEATHER_PX } from "./types";
import { maskFor } from "./mask";
import type { Point, Rect, SmileLandmarks } from "./types";

const SIZE = 256;

function fixtureLandmarks(): SmileLandmarks {
  const leftEye = { x: 100, y: 100, width: 40, height: 20 };
  const rightEye = { x: 200, y: 100, width: 40, height: 20 };
  const leftEyeCenter = { x: 120, y: 110 };
  const rightEyeCenter = { x: 220, y: 110 };
  return {
    leftEye,
    rightEye,
    leftEyeCenter,
    rightEyeCenter,
    betweenPupils: { x: 170, y: 110 },
    mouthCenter: { x: 170, y: 180 },
    noseBridge: { x: 170, y: 140 },
    leftPupil: leftEyeCenter,
    rightPupil: rightEyeCenter,
    leftOuterCorner: { x: 100, y: 110 },
    rightOuterCorner: { x: 240, y: 110 },
  };
}

function at(
  mask: Uint8Array,
  size: number,
  x: number,
  y: number,
): number {
  return mask[y * size + x]!;
}

function solidBounds(mask: Uint8Array, size: number) {
  let minX = size;
  let minY = size;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (at(mask, size, x, y) !== 255) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function scaleLandmarks(
  landmarks: SmileLandmarks,
  factor: number,
): SmileLandmarks {
  const point = (p: Point): Point => ({ x: p.x * factor, y: p.y * factor });
  const rect = (r: Rect): Rect => ({
    x: r.x * factor,
    y: r.y * factor,
    width: r.width * factor,
    height: r.height * factor,
  });
  return {
    leftEye: rect(landmarks.leftEye),
    rightEye: rect(landmarks.rightEye),
    leftEyeCenter: point(landmarks.leftEyeCenter),
    rightEyeCenter: point(landmarks.rightEyeCenter),
    betweenPupils: point(landmarks.betweenPupils),
    mouthCenter: point(landmarks.mouthCenter),
    noseBridge: point(landmarks.noseBridge),
    leftPupil: point(landmarks.leftPupil),
    rightPupil: point(landmarks.rightPupil),
    leftOuterCorner: point(landmarks.leftOuterCorner),
    rightOuterCorner: point(landmarks.rightOuterCorner),
  };
}

function widestSolidLeft(mask: Uint8Array, size: number) {
  let bestWidth = -1;
  let x = 0;
  let y = 0;
  for (let row = 0; row < size; row++) {
    let minX = -1;
    let maxX = -1;
    for (let col = 0; col < size; col++) {
      if (at(mask, size, col, row) !== 255) continue;
      if (minX < 0) minX = col;
      maxX = col;
    }
    const width = maxX - minX;
    if (width <= bestWidth) continue;
    bestWidth = width;
    x = minX;
    y = row;
  }
  return { x, y };
}

describe("maskFor", () => {
  const landmarks = fixtureLandmarks();

  it("gaze: pixel in the middle of the left eye rect is 255", () => {
    const mask = maskFor("gaze", landmarks, SIZE);
    expect(at(mask, SIZE, 120, 110)).toBe(255);
  });

  it("gaze: pixel farther than 2 * FEATHER_PX outside the left eye rect is 0", () => {
    const mask = maskFor("gaze", landmarks, SIZE);
    const x = landmarks.leftEye.x - 2 * FEATHER_PX - 1;
    expect(at(mask, SIZE, x, 110)).toBe(0);
  });

  it("gaze: pixel one feather-width outside the expanded eye rect is between 1 and 254", () => {
    const mask = maskFor("gaze", landmarks, SIZE);
    const expandedLeft = landmarks.leftEye.x - FEATHER_PX;
    const x = expandedLeft - FEATHER_PX / 2;
    const value = at(mask, SIZE, Math.floor(x), 110);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(255);
  });

  it("smile is all zeros", () => {
    const mask = maskFor("smile", landmarks, SIZE);
    expect(mask.every((v) => v === 0)).toBe(true);
  });

  it("curious includes brow extension above the eye and mouth center, and the canvas corner stays 0", () => {
    const curious = maskFor("curious", landmarks, SIZE);
    const pain = maskFor("pain", landmarks, SIZE);
    const nausea = maskFor("nausea", landmarks, SIZE);
    expect(at(curious, SIZE, 120, 90)).toBe(255);
    expect(at(curious, SIZE, 170, 180)).toBe(255);
    expect(at(curious, SIZE, 0, 0)).toBe(0);
    expect(at(pain, SIZE, 0, 0)).toBe(0);
    expect(at(nausea, SIZE, 0, 0)).toBe(0);
  });

  it("covers the pixel below the old curious mouth rect for curious, pain, and nausea", () => {
    const curious = maskFor("curious", landmarks, SIZE);
    const pain = maskFor("pain", landmarks, SIZE);
    const nausea = maskFor("nausea", landmarks, SIZE);
    const x = 170;
    const y = 206;
    expect(at(curious, SIZE, x, y)).toBe(255);
    expect(at(pain, SIZE, x, y)).toBe(255);
    expect(at(nausea, SIZE, x, y)).toBe(255);
  });

  it("cheek between the eye line and the mouth is solid for curious, pain, and nausea, and gaze is 0 there", () => {
    const curious = maskFor("curious", landmarks, SIZE);
    const pain = maskFor("pain", landmarks, SIZE);
    const nausea = maskFor("nausea", landmarks, SIZE);
    const gaze = maskFor("gaze", landmarks, SIZE);
    const x = 120;
    const y = 145;
    expect(y).toBeGreaterThan(landmarks.leftEye.y + landmarks.leftEye.height);
    expect(y).toBeLessThan(landmarks.mouthCenter.y);
    expect(x).toBeGreaterThanOrEqual(landmarks.leftEye.x);
    expect(x).toBeLessThan(landmarks.leftEye.x + landmarks.leftEye.width);
    expect(at(curious, SIZE, x, y)).toBe(255);
    expect(at(pain, SIZE, x, y)).toBe(255);
    expect(at(nausea, SIZE, x, y)).toBe(255);
    expect(at(gaze, SIZE, x, y)).toBe(0);
  });

  it("expression mask solid region is not a filled rectangle", () => {
    const mask = maskFor("nausea", landmarks, SIZE);
    expect(Array.from(maskFor("curious", landmarks, SIZE))).toEqual(
      Array.from(mask),
    );
    expect(Array.from(maskFor("pain", landmarks, SIZE))).toEqual(
      Array.from(mask),
    );
    const { minX, minY, maxX, maxY } = solidBounds(mask, SIZE);
    expect(at(mask, SIZE, minX, minY)).not.toBe(255);
    expect(at(mask, SIZE, maxX, minY)).not.toBe(255);
    expect(at(mask, SIZE, minX, maxY)).not.toBe(255);
    expect(at(mask, SIZE, maxX, maxY)).not.toBe(255);
  });

  it("expression mask feathers wider than the gaze feather and leaves the canvas corner at 0", () => {
    const factor = CANVAS_SIZE / SIZE;
    const mask = maskFor(
      "curious",
      scaleLandmarks(landmarks, factor),
      CANVAS_SIZE,
    );
    const left = widestSolidLeft(mask, CANVAS_SIZE);
    const outside = left.x - 1;
    expect(at(mask, CANVAS_SIZE, left.x, left.y)).toBe(255);
    expect(at(mask, CANVAS_SIZE, outside, left.y)).not.toBe(255);
    const band = at(mask, CANVAS_SIZE, outside - FEATHER_PX, left.y);
    expect(band).toBeGreaterThan(0);
    expect(band).toBeLessThan(255);
    expect(at(mask, CANVAS_SIZE, outside - FEATHER_PX - 32, left.y)).toBe(0);
    expect(at(mask, CANVAS_SIZE, 0, 0)).toBe(0);
  });
});
