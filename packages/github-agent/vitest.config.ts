import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@evalops/ai/telemetry": fileURLToPath(
				new URL("../ai/src/telemetry/index.ts", import.meta.url),
			),
		},
	},
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
		globals: false,
	},
});
