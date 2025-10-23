# Idle Engine Docs

This workspace hosts the Docusaurus site that renders the Idle Engine design
documents and contributor guides.

## Commands

```bash
# start the docs site locally
pnpm --filter @idle-engine/docs run start

# build static assets
pnpm --filter @idle-engine/docs run build

# preview an existing build
pnpm --filter @idle-engine/docs run serve
```

The docs plugin reads from the monorepo `docs/` directory, so updates to design
notes automatically appear the next time you run the dev server or rebuild the
site.
