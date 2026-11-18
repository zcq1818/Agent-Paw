import {
  buildAnthropicRequest,
  buildChatCompletionsUrl,
  buildRequestHeaders,
  fetchModelApi,
  isAnthropicProvider,
  loadConfig,
  parseConfigJson,
} from "./kernel";

/**
 * 不带工具、不带对话历史的一次性模型调用（搭话、复盘这类后台小活用）。
 * 本机 Claude / CodeBuddy 这类命令行模型太慢，不在这里用。
 */

export function quickModelAvailable(): boolean {
  const config = loadConfig();
  if (!config.apiKey || !config.baseUrl || !config.model) return false;
  return !/local/i.test(config.provider || "");
}

/**
 * maxTokens 给大一点：推理模型（星火 X2、DeepSeek R1 等）会先花几百个 token 思考，
 * 上限给小了正文会是空的。
 */
export async function quickComplete(
  system: string,
  prompt: string,
  { maxTokens = 1500, temperature = 1 }: { maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  const config = loadConfig();
  if (isAnthropicProvider(config)) {
    const request = buildAnthropicRequest(config, system, prompt);
    const resp = await fetchModelApi(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ ...request.body, max_tokens: maxTokens, temperature }),
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    return (data?.content || []).map((block: any) => (block?.type === "text" ? block.text : "")).join("");
  }
  const resp = await fetchModelApi(buildChatCompletionsUrl(config), {
    method: "POST",
    headers: buildRequestHeaders(config),
    body: JSON.stringify({
      ...parseConfigJson(config.extraBody),
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!resp.ok) return "";
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || "";
}

/** 从模型回复里取出 JSON 对象（去掉思考过程和代码块包裹）。 */
export function extractJson<T = any>(raw: string): T | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {}
  // 模型常在字符串里直接换行（多行的 Markdown 说明），标准 JSON 不允许，转义后再试
  try {
    return JSON.parse(escapeNewlinesInStrings(match[0])) as T;
  } catch {
    return null;
  }
}

function escapeNewlinesInStrings(json: string) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      } else if (ch === "\n") {
        out += "\\n";
        continue;
      } else if (ch === "\r") {
        continue;
      } else if (ch === "\t") {
        out += "\\t";
        continue;
      }
    } else if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  return out;
}
