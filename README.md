# 🐾 Paw — 皮卡丘桌面宠物 Agent

> 把一只会聊天、会干活的皮卡丘放进你的 Windows 桌面。

## ✨ 特性

- ⚡ **桌面宠物** — 透明窗口、可拖拽、idle/walk/sit/sleep 动画
- 💬 **AI 聊天** — 流式输出、Markdown 渲染、多轮对话
- 🔧 **工具调用** — 网页搜索、天气查询、数学计算
- 🧠 **本地记忆** — 偏好、笔记、事实，持久化在浏览器存储
- 🎯 **技能系统** — SKILL.md 文件夹扫描，按需扩展
- 🖥️ **系统托盘** — 最小化到托盘，全局快捷键唤出

## 🏗️ 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri v2 (Rust) |
| 前端 | React + Vite + Tailwind CSS |
| AI | OpenAI 兼容 API (流式 + 工具调用) |
| 状态管理 | Zustand |
| 存储 | localStorage + IndexedDB |

## 📦 安装

### 前置要求

- [Node.js](https://nodejs.org/) >= 22
- [pnpm](https://pnpm.io/) >= 11
- [Rust](https://www.rust-lang.org/tools/install) (Tauri 构建需要)
- Windows 10/11

### 开发

```bash
# 克隆
git clone https://github.com/zcq1818/chongwu.git
cd chongwu

# 安装依赖
pnpm install

# 启动开发版
pnpm tauri:dev
```

### 构建

```bash
# 构建 Windows 安装包
pnpm tauri:build
```

产物在 `src-tauri/target/release/bundle/` 下。

## ⚙️ 配置

启动后右键皮卡丘 → 设置，填入：

- **Provider**: OpenAI / DeepSeek / Anthropic / OpenRouter
- **API Key**: 你的 API Key
- **Base URL**: API 端点（默认 OpenAI）
- **模型名**: gpt-4o-mini / deepseek-chat / 等

## 📁 项目结构

```
paw/
├── src-tauri/          ← Tauri v2 Rust 壳
│   ├── src/
│   │   ├── lib.rs      ← 窗口管理
│   │   ├── main.rs     ← 入口
│   │   └── tray.rs     ← 系统托盘
│   └── tauri.conf.json
├── src/                ← React 前端
│   ├── components/     ← Pet / ChatPanel / Settings
│   ├── agent/          ← Agent 内核 / 记忆 / 上下文
│   ├── store/          ← Zustand 状态管理
│   └── styles/         ← 样式
├── skills/             ← 技能文件夹
│   ├── weather/
│   ├── todo/
│   └── media/
└── package.json
```

## 🐾 宠物状态

| 状态 | 触发 | 表现 |
|---|---|---|
| idle | 默认 | 轻微浮动 |
| walk | 随机 | 左右摇摆 |
| sit | 随机 | 静止 |
| sleep | 随机 | 半透明 + 💤 |
| excited | 点击/回复 | 跳跃 + ⚡ |
| thinking | AI 思考中 | 脉冲 + 💭 |

## License

MIT
