import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // 30 seconds for API calls
    setupFiles: ['test/setup/suppress-warnings.ts', 'test/setup/todo-store.ts'],
    fileParallelism: false, // Disable parallel file execution to avoid cost-tracking conflicts
  }
});
