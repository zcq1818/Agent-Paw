import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "./kernel";
import { analyzeImageUrl } from "./multimodal";
import { registerToolAction } from "./toolEvents";

/**
 * 读本地文件：拖给桌宠的文件、聊天里贴的路径都走这里。
 * 文本 / Word / PPT / Excel 直接读，PDF 和图片用 Windows 自带的离线 OCR，全程不上传文件本身。
 */

export interface DocText {
  path: string;
  name: string;
  kind: "text" | "word" | "slides" | "sheet" | "pdf" | "image";
  text: string;
  truncated: boolean;
  size: number;
}

export interface DroppedFile {
  path: string;
  name: string;
  ext: string;
  size: number;
  is_dir: boolean;
}

export type DropKind = "doc" | "image" | "folder" | "other";

const DOC_EXTS = new Set(["docx", "pptx", "xlsx", "pdf", "txt", "md", "markdown", "csv", "tsv", "json", "log", "html", "htm", "xml", "yaml", "yml"]);
const CODE_EXTS = new Set(["py", "js", "ts", "tsx", "jsx", "rs", "go", "java", "kt", "c", "h", "cpp", "cs", "php", "rb", "sh", "ps1", "sql", "css", "vue", "swift"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "bmp", "gif", "webp", "tif", "tiff"]);

export function dropKindOf(file: DroppedFile): DropKind {
  if (file.is_dir) return "folder";
  if (IMAGE_EXTS.has(file.ext)) return "image";
  if (DOC_EXTS.has(file.ext) || CODE_EXTS.has(file.ext)) return "doc";
  return "other";
}

export function isCodeFile(file: DroppedFile) {
  return CODE_EXTS.has(file.ext);
}

export function readDocument(path: string, maxChars?: number) {
  return invoke<DocText>("read_document", { path, maxChars });
}

export function describePaths(paths: string[]) {
  return invoke<DroppedFile[]>("describe_paths", { paths });
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const KIND_LABEL: Record<DocText["kind"], string> = {
  text: "文本",
  word: "Word 文档",
  slides: "PPT",
  sheet: "Excel 表格",
  pdf: "PDF（文字识别）",
  image: "图片（文字识别）",
};

registerToolAction("read_document", "看文件");
registerToolAction("look_at_image", "看图");

export function getDocumentTools(): Tool[] {
  return [
    {
      name: "read_document",
      description:
        "读取本地文件的文字内容（只读）。支持文本 / 代码 / Markdown / CSV、Word(.docx)、PPT(.pptx)、Excel(.xlsx)、PDF 和图片（PDF 与图片用本机离线 OCR 识别文字）。用户拖给桌宠的文件、消息里出现的本地文件路径，都先用它读，再回答。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件的完整路径" },
          max_chars: { type: "number", description: "最多返回多少字，默认 30000" },
        },
        required: ["path"],
      },
      execute: async (args) => {
        try {
          const doc = await readDocument(String(args.path || ""), args.max_chars ? Number(args.max_chars) : undefined);
          const head = `${doc.name}（${KIND_LABEL[doc.kind]}，${formatSize(doc.size)}${doc.truncated ? "，内容较长已截断" : ""}）`;
          return doc.text ? `${head}\n\n${doc.text}` : `${head}\n\n没有读到文字。${doc.kind === "image" ? "这张图里可能没有文字，可以用 look_at_image 看画面。" : ""}`;
        } catch (error) {
          return `读取失败：${error}`;
        }
      },
    },
    {
      name: "look_at_image",
      description: "让模型直接看一张本地图片的画面（截图、照片、设计稿），回答关于它的问题。只想要图里的文字时用 read_document 更快更准。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "图片的完整路径" },
          question: { type: "string", description: "想问图片的什么" },
        },
        required: ["path"],
      },
      execute: async (args) => {
        try {
          const url = await invoke<string>("read_image_data_url", { path: String(args.path || "") });
          return analyzeImageUrl(url, String(args.question || "请描述这张图片的内容"));
        } catch (error) {
          return `看图失败：${error}`;
        }
      },
    },
  ];
}
