# @idle-engine/shell-web

Placeholder React shell for the idle engine runtime. The current implementation boots the runtime loop and will eventually render resource panels, upgrade lists, and social UI components.

## Accessibility
Run `pnpm test:a11y` from the repository root to execute the Playwright accessibility smoke tests against this shell. Use `pnpm test:a11y --ui` to open the Playwright UI when iterating locally. Linux environments may need `pnpm exec playwright install-deps` once to install required system libraries.
