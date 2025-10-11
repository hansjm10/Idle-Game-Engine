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

## AI-friendly reporting

All configs include the [`vitest-llm-reporter`](https://github.com/hansjm10/vitest-llm-reporter) alongside Vitest's default reporter. It emits a machine-readable JSON summary at the end of each run so AI agents and CI tooling can parse test results reliably. Streaming output is disabled (`streaming: false`) to keep reports deterministic for batch jobs.

Override the shared reporters only when a package needs to append extra reporters:

```ts
import { createVitestConfig } from '@idle-engine/config-vitest';
import { LLMReporter } from 'vitest-llm-reporter';

export default createVitestConfig({
  test: {
    reporters: [
      'default',
      new LLMReporter({ streaming: false }),
      'junit' // additional reporter example
    ]
  }
});
```

Leaving the default reporters in place ensures the JSON summary continues to be generated for automation workflows.
