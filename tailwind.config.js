/** @type {import('tailwindcss').Config} */

// 颜色全部指向 CSS 变量（定义在 src/styles/globals.css 的 .theme-light / .theme-dark 里），
// 这样同一套类名在浅色 / 深色下自动换色。
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const scale = (prefix) =>
  Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => [step, v(`${prefix}-${step}`)]));

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // 语义色：新界面统一用这一组。
        app: v("app"),
        surface: v("surface"),
        "surface-2": v("surface-2"),
        line: v("line"),
        fg: v("fg"),
        "fg-muted": v("fg-muted"),
        primary: v("primary"),
        "primary-fg": v("primary-fg"),
        "primary-ink": v("primary-ink"),
        accent: v("accent"),
        danger: v("danger"),
        success: v("success"),
        sidebar: v("sidebar"),
        "sidebar-fg": v("sidebar-fg"),
        "sidebar-muted": v("sidebar-muted"),
        "sidebar-hover": v("sidebar-hover"),
        // 旧面板大量使用 gray / yellow：映射到同一套主题变量（gray → 中性色阶，yellow → 品牌青色），
        // 不用逐个改文件也能跟随主题。
        gray: scale("gray"),
        yellow: scale("brand"),
        pika: {
          yellow: "#F7DC6F",
          dark: "#F1C40F",
          cheek: "#E74C3C",
          bolt: "#F39C12",
          bg: "#FFF9C4",
        },
      },
      fontFamily: {
        sans: ['"Segoe UI"', '"Microsoft YaHei UI"', '"PingFang SC"', '"Noto Sans SC"', "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgb(var(--shadow) / 0.06), 0 1px 3px rgb(var(--shadow) / 0.08)",
        pop: "0 12px 32px rgb(var(--shadow) / 0.18), 0 2px 6px rgb(var(--shadow) / 0.08)",
      },
      animation: {
        "bounce-slow": "bounce 3s infinite",
        wiggle: "wiggle 0.5s ease-in-out infinite",
        float: "float 3s ease-in-out infinite",
        sparkle: "sparkle 1.5s ease-in-out infinite",
      },
      keyframes: {
        wiggle: {
          "0%, 100%": { transform: "rotate(-3deg)" },
          "50%": { transform: "rotate(3deg)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-10px)" },
        },
        sparkle: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
      },
    },
  },
  plugins: [],
};
