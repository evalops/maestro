import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // 30 seconds for API calls
    setupFiles: ['test/setup/suppress-warnings.ts', 'test/setup/todo-store.ts'],
    // Disable parallel file execution because cost-tracking tests share ~/.composer/usage.json
    // This is the correct solution for integration tests that test actual file I/O
    fileParallelism: false,
  }
});
