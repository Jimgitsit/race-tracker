import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { BASE_PATH, PORT } from "./src/shared/config.ts";

// Vite dev runs on its own port and proxies API + photo traffic to the Bun server.
// The Bun server tolerates the base prefix being present or absent, so the same
// relative URLs work in dev, in prod behind nginx, and hitting :58013 directly.
export default defineConfig({
  base: `${BASE_PATH}/`,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 58014,
    strictPort: true,
    proxy: {
      [`${BASE_PATH}/api`]: {
        target: `http://127.0.0.1:${PORT}`,
        changeOrigin: false,
      },
      [`${BASE_PATH}/photos`]: {
        target: `http://127.0.0.1:${PORT}`,
        changeOrigin: false,
      },
    },
  },
});
