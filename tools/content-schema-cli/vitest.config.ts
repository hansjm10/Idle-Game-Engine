import { createVitestConfig } from '@idle-engine/config-vitest';

export default createVitestConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx,js}'],
  },
});
