# Paw 桌面宠物助手

一个基于 Tauri v2 + React + Vite 的 Windows 桌面宠物 AI 助手。

## 功能

- 桌面宠物窗口，可拖拽、常驻桌面
- 聊天窗口，支持流式输出和 Markdown
- 工具调用：搜索、天气、时间、计算、待办、日程、快捷命令
- 本地记忆：IndexedDB 存储，支持语义上下文
- 自定义技能：可创建、导入、导出、启用/禁用
- 托盘控制：显示、隐藏、退出主窗口

## 开发

```bash
npm install
npm run dev
```

## 打包

```bash
npm run tauri:build
```

## 说明

- 默认面向 Windows 10/11
- 需要 Rust 和 Visual Studio C++ Build Tools
- 可在设置中配置 OpenAI 兼容接口、API Key、Base URL 和模型名
