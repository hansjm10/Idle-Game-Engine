import { z } from 'zod';

/**
 * Placeholder implementations for identifier schemas to unblock package scaffolding.
 * Detailed validation logic arrives in follow-up steps per docs/content-dsl-schema-design.md §5.2.
 */
export const contentIdSchema = z.string();
export const packSlugSchema = z.string();
export const localeCodeSchema = z.string();
export const flagIdSchema = z.string();
export const scriptIdSchema = z.string();
export const systemAutomationTargetIdSchema = z.string();
export const semverSchema = z.string();
export const semverRangeSchema = z.string();
