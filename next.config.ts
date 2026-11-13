import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/faces": [
      "./models/face_landmarker.task",
      "./node_modules/@mediapipe/tasks-vision/package.json",
      "./node_modules/@mediapipe/tasks-vision/wasm/**/*",
      "./node_modules/gl/**/*",
      "./node_modules/bindings/**/*",
      "./node_modules/file-uri-to-path/**/*",
      "./node_modules/bit-twiddle/**/*",
      "./node_modules/glsl-tokenizer/**/*",
    ],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.module.rules.push({
        test: /[\\/]@mediapipe[\\/]tasks-vision[\\/].*\.js$/,
        parser: { url: false },
      });
    }
    return config;
  },
};

export default nextConfig;
