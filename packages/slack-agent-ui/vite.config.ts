import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		host: "127.0.0.1",
		port: 3100,
		strictPort: true,
		proxy: {
			"/api": {
				target: "http://localhost:3200",
				changeOrigin: true,
			},
			"/slack": {
				target: "http://localhost:3200",
				changeOrigin: true,
			},
			"/webhooks": {
				target: "http://localhost:3201",
				changeOrigin: true,
			},
		},
	},
});
