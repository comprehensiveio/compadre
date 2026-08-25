import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  base: "/hosted/",
  plugins: [react()],
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/hosted/chat": "http://localhost:3100",
      "/hosted/threads": "http://localhost:3100",
    },
  },
});
