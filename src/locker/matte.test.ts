import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  confidenceToMatteBytes,
  encodePersonMatteWebp,
  personMaskIndex,
  personMatte,
  resizeMatte,
} from "./matte";
import type { RgbaImage } from "./types";

describe("person matte bytes", () => {
  it("maps high confidence to person and flips an inverted mask", () => {
    expect(Array.from(confidenceToMatteBytes(new Float32Array([0, 1, 0.5]), true))).toEqual([
      0, 255, 128,
    ]);
    expect(Array.from(confidenceToMatteBytes(new Float32Array([0, 1]), false))).toEqual([
      255, 0,
    ]);
  });

  it("picks the selfie mask and ignores a background mask", () => {
    expect(personMaskIndex(["selfie"], 1)).toBe(0);
    expect(personMaskIndex(["background", "person"], 2)).toBe(1);
    expect(personMaskIndex([], 1)).toBe(0);
  });

  it("resizes a mask to the smile dimensions", async () => {
    const out = await resizeMatte(new Uint8Array([0, 255, 255, 0]), 2, 2, 4, 4);
    expect(out.length).toBe(16);
  });

  it("encodes a grayscale matte that keeps background dark and person light", async () => {
    const encoded = await encodePersonMatteWebp(new Uint8Array([0, 255, 255, 0]), 2, 2);
    const decoded = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info.width).toBe(2);
    expect(decoded.info.height).toBe(2);
    expect(decoded.data[0]).toBeLessThan(8);
    expect(decoded.data[4]).toBeGreaterThan(247);
  });
});

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function solidImage(width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 180;
    data[index + 1] = 140;
    data[index + 2] = 120;
    data[index + 3] = 255;
  }
  return { width, height, data };
}

describe("personMatte", () => {
  it("does not download a missing segmenter model", async () => {
    const missing = path.join(tmpdir(), "expressions-missing-segmenter", "selfie_segmenter.tflite");
    const urls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(requestUrl(input));
      throw new Error(`unexpected fetch ${requestUrl(input)}`);
    }) as typeof fetch;
    try {
      await expect(personMatte(solidImage(4, 4), missing)).rejects.toThrow(
        /absent at .*selfie_segmenter\.tflite.*Refusing to download a face model/,
      );
      expect(urls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  const modelPath = path.join(process.cwd(), "models", "selfie_segmenter.tflite");

  it.skipIf(!existsSync(modelPath))(
    "returns one byte per pixel and does not fetch",
    async () => {
      const urls: string[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        urls.push(url);
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch;
      try {
        const image = solidImage(64, 48);
        const matte = await personMatte(image);
        expect(matte).toBeInstanceOf(Uint8Array);
        expect(matte.length).toBe(image.width * image.height);
        expect(urls.filter((url) => url.startsWith("http://") || url.startsWith("https://"))).toEqual(
          [],
        );
      } finally {
        globalThis.fetch = original;
      }
    },
    120_000,
  );
});
