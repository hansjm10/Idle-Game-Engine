# @idle-engine/config-vitest

Reusable helpers for standardising Vitest configuration across the Idle Engine monorepo.

## Usage

### Node-oriented packages

Create a `vitest.config.ts` file that re-exports the shared defaults:

```ts
import { createVitestConfig } from '@idle-engine/config-vitest';

export default createVitestConfig();
```

### Browser-oriented packages

For packages that need a `jsdom` environment (e.g., React shells), use the browser helper:

```ts
import { createBrowserVitestConfig } from '@idle-engine/config-vitest';

export default createBrowserVitestConfig();
```

Pass additional overrides to either helper when a package needs custom behaviour.
