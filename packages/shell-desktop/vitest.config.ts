import { createVitestConfig } from '@idle-engine/config-vitest';

export default createVitestConfig({
  esbuild: {
    include: /\.[cm]?tsx?$/,
  },
});
