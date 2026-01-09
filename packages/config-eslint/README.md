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
