import { describe, expect, it } from "vitest";
import {
  CANVAS_SIZE,
  NOSE_TOLERANCE_OF_FACE_WIDTH,
  OUTER_CORNER_MAX_PX,
  SOCKET_INSET_PX,
  type Point,
  type RgbaImage,
  type SmileLandmarks,
} from "./types";
import {
  alignToSmile,
  fitSimilarity,
  transformPoint,
  warpImage,
  type Similarity,
} from "./align";

function pt(x: number, y: number) {
  return { x, y };
}

function rect(x: number, y: number, width: number, height: number) {
  return { x, y, width, height };
}

function baseSmile(): SmileLandmarks {
  const leftEye = rect(100, 100, 80, 60);
  const rightEye = rect(300, 100, 80, 60);
  const leftEyeCenter = pt(140, 130);
  const rightEyeCenter = pt(340, 130);
  const mouthCenter = pt(240, 280);
  return {
    leftEye,
    rightEye,
    leftEyeCenter,
    rightEyeCenter,
    betweenPupils: pt(240, 130),
    mouthCenter,
    noseBridge: pt(240, 200),
    leftPupil: pt(145, 132),
    rightPupil: pt(335, 128),
    leftOuterCorner: pt(40, 220),
    rightOuterCorner: pt(440, 220),
  };
}

function cloneLandmarks(
  smile: SmileLandmarks,
  patch: Partial<SmileLandmarks> = {},
): SmileLandmarks {
  return { ...smile, ...patch };
}

function solidImage(width: number, height: number, fill = 255): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    data[o] = fill;
    data[o + 1] = fill;
    data[o + 2] = fill;
    data[o + 3] = fill === 0 ? 0 : 255;
  }
  return { width, height, data };
}

describe("fitSimilarity", () => {
  it("identity when from equals to", () => {
    const a = pt(10, 20);
    const b = pt(50, 20);
    const c = pt(30, 60);
    const sim = fitSimilarity([a, b, c], [a, b, c]);
    expect(sim.scale).toBeCloseTo(1, 6);
    expect(sim.rotation).toBeCloseTo(0, 6);
    expect(sim.tx).toBeCloseTo(0, 6);
    expect(sim.ty).toBeCloseTo(0, 6);
  });

  it("pure scale of 2", () => {
    const from: [Point, Point, Point] = [
      pt(0, 0),
      pt(10, 0),
      pt(5, 5),
    ];
    const to: [Point, Point, Point] = [
      pt(0, 0),
      pt(20, 0),
      pt(10, 10),
    ];
    const sim = fitSimilarity(from, to);
    expect(sim.scale).toBeCloseTo(2, 6);
    expect(sim.rotation).toBeCloseTo(0, 6);
    expect(sim.tx).toBeCloseTo(0, 6);
    expect(sim.ty).toBeCloseTo(0, 6);
  });

  it("90 degree rotation", () => {
    const from: [Point, Point, Point] = [
      pt(10, 0),
      pt(0, 0),
      pt(0, 10),
    ];
    const to: [Point, Point, Point] = [
      pt(0, 10),
      pt(0, 0),
      pt(-10, 0),
    ];
    const sim = fitSimilarity(from, to);
    expect(sim.scale).toBeCloseTo(1, 6);
    expect(sim.rotation).toBeCloseTo(Math.PI / 2, 6);
    expect(sim.tx).toBeCloseTo(0, 6);
    expect(sim.ty).toBeCloseTo(0, 6);
  });
});

describe("transformPoint", () => {
  it("applies scale, rotation, translation in order", () => {
    const sim: Similarity = { scale: 2, rotation: Math.PI / 2, tx: 5, ty: 7 };
    const out = transformPoint(pt(1, 0), sim);
    expect(out.x).toBeCloseTo(5, 6);
    expect(out.y).toBeCloseTo(9, 6);
  });
});

describe("warpImage", () => {
  it("preserves corner bytes through identity on a 2×2 image", () => {
    const image: RgbaImage = {
      width: 2,
      height: 2,
      data: new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      ]),
    };
    const identity: Similarity = { scale: 1, rotation: 0, tx: 0, ty: 0 };
    const warped = warpImage(image, identity, 2, 2);
    expect(warped.data[0]).toBe(1);
    expect(warped.data[1]).toBe(2);
    expect(warped.data[2]).toBe(3);
    expect(warped.data[3]).toBe(4);
    expect(warped.data[12]).toBe(13);
    expect(warped.data[13]).toBe(14);
    expect(warped.data[14]).toBe(15);
    expect(warped.data[15]).toBe(16);
  });
});

describe("alignToSmile", () => {
  const smile = baseSmile();
  const image = solidImage(CANVAS_SIZE, CANVAS_SIZE, 200);

  function faceWidth(landmarks: SmileLandmarks): number {
    const dx = landmarks.rightOuterCorner.x - landmarks.leftOuterCorner.x;
    const dy = landmarks.rightOuterCorner.y - landmarks.leftOuterCorner.y;
    return Math.hypot(dx, dy);
  }

  it("rejects nose drift beyond tolerance", () => {
    const fw = faceWidth(smile);
    const drift = NOSE_TOLERANCE_OF_FACE_WIDTH * fw + 1;
    const result = cloneLandmarks(smile, {
      noseBridge: pt(smile.noseBridge.x + drift, smile.noseBridge.y),
    });
    const out = alignToSmile(smile, image, result, "gaze");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.rejection.code).toBe("nose-moved");
    }
  });

  it("accepts nose drift under tolerance", () => {
    const fw = faceWidth(smile);
    const drift = NOSE_TOLERANCE_OF_FACE_WIDTH * fw * 0.5;
    const result = cloneLandmarks(smile, {
      noseBridge: pt(smile.noseBridge.x + drift, smile.noseBridge.y),
    });
    const out = alignToSmile(smile, image, result, "gaze");
    expect(out.ok).toBe(true);
  });

  it("rejects gaze pupil outside inset socket", () => {
    const inset = SOCKET_INSET_PX;
    const outsideX = smile.leftEye.x + inset - 1;
    const result = cloneLandmarks(smile, {
      leftPupil: pt(outsideX, smile.leftPupil.y),
    });
    const out = alignToSmile(smile, image, result, "gaze");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.rejection.code).toBe("pupil-outside-socket");
    }
  });

  it("rejects outer corner 3px away for gaze", () => {
    const result = cloneLandmarks(smile, {
      leftOuterCorner: pt(
        smile.leftOuterCorner.x + OUTER_CORNER_MAX_PX + 1,
        smile.leftOuterCorner.y,
      ),
    });
    const out = alignToSmile(smile, image, result, "gaze");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.rejection.code).toBe("outer-corner-moved");
    }
  });

  it("accepts outer corner 2px away for gaze", () => {
    const result = cloneLandmarks(smile, {
      leftOuterCorner: pt(
        smile.leftOuterCorner.x + OUTER_CORNER_MAX_PX,
        smile.leftOuterCorner.y,
      ),
    });
    const out = alignToSmile(smile, image, result, "gaze");
    expect(out.ok).toBe(true);
  });

  it("does not socket-check curious when pupil is outside", () => {
    const inset = SOCKET_INSET_PX;
    const outsideX = smile.leftEye.x + inset - 1;
    const result = cloneLandmarks(smile, {
      leftPupil: pt(outsideX, smile.leftPupil.y),
    });
    const out = alignToSmile(smile, image, result, "curious");
    expect(out.ok).toBe(true);
  });

  it("rejects when fit points are identical on the result side", () => {
    const center = pt(200, 200);
    const result = cloneLandmarks(smile, {
      leftEyeCenter: center,
      rightEyeCenter: center,
      mouthCenter: center,
    });
    const out = alignToSmile(smile, image, result, "gaze");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.rejection.code).toBe("alignment-failed");
    }
  });
});
