# Paw 桌面宠物助手

一个基于 Tauri v2 + React + Vite 的 Windows 桌面宠物 AI 助手。

## 功能

- 桌面宠物窗口：可拖拽、自主走动、气泡播报、右键菜单、迷你聊天
- 工作台窗口：流式聊天（Markdown）、多会话、团队（多 Bot）、房间协作、总管（专家委派）、记忆、Skills、任务、活动、日志、设置
- 工具调用：网页搜索、天气、时间、计算、待办、日程、快捷命令、剪贴板、打开应用/网页、系统动作、图片分析
- 本地记忆：IndexedDB 存储，自动提取 + 关键词/向量检索
- 自定义技能：可创建、导入导出 SKILL.md、启用/禁用
- 本机 Claude Code：可把任务下发给本地 `claude` CLI（复用本机登录态）
- 托盘控制：显示、隐藏、退出

## 开发

```bash
npm install
npm run dev          # 仅前端，浏览器预览：/ 为宠物，/?window=main 为工作台
npm run tauri:dev    # 完整桌面端
```

## 打包

```bash
npm run tauri:build
```

## 项目结构

```
├── src/                      前端（React 19 + zustand + Tailwind）
│   ├── App.tsx               按窗口 label 分流：pet → <Pet/>，main → 工作台
│   ├── agent/                Agent 内核（与 UI 无关的逻辑）
│   │   ├── kernel.ts         模型配置、系统提示词、基础工具、streamChat 工具调用循环
│   │   ├── tools.ts          待办/日程/快捷命令/剪贴板/系统动作等工具 + 审批确认
│   │   ├── multimodal.ts     语音、图片、截屏类工具
│   │   ├── memory.ts         IndexedDB 记忆库（提取、去重、检索、过期清理）
│   │   ├── personality.ts    用户画像与智能建议
│   │   ├── proactivity.ts    宠物主动行为调度（新闻、活动摘要、建议、自学 Skill）
│   │   ├── decision.ts       主动行为的计划选择（含冷却过滤）
│   │   ├── orchestrator.ts   总管：把任务拆给多个专家模型 / 本机 Claude 并汇总
│   │   ├── rooms.ts          房间里按 Bot 调用模型
│   │   ├── customSkills.ts   自定义 Skill 存储与 SKILL.md 导入导出
│   │   ├── news.ts           今日新闻抓取（RSS）与推送去重
│   │   ├── http.ts           跨域抓取（走 tauri-plugin-http，绕过 WebView CORS）
│   │   ├── security.ts       输入校验、限流、日志
│   │   ├── localClaude.ts    调用 Rust 侧 check_local_claude / run_local_claude
│   │   └── scope.ts …        按 Bot 分区 localStorage key 等小工具
│   ├── store/                zustand 状态
│   │   ├── agent.ts          发送消息：本地指令路由（记住/打开应用/卡片）→ streamChat
│   │   ├── chat.ts           会话与消息（按 Bot 分区持久化）
│   │   ├── bots.ts           Bot 通讯录、线程、审批请求
│   │   ├── activity.ts       本地活动观察（前台窗口统计）
│   │   ├── pet.ts / theme.ts / shortcut.ts / rooms.ts / experts.ts
│   │   └── windowSync.ts     两个窗口之间通过 storage 事件同步状态
│   ├── components/           UI：Pet、ChatPanel、Settings、BotRoster、RoomPanel …
│   └── utils/                宠物互动文案等
├── src-tauri/                Rust 后端（Tauri v2）
│   ├── src/lib.rs            命令：launch_app、system_action、get_active_window_info、
│   │                         check_local_claude、run_local_claude、窗口切换/拖拽
│   ├── src/tray.rs           托盘菜单
│   ├── capabilities/         权限；http:default 里是允许抓取的域名白名单
│   └── tauri.conf.json       两个窗口：pet（透明置顶）与 main（工作台，默认隐藏）
├── skills/                   示例 SKILL.md，可在 Skills 页导入
└── public/models/pet.glb     3D 宠物模型
```

### 两个窗口的状态

`pet` 与 `main` 是两个独立的 WebView，各有一份 zustand 状态，但共用 localStorage。
写入方保存到 localStorage，另一个窗口通过 `storage` 事件重新载入（见 `store/windowSync.ts`、
`store/bots.ts`、`store/theme.ts`）。新增需要跨窗口共享的状态时，记得接入同步。

### 访问第三方网站

WebView 里直接 `fetch` 不带 CORS 头的站点会被拦截。搜索、新闻等请求通过 `agent/http.ts`
走 `tauri-plugin-http`；新增来源时要同时在 `src-tauri/capabilities/default.json` 的
`http:default` 白名单里加上域名。

## 说明

- 默认面向 Windows 10/11
- 需要 Rust 和 Visual Studio C++ Build Tools（`build-with-msvc.ps1` 可自动配置 MSVC 环境）
- 可在设置中配置 OpenAI 兼容接口、API Key、Base URL 和模型名
- 依赖用 npm 管理（`package-lock.json`）
