/**
 * 运行中插话：桌宠正在回复 / 调用工具时，用户可以继续发消息补充或纠正。
 *
 * - 走 API 的模型：消息放进队列，下一轮请求前塞进对话（工具调用之间就能看到）；
 *   模型本来要结束了但队列里还有话，就再多跑一轮回应它。
 * - 本机 Claude / CodeBuddy：命令行一次运行中途收不了新消息，等这一轮结束后自动接着发。
 *
 * 队列只在当前窗口内有效（谁发起的对话谁处理）。
 */

const queue: string[] = [];

export function pushInterjection(text: string) {
  const value = text.trim();
  if (value) queue.push(value);
}

export function takeInterjections(): string[] {
  return queue.splice(0, queue.length);
}

export function hasInterjections() {
  return queue.length > 0;
}

export function clearInterjections() {
  queue.length = 0;
}

/** 给模型看的插话格式：说明这是用户在它干活时补充的。 */
export function formatInterjection(text: string) {
  return `（我在你处理的过程中补充）${text}`;
}
