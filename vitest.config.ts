import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The database tests share one database, and some change grants and
    // policies inside their transaction; files running side by side would
    // wait on (or deadlock with) each other's locks.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
