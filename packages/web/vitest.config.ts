import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		// Use happy-dom for Lit components (lighter than jsdom)
		environment: "happy-dom",
		include: ["src/**/*.test.ts"],
		// Exclude browser-specific fixture tests that need real DOM
		exclude: [
			"**/node_modules/**",
			// These tests use @open-wc/testing which requires real browser
			"src/components/composer-input.test.ts",
			"src/components/composer-message.test.ts",
			"src/components/composer-chat.test.ts",
		],
	},
});
