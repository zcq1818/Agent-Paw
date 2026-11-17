import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";
import type { Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

/** 私人定制的桌宠形象（public/models/pets/custom，不进 git）只在开发时用，打包时从 dist 里删掉，免得进安装包。 */
function excludePrivatePets(): Plugin {
  return {
    name: "paw-exclude-private-pets",
    apply: "build",
    closeBundle() {
      fs.rmSync(path.resolve(__dirname, "dist/models/pets/custom"), { recursive: true, force: true });
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), excludePrivatePets()],
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
          if (id.includes("/src/components/RiggedPet3D") || id.includes("three/examples/jsm/loaders/GLTFLoader")) return "pet-3d";
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
