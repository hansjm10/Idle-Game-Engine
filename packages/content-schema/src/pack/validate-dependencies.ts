import { z } from 'zod';

import type { ParsedContentPack } from './schema.js';
import type { CrossReferenceContext, KnownPackDependency } from './types.js';
import { toMutablePath } from './utils.js';

export const validateDependencies = (
  pack: ParsedContentPack,
  ctx: z.RefinementCtx,
  context: CrossReferenceContext,
) => {
  const dependencies = pack.metadata.dependencies;
  if (!dependencies) {
    return;
  }

  const packId = pack.metadata.id;

  dependencies.optional.forEach((dependency, index) => {
    if (context.activePackIds.size === 0) {
      return;
    }
    if (!context.activePackIds.has(dependency.packId)) {
      context.warningSink({
        code: 'dependencies.optionalMissing',
        message: `Optional dependency "${dependency.packId}" is not present in active pack set.`,
        path: toMutablePath(['metadata', 'dependencies', 'optional', index] as const),
        severity: 'warning',
      });
    }
  });

  const adjacency = new Map<string, Set<string>>();

  const addEdge = (from: string, to: string) => {
    if (!adjacency.has(from)) {
      adjacency.set(from, new Set());
    }
    adjacency.get(from)?.add(to);
  };

  dependencies.requires.forEach((dependency, index) => {
    if (dependency.packId === packId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath(['metadata', 'dependencies', 'requires', index, 'packId'] as const),
        message: 'Pack cannot depend on itself.',
      });
      return;
    }
    addEdge(packId, dependency.packId);
    if (!context.knownPacks.has(dependency.packId)) {
      context.warningSink({
        code: 'dependencies.unknownPack',
        message: `Dependency "${dependency.packId}" is not present in known pack graph.`,
        path: toMutablePath(['metadata', 'dependencies', 'requires', index, 'packId'] as const),
        severity: 'warning',
      });
    }
  });

  context.knownPacks.forEach((knownPack) => {
    knownPack.requires?.forEach((dependency: KnownPackDependency) => {
      addEdge(knownPack.id, dependency.packId);
    });
  });

  const stack = new Set<string>();
  const visited = new Set<string>();

  const visit = (node: string): boolean => {
    if (stack.has(node)) {
      return true;
    }
    if (visited.has(node)) {
      return false;
    }
    visited.add(node);
    stack.add(node);
    const edges = adjacency.get(node);
    if (edges) {
      for (const target of edges) {
        if (visit(target)) {
          return true;
        }
      }
    }
    stack.delete(node);
    return false;
  };

  if (visit(packId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: toMutablePath(['metadata', 'dependencies', 'requires'] as const),
      message: 'Dependency graph contains a cycle involving this pack.',
    });
  }
};
