import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pptxgenBundle = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "node_modules/pptxgenjs/dist/pptxgen.bundle.js",
);

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
    resolveAlias: {
      pptxgenjs: "./node_modules/pptxgenjs/dist/pptxgen.bundle.js",
    },
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      pptxgenjs: pptxgenBundle,
    };
    return config;
  },
};

export default nextConfig;
