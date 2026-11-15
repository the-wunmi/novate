import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // Live tests reach the real Airwallex sandbox and Metal. Only `pnpm test:live` runs them.
  test: { exclude: [...configDefaults.exclude, '**/*.live.test.ts'] },
});
