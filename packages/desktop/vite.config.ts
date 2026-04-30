import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";

const desktopPackage = JSON.parse(
	readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version?: string };

const DEV_PORT = Number(
	process.env.MAESTRO_DESKTOP_UI_PORT ?? process.env.VITE_PORT ?? 5173,
);
const DESKTOP_API_PORT = process.env.MAESTRO_DESKTOP_PORT ?? "8080";
const IS_PRODUCTION_BUILD = process.env.NODE_ENV === "production";
const DEV_API_KEY = "maestro-desktop-local-api-key";

process.env.VITE_MAESTRO_BASE_URL ??= `http://localhost:${DESKTOP_API_PORT}`;
if (!IS_PRODUCTION_BUILD || process.env.MAESTRO_DESKTOP_API_KEY) {
	process.env.VITE_MAESTRO_API_KEY ??=
		process.env.MAESTRO_DESKTOP_API_KEY ?? DEV_API_KEY;
}
process.env.VITE_MAESTRO_CSRF_TOKEN ??=
	process.env.MAESTRO_DESKTOP_CSRF_TOKEN ?? "maestro-desktop-csrf";
process.env.VITE_MAESTRO_DESKTOP_VERSION ??= desktopPackage.version ?? "dev";

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
