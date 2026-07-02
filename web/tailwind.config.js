/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Neutral ramp is CSS-variable driven so light/dark flip in one place
        // (see index.css). Semantics: 950=page bg, 900=card/input, 800=subtle/
        // hover, 700/600=borders, 500=muted text, 400/300=secondary text,
        // 200/100/50=primary text. In light mode the ramp is reversed + mint-
        // tinted, so every existing `ink-*` usage re-themes automatically.
        ink: {
          50: "rgb(var(--ink-50) / <alpha-value>)",
          100: "rgb(var(--ink-100) / <alpha-value>)",
          200: "rgb(var(--ink-200) / <alpha-value>)",
          300: "rgb(var(--ink-300) / <alpha-value>)",
          400: "rgb(var(--ink-400) / <alpha-value>)",
          500: "rgb(var(--ink-500) / <alpha-value>)",
          600: "rgb(var(--ink-600) / <alpha-value>)",
          700: "rgb(var(--ink-700) / <alpha-value>)",
          800: "rgb(var(--ink-800) / <alpha-value>)",
          900: "rgb(var(--ink-900) / <alpha-value>)",
          950: "rgb(var(--ink-950) / <alpha-value>)",
        },
        // Primary accent remapped emerald → 清新薄荷 mint. Every existing
        // `emerald-*` class becomes mint (buttons, focus rings, ok badges, KPI).
        emerald: {
          50: "#eff9f5",
          100: "#d6f3ea",
          200: "#a8e0d2", // 辅助
          300: "#89d7c4",
          400: "#6eccb4",
          500: "#5fc9b0", // 主色
          600: "#4bb79e",
          700: "#3c9c86",
          800: "#317c6c",
          900: "#295f54",
          950: "#133029",
        },
      },
    },
  },
  plugins: [],
};
