import { describe, expect, it } from "vitest";
import { FEATHER_PX } from "./types";
import { maskFor } from "./mask";
import type { SmileLandmarks } from "./types";

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

  it("curious includes brow extension above the eye and mouth center, not the far canvas corner", () => {
    const mask = maskFor("curious", landmarks, SIZE);
    expect(at(mask, SIZE, 120, 90)).toBe(255);
    expect(at(mask, SIZE, 170, 180)).toBe(255);
    expect(at(mask, SIZE, 0, 0)).toBe(0);
  });

  it("nausea includes a pixel below the curious mouth rect that curious leaves at 0", () => {
    const curious = maskFor("curious", landmarks, SIZE);
    const nausea = maskFor("nausea", landmarks, SIZE);
    const x = 170;
    const y = 206;
    expect(at(curious, SIZE, x, y)).toBe(0);
    expect(at(nausea, SIZE, x, y)).toBe(255);
  });
});
