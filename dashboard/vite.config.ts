import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard is a static app served from the SAME host as the gateway, so it needs no
// configuration at all: API calls are relative (/api/...) and the gateway URL shown on
// the Connect page is window.location.origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Vite inlines env vars with this prefix into the bundle. Nothing in this project uses
  // it, so no environment value (secret or not) can end up in the built app by accident.
  envPrefix: "TMG_DASHBOARD_PUBLIC_",
  build: { sourcemap: false },
  server: {
    // `pnpm dev`: proxy API calls to the gateway running in Kind.
    proxy: {
      "/api": { target: "http://hub.localtest.me", changeOrigin: true },
      "/mcp": { target: "http://hub.localtest.me", changeOrigin: true },
    },
  },
});
