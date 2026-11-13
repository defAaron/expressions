import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { alignToSmile } from "../locker/align";
import { compositePlate } from "../locker/composite";
import type { FaceDetector } from "../locker/crop";
import { maskFor } from "../locker/mask";
import { buildGazeSheet } from "../locker/sheet";
import {
  CANVAS_SIZE,
  type PlateName,
  type RgbaImage,
  type SmileLandmarks,
} from "../locker/types";
import { bundlePath } from "../storage/blobs";
import type { SaveImage } from "./run";

const DETECT_LONG_EDGE = 2048;

export function equalizeEyes(landmarks: SmileLandmarks): SmileLandmarks {
  const height = Math.max(landmarks.leftEye.height, landmarks.rightEye.height);
  const grow = (rect: SmileLandmarks["leftEye"]) => {
    const extra = height - rect.height;
    return {
      x: rect.x,
      y: rect.y - extra / 2,
      width: rect.width,
      height,
    };
  };
  return {
    ...landmarks,
    leftEye: grow(landmarks.leftEye),
    rightEye: grow(landmarks.rightEye),
  };
}

export function gazeCellIndex(horizontal: number, vertical: number): number {
  const col = Math.round((horizontal + 100) / 50);
  const row = Math.round((vertical + 100) / 50);
  return row * 5 + col;
}

export async function writeSmileLandmarks(
  faceId: string,
  landmarks: SmileLandmarks,
): Promise<void> {
  const file = path.join(process.cwd(), bundlePath(faceId, "landmarks.json"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(equalizeEyes(landmarks)));
}

function scaleLandmarks(landmarks: SmileLandmarks, factor: number): SmileLandmarks {
  const point = (value: { x: number; y: number }) => ({
    x: value.x * factor,
    y: value.y * factor,
  });
  const rect = (value: SmileLandmarks["leftEye"]) => ({
    x: value.x * factor,
    y: value.y * factor,
    width: value.width * factor,
    height: value.height * factor,
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

async function decodeRgba(bytes: Buffer): Promise<RgbaImage> {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data),
  };
}

async function writeWebp(image: RgbaImage, relativePath: string): Promise<void> {
  const file = path.join(process.cwd(), relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .webp({ quality: 90 })
    .toFile(file);
}

async function fitCanvas(image: RgbaImage): Promise<RgbaImage> {
  if (image.width === CANVAS_SIZE && image.height === CANVAS_SIZE) return image;
  return decodeRgba(
    await sharp(Buffer.from(image.data), {
      raw: { width: image.width, height: image.height, channels: 4 },
    })
      .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: "fill" })
      .png()
      .toBuffer(),
  );
}

async function detectOnImage(
  image: RgbaImage,
  detect: FaceDetector,
): Promise<SmileLandmarks | null> {
  const long = Math.max(image.width, image.height);
  if (long <= DETECT_LONG_EDGE) {
    const faces = await detect(image);
    return faces[0]?.landmarks ?? null;
  }
  const scale = DETECT_LONG_EDGE / long;
  const resized = await decodeRgba(
    await sharp(Buffer.from(image.data), {
      raw: { width: image.width, height: image.height, channels: 4 },
    })
      .resize(Math.round(image.width * scale), Math.round(image.height * scale), {
        fit: "fill",
      })
      .png()
      .toBuffer(),
  );
  const faces = await detect(resized);
  if (!faces[0]) return null;
  return scaleLandmarks(faces[0].landmarks, long / DETECT_LONG_EDGE);
}

function pasteRegion(
  smile: RgbaImage,
  aligned: RgbaImage,
  landmarks: SmileLandmarks,
  plate: Exclude<PlateName, "smile">,
): RgbaImage {
  const mask = maskFor(plate, landmarks, smile.width);
  const data = new Uint8Array(smile.data);
  for (let index = 0; index < mask.length; index += 1) {
    const coverage = mask[index] ?? 0;
    if (coverage === 0) continue;
    const pixel = index * 4;
    const alpha = coverage / 255;
    const inverse = 1 - alpha;
    for (let channel = 0; channel < 4; channel += 1) {
      data[pixel + channel] = Math.round(
        smile.data[pixel + channel]! * inverse +
          aligned.data[pixel + channel]! * alpha,
      );
    }
  }
  return { width: smile.width, height: smile.height, data };
}

function copyOutsideMask(
  smile: RgbaImage,
  aligned: RgbaImage,
  landmarks: SmileLandmarks,
  plate: Exclude<PlateName, "smile">,
): RgbaImage {
  const mask = maskFor(plate, landmarks, smile.width);
  const data = new Uint8Array(aligned.data);
  for (let index = 0; index < mask.length; index += 1) {
    if ((mask[index] ?? 0) !== 0) continue;
    const pixel = index * 4;
    data[pixel] = smile.data[pixel]!;
    data[pixel + 1] = smile.data[pixel + 1]!;
    data[pixel + 2] = smile.data[pixel + 2]!;
    data[pixel + 3] = smile.data[pixel + 3]!;
  }
  return { width: aligned.width, height: aligned.height, data };
}

export function createPlatePersister(input: {
  faceId: string;
  detect: FaceDetector;
}): {
  saveImage: SaveImage;
  finalizeGroup: (group: "gaze" | "blink") => Promise<void>;
} {
  const cells = new Map<number, RgbaImage>();
  let smilePromise: Promise<{ image: RgbaImage; landmarks: SmileLandmarks }> | null =
    null;
  let sheetChain = Promise.resolve();

  function loadSmile(): Promise<{ image: RgbaImage; landmarks: SmileLandmarks }> {
    if (!smilePromise) {
      smilePromise = (async () => {
        const image = await decodeRgba(
          await readFile(
            path.join(process.cwd(), bundlePath(input.faceId, "smile.webp")),
          ),
        );
        const landmarks = equalizeEyes(
          JSON.parse(
            await readFile(
              path.join(process.cwd(), bundlePath(input.faceId, "landmarks.json")),
              "utf8",
            ),
          ) as SmileLandmarks,
        );
        return { image, landmarks };
      })();
    }
    return smilePromise;
  }

  async function lockPlate(
    imageUrl: string,
    plate: Exclude<PlateName, "smile">,
  ): Promise<RgbaImage> {
    const { image: smile, landmarks } = await loadSmile();
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Could not download the generated image (${response.status}).`);
    }
    const decoded = await decodeRgba(Buffer.from(await response.arrayBuffer()));
    const detected = await detectOnImage(decoded, input.detect);
    let aligned = await fitCanvas(decoded);
    if (detected) {
      const fitted = alignToSmile(landmarks, decoded, detected, plate);
      if (fitted.ok) aligned = fitted.image;
    }
    if (aligned.width !== CANVAS_SIZE || aligned.height !== CANVAS_SIZE) {
      aligned = await fitCanvas(aligned);
    }
    const prepared = copyOutsideMask(smile, aligned, landmarks, plate);
    const composited = compositePlate(smile, landmarks, prepared, plate);
    if (composited.ok) return composited.image;
    return pasteRegion(smile, aligned, landmarks, plate);
  }

  async function writeSheet(): Promise<void> {
    const { image, landmarks } = await loadSmile();
    const list: Array<{ index: number; plate: RgbaImage }> = [];
    for (let index = 0; index < 27; index += 1) {
      if (index === 12) continue;
      list.push({ index, plate: cells.get(index) ?? image });
    }
    await writeWebp(
      buildGazeSheet(image, landmarks, list),
      bundlePath(input.faceId, "gaze.webp"),
    );
  }

  return {
    async saveImage(item, imageUrl) {
      try {
        const plate =
          item.kind === "half_blink" || item.kind === "shut" ? "blink" : item.kind;
        const image = await lockPlate(imageUrl, plate);
        if (item.kind === "curious" || item.kind === "pain" || item.kind === "nausea") {
          await writeWebp(image, bundlePath(input.faceId, `${item.kind}.webp`));
        } else {
          const index =
            item.kind === "gaze"
              ? gazeCellIndex(
                  item.entry.eye_gaze_horizontal,
                  item.entry.eye_gaze_vertical,
                )
              : item.kind === "half_blink"
                ? 25
                : 26;
          cells.set(index, image);
        }
        console.info(`[expressions] saved ${input.faceId} ${item.kind}`);
        return { ok: true };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not save the plate.";
        console.info(`[expressions] ${input.faceId} ${item.kind} failed: ${message}`);
        return { ok: false, message };
      }
    },

    finalizeGroup() {
      sheetChain = sheetChain.then(() => writeSheet());
      return sheetChain;
    },
  };
}
