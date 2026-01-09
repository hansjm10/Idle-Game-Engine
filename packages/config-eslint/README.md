# @idle-engine/config-eslint

Shared ESLint flat configuration used across the Idle Engine monorepo. Consumers should create an `eslint.config.js` file that re-exports this package:

```js
import config from '@idle-engine/config-eslint';

export default config;
```

## Options

Use `createConfig()` for opt-in rules:

```js
import { createConfig } from '@idle-engine/config-eslint';

export default createConfig({
  restrictCoreInternals: 'warn',
});
```

### `restrictCoreInternals`

- Use `'error'` in game/app-facing packages to prevent accidental dependency on `@idle-engine/core/internals`.
- Use `'warn'` for engine tooling where internals usage may be intentional.
- Use `false` to disable the rule.
