import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { RgbaImage } from "./types";

const root = path.join(process.cwd(), "node_modules/@mediapipe/tasks-vision");
const assets: Record<string, [string, string]> = {
  "/vision.mjs": [path.join(root, "vision_bundle.mjs"), "application/javascript"],
  "/face": [path.join(process.cwd(), "models/face_landmarker.task"), "application/octet-stream"],
  "/segment": [path.join(process.cwd(), "models/selfie_segmenter.tflite"), "application/octet-stream"],
};
for (const base of ["vision_wasm_internal", "vision_wasm_module_internal"]) {
  for (const ext of ["js", "wasm"]) {
    const name = `${base}.${ext}`;
    assets[`/wasm/${name}`] = [path.join(root, "wasm", name), ext === "js" ? "text/javascript" : "application/wasm"];
  }
}

export async function infer(image: RgbaImage, task: "face" | "segment") {
  const png = await sharp(Buffer.from(image.data), { raw: {width: image.width, height: image.height, channels: 4} }).png().toBuffer();
  const browser = await puppeteer.launch({
    executablePath: await chromium.executablePath(), args: chromium.args, headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", async request => {
      const pathname = new URL(request.url()).pathname;
      try {
        if (pathname === "/") return await request.respond({ contentType: "text/html", body: "<html></html>" });
        if (pathname === "/image") return await request.respond({ contentType: "image/png", body: png });
        const asset = assets[pathname];
        if (!asset) return await request.abort();
        await request.respond({ contentType: asset[1], body: await readFile(asset[0]) });
      } catch { await request.abort().catch(() => {}); }
    });
    await page.goto("https://vision.invalid/");
    // Keep this module import in the Chromium page, outside the Next.js bundler.
    const result = await page.evaluate(`(async () => {
      const vision = await import('/vision.mjs');
      const files = await vision.FilesetResolver.forVisionTasks('/wasm');
      const image = await createImageBitmap(await (await fetch('/image')).blob());
      const baseOptions = { modelAssetPath: '/${task}', delegate: 'CPU' };
      if ('${task}' === 'face') {
        const detector = await vision.FaceLandmarker.createFromOptions(files, {baseOptions, numFaces: 5});
        return { faces: detector.detect(image).faceLandmarks };
      }
      const segmenter = await vision.ImageSegmenter.createFromOptions(files, {baseOptions, outputConfidenceMasks: true});
      const masks = segmenter.segment(image).confidenceMasks;
      const person = segmenter.getLabels().findIndex(label => /person|foreground|selfie/i.test(label));
      const mask = masks[person < 0 ? 0 : person];
      const bytes = Uint8Array.from(mask.getAsFloat32Array(), v => Math.round(255 * Math.min(1, Math.max(0, v))));
      let encoded = '';
      for (let i = 0; i < bytes.length; i += 8192) encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return { matte: btoa(encoded), width: mask.width, height: mask.height };
    })()`);
    return result as { faces?: {x: number; y: number}[][]; matte?: string; width?: number; height?: number };
  } finally { await browser.close(); }
}
