import { describe, expect, it } from "vitest";
import { buildGazeSheet, cutEyes } from "./sheet";
import type { RgbaImage, SmileLandmarks } from "./types";

type Rgba = [number, number, number, number];

function landmarks(): SmileLandmarks {
  const leftEye = { x: 1, y: 1, width: 2, height: 2 };
  const rightEye = { x: 5, y: 2, width: 2, height: 2 };
  const leftEyeCenter = { x: 2, y: 2 };
  const rightEyeCenter = { x: 6, y: 3 };
  return {
    leftEye,
    rightEye,
    leftEyeCenter,
    rightEyeCenter,
    betweenPupils: { x: 4, y: 2 },
    mouthCenter: { x: 4, y: 5 },
    noseBridge: { x: 4, y: 3 },
    leftPupil: leftEyeCenter,
    rightPupil: rightEyeCenter,
    leftOuterCorner: { x: 1, y: 2 },
    rightOuterCorner: { x: 7, y: 3 },
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

function readPixel(data: Uint8Array, stride: number, x: number, y: number): Rgba {
  const i = (y * stride + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

function cellBytes(
  sheet: RgbaImage,
  index: number,
  cellWidth: number,
  cellHeight: number,
): Uint8Array {
  const out = new Uint8Array(cellWidth * cellHeight * 4);
  for (let y = 0; y < cellHeight; y++) {
    const src = (y * sheet.width + index * cellWidth) * 4;
    out.set(sheet.data.subarray(src, src + cellWidth * 4), y * cellWidth * 4);
  }
  return out;
}

describe("cutEyes", () => {
  it("copies a left-rect pixel 1:1 into the left half and does not scale", () => {
    const plate = rgbaImage(8, 5, [1, 1, 1, 255]);
    writePixel(plate, 2, 2, [9, 8, 7, 6]);
    writePixel(plate, 5, 2, [50, 60, 70, 80]);
    const eyes = landmarks();

    const cut = cutEyes(plate, eyes);

    const leftWidth = 2;
    const rightWidth = 2;
    const height = 2;
    const stride = leftWidth + rightWidth;
    expect(cut.length).toBe(stride * height * 4);
    expect(readPixel(cut, stride, 1, 1)).toEqual([9, 8, 7, 6]);
    expect(readPixel(cut, stride, 0, 0)).toEqual([1, 1, 1, 255]);
    expect(readPixel(cut, stride, leftWidth, 0)).toEqual([50, 60, 70, 80]);
  });

  it("rounds rect x, y, width, and height before copying", () => {
    const plate = rgbaImage(8, 4, [1, 1, 1, 255]);
    writePixel(plate, 2, 0, [4, 5, 6, 7]);
    writePixel(plate, 1, 0, [9, 9, 9, 9]);
    const eyes = landmarks();
    eyes.leftEye = { x: 1.6, y: 0.4, width: 2.4, height: 1.6 };
    eyes.rightEye = { x: 5.2, y: 0.4, width: 1.5, height: 1.6 };

    const cut = cutEyes(plate, eyes);

    expect(cut.length).toBe((2 + 2) * 2 * 4);
    expect(readPixel(cut, 4, 0, 0)).toEqual([4, 5, 6, 7]);
  });
});

describe("buildGazeSheet", () => {
  const cellWidth = 4;
  const cellHeight = 2;

  it("copies the smile into cell 12 even when cells includes a different index 12", () => {
    const eyes = landmarks();
    const smile = rgbaImage(8, 5, [3, 3, 3, 255]);
    writePixel(smile, 1, 1, [1, 2, 3, 4]);
    writePixel(smile, 5, 2, [5, 6, 7, 8]);
    const generatedCenter = rgbaImage(8, 5, [3, 3, 3, 255]);
    writePixel(generatedCenter, 1, 1, [8, 8, 8, 8]);
    writePixel(generatedCenter, 5, 2, [9, 9, 9, 9]);

    const sheet = buildGazeSheet(smile, eyes, [
      { index: 12, plate: generatedCenter },
    ]);

    expect(sheet.width).toBe(27 * cellWidth);
    expect(sheet.height).toBe(cellHeight);
    expect(Array.from(cellBytes(sheet, 12, cellWidth, cellHeight))).toEqual(
      Array.from(cutEyes(smile, eyes)),
    );
    expect(Array.from(cellBytes(sheet, 12, cellWidth, cellHeight))).not.toEqual(
      Array.from(cutEyes(generatedCenter, eyes)),
    );
  });

  it("places cell 0 at the start of the strip and cell 26 at the end", () => {
    const eyes = landmarks();
    const smile = rgbaImage(8, 5, [0, 0, 0, 0]);
    const cell0 = rgbaImage(8, 5, [0, 0, 0, 0]);
    const cell26 = rgbaImage(8, 5, [0, 0, 0, 0]);
    const intruder = rgbaImage(8, 5, [0, 0, 0, 0]);
    writePixel(cell0, 1, 1, [10, 0, 0, 255]);
    writePixel(cell26, 1, 1, [26, 0, 0, 255]);
    writePixel(intruder, 1, 1, [255, 255, 255, 255]);

    const sheet = buildGazeSheet(smile, eyes, [
      { index: 27, plate: intruder },
      { index: -1, plate: intruder },
      { index: 0, plate: cell0 },
      { index: 26, plate: cell26 },
    ]);

    expect(Array.from(cellBytes(sheet, 0, cellWidth, cellHeight))).toEqual(
      Array.from(cutEyes(cell0, eyes)),
    );
    expect(Array.from(cellBytes(sheet, 26, cellWidth, cellHeight))).toEqual(
      Array.from(cutEyes(cell26, eyes)),
    );
    expect(sheet.width).toBe(27 * cellWidth);
  });

  it("ignores an index outside 0 through 26", () => {
    const eyes = landmarks();
    const smile = rgbaImage(8, 5, [0, 0, 0, 0]);
    const intruder = rgbaImage(8, 5, [255, 255, 255, 255]);

    const sheet = buildGazeSheet(smile, eyes, [
      { index: 12.5, plate: intruder },
      { index: 27, plate: intruder },
      { index: -1, plate: intruder },
    ]);
    const untouched = cellBytes(sheet, 13, cellWidth, cellHeight);

    expect(Array.from(untouched)).toEqual(
      Array.from(new Uint8Array(cellWidth * cellHeight * 4)),
    );
  });

  it("fills a missing cell with transparent black", () => {
    const eyes = landmarks();
    const smile = rgbaImage(8, 5, [4, 4, 4, 255]);
    const sheet = buildGazeSheet(smile, eyes, []);
    const missing = cellBytes(sheet, 1, cellWidth, cellHeight);

    expect(sheet.width).toBe(27 * cellWidth);
    expect(sheet.height).toBe(cellHeight);
    expect(Array.from(missing)).toEqual(
      Array.from(new Uint8Array(cellWidth * cellHeight * 4)),
    );
  });
});
