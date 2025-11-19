import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
	build: {
		lib: {
			entry: resolve(__dirname, "src/index.ts"),
			name: "ComposerWeb",
			formats: ["es", "umd"],
			fileName: (format) => `composer-web.${format}.js`,
		},
		rollupOptions: {
			external: [],
			output: {
				globals: {},
			},
		},
	},
	server: {
		port: 3000,
		open: true,
	},
});
