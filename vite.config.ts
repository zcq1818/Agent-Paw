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
  // 启动时就预构建 GLTFLoader，避免运行时重新 prebundle 触发缓存删除。
  optimizeDeps: {
    include: ["three/examples/jsm/loaders/GLTFLoader.js"],
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/src/components/Pikachu3D") || id.includes("three/examples/jsm/loaders/GLTFLoader")) return "pet-3d";
          if (id.includes("node_modules")) {
            if (id.includes("three")) return "vendor-three";
            if (id.includes("react-markdown") || id.includes("remark-") || id.includes("micromark") || id.includes("mdast") || id.includes("hast") || id.includes("unified")) {
              return "vendor-markdown";
            }
            if (id.includes("@tauri-apps")) return "vendor-tauri";
            if (id.includes("react") || id.includes("scheduler")) return "vendor-react";
          }
          if (id.includes("/src/components/Settings")) return "settings";
          if (
            id.includes("/src/components/Workbench") ||
            id.includes("/src/components/ChatView") ||
            id.includes("/src/components/ChatMessage") ||
            id.includes("/src/components/SurfaceRenderer")
          ) {
            return "workbench";
          }
          if (id.includes("node_modules") && id.includes("lucide-react")) return "vendor-icons";
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
