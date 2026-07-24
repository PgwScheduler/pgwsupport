/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      // Semantic color names -> the CSS variables in src/index.css. Components
      // use these names (bg-surface-card, text-content-primary, ...), never raw
      // palette classes or literal hex. Retune the whole portal from that one
      // variable block.
      colors: {
        surface: {
          page: "var(--surface-page)",
          card: "var(--surface-card)",
          overlay: "var(--surface-overlay)",
          input: "var(--surface-input)",
          stripe: "var(--surface-stripe)",
          inverse: "var(--surface-inverse)",
        },
        scrim: "var(--scrim)",
        hairline: {
          DEFAULT: "var(--border)",
          strong: "var(--border-strong)",
        },
        content: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          muted: "var(--text-muted)",
          disabled: "var(--text-disabled)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          tint: "var(--accent-tint)",
          text: "var(--accent-text)",
        },
        "on-accent": "var(--on-accent)",
        success: {
          DEFAULT: "var(--success)",
          tint: "var(--success-tint)",
          border: "var(--success-border)",
        },
        warning: {
          DEFAULT: "var(--warning)",
          tint: "var(--warning-tint)",
          border: "var(--warning-border)",
        },
        danger: {
          DEFAULT: "var(--danger)",
          hover: "var(--danger-hover)",
          tint: "var(--danger-tint)",
          border: "var(--danger-border)",
        },
      },
    },
  },
  plugins: [],
};
