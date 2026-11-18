import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Unit tests of the AI-DLC harness itself (not of the Angular application). */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['**/*.ts'],
      exclude: ['tests/**', '*.config.ts', 'samples/**'],
      reporter: ['text-summary'],
    },
  },
});
