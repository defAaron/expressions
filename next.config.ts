import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/faces": ["./models/face_landmarker.task"],
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
