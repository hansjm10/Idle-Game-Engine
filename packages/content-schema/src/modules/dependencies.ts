import { z } from 'zod';

import {
  contentIdSchema,
  packSlugSchema,
  semverRangeSchema,
} from '../base/ids.js';

type DependencyEdge = Readonly<{
  packId: PackId;
  version?: SemanticVersionRange;
}>;

type DependencyEdgeInput = Readonly<{
  packId: PackIdInput;
  version?: SemanticVersionRangeInput;
}>;

type ConflictEntry = Readonly<{
  packId: PackId;
  message?: string;
}>;

type ConflictEntryInput = Readonly<{
  packId: PackIdInput;
  message?: string;
}>;

type CapabilityId = z.infer<typeof contentIdSchema>;
type CapabilityIdInput = z.input<typeof contentIdSchema>;

type PackId = z.infer<typeof packSlugSchema>;
type PackIdInput = z.input<typeof packSlugSchema>;

type SemanticVersionRange = z.infer<typeof semverRangeSchema>;
type SemanticVersionRangeInput = z.input<typeof semverRangeSchema>;

const MAX_MESSAGE_LENGTH = 160;

const createUniqueChecker =
  <Entry extends { readonly packId: string }>(label: string) =>
  (entries: readonly Entry[], ctx: z.RefinementCtx, path: (string | number)[]) => {
    const seen = new Map<string, number>();
    entries.forEach((entry, index) => {
      const existingIndex = seen.get(entry.packId);
      if (existingIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, index],
          message: `${label} entry for pack "${entry.packId}" duplicates index ${existingIndex}.`,
        });
        return;
      }
      seen.set(entry.packId, index);
    });
  };

const dependencyEdgeSchema: z.ZodType<
  DependencyEdge,
  z.ZodTypeDef,
  DependencyEdgeInput
> = z
  .object({
    packId: packSlugSchema,
    version: semverRangeSchema.optional(),
  })
  .strict();

const conflictEntrySchema: z.ZodType<
  ConflictEntry,
  z.ZodTypeDef,
  ConflictEntryInput
> = z
  .object({
    packId: packSlugSchema,
    message: z
      .string()
      .trim()
      .min(1, { message: 'Conflict message must contain at least one character.' })
      .max(MAX_MESSAGE_LENGTH, {
        message: `Conflict message must contain at most ${MAX_MESSAGE_LENGTH} characters.`,
      })
      .optional(),
  })
  .strict();

const capabilityIdSchema = contentIdSchema.describe(
  'Capability identifiers mirror content id grammar for deterministic casing.',
);

const sortDependencyEdges = <Edge extends DependencyEdge>(edges: readonly Edge[]) =>
  [...edges].sort((left, right) => {
    const byId = left.packId.localeCompare(right.packId);
    if (byId !== 0) {
      return byId;
    }
    const leftRange = left.version ?? '';
    const rightRange = right.version ?? '';
    return leftRange.localeCompare(rightRange);
  });

const sortCapabilities = (
  entries: readonly CapabilityId[],
): CapabilityId[] => {
  const deduped = Array.from(new Set(entries)) as CapabilityId[];
  return deduped.sort((left, right) => left.localeCompare(right));
};

const assertUniqueCapabilities = (
  entries: readonly CapabilityId[],
  ctx: z.RefinementCtx,
  path: (string | number)[],
) => {
  const seen = new Map<string, number>();
  entries.forEach((capability, index) => {
    const existing = seen.get(capability);
    if (existing !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: `Capability "${capability}" duplicates entry at index ${existing}.`,
      });
      return;
    }
    seen.set(capability, index);
  });
};

const sortConflicts = (entries: readonly ConflictEntry[]) =>
  [...entries].sort((left, right) => {
    const byId = left.packId.localeCompare(right.packId);
    if (byId !== 0) {
      return byId;
    }
    const leftMessage = left.message ?? '';
    const rightMessage = right.message ?? '';
    return leftMessage.localeCompare(rightMessage);
  });

export const dependencyDeclarationSchema = dependencyEdgeSchema;

const UNIQUE_REQUIRES = createUniqueChecker<DependencyEdge>('requires');
const UNIQUE_OPTIONAL = createUniqueChecker<DependencyEdge>('optional');
const UNIQUE_CONFLICTS = createUniqueChecker<ConflictEntry>('conflict');

export type DependencyCollection = Readonly<{
  requires: readonly DependencyEdge[];
  optional: readonly DependencyEdge[];
  conflicts: readonly ConflictEntry[];
  provides: readonly CapabilityId[];
}>;

type DependencyCollectionInput = Readonly<{
  requires?: readonly DependencyEdgeInput[];
  optional?: readonly DependencyEdgeInput[];
  conflicts?: readonly ConflictEntryInput[];
  provides?: readonly CapabilityIdInput[];
}>;

export const dependencyCollectionSchema: z.ZodType<
  DependencyCollection,
  z.ZodTypeDef,
  DependencyCollectionInput
> = z
  .object({
    requires: z.array(dependencyEdgeSchema).default([]),
    optional: z.array(dependencyEdgeSchema).default([]),
    conflicts: z.array(conflictEntrySchema).default([]),
    provides: z.array(capabilityIdSchema).default([]),
  })
  .strict()
  .superRefine((dependencies, ctx) => {
    UNIQUE_REQUIRES(dependencies.requires, ctx, ['requires']);
    UNIQUE_OPTIONAL(dependencies.optional, ctx, ['optional']);
    UNIQUE_CONFLICTS(dependencies.conflicts, ctx, ['conflicts']);
    assertUniqueCapabilities(dependencies.provides, ctx, ['provides']);
  })
  .transform((dependencies) => ({
    requires: Object.freeze(sortDependencyEdges(dependencies.requires)),
    optional: Object.freeze(sortDependencyEdges(dependencies.optional)),
    conflicts: Object.freeze(sortConflicts(dependencies.conflicts)),
    provides: Object.freeze(sortCapabilities(dependencies.provides)),
  }));

export type DependencyDeclaration = z.infer<typeof dependencyDeclarationSchema>;
