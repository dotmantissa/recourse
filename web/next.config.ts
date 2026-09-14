import type { NextConfig } from "next";
import { resolve } from "node:path";

const projectRoot = resolve(process.cwd(), "..");

const nextConfig: NextConfig = {
  turbopack: {
    root: projectRoot,
  },
  outputFileTracingRoot: projectRoot,
};

export default nextConfig;
