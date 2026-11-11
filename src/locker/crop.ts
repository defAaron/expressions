import { createHook } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  ACCEPTED_MEDIA_TYPES,
  CANVAS_SIZE,
  DETECTION_LONG_EDGE,
  MAX_UPLOAD_BYTES,
  MAX_UPSCALE,
  type LockerRejection,
  type Point,
  type Rect,
  type RgbaImage,
  type SmileLandmarks,
} from "./types";

const MAX_DECODE_PIXELS = 8192 * 8192;
const FACE_PORTION = 0.55;
const MODEL_PATH = path.join(process.cwd(), "models", "face_landmarker.task");

const require = createRequire(import.meta.url);

export type DetectedFace = {
  box: { x: number; y: number; width: number; height: number };
  bothEyesVisible: boolean;
  landmarks: SmileLandmarks;
};

export type FaceDetector = (image: RgbaImage) => Promise<DetectedFace[]>;

export type CropSuccess = {
  ok: true;
  image: RgbaImage;
  landmarks: SmileLandmarks;
};

export type CropFailure = { ok: false; rejection: LockerRejection };

type Square = { left: number; top: number; side: number };

type CropWindow = Square & {
  extractLeft: number;
  extractTop: number;
  padLeft: number;
  padTop: number;
  padRight: number;
  padBottom: number;
};

function host(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function reject(code: LockerRejection["code"], message: string): CropFailure {
  return { ok: false, rejection: { code, message } };
}

function sniffedType(bytes: Uint8Array): (typeof ACCEPTED_MEDIA_TYPES)[number] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
    const webp = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return null;
}

function mediaTypeMatches(bytes: Uint8Array, mediaType: string): boolean {
  if (!(ACCEPTED_MEDIA_TYPES as readonly string[]).includes(mediaType)) return false;
  return sniffedType(bytes) === mediaType;
}

async function decodeUpload(bytes: Uint8Array): Promise<RgbaImage | null> {
  try {
    const { data, info } = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_DECODE_PIXELS,
      pages: 1,
      animated: false,
      autoOrient: true,
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      info.channels !== 4 ||
      info.width < 1 ||
      info.height < 1 ||
      info.width * info.height > MAX_DECODE_PIXELS
    ) {
      return null;
    }
    return {
      width: info.width,
      height: info.height,
      data: new Uint8Array(data),
    };
  } catch {
    return null;
  }
}

function detectionSize(width: number, height: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= DETECTION_LONG_EDGE) return { width, height };
  if (width >= height) {
    return {
      width: DETECTION_LONG_EDGE,
      height: Math.max(1, Math.round((height * DETECTION_LONG_EDGE) / width)),
    };
  }
  return {
    width: Math.max(1, Math.round((width * DETECTION_LONG_EDGE) / height)),
    height: DETECTION_LONG_EDGE,
  };
}

async function detectionImage(image: RgbaImage): Promise<RgbaImage> {
  const size = detectionSize(image.width, image.height);
  if (size.width === image.width && size.height === image.height) return image;
  const { data, info } = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .resize(size.width, size.height, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data),
  };
}

function scalePoint(point: Point, factor: number): Point {
  return { x: point.x * factor, y: point.y * factor };
}

function scaleRect(rect: Rect, factor: number): Rect {
  return {
    x: rect.x * factor,
    y: rect.y * factor,
    width: rect.width * factor,
    height: rect.height * factor,
  };
}

function scaleLandmarks(landmarks: SmileLandmarks, factor: number): SmileLandmarks {
  return {
    leftEye: scaleRect(landmarks.leftEye, factor),
    rightEye: scaleRect(landmarks.rightEye, factor),
    leftEyeCenter: scalePoint(landmarks.leftEyeCenter, factor),
    rightEyeCenter: scalePoint(landmarks.rightEyeCenter, factor),
    betweenPupils: scalePoint(landmarks.betweenPupils, factor),
    mouthCenter: scalePoint(landmarks.mouthCenter, factor),
    noseBridge: scalePoint(landmarks.noseBridge, factor),
    leftPupil: scalePoint(landmarks.leftPupil, factor),
    rightPupil: scalePoint(landmarks.rightPupil, factor),
    leftOuterCorner: scalePoint(landmarks.leftOuterCorner, factor),
    rightOuterCorner: scalePoint(landmarks.rightOuterCorner, factor),
  };
}

function scaleFace(face: DetectedFace, factor: number): DetectedFace {
  if (factor === 1) return face;
  return {
    box: scaleRect(face.box, factor),
    bothEyesVisible: face.bothEyesVisible,
    landmarks: scaleLandmarks(face.landmarks, factor),
  };
}

function placeSquare(box: Rect, width: number, height: number): Square | null {
  const faceSpan = Math.max(box.width, box.height);
  const side = faceSpan / FACE_PORTION;
  if (!Number.isFinite(side) || side <= 0) return null;
  if (CANVAS_SIZE / side > MAX_UPSCALE) return null;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  let left = centerX - side / 2;
  let top = centerY - side / 2;
  if (side <= width) left = Math.min(Math.max(left, 0), width - side);
  if (side <= height) top = Math.min(Math.max(top, 0), height - side);
  return { left, top, side };
}

function mapPoint(point: Point, square: Square, scale: number): Point {
  return {
    x: (point.x - square.left) * scale,
    y: (point.y - square.top) * scale,
  };
}

function mapRect(rect: Rect, square: Square, scale: number): Rect {
  return {
    x: (rect.x - square.left) * scale,
    y: (rect.y - square.top) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

function mapLandmarks(landmarks: SmileLandmarks, square: Square): SmileLandmarks {
  const scale = CANVAS_SIZE / square.side;
  return {
    leftEye: mapRect(landmarks.leftEye, square, scale),
    rightEye: mapRect(landmarks.rightEye, square, scale),
    leftEyeCenter: mapPoint(landmarks.leftEyeCenter, square, scale),
    rightEyeCenter: mapPoint(landmarks.rightEyeCenter, square, scale),
    betweenPupils: mapPoint(landmarks.betweenPupils, square, scale),
    mouthCenter: mapPoint(landmarks.mouthCenter, square, scale),
    noseBridge: mapPoint(landmarks.noseBridge, square, scale),
    leftPupil: mapPoint(landmarks.leftPupil, square, scale),
    rightPupil: mapPoint(landmarks.rightPupil, square, scale),
    leftOuterCorner: mapPoint(landmarks.leftOuterCorner, square, scale),
    rightOuterCorner: mapPoint(landmarks.rightOuterCorner, square, scale),
  };
}

// sharp extract is integer pixels. Landmarks use this same rectangle, in
// original-image coordinates (negative when the square hangs off the photo).
function integerCropWindow(width: number, height: number, square: Square): CropWindow {
  const padLeft = square.left < 0 ? Math.ceil(-square.left) : 0;
  const padTop = square.top < 0 ? Math.ceil(-square.top) : 0;
  const padRight =
    square.left + square.side > width ? Math.ceil(square.left + square.side - width) : 0;
  const padBottom =
    square.top + square.side > height ? Math.ceil(square.top + square.side - height) : 0;
  const paddedWidth = width + padLeft + padRight;
  const paddedHeight = height + padTop + padBottom;

  let extractLeft = Math.round(square.left + padLeft);
  let extractTop = Math.round(square.top + padTop);
  let side = Math.max(1, Math.round(square.side));
  if (extractLeft < 0) extractLeft = 0;
  if (extractTop < 0) extractTop = 0;
  if (extractLeft + side > paddedWidth) extractLeft = Math.max(0, paddedWidth - side);
  if (extractTop + side > paddedHeight) extractTop = Math.max(0, paddedHeight - side);
  if (extractLeft + side > paddedWidth || extractTop + side > paddedHeight) {
    side = Math.max(1, Math.min(paddedWidth - extractLeft, paddedHeight - extractTop));
  }
  extractLeft = Math.min(extractLeft, Math.max(0, paddedWidth - 1));
  extractTop = Math.min(extractTop, Math.max(0, paddedHeight - 1));
  side = Math.max(1, Math.min(side, paddedWidth - extractLeft, paddedHeight - extractTop));

  return {
    left: extractLeft - padLeft,
    top: extractTop - padTop,
    side,
    extractLeft,
    extractTop,
    padLeft,
    padTop,
    padRight,
    padBottom,
  };
}

async function renderSquare(image: RgbaImage, window: CropWindow): Promise<RgbaImage> {
  // sharp applies extract to the original input, so padding has to be
  // materialized before the square is cut out of it.
  let source = image;
  if (window.padLeft || window.padTop || window.padRight || window.padBottom) {
    const extended = await sharp(image.data, {
      raw: { width: image.width, height: image.height, channels: 4 },
    })
      .extend({
        left: window.padLeft,
        top: window.padTop,
        right: window.padRight,
        bottom: window.padBottom,
        extendWith: "copy",
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    source = {
      width: extended.info.width,
      height: extended.info.height,
      data: new Uint8Array(extended.data),
    };
  }

  const { data, info } = await sharp(source.data, {
    raw: { width: source.width, height: source.height, channels: 4 },
  })
    .extract({
      left: window.extractLeft,
      top: window.extractTop,
      width: window.side,
      height: window.side,
    })
    .resize(CANVAS_SIZE, CANVAS_SIZE, { kernel: "lanczos3", fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== CANVAS_SIZE || info.height !== CANVAS_SIZE || info.channels !== 4) {
    throw new Error("Smile resize did not produce a 1024 RGBA image.");
  }

  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data),
  };
}

export async function cropToSmile(
  input: { bytes: Uint8Array; mediaType: string },
  detect: FaceDetector,
): Promise<CropSuccess | CropFailure> {
  if (!mediaTypeMatches(input.bytes, input.mediaType)) {
    return reject("unsupported-type", "Upload must be a JPEG, PNG, or WebP.");
  }
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    return reject("too-large", "Upload is larger than 15 MB.");
  }

  const decoded = await decodeUpload(input.bytes);
  if (!decoded) {
    return reject("decode-failed", "Upload could not be decoded.");
  }

  const detection = await detectionImage(decoded);
  const faces = await detect(detection);
  if (faces.length === 0) {
    return reject("no-face", "No face found.");
  }
  if (faces.length > 1) {
    return reject("multiple-faces", "More than one face found.");
  }
  const found = faces[0]!;
  if (!found.bothEyesVisible) {
    return reject("eyes-not-visible", "Both eyes need to be visible.");
  }

  const toOriginal =
    Math.max(decoded.width, decoded.height) /
    Math.max(detection.width, detection.height);
  const face = scaleFace(found, toOriginal);
  const square = placeSquare(face.box, decoded.width, decoded.height);
  if (!square) {
    return reject(
      "upscale-too-large",
      "Face is too small to fill 1024 without upscaling past 1.5×.",
    );
  }

  const window = integerCropWindow(decoded.width, decoded.height, square);
  const image = await renderSquare(decoded, window);
  return {
    ok: true,
    image,
    landmarks: mapLandmarks(face.landmarks, window),
  };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function wasmModulePath(): string {
  return require.resolve("@mediapipe/tasks-vision/vision_wasm_module_internal.js");
}

let moduleFactory: ((moduleArg?: object) => Promise<unknown>) | undefined;

async function ensureModuleFactory(): Promise<void> {
  const globals = host();
  if (typeof globals.ModuleFactory === "function") return;
  if (!moduleFactory) {
    const loaded = (await import(pathToFileURL(wasmModulePath()).href)) as { default?: unknown };
    if (typeof loaded.default !== "function") {
      throw new Error("Local face-landmarker wasm did not load. Refusing to download it.");
    }
    moduleFactory = loaded.default as (moduleArg?: object) => Promise<unknown>;
  }
  globals.ModuleFactory = moduleFactory;
}

type HeadlessGL = ((
  width: number,
  height: number,
  options?: Record<string, unknown>,
) => WebGLRenderingContext | null) & {
  WebGLRenderingContext?: new (...args: never[]) => WebGLRenderingContext;
};

type RgbaUpload = {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
};

const canvasGL = new WeakMap<NodeOffscreenCanvas, WebGLRenderingContext>();
let webglCreated: WebGLRenderingContext[] | undefined;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function headlessGL(): HeadlessGL {
  let loaded: unknown;
  try {
    loaded = require("gl");
  } catch (error) {
    throw new Error(`headless-gl failed to load: ${errorText(error)}`);
  }
  if (typeof loaded !== "function") {
    throw new Error("headless-gl failed to load: package did not export a context factory.");
  }
  return loaded as HeadlessGL;
}

function isRgbaUpload(value: unknown): value is RgbaUpload {
  if (typeof value !== "object" || value === null) return false;
  const source = value as { width?: unknown; height?: unknown; data?: unknown };
  const { width, height, data } = source;
  if (typeof width !== "number" || typeof height !== "number") return false;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return false;
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) return false;
  return data.length >= width * height * 4;
}

function rgbaBytes(data: Uint8Array | Uint8ClampedArray, needed: number): Uint8Array {
  const bytes =
    data.constructor === Uint8Array
      ? data
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return bytes.length === needed ? bytes : bytes.subarray(0, needed);
}

// detect() calls texImage2D(target, level, internalFormat, format, type, image).
// Store those pixels with headless-gl's width/height overload; leave every other call on the real context.
function wrapWebGL(raw: WebGLRenderingContext, canvas: NodeOffscreenCanvas): WebGLRenderingContext {
  const upload = raw.texImage2D.bind(raw) as (...args: unknown[]) => void;
  const texImage2D = (...args: unknown[]): void => {
    if (args.length === 6 && isRgbaUpload(args[5])) {
      const source = args[5];
      upload(
        args[0],
        args[1],
        args[2],
        source.width,
        source.height,
        0,
        args[3],
        args[4],
        rgbaBytes(source.data, source.width * source.height * 4),
      );
      return;
    }
    upload(...args);
  };

  return new Proxy(raw, {
    get(target, prop) {
      if (prop === "texImage2D") return texImage2D;
      if (prop === "canvas") return canvas;
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value === "function") return (value as (...args: unknown[]) => unknown).bind(target);
      return value;
    },
    set(target, prop, value) {
      if (prop === "canvas") return true;
      Reflect.set(target, prop, value, target);
      return true;
    },
  });
}

function publishWebGLConstructor(factory: HeadlessGL, raw: object): void {
  const ctor = factory.WebGLRenderingContext;
  if (typeof ctor !== "function") {
    throw new Error(
      "headless-gl failed to create a WebGL context: WebGLRenderingContext export is missing.",
    );
  }
  const globals = host();
  if (typeof globals.WebGLRenderingContext !== "function") {
    globals.WebGLRenderingContext = ctor;
  }
  const published = globals.WebGLRenderingContext;
  if (typeof published !== "function" || !(raw instanceof published)) {
    throw new Error("headless-gl context is not a WebGLRenderingContext.");
  }
}

function createFaceWebGL(width: number, height: number, canvas: NodeOffscreenCanvas): WebGLRenderingContext {
  const factory = headlessGL();
  let raw: WebGLRenderingContext | null = null;
  try {
    raw = factory(width, height, {
      preserveDrawingBuffer: true,
      antialias: false,
      alpha: true,
      depth: true,
      stencil: false,
    });
  } catch (error) {
    throw new Error(`headless-gl failed to create a WebGL context: ${errorText(error)}`);
  }
  if (!raw) {
    throw new Error("headless-gl failed to create a WebGL context.");
  }
  publishWebGLConstructor(factory, raw);
  const wrapped = wrapWebGL(raw, canvas);
  const published = host().WebGLRenderingContext;
  if (typeof published !== "function" || !(wrapped instanceof published)) {
    throw new Error("headless-gl context is not a WebGLRenderingContext.");
  }
  webglCreated?.push(wrapped);
  return wrapped;
}

function releaseWebGL(gl: WebGLRenderingContext): void {
  try {
    const ext = gl.getExtension("STACKGL_destroy_context") as { destroy?: () => void } | null;
    ext?.destroy?.();
  } catch {
    // The graph may already have released this context.
  }
}

export class NodeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
  }
  // webgl2 stays null so tasks-vision falls through to this WebGL 1 context.
  getContext(kind?: string): WebGLRenderingContext | null {
    if (kind !== "webgl") return null;
    const existing = canvasGL.get(this);
    if (existing) return existing;
    const gl = createFaceWebGL(Math.max(1, this.width), Math.max(1, this.height), this);
    canvasGL.set(this, gl);
    return gl;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

class NodeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace = "srgb" as const;
  constructor(data: Uint8ClampedArray, width: number, height?: number) {
    const nextHeight = height ?? data.length / 4 / width;
    if (!Number.isInteger(nextHeight) || data.length !== width * nextHeight * 4) {
      throw new Error("ImageData length does not match its dimensions.");
    }
    this.data = data;
    this.width = width;
    this.height = nextHeight;
  }
}

function installNodeCanvas(): () => void {
  const globals = host();
  const hadCanvas = typeof globals.OffscreenCanvas === "function";
  const hadImageData = typeof globals.ImageData === "function";
  if (!hadCanvas) {
    globals.OffscreenCanvas = NodeOffscreenCanvas;
  }
  if (!hadImageData) {
    globals.ImageData = NodeImageData;
  }
  return () => {
    if (!hadCanvas) restoreHost("OffscreenCanvas", undefined);
    if (!hadImageData) restoreHost("ImageData", undefined);
  };
}

// Model init arms a 60s logger that later POSTs to Google. Drop timers created
// during the attempt so a rejected model cannot send that request.
function captureIntervals(): () => void {
  const timers: NodeJS.Timeout[] = [];
  const hook = createHook({
    init(_asyncId, type, _triggerAsyncId, resource) {
      if (type === "Timeout") timers.push(resource as NodeJS.Timeout);
    },
  });
  hook.enable();
  return () => {
    hook.disable();
    for (const timer of timers) clearInterval(timer);
  };
}

function imageSource(image: RgbaImage): ImageData {
  return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
}

let runtimeGate: Promise<void> = Promise.resolve();

function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = runtimeGate.then(run, run);
  runtimeGate = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Image-left is the viewer's left, which is the person's right eye on a front-facing photo.
const PERSON_RIGHT_EYE = {
  outer: 33,
  inner: 133,
  iris: 468,
  contour: [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173],
};
const PERSON_LEFT_EYE = {
  outer: 263,
  inner: 362,
  iris: 473,
  contour: [263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398],
};
const NOSE_BRIDGE = 6;
const UPPER_LIP = 13;
const LOWER_LIP = 14;

type NormalizedLandmark = { x: number; y: number; visibility?: number };

function pixelPoint(landmark: NormalizedLandmark, width: number, height: number): Point {
  return { x: landmark.x * width, y: landmark.y * height };
}

function boundsOf(points: Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function insideImage(point: Point, width: number, height: number): boolean {
  return point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height;
}

function eyesVisible(
  width: number,
  height: number,
  leftOuter: Point,
  rightOuter: Point,
  leftInner: Point,
  rightInner: Point,
  leftPupil: Point,
  rightPupil: Point,
): boolean {
  const leftWidth = Math.hypot(leftOuter.x - leftInner.x, leftOuter.y - leftInner.y);
  const rightWidth = Math.hypot(rightOuter.x - rightInner.x, rightOuter.y - rightInner.y);
  if (leftWidth < 1 || rightWidth < 1) return false;
  const ratio = Math.min(leftWidth, rightWidth) / Math.max(leftWidth, rightWidth);
  if (ratio < 0.45) return false;
  return [leftOuter, rightOuter, leftPupil, rightPupil].every((point) =>
    insideImage(point, width, height),
  );
}

function faceFromLandmarks(
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
): DetectedFace {
  if (landmarks.length <= PERSON_LEFT_EYE.iris) {
    throw new Error("Face landmarker returned too few landmarks.");
  }
  const at = (index: number) => pixelPoint(landmarks[index]!, width, height);
  const leftOuter = at(PERSON_RIGHT_EYE.outer);
  const rightOuter = at(PERSON_LEFT_EYE.outer);
  const leftInner = at(PERSON_RIGHT_EYE.inner);
  const rightInner = at(PERSON_LEFT_EYE.inner);
  const leftPupil = at(PERSON_RIGHT_EYE.iris);
  const rightPupil = at(PERSON_LEFT_EYE.iris);
  const leftEye = boundsOf(PERSON_RIGHT_EYE.contour.map((index) => at(index)));
  const rightEye = boundsOf(PERSON_LEFT_EYE.contour.map((index) => at(index)));
  const upperLip = at(UPPER_LIP);
  const lowerLip = at(LOWER_LIP);
  return {
    box: boundsOf(landmarks.map((landmark) => pixelPoint(landmark, width, height))),
    bothEyesVisible: eyesVisible(
      width,
      height,
      leftOuter,
      rightOuter,
      leftInner,
      rightInner,
      leftPupil,
      rightPupil,
    ),
    landmarks: {
      leftEye,
      rightEye,
      leftEyeCenter: {
        x: (leftOuter.x + leftInner.x) / 2,
        y: (leftOuter.y + leftInner.y) / 2,
      },
      rightEyeCenter: {
        x: (rightOuter.x + rightInner.x) / 2,
        y: (rightOuter.y + rightInner.y) / 2,
      },
      betweenPupils: {
        x: (leftPupil.x + rightPupil.x) / 2,
        y: (leftPupil.y + rightPupil.y) / 2,
      },
      mouthCenter: {
        x: (upperLip.x + lowerLip.x) / 2,
        y: (upperLip.y + lowerLip.y) / 2,
      },
      noseBridge: at(NOSE_BRIDGE),
      leftPupil,
      rightPupil,
      leftOuterCorner: leftOuter,
      rightOuterCorner: rightOuter,
    },
  };
}

function refusingFetch(input: RequestInfo | URL): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    throw new Error("Refusing to download a face model.");
  }
  throw new Error("Refusing to fetch while detecting a face.");
}

async function detectWithLocalModel(
  image: RgbaImage,
  modelBytes: Uint8Array,
): Promise<DetectedFace[]> {
  const createdWebGL: WebGLRenderingContext[] = [];
  const previousWebGL = webglCreated;
  webglCreated = createdWebGL;
  const globals = host();
  const previous = {
    self: globals.self,
    require: globals.require,
    importScripts: globals.importScripts,
    fetch: globalThis.fetch,
    ModuleFactory: globals.ModuleFactory,
  };
  const releaseCanvas = installNodeCanvas();
  const releaseIntervals = captureIntervals();
  globals.self = globalThis;
  globals.require = require;
  globals.importScripts = () => {
    throw new TypeError("Load face-landmarker wasm from disk.");
  };
  globalThis.fetch = refusingFetch as typeof fetch;

  try {
    await ensureModuleFactory();
    const vision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks(
      pathToFileURL(path.dirname(wasmModulePath())).href,
      true,
    );
    const landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: modelBytes, delegate: "CPU" },
      runningMode: "IMAGE",
      numFaces: 5,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
    try {
      const result = landmarker.detect(imageSource(image));
      return result.faceLandmarks.map((landmarks) =>
        faceFromLandmarks(landmarks, image.width, image.height),
      );
    } finally {
      landmarker.close();
    }
  } finally {
    releaseIntervals();
    releaseCanvas();
    restoreHost("self", previous.self);
    restoreHost("require", previous.require);
    restoreHost("importScripts", previous.importScripts);
    restoreHost("ModuleFactory", previous.ModuleFactory);
    globalThis.fetch = previous.fetch;
    webglCreated = previousWebGL;
    for (const gl of createdWebGL) releaseWebGL(gl);
  }
}

function restoreHost(key: string, value: unknown): void {
  const globals = host();
  if (value !== undefined) {
    globals[key] = value;
    return;
  }
  try {
    delete globals[key];
  } catch {
    globals[key] = undefined;
  }
}

export function createMediaPipeDetector(modelPath: string = MODEL_PATH): FaceDetector {
  return (image) =>
    exclusive(async () => {
      let modelBytes: Buffer;
      try {
        modelBytes = await readFile(modelPath);
      } catch (error) {
        if (isEnoent(error)) {
          throw new Error(
            `Face landmarker model is absent at ${modelPath}. Refusing to download a face model.`,
          );
        }
        throw error;
      }
      return detectWithLocalModel(image, new Uint8Array(modelBytes));
    });
}
