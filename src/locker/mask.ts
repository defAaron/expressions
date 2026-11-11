import {
  CANVAS_SIZE,
  FEATHER_PX,
  type PlateName,
  type Rect,
  type SmileLandmarks,
} from "./types";

function expandRect(rect: Rect, px: number): Rect {
  return {
    x: rect.x - px,
    y: rect.y - px,
    width: rect.width + 2 * px,
    height: rect.height + 2 * px,
  };
}

function eyeWithBrowExtension(eye: Rect): Rect {
  return {
    x: eye.x,
    y: eye.y - eye.height,
    width: eye.width,
    height: eye.height * 2,
  };
}

function mouthRect(landmarks: SmileLandmarks, extraDown = 0): Rect {
  const eyeDist = Math.hypot(
    landmarks.rightEyeCenter.x - landmarks.leftEyeCenter.x,
    landmarks.rightEyeCenter.y - landmarks.leftEyeCenter.y,
  );
  const height = landmarks.leftEye.height + extraDown;
  return {
    x: landmarks.mouthCenter.x - eyeDist / 2,
    y: landmarks.mouthCenter.y - landmarks.leftEye.height / 2,
    width: eyeDist,
    height,
  };
}

function distanceOutsideRect(px: number, py: number, rect: Rect): number {
  const dx = Math.max(rect.x - px, 0, px - (rect.x + rect.width));
  const dy = Math.max(rect.y - py, 0, py - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function valueForFeatheredRect(px: number, py: number, base: Rect): number {
  const solid = expandRect(base, FEATHER_PX);
  const d = distanceOutsideRect(px, py, solid);
  if (d === 0) {
    return 255;
  }
  if (d >= FEATHER_PX) {
    return 0;
  }
  return Math.round(255 * (1 - d / FEATHER_PX));
}

function collectRects(plate: PlateName, landmarks: SmileLandmarks): Rect[] {
  switch (plate) {
    case "smile":
      return [];
    case "gaze":
    case "blink":
      return [landmarks.leftEye, landmarks.rightEye];
    case "curious":
    case "pain":
      return [
        eyeWithBrowExtension(landmarks.leftEye),
        eyeWithBrowExtension(landmarks.rightEye),
        mouthRect(landmarks),
      ];
    case "nausea":
      return [
        eyeWithBrowExtension(landmarks.leftEye),
        eyeWithBrowExtension(landmarks.rightEye),
        mouthRect(landmarks, landmarks.leftEye.height),
      ];
  }
}

export function maskFor(
  plate: PlateName,
  landmarks: SmileLandmarks,
  size: number = CANVAS_SIZE,
): Uint8Array {
  const mask = new Uint8Array(size * size);
  const rects = collectRects(plate, landmarks);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value = 0;
      for (const rect of rects) {
        value = Math.max(value, valueForFeatheredRect(x + 0.5, y + 0.5, rect));
      }
      mask[y * size + x] = value;
    }
  }

  return mask;
}
