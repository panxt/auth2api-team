import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build the dashboard at /ui base so it can be served by Express at /ui/.
// Dev server proxies /admin/* to the running auth2api so `npm run dev` works
// against the real backend without rebuilding.
export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/admin": "http://127.0.0.1:8317",
      "/v1": "http://127.0.0.1:8317",
      "/health": "http://127.0.0.1:8317",
    },
  },
});
