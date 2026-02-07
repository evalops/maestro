import { defineConfig } from "vitest/config";

if (process.env.FORCE_COLOR && process.env.NO_COLOR) {
	Reflect.deleteProperty(process.env, "NO_COLOR");
}

const fastMode = process.env.VITEST_FAST === "1";
const poolOptions = fastMode
	? { threads: { singleThread: false } }
	: { forks: { singleFork: true } };

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["test/**/*.test.ts"],
		testTimeout: 30000, // 30 seconds for API calls
		hookTimeout: 30000,
		setupFiles: [
			"test/setup/suppress-warnings.ts",
			"test/setup/todo-store.ts",
			"test/setup/restore-cwd.ts",
			"test/setup/restore-timers.ts",
			"test/setup/reset-safety-state.ts",
			"test/setup/restore-env.ts",
		],
		// Disable file parallelism by default to reduce memory pressure and prevent test hangs
		// Set VITEST_FAST=1 to opt into parallelism for local runs
		fileParallelism: fastMode,
		// Isolate tests to prevent module state leakage between test files
		isolate: true,
		// Pool configuration for better memory management
		pool: fastMode ? "threads" : "forks",
		// Benchmark configuration
		benchmark: {
			include: ["test/**/*.bench.ts"],
			reporters: ["verbose"],
		},
		// Coverage configuration (run with --coverage flag)
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html", "lcov"],
			reportsDirectory: "./coverage",
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.d.ts",
				"src/**/*.test.ts",
				"src/**/types.ts",
				"src/cli.ts",
			],
			// Minimum coverage thresholds — prevents regression
			thresholds: {
				statements: 40,
				branches: 30,
				functions: 30,
				lines: 40,
			},
		},
	},
	poolOptions,
});
