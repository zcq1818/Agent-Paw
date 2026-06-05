/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        pika: {
          yellow: "#F7DC6F",
          dark: "#F1C40F",
          cheek: "#E74C3C",
          bolt: "#F39C12",
          bg: "#FFF9C4",
        },
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
