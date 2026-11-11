import {
  CANVAS_SIZE,
  NOSE_TOLERANCE_OF_FACE_WIDTH,
  OUTER_CORNER_MAX_PX,
  SOCKET_INSET_PX,
  type LockerRejection,
  type Point,
  type Rect,
  type RgbaImage,
  type SmileLandmarks,
} from "./types";

export type Similarity = {
  scale: number;
  rotation: number;
  tx: number;
  ty: number;
};

type FitTriple = [Point, Point, Point];

function reject(code: LockerRejection["code"], message: string) {
  return { ok: false as const, rejection: { code, message } };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointsEqual(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function allFitPointsIdentical(from: FitTriple): boolean {
  return (
    pointsEqual(from[0], from[1]) &&
    pointsEqual(from[1], from[2])
  );
}

export function fitSimilarity(from: FitTriple, to: FitTriple): Similarity {
  const n = 3;
  let meanFromX = 0;
  let meanFromY = 0;
  let meanToX = 0;
  let meanToY = 0;

  for (let i = 0; i < n; i++) {
    meanFromX += from[i].x;
    meanFromY += from[i].y;
    meanToX += to[i].x;
    meanToY += to[i].y;
  }
  meanFromX /= n;
  meanFromY /= n;
  meanToX /= n;
  meanToY /= n;

  let a = 0;
  let b = 0;
  let varFrom = 0;

  for (let i = 0; i < n; i++) {
    const fx = from[i].x - meanFromX;
    const fy = from[i].y - meanFromY;
    const tx = to[i].x - meanToX;
    const ty = to[i].y - meanToY;
    a += tx * fx + ty * fy;
    b += ty * fx - tx * fy;
    varFrom += fx * fx + fy * fy;
  }

  if (varFrom === 0) {
    return { scale: 0, rotation: 0, tx: meanToX, ty: meanToY };
  }

  const scale = Math.sqrt(a * a + b * b) / varFrom;
  const rotation = Math.atan2(b, a);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const tx = meanToX - scale * (cos * meanFromX - sin * meanFromY);
  const ty = meanToY - scale * (sin * meanFromX + cos * meanFromY);

  return { scale, rotation, tx, ty };
}

export function transformPoint(point: Point, similarity: Similarity): Point {
  const { scale, rotation, tx, ty } = similarity;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    x: scale * (cos * point.x - sin * point.y) + tx,
    y: scale * (sin * point.x + cos * point.y) + ty,
  };
}

function sampleBilinear(image: RgbaImage, sx: number, sy: number): [number, number, number, number] {
  if (sx < 0 || sy < 0 || sx > image.width - 1 || sy > image.height - 1) {
    return [0, 0, 0, 0];
  }

  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(x0 + 1, image.width - 1);
  const y1 = Math.min(y0 + 1, image.height - 1);
  const fx = sx - x0;
  const fy = sy - y0;

  function pixel(x: number, y: number): [number, number, number, number] {
    const i = (y * image.width + x) * 4;
    return [
      image.data[i],
      image.data[i + 1],
      image.data[i + 2],
      image.data[i + 3],
    ];
  }

  const c00 = pixel(x0, y0);
  const c10 = pixel(x1, y0);
  const c01 = pixel(x0, y1);
  const c11 = pixel(x1, y1);

  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const top = c00[c] * (1 - fx) + c10[c] * fx;
    const bottom = c01[c] * (1 - fx) + c11[c] * fx;
    out[c] = Math.round(top * (1 - fy) + bottom * fy);
  }
  return out;
}

function inverseSimilarityPoint(
  x: number,
  y: number,
  similarity: Similarity,
): Point {
  const { scale, rotation, tx, ty } = similarity;
  if (scale === 0) {
    return { x: NaN, y: NaN };
  }
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = x - tx;
  const dy = y - ty;
  const inv = 1 / scale;
  return {
    x: inv * (cos * dx + sin * dy),
    y: inv * (-sin * dx + cos * dy),
  };
}

export function warpImage(
  source: RgbaImage,
  similarity: Similarity,
  width: number,
  height: number,
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcPt = inverseSimilarityPoint(x, y, similarity);
      const [r, g, b, a] = sampleBilinear(source, srcPt.x, srcPt.y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { width, height, data };
}

function pupilInsideSocket(pupil: Point, eye: Rect, inset: number): boolean {
  const minX = eye.x + inset;
  const maxX = eye.x + eye.width - inset;
  const minY = eye.y + inset;
  const maxY = eye.y + eye.height - inset;
  return (
    pupil.x >= minX &&
    pupil.x <= maxX &&
    pupil.y >= minY &&
    pupil.y <= maxY
  );
}

function socketChecks(
  smile: SmileLandmarks,
  transformed: {
    leftPupil: Point;
    rightPupil: Point;
    leftOuterCorner: Point;
    rightOuterCorner: Point;
  },
): LockerRejection | null {
  if (
    !pupilInsideSocket(transformed.leftPupil, smile.leftEye, SOCKET_INSET_PX)
  ) {
    return {
      code: "pupil-outside-socket",
      message: "Left pupil is outside the inset eye socket.",
    };
  }
  if (
    !pupilInsideSocket(transformed.rightPupil, smile.rightEye, SOCKET_INSET_PX)
  ) {
    return {
      code: "pupil-outside-socket",
      message: "Right pupil is outside the inset eye socket.",
    };
  }
  const leftCornerDist = dist(transformed.leftOuterCorner, smile.leftOuterCorner);
  if (leftCornerDist > OUTER_CORNER_MAX_PX) {
    return {
      code: "outer-corner-moved",
      message: "Left outer corner moved too far from the smile.",
    };
  }
  const rightCornerDist = dist(
    transformed.rightOuterCorner,
    smile.rightOuterCorner,
  );
  if (rightCornerDist > OUTER_CORNER_MAX_PX) {
    return {
      code: "outer-corner-moved",
      message: "Right outer corner moved too far from the smile.",
    };
  }
  return null;
}

export function alignToSmile(
  smile: SmileLandmarks,
  resultImage: RgbaImage,
  result: SmileLandmarks,
  plate: "gaze" | "blink" | "curious" | "pain" | "nausea",
):
  | { ok: true; image: RgbaImage; landmarks: SmileLandmarks }
  | { ok: false; rejection: LockerRejection } {
  const from: FitTriple = [
    result.leftEyeCenter,
    result.rightEyeCenter,
    result.mouthCenter,
  ];
  const to: FitTriple = [
    smile.leftEyeCenter,
    smile.rightEyeCenter,
    smile.mouthCenter,
  ];

  if (allFitPointsIdentical(from)) {
    return reject("alignment-failed", "Result fit points are identical.");
  }

  const similarity = fitSimilarity(from, to);
  if (!Number.isFinite(similarity.scale) || similarity.scale === 0) {
    return reject("alignment-failed", "Similarity scale is zero.");
  }

  const transformedNose = transformPoint(result.noseBridge, similarity);
  const faceWidth = dist(smile.leftOuterCorner, smile.rightOuterCorner);
  const noseDrift = dist(transformedNose, smile.noseBridge);
  if (noseDrift > NOSE_TOLERANCE_OF_FACE_WIDTH * faceWidth) {
    return reject("nose-moved", "Nose bridge moved beyond tolerance.");
  }

  const transformed = {
    noseBridge: transformedNose,
    leftPupil: transformPoint(result.leftPupil, similarity),
    rightPupil: transformPoint(result.rightPupil, similarity),
    leftOuterCorner: transformPoint(result.leftOuterCorner, similarity),
    rightOuterCorner: transformPoint(result.rightOuterCorner, similarity),
  };

  if (plate === "gaze" || plate === "blink") {
    const socketRejection = socketChecks(smile, transformed);
    if (socketRejection) {
      return { ok: false, rejection: socketRejection };
    }
  }

  const image = warpImage(resultImage, similarity, CANVAS_SIZE, CANVAS_SIZE);
  const landmarks: SmileLandmarks = {
    leftEye: smile.leftEye,
    rightEye: smile.rightEye,
    leftEyeCenter: smile.leftEyeCenter,
    rightEyeCenter: smile.rightEyeCenter,
    betweenPupils: smile.betweenPupils,
    mouthCenter: smile.mouthCenter,
    noseBridge: transformed.noseBridge,
    leftPupil: transformed.leftPupil,
    rightPupil: transformed.rightPupil,
    leftOuterCorner: transformed.leftOuterCorner,
    rightOuterCorner: transformed.rightOuterCorner,
  };

  return { ok: true, image, landmarks };
}
