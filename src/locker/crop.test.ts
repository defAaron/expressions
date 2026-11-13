import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  createMediaPipeDetector,
  cropToSmile,
  NodeOffscreenCanvas,
  type DetectedFace,
  type FaceDetector,
} from "./crop";
import {
  CANVAS_SIZE,
  MAX_UPLOAD_BYTES,
  MAX_UPSCALE,
  type Point,
  type Rect,
  type RgbaImage,
  type SmileLandmarks,
} from "./types";

const PIXEL_LIMIT = 8192 * 8192;

function startsWithJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function startsWithPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function isWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const riff = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  const webp = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
  return riff === "RIFF" && webp === "WEBP";
}

async function encode(
  format: "jpeg" | "png" | "webp",
  width: number,
  height: number,
  raw?: Buffer,
): Promise<Uint8Array> {
  const channels = 3;
  const input = raw ?? Buffer.alloc(width * height * channels, 180);
  const pipeline = sharp(input, { raw: { width, height, channels } });
  const encoded =
    format === "jpeg" ? pipeline.jpeg() : format === "png" ? pipeline.png() : pipeline.webp();
  return new Uint8Array(await encoded.toBuffer());
}

function gradientRaw(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = x & 255;
      raw[i + 1] = y & 255;
      raw[i + 2] = (x * 3 + y) & 255;
    }
  }
  return raw;
}

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

function point(x: number, y: number): Point {
  return { x, y };
}

function landmarksAt(patch: Partial<SmileLandmarks> = {}): SmileLandmarks {
  const origin = point(0, 0);
  const eye = rect(0, 0, 10, 8);
  return {
    leftEye: eye,
    rightEye: rect(20, 0, 12, 9),
    leftEyeCenter: origin,
    rightEyeCenter: origin,
    betweenPupils: origin,
    mouthCenter: origin,
    noseBridge: origin,
    leftPupil: origin,
    rightPupil: origin,
    leftOuterCorner: origin,
    rightOuterCorner: origin,
    ...patch,
  };
}

function face(
  box: Rect,
  bothEyesVisible = true,
  patch: Partial<SmileLandmarks> = {},
): DetectedFace {
  const center = point(box.x + box.width / 2, box.y + box.height / 2);
  return {
    box,
    bothEyesVisible,
    landmarks: landmarksAt({
      betweenPupils: center,
      leftEyeCenter: center,
      rightEyeCenter: center,
      mouthCenter: center,
      noseBridge: center,
      leftPupil: center,
      rightPupil: center,
      leftOuterCorner: center,
      rightOuterCorner: center,
      ...patch,
    }),
  };
}

function recordingDetector(faces: DetectedFace[]): {
  detect: FaceDetector;
  calls: RgbaImage[];
} {
  const calls: RgbaImage[] = [];
  const detect: FaceDetector = async (image) => {
    calls.push(image);
    return faces;
  };
  return { detect, calls };
}

function rejectionCode(result: { ok: boolean; rejection?: { code: string } }): string {
  return result.ok ? "ok" : (result.rejection?.code ?? "");
}

function firstMismatch(actual: Uint8Array, expected: Uint8Array): string {
  if (actual.length !== expected.length) {
    return `length ${actual.length} !== ${expected.length}`;
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      return `byte ${i}: ${actual[i]} !== ${expected[i]}`;
    }
  }
  return "";
}

describe("cropToSmile", () => {
  it.each([
    ["jpeg", "image/jpeg", startsWithJpeg],
    ["png", "image/png", startsWithPng],
    ["webp", "image/webp", isWebp],
  ] as const)(
    "accepts %s magic bytes that match the media type and calls the detector",
    async (format, mediaType, matches) => {
      const width = 48;
      const height = 36;
      const bytes = await encode(format, width, height);
      expect(matches(bytes)).toBe(true);
      const { detect, calls } = recordingDetector([]);

      await cropToSmile({ bytes, mediaType }, detect);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.width).toBe(width);
      expect(calls[0]!.height).toBe(height);
      expect(calls[0]!.data.length).toBe(width * height * 4);
    },
  );

  it("rejects an unknown media type without calling the detector", async () => {
    const bytes = await encode("jpeg", 32, 32);
    const { detect, calls } = recordingDetector([]);

    const result = await cropToSmile({ bytes, mediaType: "image/gif" }, detect);

    expect(calls).toHaveLength(0);
    expect(rejectionCode(result)).toBe("unsupported-type");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.message.length).toBeGreaterThan(0);
  });

  it("rejects a PNG labeled as JPEG without calling the detector", async () => {
    const bytes = await encode("png", 32, 32);
    expect(startsWithPng(bytes)).toBe(true);
    const { detect, calls } = recordingDetector([]);

    const result = await cropToSmile({ bytes, mediaType: "image/jpeg" }, detect);

    expect(calls).toHaveLength(0);
    expect(rejectionCode(result)).toBe("unsupported-type");
  });

  it("rejects RIFF bytes that are not WebP", async () => {
    const bytes = new Uint8Array(12);
    bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    const { detect, calls } = recordingDetector([]);

    const result = await cropToSmile({ bytes, mediaType: "image/webp" }, detect);

    expect(calls).toHaveLength(0);
    expect(rejectionCode(result)).toBe("unsupported-type");
  });

  it("rejects an upload over the byte limit before decode and without the detector", async () => {
    const bytes = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    bytes[2] = 0xff;
    const { detect, calls } = recordingDetector([]);

    const result = await cropToSmile({ bytes, mediaType: "image/jpeg" }, detect);

    expect(calls).toHaveLength(0);
    expect(rejectionCode(result)).toBe("too-large");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.message.length).toBeGreaterThan(0);
  });

  it("checks the media type before the byte limit", async () => {
    const bytes = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    bytes[2] = 0xff;
    const { detect, calls } = recordingDetector([]);

    const result = await cropToSmile({ bytes, mediaType: "image/gif" }, detect);

    expect(calls).toHaveLength(0);
    expect(rejectionCode(result)).toBe("unsupported-type");
  });

  it("rejects bytes that match JPEG but do not decode", async () => {
    const bytes = Uint8Array.of(0xff, 0xd8, 0xff, 0x00);
    const { detect, calls } = recordingDetector([]);

    const result = await cropToSmile({ bytes, mediaType: "image/jpeg" }, detect);

    expect(calls).toHaveLength(0);
    expect(rejectionCode(result)).toBe("decode-failed");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.message.length).toBeGreaterThan(0);
  });

  it("rejects zero faces", async () => {
    const bytes = await encode("png", 64, 64);
    const { detect, calls } = recordingDetector([]);

    const result = await cropToSmile({ bytes, mediaType: "image/png" }, detect);

    expect(calls).toHaveLength(1);
    expect(rejectionCode(result)).toBe("no-face");
  });

  it("rejects two faces", async () => {
    const bytes = await encode("png", 800, 800);
    const box = rect(100, 100, 400, 400);
    const { detect, calls } = recordingDetector([face(box), face(rect(100, 100, 420, 400))]);

    const result = await cropToSmile({ bytes, mediaType: "image/png" }, detect);

    expect(calls).toHaveLength(1);
    expect(rejectionCode(result)).toBe("multiple-faces");
  });

  it("rejects one face when both eyes are not visible", async () => {
    const bytes = await encode("png", 800, 800);
    const { detect, calls } = recordingDetector([face(rect(200, 200, 400, 400), false)]);

    const result = await cropToSmile({ bytes, mediaType: "image/png" }, detect);

    expect(calls).toHaveLength(1);
    expect(rejectionCode(result)).toBe("eyes-not-visible");
  });

  it("rejects a tiny face", async () => {
    const bytes = await encode("png", 400, 400);
    const { detect, calls } = recordingDetector([face(rect(10, 10, 20, 30))]);

    const result = await cropToSmile({ bytes, mediaType: "image/png" }, detect);

    expect(calls).toHaveLength(1);
    expect(MAX_UPSCALE).toBe(4);
    expect(rejectionCode(result)).toBe("upscale-too-large");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.message).toBe(
        `Face is too small to fill 1024 without upscaling past ${MAX_UPSCALE}×.`,
      );
    }
  });

  it("accepts a face whose upscale is exactly 4", async () => {
    const bytes = await encode("png", 900, 900);
    const faceSpan = (CANVAS_SIZE * 0.55) / MAX_UPSCALE;
    const { detect } = recordingDetector([
      face(rect(100, 100, faceSpan, faceSpan / 2)),
    ]);

    const result = await cropToSmile({ bytes, mediaType: "image/png" }, detect);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(CANVAS_SIZE);
    expect(result.image.height).toBe(CANVAS_SIZE);
  });

  it("accepts a face whose upscale is 2", async () => {
    const bytes = await encode("png", 900, 900);
    const faceSpan = (CANVAS_SIZE * 0.55) / 2;
    const { detect } = recordingDetector([
      face(rect(100, 100, faceSpan, faceSpan / 2)),
    ]);

    const result = await cropToSmile({ bytes, mediaType: "image/png" }, detect);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(CANVAS_SIZE);
    expect(result.image.height).toBe(CANVAS_SIZE);
  });

  it("rejects a face that needs upscale just over 4", async () => {
    const bytes = await encode("png", 900, 900);
    const faceSpan = (CANVAS_SIZE * 0.55) / (MAX_UPSCALE + 1e-4);
    expect(1024 / (faceSpan / 0.55)).toBeGreaterThan(4);
    const { detect, calls } = recordingDetector([
      face(rect(100, 100, faceSpan, faceSpan / 2)),
    ]);

    const result = await cropToSmile({ bytes, mediaType: "image/png" }, detect);

    expect(calls).toHaveLength(1);
    expect(rejectionCode(result)).toBe("upscale-too-large");
    expect(result.ok).toBe(false);
  });

  it("crops a centered face to 1024 and maps the box center to the canvas center", async () => {
    expect(CANVAS_SIZE).toBe(1024);
    const width = 1000;
    const height = 1000;
    const raw = gradientRaw(width, height);
    const bytes = await encode("png", width, height, raw);
    const box = rect(307.5, 307.5, 385, 385);
    const detected = face(box, true, {
      leftEye: rect(400, 420, 80, 30),
      rightEye: rect(520, 430, 70, 36),
      betweenPupils: point(500, 500),
      mouthCenter: point(480, 700),
      noseBridge: point(510, 560),
      leftPupil: point(430, 440),
      rightPupil: point(560, 450),
      leftEyeCenter: point(440, 435),
      rightEyeCenter: point(555, 445),
      leftOuterCorner: point(390, 430),
      rightOuterCorner: point(600, 440),
    });
    const { detect, calls } = recordingDetector([detected]);

    const result = await cropToSmile({ bytes, mediaType: "image/png" }, detect);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.width).toBe(width);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.image.width).toBe(1024);
    expect(result.image.height).toBe(1024);
    expect(result.image.data.length).toBe(1024 * 1024 * 4);
    expect(result.landmarks.betweenPupils).toEqual({ x: 512, y: 512 });

    const left = 150;
    const top = 150;
    const side = 700;
    const scale = 1024 / side;
    const map = (p: Point) => ({ x: (p.x - left) * scale, y: (p.y - top) * scale });
    const mapRect = (r: Rect) => ({
      x: (r.x - left) * scale,
      y: (r.y - top) * scale,
      width: r.width * scale,
      height: r.height * scale,
    });

    expect(result.landmarks.leftEye).toEqual(mapRect(detected.landmarks.leftEye));
    expect(result.landmarks.rightEye).toEqual(mapRect(detected.landmarks.rightEye));
    expect(result.landmarks.mouthCenter).toEqual(map(detected.landmarks.mouthCenter));
    expect(result.landmarks.noseBridge).toEqual(map(detected.landmarks.noseBridge));
    expect(result.landmarks.leftPupil).toEqual(map(detected.landmarks.leftPupil));
    expect(result.landmarks.rightPupil).toEqual(map(detected.landmarks.rightPupil));
    expect(result.landmarks.leftEyeCenter).toEqual(map(detected.landmarks.leftEyeCenter));
    expect(result.landmarks.rightEyeCenter).toEqual(map(detected.landmarks.rightEyeCenter));
    expect(result.landmarks.leftOuterCorner).toEqual(map(detected.landmarks.leftOuterCorner));
    expect(result.landmarks.rightOuterCorner).toEqual(map(detected.landmarks.rightOuterCorner));
    expect(result.landmarks.leftEye.width).not.toBe(result.landmarks.leftEye.height);

    const decoded = await sharp(bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const lanczos = await sharp(decoded.data, {
      raw: { width: decoded.info.width, height: decoded.info.height, channels: 4 },
    })
      .extract({ left, top, width: side, height: side })
      .resize(1024, 1024, { kernel: "lanczos3", fit: "fill" })
      .raw()
      .toBuffer();
    const nearest = await sharp(decoded.data, {
      raw: { width: decoded.info.width, height: decoded.info.height, channels: 4 },
    })
      .extract({ left, top, width: side, height: side })
      .resize(1024, 1024, { kernel: "nearest", fit: "fill" })
      .raw()
      .toBuffer();

    expect(firstMismatch(result.image.data, new Uint8Array(lanczos))).toBe("");
    expect(firstMismatch(result.image.data, new Uint8Array(nearest))).not.toBe("");
    expect(decoded.info.width * decoded.info.height).toBeLessThanOrEqual(PIXEL_LIMIT);
  });

  it("maps the face-box center through the integer window when faceSpan / 0.55 is not whole", async () => {
    const width = 1000;
    const height = 1000;
    const faceSpan = 400;
    const squareSide = faceSpan / 0.55;
    expect(Number.isInteger(squareSide)).toBe(false);

    const box = rect(300, 300, faceSpan, faceSpan);
    const center = point(box.x + box.width / 2, box.y + box.height / 2);
    const floatLeft = center.x - squareSide / 2;
    const floatTop = center.y - squareSide / 2;
    expect(floatLeft).toBeGreaterThan(0);
    expect(floatTop).toBeGreaterThan(0);
    expect(floatLeft + squareSide).toBeLessThan(width);
    expect(floatTop + squareSide).toBeLessThan(height);

    const exLeft = Math.round(floatLeft);
    const exTop = Math.round(floatTop);
    const exSide = Math.round(squareSide);
    expect(exLeft + exSide).toBeLessThanOrEqual(width);
    expect(exTop + exSide).toBeLessThanOrEqual(height);

    const raw = gradientRaw(width, height);
    const bytes = await encode("png", width, height, raw);
    const { detect } = recordingDetector([face(box)]);

    const result = await cropToSmile({ bytes, mediaType: "image/png" }, detect);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const scale = CANVAS_SIZE / exSide;
    const integerWindowCenter = point(exLeft + exSide / 2, exTop + exSide / 2);
    const onCanvas = (p: Point) => ({
      x: (p.x - exLeft) * scale,
      y: (p.y - exTop) * scale,
    });
    // The extracted window's center scales to the middle of the 1024 canvas.
    // Rounding moves that window off the face-box center by a fraction of a
    // pixel, so the mapped face center is that point scaled through the window.
    expect(onCanvas(integerWindowCenter)).toEqual({ x: CANVAS_SIZE / 2, y: CANVAS_SIZE / 2 });
    expect(onCanvas(center)).not.toEqual(onCanvas(integerWindowCenter));
    expect(result.landmarks.betweenPupils).toEqual(onCanvas(center));

    const decoded = await sharp(bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const lanczos = await sharp(decoded.data, {
      raw: { width: decoded.info.width, height: decoded.info.height, channels: 4 },
    })
      .extract({ left: exLeft, top: exTop, width: exSide, height: exSide })
      .resize(CANVAS_SIZE, CANVAS_SIZE, { kernel: "lanczos3", fit: "fill" })
      .raw()
      .toBuffer();
    expect(firstMismatch(result.image.data, new Uint8Array(lanczos))).toBe("");
  });

  it("shifts the square inside the image when a centered square would clip", async () => {
    const bytes = await encode("png", 1000, 1000);
    const { detect } = recordingDetector([
      face(rect(0, 0, 385, 385), true, { betweenPupils: point(192.5, 192.5) }),
    ]);

    const result = await cropToSmile({ bytes, mediaType: "image/png" }, detect);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.landmarks.betweenPupils.x).toBeCloseTo(281.6, 4);
    expect(result.landmarks.betweenPupils.y).toBeCloseTo(281.6, 4);
    expect(result.landmarks.betweenPupils.x).not.toBeCloseTo(512, 1);
  });

  it("keeps the square on the face when it cannot fit inside the image", async () => {
    const bytes = await encode("png", 640, 640);
    const faceSpan = 440;
    const { detect } = recordingDetector([
      face(rect(320 - faceSpan / 2, 320 - faceSpan / 2, faceSpan, faceSpan), true, {
        betweenPupils: point(320, 320),
      }),
    ]);

    const result = await cropToSmile({ bytes, mediaType: "image/png" }, detect);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(1024);
    expect(result.image.height).toBe(1024);
    expect(result.landmarks.betweenPupils.x).toBeCloseTo(512, 4);
    expect(result.landmarks.betweenPupils.y).toBeCloseTo(512, 4);
  });

  it("runs detection on the long-edge image and scales those coordinates back", async () => {
    const width = 2560;
    const height = 1600;
    const bytes = await encode("png", width, height);
    const faceSpan = 770;
    const origBox = rect(width - faceSpan, Math.round((height - faceSpan) / 2), faceSpan, faceSpan);
    const detW = 2048;
    const detH = Math.round((height * detW) / width);
    const factor = width / detW;
    const detBox = rect(
      origBox.x / factor,
      origBox.y / factor,
      origBox.width / factor,
      origBox.height / factor,
    );
    const detCenter = point(detBox.x + detBox.width / 2, detBox.y + detBox.height / 2);
    const { detect, calls } = recordingDetector([
      face(detBox, true, { betweenPupils: detCenter }),
    ]);

    const result = await cropToSmile({ bytes, mediaType: "image/png" }, detect);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.width).toBe(detW);
    expect(calls[0]!.height).toBe(detH);
    expect(Math.max(calls[0]!.width, calls[0]!.height)).toBeLessThanOrEqual(2048);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.landmarks.betweenPupils.x).toBeCloseTo(742.4, 4);
    expect(result.landmarks.betweenPupils.y).toBeCloseTo(512, 4);
  });

  it("decodes only the first frame of an animated WebP", async () => {
    const red = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const blue = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();
    const bytes = new Uint8Array(
      await sharp([red, blue], { join: { animated: true } }).webp().toBuffer(),
    );
    expect(isWebp(bytes)).toBe(true);
    const { detect, calls } = recordingDetector([]);

    await cropToSmile({ bytes, mediaType: "image/webp" }, detect);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.width).toBe(16);
    expect(calls[0]!.height).toBe(16);
    expect(calls[0]!.data[0]).toBeGreaterThan(200);
    expect(calls[0]!.data[2]).toBeLessThan(40);
  });

  it("applies JPEG orientation before the detector runs", async () => {
    const raw = Buffer.alloc(40 * 20 * 3, 180);
    const bytes = new Uint8Array(
      await sharp(raw, { raw: { width: 40, height: 20, channels: 3 } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer(),
    );
    expect(startsWithJpeg(bytes)).toBe(true);
    const { detect, calls } = recordingDetector([]);

    await cropToSmile({ bytes, mediaType: "image/jpeg" }, detect);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.width).toBe(20);
    expect(calls[0]!.height).toBe(40);
  });
});

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function tinyImage(): RgbaImage {
  return { width: 2, height: 2, data: new Uint8Array(16) };
}

describe("createMediaPipeDetector", () => {
  it("rejects a missing model file and does not fetch", async () => {
    const missing = path.join(tmpdir(), "expressions-missing-face", "face_landmarker.task");
    const urls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(requestUrl(input));
      throw new Error(`unexpected fetch ${requestUrl(input)}`);
    }) as typeof fetch;
    try {
      await expect(createMediaPipeDetector(missing)(tinyImage())).rejects.toThrow(
        /absent at .*face_landmarker\.task.*Refusing to download a face model/,
      );
      expect(urls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects a present dummy model for a parse failure, not the Node runtime", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "expressions-face-"));
    const modelPath = path.join(dir, "face_landmarker.task");
    await writeFile(modelPath, Buffer.from("not-a-face-landmarker"));
    const urls: string[] = [];
    const original = globalThis.fetch;
    const timeouts = () =>
      process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
    const timersBefore = timeouts();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      urls.push(url);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    try {
      let faces: DetectedFace[] | undefined;
      let failure: unknown;
      try {
        faces = await createMediaPipeDetector(modelPath)(tinyImage());
      } catch (error) {
        failure = error;
      }
      expect(timeouts()).toBeLessThanOrEqual(timersBefore);
      if (failure !== undefined) {
        const message = failure instanceof Error ? failure.message : String(failure);
        expect(message).not.toMatch(/__dirname/);
        expect(message).not.toMatch(/document/);
        expect(message).not.toMatch(/ImageSource|TexImageSource|Unsupported image source/i);
        expect(message).toMatch(/zip archive|Unable to open|Initialize was not ok/i);
      } else {
        expect(Array.isArray(faces)).toBe(true);
      }
      expect(urls.filter((url) => url.startsWith("http://") || url.startsWith("https://"))).toEqual(
        [],
      );
    } finally {
      globalThis.fetch = original;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uploads a 2x2 RGBA image through the canvas webgl texImage2D overload", () => {
    const canvas = new NodeOffscreenCanvas(2, 2);
    const gl = canvas.getContext("webgl");
    expect(gl).not.toBeNull();
    expect(gl instanceof WebGLRenderingContext).toBe(true);
    const gl2 = canvas.getContext("webgl2");
    expect(gl2).not.toBeNull();
    expect(gl2 instanceof WebGLRenderingContext).toBe(false);
    if (!gl) return;

    const image = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([
        12, 34, 56, 255, 70, 80, 90, 255, 1, 2, 3, 255, 4, 5, 6, 255,
      ]),
    };
    const texture = gl.createTexture();
    expect(texture).not.toBeNull();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    expect(() => {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image as unknown as TexImageSource,
      );
    }).not.toThrow();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    expect(Array.from(pixel)).toEqual([12, 34, 56, 255]);

    const ext = gl.getExtension("STACKGL_destroy_context") as { destroy?: () => void } | null;
    ext?.destroy?.();
  });

  it("returns a webgl2 facade when WebGLRenderingContext starts out absent", () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = globals.WebGLRenderingContext;
    delete globals.WebGLRenderingContext;
    const canvas = new NodeOffscreenCanvas(2, 2);
    let gl: WebGLRenderingContext | null = null;
    try {
      let context: object | null = null;
      expect(() => {
        context = canvas.getContext("webgl2");
        void (context instanceof WebGLRenderingContext);
      }).not.toThrow();
      expect(context).not.toBeNull();
      expect(context instanceof WebGLRenderingContext).toBe(false);
      gl = canvas.getContext("webgl");
      expect(gl instanceof WebGLRenderingContext).toBe(true);
    } finally {
      const ext = gl?.getExtension("STACKGL_destroy_context") as { destroy?: () => void } | null;
      ext?.destroy?.();
      if (previous === undefined) delete globals.WebGLRenderingContext;
      else globals.WebGLRenderingContext = previous;
    }
  });

  it("signals a finished fence on the WebGL 1 context", () => {
    const canvas = new NodeOffscreenCanvas(2, 2);
    const gl = canvas.getContext("webgl") as
      | (WebGLRenderingContext & {
          fenceSync: () => object;
          clientWaitSync: (sync: object, flags: number, timeout: number) => number;
          deleteSync: (sync: object | null) => void;
        })
      | null;
    expect(gl).not.toBeNull();
    if (!gl) return;
    try {
      const first = gl.fenceSync();
      const second = gl.fenceSync();
      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      expect(first).not.toBe(second);
      expect(gl.clientWaitSync(first, 0, 0)).toBe(0x911a);
      expect(() => gl.deleteSync(first)).not.toThrow();
    } finally {
      const ext = gl.getExtension("STACKGL_destroy_context") as { destroy?: () => void } | null;
      ext?.destroy?.();
    }
  });

  it("resolves a face array from the local landmarker model without a download", async () => {
    const urls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      urls.push(url);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    let faces: DetectedFace[] | undefined;
    let failure: unknown;
    try {
      try {
        faces = await createMediaPipeDetector()(tinyImage());
      } catch (error) {
        failure = error;
      }
      expect(urls.filter((url) => url.startsWith("http://") || url.startsWith("https://"))).toEqual(
        [],
      );
      expect(failure).toBeUndefined();
      expect(Array.isArray(faces)).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  }, 120_000);

  const portrait = path.join(
    process.cwd(),
    "public/faces/60e9c989f9b70c7b686b617bc349ebc4/smile.webp",
  );

  it.skipIf(!existsSync(portrait))(
    "detects the local smile portrait with both eyes visible",
    async () => {
      const bytes = await readFile(portrait);
      const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const image: RgbaImage = {
        width: decoded.info.width,
        height: decoded.info.height,
        data: new Uint8Array(decoded.data),
      };
      const urls: string[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        urls.push(url);
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch;
      try {
        const faces = await createMediaPipeDetector()(image);
        expect(
          urls.filter((url) => url.startsWith("http://") || url.startsWith("https://")),
        ).toEqual([]);
        expect(faces).toHaveLength(1);
        expect(faces[0]?.bothEyesVisible).toBe(true);
      } finally {
        globalThis.fetch = original;
      }
    },
    120_000,
  );
});
