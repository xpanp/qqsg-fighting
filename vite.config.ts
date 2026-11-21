import { defineConfig } from "vite";
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
export default defineConfig({
  root: "frontend",
  base: "/fighting/",
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
  worker: { format: "es" },
  server: { headers },
  preview: { headers },
});
