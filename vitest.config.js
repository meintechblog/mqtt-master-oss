import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: false,
    testTimeout: 15000,
    // The service refuses to start without ENCRYPTION_SECRET.
    env: { ENCRYPTION_SECRET: 'vitest-only-secret-not-for-production' },
  },
});
