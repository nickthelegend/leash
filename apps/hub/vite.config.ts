import { defineConfig } from "vite";

// No React plugin needed: esbuild compiles TSX with the automatic runtime.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  build: { target: "es2022", outDir: "dist", sourcemap: false },
});
