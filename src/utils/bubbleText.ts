/**
 * 把一段 Markdown 回复截成适合桌宠气泡的摘要，保留 Markdown（气泡本身会渲染）。
 *
 * 以前的做法是删光 # * _ ` 等符号再压成一行，表格的 | 和 --- 留在里面变成乱码，
 * 列表、换行也全没了。现在：
 * - 代码块、表格不放进气泡，换成一句提示，详细内容看聊天窗口；
 * - 按行累加到字数上限，尽量在行尾或句号处截断，不会把 **加粗** 切成半截；
 * - 截断后由调用方决定是否提示“点击查看完整回复”。
 */
export interface BubbleExcerpt {
  text: string;
  truncated: boolean;
}

const SENTENCE_END = /[。！？!?；;.…]/;

function closeOpenMarkers(text: string) {
  // 截在一半的 ** / ` 会让后面整段变成粗体或代码，补上收尾标记。
  let result = text;
  if ((result.match(/\*\*/g) || []).length % 2 === 1) result += "**";
  if ((result.match(/`/g) || []).length % 2 === 1) result += "`";
  return result;
}

export function bubbleExcerpt(markdown: string, limit = 160): BubbleExcerpt {
  let hadOmitted = false;
  const lines = markdown
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?(```|$)/g, () => {
      hadOmitted = true;
      return "\n（代码在聊天窗口里）\n";
    })
    .split("\n");

  // 连续的表格行合并成一句提示
  const blocks: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|.*\|?$/.test(trimmed) || /^:?-{3,}:?(\s*\|\s*:?-{3,}:?)+$/.test(trimmed)) {
      if (blocks[blocks.length - 1] !== "（表格在聊天窗口里）") blocks.push("（表格在聊天窗口里）");
      hadOmitted = true;
      continue;
    }
    if (/^-{3,}$|^\*{3,}$/.test(trimmed)) continue; // 分隔线
    blocks.push(line.replace(/\s+$/, ""));
  }

  const cleaned = blocks
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 表格 / 代码被省略了，也算“没显示完整”，要提示去聊天窗口看。
  if (cleaned.length <= limit) return { text: cleaned, truncated: hadOmitted };

  // 按行累加，超过上限就停在上一行
  let out = "";
  for (const line of cleaned.split("\n")) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > limit) {
      if (!out) {
        // 第一行就太长：在上限内最后一个句末标点处截断
        const slice = line.slice(0, limit);
        let cut = -1;
        for (let i = slice.length - 1; i >= limit * 0.5; i -= 1) {
          if (SENTENCE_END.test(slice[i])) {
            cut = i + 1;
            break;
          }
        }
        out = cut > 0 ? slice.slice(0, cut) : `${slice}…`;
      }
      break;
    }
    out = next;
  }
  return { text: closeOpenMarkers(out.trim()), truncated: true };
}

/** 气泡里显示的文本：摘要 + 截断提示。 */
export function bubbleText(markdown: string, limit = 160): string {
  const { text, truncated } = bubbleExcerpt(markdown, limit);
  return truncated ? `${text}\n\n*…点我看完整回复*` : text;
}
