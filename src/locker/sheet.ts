import type { Rect, RgbaImage, SmileLandmarks } from "./types";

const SHEET_CELLS = 27;
const CENTER_CELL = 12;

type RoundedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function roundRect(rect: Rect): RoundedRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function copyPixel(
  dst: Uint8Array,
  dstIndex: number,
  src: Uint8Array,
  srcIndex: number,
) {
  if (srcIndex < 0 || srcIndex + 3 >= src.length) return;
  dst[dstIndex] = src[srcIndex]!;
  dst[dstIndex + 1] = src[srcIndex + 1]!;
  dst[dstIndex + 2] = src[srcIndex + 2]!;
  dst[dstIndex + 3] = src[srcIndex + 3]!;
}

export function cutEyes(plate: RgbaImage, landmarks: SmileLandmarks): Uint8Array {
  const left = roundRect(landmarks.leftEye);
  const right = roundRect(landmarks.rightEye);
  const height = left.height;
  const stride = left.width + right.width;
  const out = new Uint8Array(stride * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < left.width; x++) {
      const src = ((left.y + y) * plate.width + (left.x + x)) * 4;
      const dst = (y * stride + x) * 4;
      copyPixel(out, dst, plate.data, src);
    }
    for (let x = 0; x < right.width; x++) {
      const src = ((right.y + y) * plate.width + (right.x + x)) * 4;
      const dst = (y * stride + left.width + x) * 4;
      copyPixel(out, dst, plate.data, src);
    }
  }

  return out;
}

function blitCell(
  sheet: Uint8Array,
  sheetWidth: number,
  originX: number,
  cell: Uint8Array,
  cellWidth: number,
  cellHeight: number,
) {
  for (let y = 0; y < cellHeight; y++) {
    const src = y * cellWidth * 4;
    const dst = (y * sheetWidth + originX) * 4;
    sheet.set(cell.subarray(src, src + cellWidth * 4), dst);
  }
}

export function buildGazeSheet(
  smile: RgbaImage,
  landmarks: SmileLandmarks,
  cells: ReadonlyArray<{ index: number; plate: RgbaImage }>,
): RgbaImage {
  const left = roundRect(landmarks.leftEye);
  const right = roundRect(landmarks.rightEye);
  const cellWidth = left.width + right.width;
  const cellHeight = left.height;
  const width = SHEET_CELLS * cellWidth;
  const data = new Uint8Array(width * cellHeight * 4);

  for (const cell of cells) {
    if (!Number.isInteger(cell.index) || cell.index < 0 || cell.index > 26) {
      continue;
    }
    if (cell.index === CENTER_CELL) continue;
    blitCell(
      data,
      width,
      cell.index * cellWidth,
      cutEyes(cell.plate, landmarks),
      cellWidth,
      cellHeight,
    );
  }

  blitCell(
    data,
    width,
    CENTER_CELL * cellWidth,
    cutEyes(smile, landmarks),
    cellWidth,
    cellHeight,
  );

  return { width, height: cellHeight, data };
}
