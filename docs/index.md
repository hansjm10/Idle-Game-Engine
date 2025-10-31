---
title: Overview
sidebar_position: 1
slug: /
---

# Idle Engine Documentation

Welcome to the developer hub for the Idle Engine monorepo. This site pulls
together the design proposals in `docs/`, package READMEs, and new contributor
guides so you can reason about the runtime, shell, and content pipeline in one
place.

## How to use these docs

- Start with the **Contributor Handbook** if you are setting up a workstation or
  want to understand the pnpm workflows, testing matrix, and repository
  conventions.
- Browse **Core Runtime** and **Content Pipeline** sections for in-depth design
  notes and current implementation status. Each design doc links back to the
  relevant source files in `packages/`.
- Extending the presentation shell? Follow the
  [Worker Bridge Extension Tutorial](worker-bridge-extension-tutorial.md) to add
  new commands end-to-end.
- Consuming shared shell state? Read the
  [Shell State Provider Integration Guide](shell-state-provider-guide.md) for
  hook usage, diagnostics, and migration practices.
- Use the **Design Document Template** when drafting new proposals or migrating
  historical specs so the archive stays consistent.
- Check the **Decisions** section when you need historical context before
  opening an RFC or refactoring existing systems.

The design documents remain living references. When you ship meaningful changes,
update the relevant doc and include the affected tests in your pull request
summary.
