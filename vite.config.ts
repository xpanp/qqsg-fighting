import { defineConfig } from "vite";
import { resolve } from "node:path";
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
export default defineConfig({
  root: "frontend",
  base: "/fighting/",
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022", rollupOptions: { input: { capture: resolve("frontend/index.html"), admin: resolve("frontend/admin/index.html") } } },
  worker: { format: "es" },
  server: { headers, proxy: { "/fighting/api/": "http://127.0.0.1:8780" } },
  preview: { headers },
});
