---
title: Overview
sidebar_position: 1
slug: /
---

# Idle Engine Documentation

Welcome to the developer hub for the Idle Engine monorepo. This site pulls
together the design proposals in `docs/`, package READMEs, and new contributor
guides so you can reason about the runtime, content pipeline, and supporting
services in one place.

## How to use these docs

- Start with the **Contributor Handbook** if you are setting up a workstation or
  want to understand the pnpm workflows, testing matrix, and repository
  conventions.
- Browse **Core Runtime** and **Content Pipeline** sections for in-depth design
  notes and current implementation status. Each design doc links back to the
  relevant source files in `packages/`.
- Presentation shell docs have been archived; downstream shells should maintain their own integration guides.
- Use the **Design Document Template** when drafting new proposals or migrating
  historical specs so the archive stays consistent.
- Check the **Decisions** section when you need historical context before
  opening an RFC or refactoring existing systems.

## Saving and loading game state

The high-level `Game` facade uses `serialize()` and `hydrate()` for save/load
workflows. These names follow state-management terminology: `serialize()`
creates a JSON-compatible save object, and `hydrate(save)` restores a parsed
save object into a runtime. They are the save and load methods; the facade does
not expose separate `save()` or `load()` aliases.

Use your host environment to choose the persistence backend. In a browser,
`localStorage` is enough for a basic save slot:

```ts
import type { Game } from '@idle-engine/core';

const SAVE_KEY = 'idle-game-save';

export function saveGame(game: Game): void {
  const data = game.serialize();
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
}

export function loadGame(game: Game): boolean {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) {
    return false;
  }

  const data: unknown = JSON.parse(raw);
  game.hydrate(data);
  return true;
}
```

`hydrate()` validates and migrates supported save formats before restoring the
runtime. During restoration it temporarily stops the built-in scheduler. If the
game was running because `start()` had been called, it starts ticking again
after hydration completes or throws; if it was stopped, it stays stopped.

`hydrate()` also preserves deterministic step ordering. A save from a future
step fast-forwards the runtime before restoration, but a save from an earlier
step than the current runtime is rejected. Create a new game instance when you
need to load an older save into a session that has already advanced.

The design documents remain living references. When you ship meaningful changes,
update the relevant doc and include the affected tests in your pull request
summary.
