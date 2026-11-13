import { useBotStore } from "../store/bots";
import type { ApprovalKind } from "../store/bots";
import { BotAvatar } from "./BotAvatar";
import { useThemeClass } from "../store/theme";
import { addAlwaysAllow } from "../agent/tools";

const KIND_LABEL: Record<ApprovalKind, string> = {
  shell: "系统命令",
  file_edit: "文件改动",
  network: "网络访问",
  tool: "工具调用",
};

/**
 * 内联审批卡片：替代 tools.ts 里的 window.confirm 弹窗。
 * 只有真实产生 pending 审批时才会出现，不做演示用的假数据。
 */
/** compact：宠物窗口只有 340px，一次只展示一张卡片。 */
export function ApprovalOverlay({ compact = false }: { compact?: boolean }) {
  const themeClass = useThemeClass();
  const approvals = useBotStore((state) => state.approvals);
  const bots = useBotStore((state) => state.bots);
  const resolveApproval = useBotStore((state) => state.resolveApproval);

  const pending = approvals.filter((request) => request.status === "pending");
  if (pending.length === 0) return null;

  return (
    // 工作台里卡片放在输入框上方，不能盖住输入框（盖住后看不到发送 / 停止按钮，会以为卡死了）
    <div
      className={`${themeClass} pointer-events-none fixed inset-0 z-50 flex items-end justify-center ${
        compact ? "p-2" : "px-4 pb-28 pt-4"
      }`}
    >
      <div className="pointer-events-auto w-full max-w-md space-y-3">
        {pending.slice(0, compact ? 1 : 3).map((request) => {
          const bot = bots.find((item) => item.id === request.botId);
          return (
            <div
              key={request.id}
              className="rounded-xl border border-yellow-500/60 ui-panel-strong p-4 shadow-2xl backdrop-blur"
            >
              <div className="flex items-center gap-2 text-xs text-yellow-300">
                <span className="rounded bg-yellow-500/20 px-1.5 py-0.5">{KIND_LABEL[request.kind]}</span>
                <span>需要你确认</span>
                {bot && (
                  <span className="ml-auto flex items-center gap-1 ui-muted">
                    <BotAvatar bot={bot} size={18} />
                    {bot.name}
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm font-semibold">{request.summary}</p>
              {/* 详情第一行就是标题，不再重复显示 */}
              {(() => {
                const detail = request.detail.startsWith(request.summary)
                  ? request.detail.slice(request.summary.length).trim()
                  : request.detail;
                return detail ? (
                  <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-xs ui-muted">{detail}</pre>
                ) : null;
              })()}
              <div className={`mt-3 grid gap-2 ${request.allowAlways ? "grid-cols-3" : "grid-cols-2"}`}>
                <button
                  type="button"
                  onClick={() => resolveApproval(request.id, "allowed")}
                  className="rounded-lg bg-yellow-500 px-2 py-2 text-sm font-bold text-gray-900 hover:bg-yellow-400"
                >
                  允许一次
                </button>
                {request.allowAlways && request.scope && (
                  <button
                    type="button"
                    onClick={() => {
                      addAlwaysAllow(request.scope!, request.scopeLabel);
                      resolveApproval(request.id, "allowed");
                    }}
                    title={`以后「${request.scopeLabel || request.scope}」不再询问（高风险操作仍会确认），可在 设置 → AI 能力 → 电脑控制 里撤销`}
                    className="rounded-lg border border-yellow-500/70 px-2 py-2 text-sm font-semibold text-yellow-300 hover:bg-yellow-500/15"
                  >
                    一直允许
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => resolveApproval(request.id, "denied")}
                  className="rounded-lg bg-gray-700 px-2 py-2 text-sm text-gray-200 hover:bg-gray-600"
                >
                  拒绝
                </button>
              </div>
              {request.allowAlways && request.scopeLabel && (
                <p className="mt-1.5 text-[11px] ui-muted">“一直允许”只对「{request.scopeLabel}」生效，高风险操作仍会每次确认。</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
