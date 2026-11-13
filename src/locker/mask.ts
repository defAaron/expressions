import {
  CANVAS_SIZE,
  FEATHER_PX,
  type PlateName,
  type Point,
  type Rect,
  type SmileLandmarks,
} from "./types";

// 32px on a 1024 plate. Smaller plates keep the same fraction of the canvas.
const EXPRESSION_FALLOFF_PX = 32;

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

type Ellipse = { cx: number; cy: number; rx: number; ry: number };

function rectCorners(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height },
  ];
}

function expressionCoverPoints(landmarks: SmileLandmarks): Point[] {
  const tongue = mouthRect(landmarks, landmarks.leftEye.height);
  return [
    ...rectCorners(eyeWithBrowExtension(landmarks.leftEye)),
    ...rectCorners(eyeWithBrowExtension(landmarks.rightEye)),
    ...rectCorners(tongue),
  ];
}

function expressionEllipse(landmarks: SmileLandmarks): Ellipse {
  const left = landmarks.leftEye;
  const right = landmarks.rightEye;
  const cheekLeft = left.x - left.width;
  const cheekRight = right.x + right.width + right.width;
  const cx = (cheekLeft + cheekRight) / 2;
  let rx = (cheekRight - cheekLeft) / 2;

  const samples = expressionCoverPoints(landmarks);
  const anchorY =
    samples.reduce((sum, point) => sum + point.y, 0) / samples.length;
  const cover = samples.map((point) => {
    const dx = point.x - cx;
    const dy = point.y - anchorY;
    const length = Math.hypot(dx, dy) || 1;
    return { x: point.x + dx / length, y: point.y + dy / length };
  });
  for (const point of cover) {
    const dx = Math.abs(point.x - cx);
    if (dx >= rx) rx = dx + 1;
  }

  const scaled = cover.map((point) => ({
    y: point.y,
    reach: Math.sqrt(Math.max(0, 1 - ((point.x - cx) / rx) ** 2)),
  }));
  let ry = 0;
  for (const above of scaled) {
    for (const below of scaled) {
      const span = above.reach + below.reach;
      if (span <= 0) continue;
      ry = Math.max(ry, (above.y - below.y) / span);
    }
  }

  let lo = -Infinity;
  let hi = Infinity;
  for (const point of scaled) {
    lo = Math.max(lo, point.y - ry * point.reach);
    hi = Math.min(hi, point.y + ry * point.reach);
  }

  return { cx, cy: (lo + hi) / 2, rx, ry };
}

function expressionCoverage(
  px: number,
  py: number,
  ellipse: Ellipse,
  falloff: number,
): number {
  const dx = px - ellipse.cx;
  const dy = py - ellipse.cy;
  const norm = Math.hypot(dx / ellipse.rx, dy / ellipse.ry);
  if (norm <= 1) {
    return 255;
  }
  const fromCenter = Math.hypot(dx, dy);
  const outside = fromCenter - fromCenter / norm;
  if (outside >= falloff) {
    return 0;
  }
  const faded = Math.round(255 * (1 - outside / falloff));
  return Math.min(254, Math.max(1, faded));
}

function expressionMask(landmarks: SmileLandmarks, size: number): Uint8Array {
  const mask = new Uint8Array(size * size);
  const ellipse = expressionEllipse(landmarks);
  const falloff = (EXPRESSION_FALLOFF_PX * size) / CANVAS_SIZE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      mask[y * size + x] = expressionCoverage(
        x + 0.5,
        y + 0.5,
        ellipse,
        falloff,
      );
    }
  }
  return mask;
}

function collectRects(
  plate: "smile" | "gaze" | "blink",
  landmarks: SmileLandmarks,
): Rect[] {
  switch (plate) {
    case "smile":
      return [];
    case "gaze":
    case "blink":
      return [landmarks.leftEye, landmarks.rightEye];
  }
}

export function maskFor(
  plate: PlateName,
  landmarks: SmileLandmarks,
  size: number = CANVAS_SIZE,
): Uint8Array {
  if (plate === "curious" || plate === "pain" || plate === "nausea") {
    return expressionMask(landmarks, size);
  }

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
