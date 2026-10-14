import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// O renderer é servido pelo protocolo app://myscreen em produção: caminhos
// relativos (`base: "./"`) e duas páginas (a sala e a barra "Compartilhando").
export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src/renderer"),
      "@shared": resolve(import.meta.dirname, "src/shared"),
    },
  },
  server: { port: 5183, strictPort: true },
  build: {
    outDir: resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome130",
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "src/renderer/index.html"),
      },
    },
  },
});
