import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";

const DEV_PORT = Number(
	process.env.MAESTRO_DESKTOP_UI_PORT ?? process.env.VITE_PORT ?? 5173,
);

export default defineConfig({
	plugins: [
		react(),
		electron({
			main: {
				// Main process entry
				entry: "src/main/index.ts",
				onstart(args) {
					args.startup();
				},
				vite: {
					build: {
						outDir: "dist-electron/main",
						rollupOptions: {
							external: ["electron", "electron-updater", "electron-store"],
						},
					},
				},
			},
			preload: {
				// Preload script entry - will be built as CJS automatically
				input: "src/preload/index.ts",
				onstart(args) {
					args.reload();
				},
				vite: {
					build: {
						outDir: "dist-electron/preload",
					},
				},
			},
			// Enable Node.js APIs in renderer if needed
			renderer: {},
		}),
	],
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		port: DEV_PORT,
		strictPort: true,
	},
});
