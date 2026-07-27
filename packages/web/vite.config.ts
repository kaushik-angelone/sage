import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const proxyTarget = process.env.ALTIMATE_SERVE_URL ?? "http://127.0.0.1:4096"

export default defineConfig({
  plugins: [react()],
  base: "/",
  server: {
    port: 5173,
    proxy: {
      "/session": proxyTarget,
      "/event": proxyTarget,
      "/global": proxyTarget,
      "/config": proxyTarget,
      "/provider": proxyTarget,
      "/project": proxyTarget,
      "/permission": proxyTarget,
      "/question": proxyTarget,
      "/pty": proxyTarget,
      "/mcp": proxyTarget,
      "/file": proxyTarget,
      "/experimental": proxyTarget,
      "/auth": proxyTarget,
      "/doc": proxyTarget,
      "/health": proxyTarget,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
  },
})
