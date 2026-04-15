/** @type {import('tailwindcss').Config} */
export default {
	content: ["./src/renderer/**/*.{js,ts,jsx,tsx}", "./index.html"],
	darkMode: "class",
	theme: {
		extend: {
			colors: {
				bg: {
					void: "var(--bg-void)",
					primary: "var(--bg-primary)",
					secondary: "var(--bg-secondary)",
					tertiary: "var(--bg-tertiary)",
					elevated: "var(--bg-elevated)",
					surface: "var(--bg-surface)",
				},
				text: {
					primary: "var(--text-primary)",
					secondary: "var(--text-secondary)",
					tertiary: "var(--text-tertiary)",
					muted: "var(--text-muted)",
				},
				line: {
					DEFAULT: "var(--border-default)",
					subtle: "var(--border-subtle)",
					emphasis: "var(--border-emphasis)",
					glow: "var(--border-glow)",
				},
				accent: {
					DEFAULT: "var(--accent)",
					hover: "var(--accent-hover)",
					glow: "var(--accent-glow)",
					subtle: "var(--accent-subtle)",
				},
				success: {
					DEFAULT: "var(--success)",
					glow: "var(--success-glow)",
				},
				warning: "var(--warning)",
				error: {
					DEFAULT: "var(--error)",
					glow: "var(--error-glow)",
				},
				amber: {
					400: "#fbbf24",
					500: "#f59e0b",
				},
			},
			fontFamily: {
				sans: ["DM Sans", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
				mono: ["JetBrains Mono", "SF Mono", "Monaco", "monospace"],
			},
			fontSize: {
				xs: ["12px", { lineHeight: "16px" }],
				sm: ["14px", { lineHeight: "20px" }],
				base: ["15px", { lineHeight: "24px" }],
				lg: ["18px", { lineHeight: "28px" }],
				xl: ["24px", { lineHeight: "32px" }],
				"2xl": ["32px", { lineHeight: "40px" }],
			},
			borderRadius: {
				xl: "12px",
				"2xl": "16px",
				"3xl": "24px",
			},
			spacing: {
				header: "var(--header-height)",
				sidebar: "var(--sidebar-width)",
				titlebar: "var(--titlebar-height)",
			},
			animation: {
				"fade-in": "fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
				"slide-up": "slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
				"slide-in-left": "slide-in-left 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
				"pulse-soft": "pulse-soft 2s ease-in-out infinite",
			},
			keyframes: {
				"fade-in": {
					"0%": { opacity: "0" },
					"100%": { opacity: "1" },
				},
				"slide-up": {
					"0%": { opacity: "0", transform: "translateY(8px)" },
					"100%": { opacity: "1", transform: "translateY(0)" },
				},
				"slide-in-left": {
					"0%": { opacity: "0", transform: "translateX(-12px)" },
					"100%": { opacity: "1", transform: "translateX(0)" },
				},
				"pulse-soft": {
					"0%, 100%": { opacity: "0.6" },
					"50%": { opacity: "1" },
				},
			},
			transitionTimingFunction: {
				"out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
			},
		},
	},
	plugins: [],
};
