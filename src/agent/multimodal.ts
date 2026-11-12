/**
 * 多模态工具
 * - 语音合成
 * - 图片理解
 * - 截图分析
 */

import { buildChatCompletionsUrl, buildRequestHeaders, loadConfig, parseConfigJson } from "./kernel";

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface SpeechConfig {
  voice?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

let speechSynthesis: SpeechSynthesis | null = null;
let currentUtterance: SpeechSynthesisUtterance | null = null;

function getSpeechSynthesis(): SpeechSynthesis | null {
  if (!speechSynthesis && typeof window !== "undefined" && window.speechSynthesis) {
    speechSynthesis = window.speechSynthesis;
  }
  return speechSynthesis;
}

function getVoices(): SpeechSynthesisVoice[] {
  const synth = getSpeechSynthesis();
  if (!synth) return [];
  return synth.getVoices().sort((a, b) => {
    const aZh = a.lang.includes("zh");
    const bZh = b.lang.includes("zh");
    if (aZh && !bZh) return -1;
    if (!aZh && bZh) return 1;
    return 0;
  });
}

const ttsTools: Tool[] = [
  {
    name: "speak",
    description: "让皮卡丘说话（语音合成）",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要说的内容" },
        voice: { type: "string", description: "语音名称（可选）" },
        rate: { type: "number", description: "语速，0.1-10，默认 1" },
        pitch: { type: "number", description: "音调，0.1-2，默认 1" },
      },
      required: ["text"],
    },
    execute: async (args) => {
      const synth = getSpeechSynthesis();
      if (!synth) return "当前浏览器不支持语音合成";

      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(args.text as string);
      if (args.rate) utterance.rate = Math.max(0.1, Math.min(10, args.rate as number));
      if (args.pitch) utterance.pitch = Math.max(0.1, Math.min(2, args.pitch as number));

      if (args.voice) {
        const voice = getVoices().find((item) => item.name.includes(args.voice as string));
        if (voice) utterance.voice = voice;
      } else {
        const zhVoice = getVoices().find((item) => item.lang.includes("zh"));
        if (zhVoice) utterance.voice = zhVoice;
      }

      currentUtterance = utterance;
      return new Promise((resolve) => {
        utterance.onend = () => {
          currentUtterance = null;
          resolve("语音播放完成");
        };
        utterance.onerror = () => {
          currentUtterance = null;
          resolve("语音合成失败");
        };
        synth.speak(utterance);
        setTimeout(() => {
          if (currentUtterance === utterance) {
            resolve("语音播放完成");
          }
        }, 100);
      });
    },
  },
  {
    name: "stop_speaking",
    description: "停止当前语音",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const synth = getSpeechSynthesis();
      if (synth) {
        synth.cancel();
        currentUtterance = null;
        return "已停止语音";
      }
      return "当前没有正在播放的语音";
    },
  },
  {
    name: "list_voices",
    description: "列出可用语音",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const voices = getVoices();
      if (voices.length === 0) return "正在加载语音列表...";
      return `可用语音：\n${voices.slice(0, 10).map((voice) => `${voice.name} (${voice.lang})`).join("\n")}`;
    },
  },
];

const visionTools: Tool[] = [
  {
    name: "analyze_image",
    description: "分析图片内容",
    parameters: {
      type: "object",
      properties: {
        image: { type: "string", description: "图片 URL 或 base64" },
        question: { type: "string", description: "关于这张图片的问题" },
      },
      required: ["image"],
    },
    execute: async (args) => {
      const config = loadConfig();
      if (!config.apiKey) return "请先在设置中配置 API Key";

      const imageUrl = args.image as string;
      const question = (args.question as string) || "请描述这张图片的内容";
      if (!imageUrl.startsWith("http") && !imageUrl.startsWith("data:image")) {
        return "请输入有效的图片 URL 或 base64 数据";
      }

      try {
        const resp = await fetch(buildChatCompletionsUrl(config), {
          method: "POST",
          headers: buildRequestHeaders(config),
          body: JSON.stringify({
            ...parseConfigJson(config.extraBody),
            model: config.model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: question },
                  { type: "image_url", image_url: { url: imageUrl } },
                ],
              },
            ],
            max_tokens: 1000,
          }),
        });

        if (!resp.ok) return `API 错误：${resp.status}`;
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content || "";
        return `图片分析结果：\n\n${content}`;
      } catch (error) {
        return `图片分析失败：${error}`;
      }
    },
  },
  {
    name: "upload_and_analyze",
    description: "上传本地图片并分析",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "关于图片的问题" },
      },
    },
    execute: async (args) =>
      new Promise<string>((rawResolve) => {
        // 这个 Promise 必须保证一定会 settle：用户取消选择、文件对话框因缺少用户手势被浏览器拦截、
        // 网络请求抛错，之前都会让 Promise 永远挂起，整轮对话卡在“思考中”。
        let settled = false;
        const timer = window.setTimeout(() => resolve("等待选择图片超时（2 分钟），已取消。"), 120_000);
        function resolve(value: string) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          rawResolve(value);
        }

        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.addEventListener("cancel", () => resolve("未选择图片"));
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) {
            resolve("未选择图片");
            return;
          }

          const reader = new FileReader();
          reader.onload = async () => {
           try {
            const base64 = reader.result as string;
            const config = loadConfig();
            if (!config.apiKey) {
              resolve("请先在设置中配置 API Key");
              return;
            }

            const question = (args.question as string) || "请描述这张图片的内容";
            const resp = await fetch(buildChatCompletionsUrl(config), {
              method: "POST",
              headers: buildRequestHeaders(config),
              body: JSON.stringify({
                ...parseConfigJson(config.extraBody),
                model: config.model,
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: question },
                      { type: "image_url", image_url: { url: base64 } },
                    ],
                  },
                ],
                max_tokens: 1000,
              }),
            });

            if (!resp.ok) {
              resolve(`API 错误：${resp.status}`);
              return;
            }

            const data = await resp.json();
            const content = data.choices?.[0]?.message?.content || "";
            resolve(`图片分析结果：\n\n${content}`);
           } catch (error) {
            resolve(`图片分析失败：${error}`);
           }
          };
          reader.onerror = () => resolve("读取图片失败");
          reader.readAsDataURL(file);
        };
        try {
          input.click();
        } catch (error) {
          resolve(`无法打开文件选择框：${error}`);
        }
      }),
  },
];

const screenshotTools: Tool[] = [
  {
    name: "capture_screen",
    description: "截取当前屏幕",
    parameters: {
      type: "object",
      properties: {
        area: { type: "string", enum: ["full", "window"], description: "full=全屏，window=窗口" },
      },
    },
    execute: async (args) => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            displaySurface: args.area === "window" ? "monitor" : "monitor",
          },
        });

        const video = document.createElement("video");
        video.srcObject = stream;
        await video.play();

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          stream.getTracks().forEach((track) => track.stop());
          return "无法创建画布上下文";
        }

        ctx.drawImage(video, 0, 0);
        stream.getTracks().forEach((track) => track.stop());
        const dataUrl = canvas.toDataURL("image/png");

        try {
          const blob = await (await fetch(dataUrl)).blob();
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          return "截图已保存到剪贴板";
        } catch {
          const base64 = dataUrl.slice(22);
          return `截图完成（base64 长度：${base64.length}）\n如需分析，请使用 analyze_image 工具`;
        }
      } catch (error) {
        if ((error as Error).name === "NotAllowedError") {
          return "用户取消了屏幕捕获";
        }
        return `截图失败：${error}`;
      }
    },
  },
  {
    name: "capture_and_analyze",
    description: "截屏并自动分析",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "关于截图的问题" },
      },
    },
    execute: async (args) => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "monitor" },
        });

        const video = document.createElement("video");
        video.srcObject = stream;
        await video.play();

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          stream.getTracks().forEach((track) => track.stop());
          return "无法创建画布上下文";
        }

        ctx.drawImage(video, 0, 0);
        stream.getTracks().forEach((track) => track.stop());
        const dataUrl = canvas.toDataURL("image/png");

        const config = loadConfig();
        if (!config.apiKey) return "请先在设置中配置 API Key";

        const question = (args.question as string) || "请描述这个屏幕的内容";
        const resp = await fetch(buildChatCompletionsUrl(config), {
          method: "POST",
          headers: buildRequestHeaders(config),
          body: JSON.stringify({
            ...parseConfigJson(config.extraBody),
            model: config.model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: question },
                  { type: "image_url", image_url: { url: dataUrl } },
                ],
              },
            ],
            max_tokens: 1000,
          }),
        });

        if (!resp.ok) return `API 错误：${resp.status}`;
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content || "";
        return `屏幕分析结果：\n\n${content}`;
      } catch (error) {
        if ((error as Error).name === "NotAllowedError") {
          return "用户取消了屏幕捕获";
        }
        return `分析失败：${error}`;
      }
    },
  },
];

export function getMultimodalTools(): Tool[] {
  return [...ttsTools, ...visionTools, ...screenshotTools];
}
