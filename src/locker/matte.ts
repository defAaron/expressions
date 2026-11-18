import { createHook } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import * as nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { NodeOffscreenCanvas } from "./crop";
import type { RgbaImage } from "./types";

const MODEL_PATH = path.join(process.cwd(), "models", "selfie_segmenter.tflite");

/**
 * High confidence on this model is the person (hair, face, clothes).
 * A corner of a real smile is background and stays near 0; hair and jacket stay near 255.
 */
export const PERSON_CONFIDENCE_IS_PERSON = true;

const PERSON_LABEL = /selfie|person|foreground/i;
const BACKGROUND_LABEL = /background/i;

const nodeRequire = nodeModule.createRequire(import.meta.url);

function host(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isModuleNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "MODULE_NOT_FOUND"
  );
}

function resolveFromProject(specifier: string): string {
  const fromProject = nodeModule.createRequire(path.join(process.cwd(), "package.json"));
  return fromProject.resolve(specifier);
}

function wasmModulePath(): string {
  const specifier = "@mediapipe/tasks-vision/vision_wasm_module_internal.js";
  try {
    return nodeRequire.resolve(specifier);
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
    return resolveFromProject(specifier);
  }
}

let moduleFactory: ((moduleArg?: object) => Promise<unknown>) | undefined;

function nativeImport(href: string): Promise<unknown> {
  return import(
    /* webpackIgnore: true */
    /* @vite-ignore */
    href
  );
}

async function ensureModuleFactory(): Promise<void> {
  const globals = host();
  if (typeof globals.ModuleFactory === "function") return;
  if (!moduleFactory) {
    const href = pathToFileURL(wasmModulePath()).href;
    const loaded = (await import(
      /* webpackIgnore: true */
      /* @vite-ignore */
      href
    )) as { default?: unknown };
    if (typeof loaded.default !== "function") {
      throw new Error("Local selfie segmenter wasm did not load. Refusing to download it.");
    }
    moduleFactory = loaded.default as (moduleArg?: object) => Promise<unknown>;
  }
  globals.ModuleFactory = moduleFactory;
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

function refusingFetch(input: RequestInfo | URL): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    throw new Error("Refusing to download a face model.");
  }
  throw new Error("Refusing to fetch while segmenting a face.");
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

let recording: NodeOffscreenCanvas[] | undefined;

class RecordingCanvas extends NodeOffscreenCanvas {
  constructor(width = 0, height = 0) {
    super(width, height);
    recording?.push(this);
  }
}

function installNodeCanvas(): () => void {
  const globals = host();
  const hadCanvas = typeof globals.OffscreenCanvas === "function";
  const hadImageData = typeof globals.ImageData === "function";
  if (!hadCanvas) {
    globals.OffscreenCanvas = RecordingCanvas;
  }
  if (!hadImageData) {
    globals.ImageData = NodeImageData;
  }
  return () => {
    if (!hadCanvas) restoreHost("OffscreenCanvas", undefined);
    if (!hadImageData) restoreHost("ImageData", undefined);
  };
}

function releaseCanvas(canvas: NodeOffscreenCanvas): void {
  try {
    const gl = canvas.getContext("webgl");
    const ext = gl?.getExtension("STACKGL_destroy_context") as { destroy?: () => void } | null;
    ext?.destroy?.();
  } catch {
    // The graph may already have released this context.
  }
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

export function personMaskIndex(labels: readonly string[], maskCount: number): number {
  if (maskCount < 1) {
    throw new Error("Selfie segmenter returned no confidence mask.");
  }
  for (let index = 0; index < labels.length && index < maskCount; index += 1) {
    if (PERSON_LABEL.test(labels[index] ?? "")) return index;
  }
  for (let index = 0; index < labels.length && index < maskCount; index += 1) {
    if (!BACKGROUND_LABEL.test(labels[index] ?? "")) continue;
    if (maskCount === 1) return 0;
    return index === 0 ? 1 : 0;
  }
  return 0;
}

/** Map model confidence to one byte per pixel. 0 is background, 255 is person. */
export function confidenceToMatteBytes(
  confidence: ArrayLike<number>,
  personIsHigh: boolean,
): Uint8Array {
  const out = new Uint8Array(confidence.length);
  for (let index = 0; index < confidence.length; index += 1) {
    let value = confidence[index] ?? 0;
    if (!Number.isFinite(value)) value = 0;
    if (!personIsHigh) value = 1 - value;
    if (value < 0) value = 0;
    if (value > 1) value = 1;
    out[index] = Math.round(value * 255);
  }
  return out;
}

export async function resizeMatte(
  bytes: Uint8Array,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
): Promise<Uint8Array> {
  if (width === targetWidth && height === targetHeight) {
    return new Uint8Array(bytes);
  }
  const { data, info } = await sharp(Buffer.from(bytes), {
    raw: { width, height, channels: 1 },
  })
    .resize(targetWidth, targetHeight, { fit: "fill", kernel: "lanczos3" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || info.width !== targetWidth || info.height !== targetHeight) {
    throw new Error("Matte resize did not match the smile.");
  }
  return new Uint8Array(data);
}

export async function encodePersonMatteWebp(
  matte: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  if (matte.length !== width * height) {
    throw new Error("Matte length does not match its dimensions.");
  }
  return sharp(Buffer.from(matte), { raw: { width, height, channels: 1 } })
    .webp({ lossless: true })
    .toBuffer();
}

type ConfidenceMask = {
  width: number;
  height: number;
  getAsFloat32Array: () => Float32Array;
};

type SegmentResult = {
  confidenceMasks?: ConfidenceMask[];
  close: () => void;
};

type Segmenter = {
  getLabels: () => string[];
  segment: (image: ImageData) => SegmentResult;
  close: () => void;
};

async function segmentWithLocalModel(
  image: RgbaImage,
  modelBytes: Uint8Array,
): Promise<Uint8Array> {
  const created: NodeOffscreenCanvas[] = [];
  const previousRecording = recording;
  recording = created;
  const globals = host();
  const previous = {
    self: globals.self,
    require: globals.require,
    importScripts: globals.importScripts,
    importer: globals["import"],
    fetch: globalThis.fetch,
    ModuleFactory: globals.ModuleFactory,
  };
  const releaseCanvasInstall = installNodeCanvas();
  const releaseIntervals = captureIntervals();
  globals.self = globalThis;
  globals.require = nodeRequire;
  globals["import"] = nativeImport;
  globals.importScripts = () => {
    throw new TypeError("Load selfie segmenter wasm from disk.");
  };
  globalThis.fetch = refusingFetch as typeof fetch;

  let segmenter: Segmenter | undefined;
  try {
    await ensureModuleFactory();
    const vision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks(
      pathToFileURL(path.dirname(wasmModulePath())).href,
      true,
    );
    segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: modelBytes, delegate: "CPU" },
      runningMode: "IMAGE",
      outputConfidenceMasks: true,
    });
    const result = segmenter.segment(imageSource(image));
    try {
      const masks = result.confidenceMasks;
      if (!masks || masks.length === 0) {
        throw new Error("Selfie segmenter returned no confidence mask.");
      }
      const mask = masks[personMaskIndex(segmenter.getLabels(), masks.length)];
      if (!mask || mask.width < 1 || mask.height < 1) {
        throw new Error("Selfie segmenter returned an empty confidence mask.");
      }
      const needed = mask.width * mask.height;
      const view = mask.getAsFloat32Array();
      if (view.length < needed) {
        throw new Error("Selfie segmenter confidence mask is shorter than its dimensions.");
      }
      const confidence =
        view.length === needed ? new Float32Array(view) : new Float32Array(view.subarray(0, needed));
      const bytes = confidenceToMatteBytes(confidence, PERSON_CONFIDENCE_IS_PERSON);
      return await resizeMatte(bytes, mask.width, mask.height, image.width, image.height);
    } finally {
      result.close();
    }
  } finally {
    segmenter?.close();
    releaseIntervals();
    releaseCanvasInstall();
    restoreHost("self", previous.self);
    restoreHost("require", previous.require);
    restoreHost("importScripts", previous.importScripts);
    restoreHost("import", previous.importer);
    restoreHost("ModuleFactory", previous.ModuleFactory);
    globalThis.fetch = previous.fetch;
    recording = previousRecording;
    for (const canvas of created) releaseCanvas(canvas);
  }
}

export function personMatte(
  image: RgbaImage,
  modelPath: string = MODEL_PATH,
): Promise<Uint8Array> {
  if (process.env.VERCEL) {
    return import("./vercel-vision").then(async ({ infer }) => {
      const { matte, width, height } = await infer(image, "segment");
      if (!matte || !width || !height) throw new Error("Missing segmentation result");
      return resizeMatte(Buffer.from(matte, "base64"), width, height, image.width, image.height);
    });
  }
  return exclusive(async () => {
    let modelBytes: Buffer;
    try {
      modelBytes = await readFile(modelPath);
    } catch (error) {
      if (isEnoent(error)) {
        throw new Error(
          `Selfie segmenter model is absent at ${modelPath}. Refusing to download a face model.`,
        );
      }
      throw error;
    }
    return segmentWithLocalModel(image, new Uint8Array(modelBytes));
  });
}
