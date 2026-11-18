import type { NextConfig } from "next";

const visionAssets = [
  "./models/*", "./recipes/v1.json", "./node_modules/@sparticuz/chromium/bin/*",
  "./node_modules/@mediapipe/tasks-vision/vision_bundle.mjs",
  "./node_modules/@mediapipe/tasks-vision/wasm/*",
];
const nextConfig: NextConfig = {
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core", "gl", "@mediapipe/tasks-vision"],
  outputFileTracingIncludes: { "/api/faces": visionAssets, "/api/faces/**/*": visionAssets },
  outputFileTracingExcludes: { "/**/*": ["./node_modules/gl/**/*", "./private/faces/**/*", "./public/faces/**/*"] },
};
export default nextConfig;
