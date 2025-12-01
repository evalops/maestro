import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // 30 seconds for API calls
    setupFiles: ['test/setup/suppress-warnings.ts', 'test/setup/todo-store.ts'],
    // File parallelism enabled - cost-tracking tests now use isolated temp directories
    // via COMPOSER_USAGE_FILE environment variable
    fileParallelism: true,
  }
});
