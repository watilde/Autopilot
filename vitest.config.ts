import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // config.ts validates at import time, so the suite needs a valid
    // environment before any module under test is loaded.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DEVIN_MODE: 'mock',
      ALLOW_UNSIGNED_WEBHOOKS: 'true',
      DATABASE_PATH: ':memory:',
      GITHUB_OWNER: 'watilde',
      GITHUB_REPO: 'superset',
    },
  },
});
