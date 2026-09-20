import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/wasm packages out of the server bundle: PGlite loads its wasm
  // via file URLs and the Agent SDK spawns a bundled Claude Code binary.
  serverExternalPackages: ["@electric-sql/pglite", "@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
