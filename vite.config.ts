import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 520,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("three")) return "vendor-three";
            if (id.includes("react-markdown") || id.includes("remark-") || id.includes("micromark") || id.includes("mdast") || id.includes("hast") || id.includes("unified")) {
              return "vendor-markdown";
            }
            if (id.includes("@tauri-apps")) return "vendor-tauri";
            if (id.includes("react") || id.includes("scheduler")) return "vendor-react";
          }
          if (id.includes("/src/components/Pikachu3D")) return "pet-3d";
          if (id.includes("/src/components/Settings")) return "settings";
          if (id.includes("/src/components/ChatPanel") || id.includes("/src/components/ChatMessage") || id.includes("/src/components/SurfaceRenderer")) {
            return "workbench";
          }
          if (id.includes("/src/agent/")) return "agent";
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
