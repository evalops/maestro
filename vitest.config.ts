import { defineConfig } from "vitest/config";

const fastMode = process.env.VITEST_FAST === "1";

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // 30 seconds for API calls
    hookTimeout: 30000,
    setupFiles: [
      'test/setup/suppress-warnings.ts',
      'test/setup/todo-store.ts',
      'test/setup/restore-cwd.ts',
      'test/setup/restore-timers.ts',
      'test/setup/reset-safety-state.ts',
      'test/setup/restore-env.ts',
    ],
    // Disable file parallelism by default to reduce memory pressure and prevent test hangs
    // Set VITEST_FAST=1 to opt into parallelism for local runs
    fileParallelism: fastMode,
    // Isolate tests to prevent module state leakage between test files
    isolate: true,
    // Pool configuration for better memory management
    pool: fastMode ? 'threads' : 'forks',
    poolOptions: fastMode
      ? { threads: { singleThread: false } }
      : { forks: { singleFork: true } },
    // Benchmark configuration
    benchmark: {
      include: ['test/**/*.bench.ts'],
      reporters: ['verbose'],
    },
  }
});
